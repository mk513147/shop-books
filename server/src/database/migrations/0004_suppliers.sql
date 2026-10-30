-- 0004_suppliers
--
-- Suppliers, supplier <-> category suggestions, expenses.supplier_id (with a cautious backfill from
-- the free-text supplier names entered so far), and server-side idempotency for expense creation.
--
-- Backfill rule (deliberately conservative): two entered names are treated as the same supplier ONLY
-- when they are identical after trimming, collapsing runs of whitespace to one space and ignoring
-- letter case ("Sharma  Traders" = "sharma traders"). Anything else ("Sharma Traders." vs
-- "Sharma Traders", "AK Traders" vs "A.K. Traders") becomes a separate supplier, to be reviewed by
-- the owner (`npm run suppliers:backfill-report` lists likely duplicates). The text originally typed
-- on each expense is kept unchanged in expenses.legacy_supplier_name; every mapping is recorded in
-- supplier_backfill_log. The migration aborts (and rolls back completely) if any named expense
-- would be left unlinked.

-- 1. Suppliers ------------------------------------------------------------------------------------

CREATE TABLE suppliers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  -- Primary contact number. Several contacts per supplier will be a separate supplier_contacts
  -- table later; this column then stays as the main number.
  phone       text,
  address     text,
  notes       text,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  -- Names are stored trimmed with single spaces, so case-insensitive uniqueness is meaningful.
  CONSTRAINT suppliers_name_valid CHECK (
    name = btrim(regexp_replace(name, '\s+', ' ', 'g')) AND length(name) BETWEEN 1 AND 120),
  CONSTRAINT suppliers_phone_valid CHECK (phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()-]{4,18}[0-9]$'),
  CONSTRAINT suppliers_address_valid CHECK (
    address IS NULL OR (address = btrim(address) AND length(address) BETWEEN 1 AND 300)),
  CONSTRAINT suppliers_notes_valid CHECK (
    notes IS NULL OR (notes = btrim(notes) AND length(notes) BETWEEN 1 AND 1000)),
  CONSTRAINT suppliers_version_positive CHECK (version >= 1)
);

-- Case-insensitive uniqueness among ACTIVE suppliers (an archived name may be reused).
CREATE UNIQUE INDEX suppliers_active_name_unique ON suppliers (lower(name)) WHERE is_active;

CREATE TRIGGER suppliers_set_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- 2. Supplier <-> category suggestions (many-to-many) ------------------------------------------
-- Categories stay global. A link only drives suggestions in the expense form; it never restricts
-- which category an expense may use, and removing a link never touches existing expenses.

CREATE TABLE supplier_categories (
  supplier_id  uuid        NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  category_id  uuid        NOT NULL REFERENCES expense_categories (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  PRIMARY KEY (supplier_id, category_id)
);

CREATE INDEX supplier_categories_category_idx ON supplier_categories (category_id);


-- 3. Expenses: supplier_id + the as-entered name kept as history -------------------------------

ALTER TABLE expenses RENAME COLUMN supplier_name TO legacy_supplier_name;
ALTER TABLE expenses RENAME CONSTRAINT expenses_supplier_valid TO expenses_legacy_supplier_valid;
COMMENT ON COLUMN expenses.legacy_supplier_name IS
  'Supplier name exactly as typed before suppliers existed (migration 0004). Read-only history; never written by the application.';

ALTER TABLE expenses ADD COLUMN supplier_id uuid REFERENCES suppliers (id) ON DELETE RESTRICT;
CREATE INDEX expenses_supplier_idx ON expenses (supplier_id);


-- 4. Backfill ------------------------------------------------------------------------------------

-- Permanent record of how each distinct entered name was mapped.
CREATE TABLE supplier_backfill_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_name  text        NOT NULL,
  supplier_id    uuid        NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  supplier_name  text        NOT NULL,
  expense_count  integer     NOT NULL,
  -- exact: the entered text is the supplier's name; normalised: merged by case/whitespace only.
  match_rule     text        NOT NULL CHECK (match_rule IN ('exact', 'normalised')),
  migrated_at    timestamptz NOT NULL DEFAULT now()
);

-- One supplier per normalisation key. Its name is the most frequently used spelling (whitespace
-- tidied), ties going to the earliest-recorded one. created_by is whoever first recorded the name.
WITH named AS (
  SELECT e.id, e.created_at, e.created_by,
         btrim(regexp_replace(e.legacy_supplier_name, '\s+', ' ', 'g')) AS cleaned
    FROM expenses e
   WHERE e.legacy_supplier_name IS NOT NULL
),
spellings AS (
  SELECT lower(cleaned) AS match_key, cleaned, count(*) AS uses, min(created_at) AS first_used
    FROM named
   GROUP BY lower(cleaned), cleaned
),
chosen AS (
  SELECT DISTINCT ON (match_key) match_key, cleaned AS name
    FROM spellings
   ORDER BY match_key, uses DESC, first_used, cleaned
),
first_recorder AS (
  SELECT DISTINCT ON (lower(cleaned)) lower(cleaned) AS match_key, created_by
    FROM named
   ORDER BY lower(cleaned), created_at, id
)
INSERT INTO suppliers (name, created_by, updated_by)
SELECT c.name, f.created_by, f.created_by
  FROM chosen c JOIN first_recorder f USING (match_key);

-- Linking must not look like a user edit: keep updated_at/version as they were.
ALTER TABLE expenses DISABLE TRIGGER expenses_set_updated_at;

UPDATE expenses e
   SET supplier_id = s.id
  FROM suppliers s
 WHERE e.legacy_supplier_name IS NOT NULL
   AND lower(btrim(regexp_replace(e.legacy_supplier_name, '\s+', ' ', 'g'))) = lower(s.name);

ALTER TABLE expenses ENABLE TRIGGER expenses_set_updated_at;

INSERT INTO supplier_backfill_log (original_name, supplier_id, supplier_name, expense_count, match_rule)
SELECT e.legacy_supplier_name, s.id, s.name, count(*)::int,
       CASE WHEN e.legacy_supplier_name = s.name THEN 'exact' ELSE 'normalised' END
  FROM expenses e
  JOIN suppliers s ON s.id = e.supplier_id
 GROUP BY e.legacy_supplier_name, s.id, s.name
 ORDER BY s.name, e.legacy_supplier_name;

-- Never silently drop supplier information.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM expenses WHERE legacy_supplier_name IS NOT NULL AND supplier_id IS NULL) THEN
    RAISE EXCEPTION 'supplier backfill would leave expenses without a supplier; migration aborted';
  END IF;
END
$$;


-- 5. Financial audit: suppliers, category links and the one-off import -------------------------

-- 'import' rows are written only by this migration: no user performed them, so actor is NULL.
ALTER TABLE financial_audit_events ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  DROP CONSTRAINT financial_audit_action_valid,
  DROP CONSTRAINT financial_audit_before_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN ('expense', 'expense_category', 'supplier')),
  ADD CONSTRAINT financial_audit_action_valid CHECK (action IN (
    'create', 'update', 'void', 'restore', 'archive', 'reactivate', 'link_category', 'unlink_category', 'import')),
  ADD CONSTRAINT financial_audit_before_valid CHECK ((action IN ('create', 'import')) = (before_values IS NULL)),
  ADD CONSTRAINT financial_audit_actor_valid CHECK ((action = 'import') = (actor_user_id IS NULL));

INSERT INTO financial_audit_events (entity_type, entity_id, action, actor_user_id, before_values, after_values)
SELECT 'supplier', s.id, 'import', NULL, NULL,
       jsonb_build_object('name', s.name, 'phone', NULL, 'address', NULL, 'notes', NULL, 'isActive', true,
                          'source', 'Created from supplier names on existing expenses (migration 0004)')
  FROM suppliers s;


-- 6. Idempotency for expense creation ----------------------------------------------------------
-- Only successful creations are stored (a failed request rolls back and leaves no key). Keys are
-- scoped per user and operation. Retention: see docs/maintenance.md (30 days, manual cleanup).

CREATE TABLE idempotency_keys (
  user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  operation        text        NOT NULL CHECK (operation IN ('expense.create')),
  key              text        NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,100}$'),
  -- SHA-256 of the normalised request body: same key + different body = 409.
  request_hash     bytea       NOT NULL CHECK (octet_length(request_hash) = 32),
  response_status  smallint    NOT NULL,
  response_body    jsonb       NOT NULL,
  resource_id      uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
