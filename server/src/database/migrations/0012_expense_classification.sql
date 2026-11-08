-- 0012_expense_classification
--
-- Classification metadata for expenses: several categories and several brands per expense, plus
-- brands as their own master data with per-supplier defaults.
--
--   brands                  master data (manufacturers), independent of suppliers and categories
--   supplier_brands         supplier <-> brand defaults (like the existing supplier_categories)
--   expense_category_links  expense <-> category, ordered; position 1 is the PRIMARY category
--   expense_brands          expense <-> brand, ordered
--
-- Money is NOT allocated to categories or brands. They are labels on the expense, never extra
-- expenditure: an expense is counted once in every total. Category amounts in reports stay
-- attributed to the primary category only (expenses.category_id, unchanged), so category totals
-- still add up to the expense total. expenses.category_id is kept as the primary category and must
-- always equal the position-1 link (deferred constraint trigger below).
--
-- Existing data: every expense gets exactly one category link (its current category, position 1).
-- No existing row is changed or deleted. Supplier defaults (supplier_categories / supplier_brands)
-- are only defaults for NEW expenses: changing them never touches saved expenses.

-- 1. Brands ---------------------------------------------------------------------------------------

CREATE TABLE brands (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT brands_name_valid CHECK (
    name = btrim(regexp_replace(name, '\s+', ' ', 'g')) AND length(name) BETWEEN 1 AND 80)
);

-- Case-insensitive uniqueness among ACTIVE brands (an archived name may be reused), like categories.
CREATE UNIQUE INDEX brands_active_name_unique ON brands (lower(name)) WHERE is_active;

CREATE TRIGGER brands_set_updated_at
  BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Brands are archived, never deleted (expenses keep referring to them).
CREATE TRIGGER brands_no_delete
  BEFORE DELETE ON brands
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();


-- 2. Supplier <-> brand defaults ------------------------------------------------------------------

CREATE TABLE supplier_brands (
  supplier_id  uuid        NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  brand_id     uuid        NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  PRIMARY KEY (supplier_id, brand_id)
);

CREATE INDEX supplier_brands_brand_idx ON supplier_brands (brand_id);


-- 3. Expense <-> categories -----------------------------------------------------------------------

CREATE TABLE expense_category_links (
  expense_id   uuid        NOT NULL REFERENCES expenses (id) ON DELETE RESTRICT,
  category_id  uuid        NOT NULL REFERENCES expense_categories (id) ON DELETE RESTRICT,
  -- Order chosen by the user; 1 = primary (mirrored on expenses.category_id).
  position     smallint    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (expense_id, category_id),
  CONSTRAINT expense_category_links_position_valid CHECK (position >= 1),
  CONSTRAINT expense_category_links_position_unique UNIQUE (expense_id, position)
);

CREATE INDEX expense_category_links_category_idx ON expense_category_links (category_id);

INSERT INTO expense_category_links (expense_id, category_id, position)
SELECT id, category_id, 1 FROM expenses;


-- 4. Expense <-> brands ---------------------------------------------------------------------------

CREATE TABLE expense_brands (
  expense_id  uuid        NOT NULL REFERENCES expenses (id) ON DELETE RESTRICT,
  brand_id    uuid        NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  position    smallint    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (expense_id, brand_id),
  CONSTRAINT expense_brands_position_valid CHECK (position >= 1),
  CONSTRAINT expense_brands_position_unique UNIQUE (expense_id, position)
);

CREATE INDEX expense_brands_brand_idx ON expense_brands (brand_id);


-- 5. The primary category and the position-1 link always agree.
--
--    a) Writers that do not know about links (the previous application version while a deployment
--       is in progress, manual data fixes) only set expenses.category_id: this trigger keeps the
--       primary link in step, so they keep working. The current application rewrites all links
--       right after, in the same transaction.
CREATE FUNCTION sync_expense_primary_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM expense_category_links
              WHERE expense_id = NEW.id AND position = 1 AND category_id = NEW.category_id) THEN
    RETURN NULL;
  END IF;
  DELETE FROM expense_category_links WHERE expense_id = NEW.id AND (position = 1 OR category_id = NEW.category_id);
  INSERT INTO expense_category_links (expense_id, category_id, position) VALUES (NEW.id, NEW.category_id, 1);
  RETURN NULL;
END;
$$;

CREATE TRIGGER expenses_sync_primary_category
  AFTER INSERT OR UPDATE OF category_id ON expenses
  FOR EACH ROW EXECUTE FUNCTION sync_expense_primary_category();

--    b) Backstop, checked at COMMIT (so a transaction may rewrite the expense and its links in
--       any order): the position-1 link must equal expenses.category_id.

CREATE FUNCTION check_expense_primary_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eid      uuid;
  primary_ uuid;
  linked   uuid;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    eid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    eid := OLD.expense_id;
  ELSE
    eid := NEW.expense_id;
  END IF;
  SELECT category_id INTO primary_ FROM expenses WHERE id = eid;
  IF primary_ IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT category_id INTO linked FROM expense_category_links WHERE expense_id = eid AND position = 1;
  IF linked IS DISTINCT FROM primary_ THEN
    RAISE EXCEPTION 'the first category of an expense must be its primary category (expense %)', eid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER expenses_check_primary_category
  AFTER INSERT OR UPDATE OF category_id ON expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_expense_primary_category();

CREATE CONSTRAINT TRIGGER expense_category_links_check_primary
  AFTER INSERT OR UPDATE OR DELETE ON expense_category_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_expense_primary_category();


-- 6. Audit: brands, and supplier <-> brand default links --------------------------------------------

ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  DROP CONSTRAINT financial_audit_action_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN (
    'expense', 'expense_category', 'supplier', 'supplier_payment', 'customer', 'customer_transaction',
    'report_settings', 'report_recipient', 'report_job', 'report_delivery', 'brand')),
  ADD CONSTRAINT financial_audit_action_valid CHECK (action IN (
    'create', 'update', 'void', 'restore', 'archive', 'reactivate', 'link_category', 'unlink_category', 'import',
    'document_add', 'document_remove', 'reverse', 'allocate', 'release_allocation', 'retry',
    'link_brand', 'unlink_brand'));
