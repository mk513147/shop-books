-- 0017_product_catalogue_hardening
--
-- Fixes from the product catalogue security audit. Additive only: no existing row is changed or
-- removed. Forward-only like every migration here; a mistake after release is fixed by a new
-- migration (restore the pre-migration Neon branch only if nothing was written since).
--
-- 1. users.can_edit_purchase_prices: changing purchase prices (default price, supplier prices, and
--    supplier-link changes that alter or delete a stored price or the effective price) is a
--    separate permission from SEEING them. Off for everyone; the owner always has both (in code).
--    Editing without viewing makes no sense, so the database refuses that combination.
--
-- 2. Barcodes are unique among active products IGNORING LETTER CASE, like SKUs. Stored values are
--    not changed (kept exactly as typed, trimmed by the API); only the uniqueness rule and the
--    lookup index change. If two active products already share a barcode in a different case, the
--    migration stops with a clear message (nothing is applied) instead of changing either one.
--
-- 3. Search documents stay correct under concurrent changes. Every refresh first takes one
--    transaction-scoped advisory lock (key 726001003; the migrator uses 726001001 and the report
--    scheduler 726001002), then reads with a fresh snapshot (PL/pgSQL, READ COMMITTED). So:
--      * a product edit racing a brand / category / supplier rename always ends with a document
--        that has both changes, whichever commits first (previously the later writer could store
--        a document built from a snapshot without the other's change);
--      * refreshes no longer upsert product_search / product_search_words rows in different orders
--        in parallel, which could deadlock.
--    The rename triggers take the lock BEFORE choosing which products to refresh, so a product
--    moved to the renamed brand by a concurrent transaction is not missed.
--    Cost: product-catalogue writes are serialised for the rest of their (short) transaction.
--    Search reads take no lock. The application runs at READ COMMITTED (the PostgreSQL default),
--    which this design relies on.

-- 1. Permission to change purchase prices ------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN can_edit_purchase_prices boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT users_edit_prices_needs_view CHECK (NOT can_edit_purchase_prices OR can_view_purchase_prices);

-- 2. Case-insensitive barcode uniqueness ----------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products
     WHERE is_active AND barcode IS NOT NULL
     GROUP BY lower(barcode) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Two or more active products share a barcode that differs only in letter case. Fix or deactivate one of them, then run the migration again.';
  END IF;
END
$$;

DROP INDEX products_active_barcode_unique;
CREATE UNIQUE INDEX products_active_barcode_unique ON products (lower(barcode)) WHERE is_active AND barcode IS NOT NULL;

DROP INDEX products_barcode_idx;
CREATE INDEX products_barcode_idx ON products (lower(barcode)) WHERE barcode IS NOT NULL;

-- Exact SKU lookup (scanner / quick lookup) for active AND inactive products.
CREATE INDEX products_sku_lookup_idx ON products (lower(sku)) WHERE sku IS NOT NULL;

-- 3. Concurrency-safe search refresh -----------------------------------------------------------------

CREATE FUNCTION product_search_lock() RETURNS void
  LANGUAGE sql
  AS $$ SELECT pg_advisory_xact_lock(726001003) $$;

CREATE OR REPLACE FUNCTION refresh_product_search(ids uuid[]) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM product_search_lock();

  -- New statement => new snapshot: sees everything committed before the lock was granted.
  INSERT INTO product_search (product_id, document, supplier_document)
  SELECT p.id,
         product_search_norm(concat_ws(' ',
           b.name, p.name, c.name, p.size,
           CASE WHEN p.page_count IS NOT NULL THEN p.page_count::text || ' pages ' || p.page_count::text || 'p' END,
           CASE WHEN p.gsm IS NOT NULL THEN p.gsm::text || 'gsm ' || p.gsm::text || 'g' END,
           p.binding,
           array_to_string(p.search_aliases, ' '),
           (SELECT string_agg(a.value, ' ' ORDER BY a.key) FROM jsonb_each_text(p.attributes) a),
           p.sku,
           p.barcode)),
         product_search_norm((SELECT string_agg(s.name, ' ' ORDER BY s.name)
                                FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
                               WHERE ps.product_id = p.id))
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN expense_categories c ON c.id = p.category_id
   WHERE p.id = ANY (ids)
   ORDER BY p.id
  ON CONFLICT (product_id) DO UPDATE
     SET document = EXCLUDED.document, supplier_document = EXCLUDED.supplier_document;

  INSERT INTO product_search_words (word)
  SELECT DISTINCT w
    FROM product_search ps,
         unnest(string_to_array(ps.document || ' ' || ps.supplier_document, ' ')) AS w
   WHERE ps.product_id = ANY (ids)
     AND length(w) BETWEEN 4 AND 60
     AND w !~ '^[0-9]+$'
   ORDER BY w
  ON CONFLICT (word) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION brands_refresh_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM product_search_lock();
  PERFORM refresh_product_search(ARRAY(SELECT id FROM products WHERE brand_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION categories_refresh_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM product_search_lock();
  PERFORM refresh_product_search(ARRAY(SELECT id FROM products WHERE category_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION suppliers_refresh_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM product_search_lock();
  PERFORM refresh_product_search(ARRAY(SELECT product_id FROM product_suppliers WHERE supplier_id = NEW.id));
  RETURN NULL;
END;
$$;
