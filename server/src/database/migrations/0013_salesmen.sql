-- 0013_salesmen
--
-- Salesmen: a standalone directory of people (name, phone, notes). Deliberately NOT linked to any
-- other table: there are no sales, orders, commissions or targets in Shop-Books. A salesman is
-- deactivated (is_active = false), never deleted, so history stays readable. Every change is
-- recorded in financial_audit_events (entity_type 'salesman') in the same transaction.
-- No existing table or row is changed (except the audit entity CHECK list).

CREATE TABLE salesmen (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  phone       text,
  notes       text,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT salesmen_name_valid CHECK (
    name = btrim(regexp_replace(name, '\s+', ' ', 'g')) AND length(name) BETWEEN 1 AND 120),
  CONSTRAINT salesmen_phone_valid CHECK (phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()-]{4,18}[0-9]$'),
  CONSTRAINT salesmen_notes_valid CHECK (
    notes IS NULL OR (notes = btrim(notes) AND length(notes) BETWEEN 1 AND 1000)),
  CONSTRAINT salesmen_version_positive CHECK (version >= 1)
);

-- Names may repeat (two people can share a name).
CREATE INDEX salesmen_name_idx ON salesmen (lower(name));

CREATE TRIGGER salesmen_set_updated_at
  BEFORE UPDATE ON salesmen
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deactivate instead of deleting, so history is preserved.
CREATE TRIGGER salesmen_no_delete
  BEFORE DELETE ON salesmen
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN (
    'expense', 'expense_category', 'supplier', 'supplier_payment', 'customer', 'customer_transaction',
    'report_settings', 'report_recipient', 'report_job', 'report_delivery', 'brand', 'salesman'));
