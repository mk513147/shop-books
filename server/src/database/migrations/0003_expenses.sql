-- 0003_expenses
--
-- Stage 3A: expense categories, expenses and the append-only financial audit log.
-- No document/bill columns (documents get their own table later) and no suppliers table yet.
-- Money is NUMERIC(14,2). Outstanding (amount - amount_paid) is always derived, never stored.

CREATE TABLE expense_categories (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Users are deactivated, never deleted, so RESTRICT protects the attribution.
  created_by   uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by   uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT expense_categories_name_valid CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  CONSTRAINT expense_categories_description_valid CHECK (
    description IS NULL OR (description = btrim(description) AND length(description) BETWEEN 1 AND 500))
);

-- Case-insensitive uniqueness among ACTIVE categories (an archived name may be reused).
CREATE UNIQUE INDEX expense_categories_active_name_unique
  ON expense_categories (lower(name)) WHERE is_active;

CREATE TRIGGER expense_categories_set_updated_at
  BEFORE UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE expenses (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date       date          NOT NULL,
  -- Free text until suppliers exist. A later migration adds a nullable supplier_id FK to the
  -- suppliers table and backfills it; supplier_name then remains as the as-entered label.
  supplier_name      text,
  -- Categories are never deleted while referenced (RESTRICT); archiving keeps the link intact.
  category_id        uuid          NOT NULL REFERENCES expense_categories (id) ON DELETE RESTRICT,
  description        text          NOT NULL,
  amount             numeric(14,2) NOT NULL,
  -- Simplified Stage 3A model: payment recorded directly on the expense ("paid at purchase").
  -- Future supplier payments/allocations will be separate tables; this column stays as the
  -- historical at-purchase payment, so existing records keep their meaning.
  amount_paid        numeric(14,2) NOT NULL DEFAULT 0,
  payment_mode       text,
  invoice_reference  text,
  version            integer       NOT NULL DEFAULT 1,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  created_by         uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by         uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  voided_at          timestamptz,
  voided_by          uuid          REFERENCES users (id) ON DELETE RESTRICT,
  void_reason        text,

  CONSTRAINT expenses_date_range        CHECK (expense_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  CONSTRAINT expenses_supplier_valid    CHECK (supplier_name IS NULL OR (supplier_name = btrim(supplier_name) AND length(supplier_name) BETWEEN 1 AND 120)),
  CONSTRAINT expenses_description_valid CHECK (description = btrim(description) AND length(description) BETWEEN 1 AND 500),
  CONSTRAINT expenses_amount_positive   CHECK (amount > 0),
  CONSTRAINT expenses_paid_non_negative CHECK (amount_paid >= 0),
  CONSTRAINT expenses_paid_within_amount CHECK (amount_paid <= amount),
  CONSTRAINT expenses_payment_mode_valid CHECK (
    payment_mode IS NULL OR payment_mode IN ('cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other')),
  -- A payment mode is required whenever something was paid; an unpaid (credit) expense may omit it.
  CONSTRAINT expenses_payment_mode_when_paid CHECK (amount_paid = 0 OR payment_mode IS NOT NULL),
  CONSTRAINT expenses_invoice_valid     CHECK (invoice_reference IS NULL OR (invoice_reference = btrim(invoice_reference) AND length(invoice_reference) BETWEEN 1 AND 100)),
  CONSTRAINT expenses_version_positive  CHECK (version >= 1),
  CONSTRAINT expenses_void_consistent   CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
    (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL
       AND void_reason = btrim(void_reason) AND length(void_reason) BETWEEN 1 AND 500))
);

CREATE INDEX expenses_date_idx        ON expenses (expense_date DESC, created_at DESC);
CREATE INDEX expenses_category_idx    ON expenses (category_id);
CREATE INDEX expenses_created_by_idx  ON expenses (created_by);
CREATE INDEX expenses_active_date_idx ON expenses (expense_date) WHERE voided_at IS NULL;

CREATE TRIGGER expenses_set_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Financial records are never physically deleted (void instead).
CREATE FUNCTION prevent_expense_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'expenses are never deleted; void the expense instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER expenses_no_delete
  BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION prevent_expense_delete();


-- Append-only history of financial changes (separate from auth_events).
CREATE TABLE financial_audit_events (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  entity_type    text        NOT NULL,
  entity_id      uuid        NOT NULL,
  action         text        NOT NULL,
  actor_user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reason         text,
  -- Snapshots of the business fields only (never secrets). NULL before a create.
  before_values  jsonb,
  after_values   jsonb       NOT NULL,

  CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN ('expense', 'expense_category')),
  CONSTRAINT financial_audit_action_valid CHECK (action IN ('create', 'update', 'void', 'restore', 'archive', 'reactivate')),
  CONSTRAINT financial_audit_before_valid CHECK ((action = 'create') = (before_values IS NULL)),
  CONSTRAINT financial_audit_reason_valid CHECK (
    (action IN ('void', 'restore') AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500)
    OR (action NOT IN ('void', 'restore') AND reason IS NULL))
);

CREATE INDEX financial_audit_entity_idx ON financial_audit_events (entity_type, entity_id, occurred_at, id);

-- Enforce append-only at the database level: no UPDATE or DELETE of audit rows.
CREATE FUNCTION prevent_audit_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_audit_events is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER financial_audit_events_append_only
  BEFORE UPDATE OR DELETE ON financial_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();
