-- 0015_products
--
-- Product catalogue (catalogue ONLY: no stock, stock movements, purchase orders, sales or billing).
--
--   products                 one independently sellable unit per row (deactivated, never deleted)
--   product_costs            default purchase price (protected: separate table, never joined by
--                            ordinary product queries)
--   product_suppliers        product <-> supplier links with a supplier-specific purchase price
--                            (protected) and one preferred supplier per product
--   product_search           trigger-maintained search documents (pg_trgm GIN indexes)
--   product_import_batches   Excel import staging: one row per uploaded block
--   product_import_rows      one row per source row (original row number and raw cells kept)
--
-- Also:
--   expense_categories.is_product_usable  (default FALSE: no category becomes a product category
--                                          until someone marks it; expense and customer-due
--                                          workflows ignore the flag)
--   users.can_view_purchase_prices        (default FALSE; the owner is always allowed, in code)
--
-- Additive only: no existing row is changed (new columns have constant defaults, which is a
-- metadata-only change). The CHECK lists of financial_audit_events, auth_events and
-- idempotency_keys only grow, so the previously deployed application keeps working.
-- Forward-only: once product audit rows exist the narrower CHECK lists cannot be restored
-- (financial_audit_events is append-only), so fixes after release are new migrations.

-- 0. Trigram matching. pg_trgm is a trusted extension: a non-superuser with CREATE on the database
--    may install it. Always in public, so throw-away schemas used by tests never own it.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


-- 1. Flags on existing tables ---------------------------------------------------------------------

ALTER TABLE expense_categories ADD COLUMN is_product_usable boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN expense_categories.is_product_usable IS
  'Offered in the product form (migration 0015). Expense and customer-due category pickers ignore it.';

ALTER TABLE users ADD COLUMN can_view_purchase_prices boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN users.can_view_purchase_prices IS
  'Manager may see and change product purchase prices. The owner is always allowed (enforced in code).';


-- 2. Products -------------------------------------------------------------------------------------

CREATE TABLE products (
  id                         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Product name WITHOUT the brand (the brand is brand_id).
  name                       text          NOT NULL,
  brand_id                   uuid          REFERENCES brands (id) ON DELETE RESTRICT,
  category_id                uuid          NOT NULL REFERENCES expense_categories (id) ON DELETE RESTRICT,
  sku                        text,
  barcode                    text,
  description                text,
  -- Stored as written (normalised to upper case), never interpreted: "A4", "SL", "MD" ...
  size                       text,
  page_count                 integer,
  gsm                        integer,
  binding                    text,
  -- MRP, selling price and purchase prices are all per ONE selling unit; pack_qty = pieces in it.
  selling_unit               text          NOT NULL DEFAULT 'piece',
  pack_qty                   integer       NOT NULL DEFAULT 1,
  attributes                 jsonb         NOT NULL DEFAULT '{}'::jsonb,
  search_aliases             text[]        NOT NULL DEFAULT '{}',
  mrp                        numeric(14,2),
  selling_price              numeric(14,2) NOT NULL,
  -- Who explicitly confirmed a selling price above the MRP, and when (NULL when SP <= MRP).
  sp_above_mrp_confirmed_at  timestamptz,
  sp_above_mrp_confirmed_by  uuid          REFERENCES users (id) ON DELETE RESTRICT,
  is_active                  boolean       NOT NULL DEFAULT true,
  version                    integer       NOT NULL DEFAULT 1,
  created_at                 timestamptz   NOT NULL DEFAULT now(),
  updated_at                 timestamptz   NOT NULL DEFAULT now(),
  created_by                 uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by                 uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT products_name_valid CHECK (
    name = btrim(regexp_replace(name, '\s+', ' ', 'g')) AND length(name) BETWEEN 1 AND 160),
  CONSTRAINT products_sku_valid CHECK (sku IS NULL OR sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  CONSTRAINT products_barcode_valid CHECK (barcode IS NULL OR barcode ~ '^[A-Za-z0-9-]{4,64}$'),
  CONSTRAINT products_description_valid CHECK (
    description IS NULL OR (description = btrim(description) AND length(description) BETWEEN 1 AND 1000)),
  CONSTRAINT products_size_valid CHECK (
    size IS NULL OR (size = upper(btrim(regexp_replace(size, '\s+', ' ', 'g'))) AND length(size) BETWEEN 1 AND 20)),
  CONSTRAINT products_page_count_valid CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 10000),
  CONSTRAINT products_gsm_valid CHECK (gsm IS NULL OR gsm BETWEEN 1 AND 2000),
  CONSTRAINT products_binding_valid CHECK (
    binding IS NULL OR (binding = lower(btrim(regexp_replace(binding, '\s+', ' ', 'g'))) AND length(binding) BETWEEN 1 AND 40)),
  CONSTRAINT products_unit_valid CHECK (selling_unit IN ('piece', 'pack', 'box', 'set', 'ream')),
  CONSTRAINT products_pack_qty_valid CHECK (pack_qty BETWEEN 1 AND 100000 AND (selling_unit <> 'piece' OR pack_qty = 1)),
  CONSTRAINT products_attributes_valid CHECK (jsonb_typeof(attributes) = 'object' AND pg_column_size(attributes) <= 4096),
  CONSTRAINT products_aliases_valid CHECK (cardinality(search_aliases) <= 20 AND array_position(search_aliases, NULL) IS NULL),
  CONSTRAINT products_mrp_valid CHECK (mrp IS NULL OR mrp > 0),
  CONSTRAINT products_selling_price_valid CHECK (selling_price > 0),
  -- No "SP <= MRP" rule (selling above MRP is allowed after explicit confirmation), but a selling
  -- price above the MRP must always carry who confirmed it and when.
  CONSTRAINT products_sp_above_mrp_confirmed CHECK (
    (sp_above_mrp_confirmed_at IS NULL) = (sp_above_mrp_confirmed_by IS NULL)
    AND (mrp IS NULL OR selling_price <= mrp OR sp_above_mrp_confirmed_at IS NOT NULL)),
  CONSTRAINT products_version_positive CHECK (version >= 1)
);

CREATE INDEX products_brand_idx ON products (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX products_category_idx ON products (category_id);
-- Codes are unique among ACTIVE products (a deactivated product's code may be reused; reactivating
-- it then conflicts, which the application reports as 409).
CREATE UNIQUE INDEX products_active_sku_unique ON products (lower(sku)) WHERE is_active AND sku IS NOT NULL;
CREATE UNIQUE INDEX products_active_barcode_unique ON products (barcode) WHERE is_active AND barcode IS NOT NULL;
-- Exact code lookups that include deactivated products.
CREATE INDEX products_barcode_idx ON products (barcode) WHERE barcode IS NOT NULL;

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deactivated, never deleted (future records may refer to a product).
CREATE TRIGGER products_no_delete
  BEFORE DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();


-- 3. Purchase prices (protected) ------------------------------------------------------------------

CREATE TABLE product_costs (
  product_id              uuid          PRIMARY KEY REFERENCES products (id) ON DELETE RESTRICT,
  -- NULL = no default purchase price (the row is kept so its version keeps counting).
  default_purchase_price  numeric(14,2),
  version                 integer       NOT NULL DEFAULT 1,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  created_by              uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by              uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT product_costs_price_valid CHECK (default_purchase_price IS NULL OR default_purchase_price >= 0),
  CONSTRAINT product_costs_version_positive CHECK (version >= 1)
);

CREATE TRIGGER product_costs_set_updated_at
  BEFORE UPDATE ON product_costs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER product_costs_no_delete
  BEFORE DELETE ON product_costs
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

CREATE TABLE product_suppliers (
  product_id             uuid          NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  supplier_id            uuid          NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  purchase_price         numeric(14,2),
  supplier_product_code  text,
  notes                  text,
  is_preferred           boolean       NOT NULL DEFAULT false,
  version                integer       NOT NULL DEFAULT 1,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  created_by             uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by             uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  PRIMARY KEY (product_id, supplier_id),
  CONSTRAINT product_suppliers_price_valid CHECK (purchase_price IS NULL OR purchase_price >= 0),
  CONSTRAINT product_suppliers_code_valid CHECK (
    supplier_product_code IS NULL OR (supplier_product_code = btrim(supplier_product_code) AND length(supplier_product_code) BETWEEN 1 AND 60)),
  CONSTRAINT product_suppliers_notes_valid CHECK (notes IS NULL OR (notes = btrim(notes) AND length(notes) BETWEEN 1 AND 500)),
  CONSTRAINT product_suppliers_version_positive CHECK (version >= 1)
);

CREATE INDEX product_suppliers_supplier_idx ON product_suppliers (supplier_id);
-- At most one preferred supplier per product.
CREATE UNIQUE INDEX product_suppliers_one_preferred ON product_suppliers (product_id) WHERE is_preferred;

CREATE TRIGGER product_suppliers_set_updated_at
  BEFORE UPDATE ON product_suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- 4. Search documents -----------------------------------------------------------------------------
-- Kept OUTSIDE products so a brand/category/supplier rename or a supplier link change refreshes
-- search text without touching products (no updated_at/version change, no row lock on the product,
-- no audit row). Purchase prices are never part of a document.

CREATE TABLE product_search (
  product_id         uuid  PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
  document           text  NOT NULL,
  supplier_document  text  NOT NULL DEFAULT ''
);

CREATE INDEX product_search_document_trgm ON product_search USING gin (document gin_trgm_ops);
CREATE INDEX product_search_supplier_trgm ON product_search USING gin (supplier_document gin_trgm_ops);

-- Lower case; every run of non-alphanumeric characters becomes one space. The API normalises the
-- typed search text with the same rule (products/search.ts; parity is tested).
CREATE FUNCTION product_search_norm(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT btrim(regexp_replace(lower(coalesce(t, '')), '[^[:alnum:]]+', ' ', 'g')) $$;

CREATE FUNCTION refresh_product_search(ids uuid[]) RETURNS void
  LANGUAGE sql
  AS $$
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
  ON CONFLICT (product_id) DO UPDATE
     SET document = EXCLUDED.document, supplier_document = EXCLUDED.supplier_document
  $$;

CREATE FUNCTION products_refresh_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_search(ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;

CREATE TRIGGER products_search_sync
  AFTER INSERT OR UPDATE OF name, brand_id, category_id, size, page_count, gsm, binding, attributes, search_aliases, sku, barcode
  ON products
  FOR EACH ROW EXECUTE FUNCTION products_refresh_search();

CREATE FUNCTION brands_refresh_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_search(ARRAY(SELECT id FROM products WHERE brand_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER brands_product_search
  AFTER UPDATE OF name ON brands
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION brands_refresh_product_search();

CREATE FUNCTION categories_refresh_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_search(ARRAY(SELECT id FROM products WHERE category_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER expense_categories_product_search
  AFTER UPDATE OF name ON expense_categories
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION categories_refresh_product_search();

CREATE FUNCTION suppliers_refresh_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_product_search(ARRAY(SELECT product_id FROM product_suppliers WHERE supplier_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER suppliers_product_search
  AFTER UPDATE OF name ON suppliers
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION suppliers_refresh_product_search();

CREATE FUNCTION product_suppliers_refresh_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_product_search(ARRAY[OLD.product_id]);
  ELSE
    PERFORM refresh_product_search(ARRAY[NEW.product_id]);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER product_suppliers_search
  AFTER INSERT OR DELETE OR UPDATE OF supplier_id ON product_suppliers
  FOR EACH ROW EXECUTE FUNCTION product_suppliers_refresh_search();


-- 5. Excel import staging -------------------------------------------------------------------------
-- Only the block the user selected is stored (never the rest of the workbook). Raw cells are kept
-- exactly as read, with their original sheet row numbers.

CREATE TABLE product_import_batches (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name           text         NOT NULL,
  file_sha256         bytea        NOT NULL,
  sheet_name          text         NOT NULL,
  -- Selected block, e.g. "A1:E109", and the header row inside it.
  block_range         text         NOT NULL,
  header_row          integer      NOT NULL,
  -- { columns: { "<letter>": "<field>" }, sectionRows: boolean }
  mapping             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- Explicitly confirmed parsing rules (nothing is inferred without one).
  value_rules         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- New-brand approvals: { "<normalised source name>": { "action": "create", "name": ... } | { "action": "existing", "brandId": ... } }
  brand_decisions     jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- { "<section>": "<category id>" }
  section_categories  jsonb        NOT NULL DEFAULT '{}'::jsonb,
  status              text         NOT NULL DEFAULT 'review',
  summary             jsonb,
  version             integer      NOT NULL DEFAULT 1,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  created_by          uuid         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by          uuid         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  committed_at        timestamptz,
  committed_by        uuid         REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT product_import_batches_file_name_valid CHECK (length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT product_import_batches_sha_valid CHECK (octet_length(file_sha256) = 32),
  CONSTRAINT product_import_batches_sheet_valid CHECK (length(sheet_name) BETWEEN 1 AND 100),
  CONSTRAINT product_import_batches_range_valid CHECK (block_range ~ '^[A-Z]{1,3}[0-9]{1,7}:[A-Z]{1,3}[0-9]{1,7}$'),
  CONSTRAINT product_import_batches_header_valid CHECK (header_row >= 1),
  CONSTRAINT product_import_batches_status_valid CHECK (status IN ('review', 'committed', 'discarded')),
  CONSTRAINT product_import_batches_commit_valid CHECK (
    (status = 'committed') = (committed_at IS NOT NULL) AND (committed_at IS NULL) = (committed_by IS NULL)),
  CONSTRAINT product_import_batches_version_positive CHECK (version >= 1)
);

CREATE INDEX product_import_batches_created_idx ON product_import_batches (created_at DESC);

CREATE TRIGGER product_import_batches_set_updated_at
  BEFORE UPDATE ON product_import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER product_import_batches_no_delete
  BEFORE DELETE ON product_import_batches
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

CREATE TABLE product_import_rows (
  batch_id            uuid      NOT NULL REFERENCES product_import_batches (id) ON DELETE RESTRICT,
  -- Original sheet row number; split_index > 0 for rows the user split into several products.
  row_number          integer   NOT NULL,
  split_index         smallint  NOT NULL DEFAULT 0,
  section             text,
  -- { "<column letter>": { "t": "<cell type>", "v": <value as read> } }, never modified.
  raw                 jsonb     NOT NULL,
  -- What the importer derived from the raw cells and the batch's confirmed rules.
  proposal            jsonb     NOT NULL DEFAULT '{}'::jsonb,
  -- Explicit per-row edits by the user (win over the proposal).
  overrides           jsonb     NOT NULL DEFAULT '{}'::jsonb,
  issues              jsonb     NOT NULL DEFAULT '[]'::jsonb,
  grp                 text      NOT NULL DEFAULT 'error',
  decision            text      NOT NULL DEFAULT 'pending',
  duplicate_of        integer,
  matched_product_id  uuid      REFERENCES products (id) ON DELETE RESTRICT,
  result_product_id   uuid      REFERENCES products (id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, row_number, split_index),
  CONSTRAINT product_import_rows_row_valid CHECK (row_number >= 1 AND split_index >= 0),
  CONSTRAINT product_import_rows_group_valid CHECK (grp IN ('new', 'update', 'duplicate', 'error')),
  CONSTRAINT product_import_rows_decision_valid CHECK (decision IN ('pending', 'create', 'update', 'skip'))
);


-- 6. Audit, access events and idempotency ---------------------------------------------------------
-- product          create/update/archive/reactivate + supplier link events (no purchase prices)
-- product_cost     default and supplier purchase prices (entity_id = product id; shown only to
--                  users allowed to see purchase prices)
-- product_import   create/commit/discard of an import batch

ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  DROP CONSTRAINT financial_audit_action_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN (
    'expense', 'expense_category', 'supplier', 'supplier_payment', 'customer', 'customer_transaction',
    'report_settings', 'report_recipient', 'report_job', 'report_delivery', 'brand', 'salesman',
    'product', 'product_cost', 'product_import')),
  ADD CONSTRAINT financial_audit_action_valid CHECK (action IN (
    'create', 'update', 'void', 'restore', 'archive', 'reactivate', 'link_category', 'unlink_category', 'import',
    'document_add', 'document_remove', 'reverse', 'allocate', 'release_allocation', 'retry',
    'link_brand', 'unlink_brand',
    'link_supplier', 'unlink_supplier', 'update_supplier_link', 'commit', 'discard'));

-- Managers' purchase-price reveals (an access trail: no prices are recorded).
ALTER TABLE auth_events
  DROP CONSTRAINT auth_events_type_valid,
  ADD CONSTRAINT auth_events_type_valid CHECK (event_type IN (
    'owner_bootstrapped', 'login_success', 'login_failure', 'login_rate_limited', 'account_locked',
    'logout', 'password_changed', 'password_reset', 'user_created', 'user_updated',
    'user_activated', 'user_deactivated', 'sessions_revoked', 'purchase_prices_viewed'));

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_operation_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_operation_check
  CHECK (operation IN ('expense.create', 'supplier_payment.create', 'supplier_payment.allocate',
                       'customer_transaction.create', 'customer_due.settle_all', 'product.create'));
