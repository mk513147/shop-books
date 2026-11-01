-- 0007_customers
--
-- Stage 3D: customers and a lightweight customer ledger of dues, due payments, advances and
-- advance refunds. NOT sales, orders, billing or inventory.
--
-- Two INDEPENDENT balances per customer, never netted against each other:
--
--   due balance      = active dues      - active payments against those dues
--   advance balance  = active advances  - active advance refunds
--
-- Both are derived (view `customer_balances`); nothing is stored as an editable balance.
-- Transactions are never deleted or edited: corrections are reversals (with a reason), after
-- which the entry stops counting and a corrected one can be recorded.
-- The application serialises every ledger write per customer (customer row FOR UPDATE); the
-- deferred triggers below are the database-level backstop.
-- No existing table or row is changed (except the audit/idempotency CHECK lists).

CREATE TABLE customers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  phone       text,
  -- Last 10 digits of the phone: "+91 98765 43210" and "09876543210" are the same number.
  phone_key   text        GENERATED ALWAYS AS (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)) STORED,
  address     text,
  notes       text,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT customers_name_valid CHECK (
    name = btrim(regexp_replace(name, '\s+', ' ', 'g')) AND length(name) BETWEEN 1 AND 120),
  CONSTRAINT customers_phone_valid CHECK (phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()-]{4,18}[0-9]$'),
  CONSTRAINT customers_address_valid CHECK (
    address IS NULL OR (address = btrim(address) AND length(address) BETWEEN 1 AND 300)),
  CONSTRAINT customers_notes_valid CHECK (
    notes IS NULL OR (notes = btrim(notes) AND length(notes) BETWEEN 1 AND 1000)),
  CONSTRAINT customers_version_positive CHECK (version >= 1)
);

-- Names may repeat (two customers can share a name); a phone number identifies one ACTIVE customer.
CREATE UNIQUE INDEX customers_active_phone_unique ON customers (phone_key) WHERE is_active AND phone IS NOT NULL;
CREATE INDEX customers_name_idx ON customers (lower(name));

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Customers are archived, never deleted (their history must stay).
CREATE TRIGGER customers_no_delete
  BEFORE DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();


CREATE TABLE customer_transactions (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid          NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  txn_type         text          NOT NULL,
  txn_date         date          NOT NULL,
  amount           numeric(14,2) NOT NULL,
  -- How money moved (payments, advances, refunds). A due moves no money, so it has none.
  payment_mode     text,
  -- due_payment only: the due it settles (same customer).
  due_id           uuid          REFERENCES customer_transactions (id) ON DELETE RESTRICT,
  description      text,
  reference        text,
  notes            text,
  version          integer       NOT NULL DEFAULT 1,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  created_by       uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by       uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reversed_at      timestamptz,
  reversed_by      uuid          REFERENCES users (id) ON DELETE RESTRICT,
  reversal_reason  text,

  CONSTRAINT customer_txn_type_valid CHECK (txn_type IN ('due', 'due_payment', 'advance', 'advance_refund')),
  CONSTRAINT customer_txn_date_range CHECK (txn_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  CONSTRAINT customer_txn_amount_positive CHECK (amount > 0),
  CONSTRAINT customer_txn_mode_valid CHECK (
    payment_mode IS NULL OR payment_mode IN ('cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other')),
  CONSTRAINT customer_txn_mode_required CHECK ((txn_type = 'due') = (payment_mode IS NULL)),
  CONSTRAINT customer_txn_due_link CHECK ((txn_type = 'due_payment') = (due_id IS NOT NULL)),
  CONSTRAINT customer_txn_due_description CHECK (txn_type <> 'due' OR description IS NOT NULL),
  CONSTRAINT customer_txn_description_valid CHECK (
    description IS NULL OR (description = btrim(description) AND length(description) BETWEEN 1 AND 500)),
  CONSTRAINT customer_txn_reference_valid CHECK (
    reference IS NULL OR (reference = btrim(reference) AND length(reference) BETWEEN 1 AND 100)),
  CONSTRAINT customer_txn_notes_valid CHECK (
    notes IS NULL OR (notes = btrim(notes) AND length(notes) BETWEEN 1 AND 1000)),
  CONSTRAINT customer_txn_version_positive CHECK (version >= 1),
  CONSTRAINT customer_txn_reversal_consistent CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL) OR
    (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL
       AND reversal_reason = btrim(reversal_reason) AND length(reversal_reason) BETWEEN 1 AND 500))
);

CREATE INDEX customer_txn_customer_idx ON customer_transactions (customer_id, txn_date, created_at);
CREATE INDEX customer_txn_due_idx ON customer_transactions (due_id) WHERE due_id IS NOT NULL;

CREATE TRIGGER customer_transactions_set_updated_at
  BEFORE UPDATE ON customer_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER customer_transactions_no_delete
  BEFORE DELETE ON customer_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

-- Recorded values are fixed; the only change is a (final) reversal.
CREATE FUNCTION guard_customer_txn_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.txn_type <> OLD.txn_type OR NEW.txn_date <> OLD.txn_date
     OR NEW.amount <> OLD.amount OR NEW.payment_mode IS DISTINCT FROM OLD.payment_mode
     OR NEW.due_id IS DISTINCT FROM OLD.due_id OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'customer transactions cannot be edited; reverse and record again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a reversed customer transaction cannot change again'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_transactions_guard_update
  BEFORE UPDATE ON customer_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_customer_txn_update();

-- Ledger invariants for the affected customer, checked at COMMIT.
CREATE FUNCTION check_customer_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d customer_transactions%ROWTYPE;
BEGIN
  IF NEW.txn_type = 'due_payment' THEN
    SELECT * INTO d FROM customer_transactions WHERE id = NEW.due_id;
    IF d.txn_type <> 'due' OR d.customer_id <> NEW.customer_id THEN
      RAISE EXCEPTION 'a due payment must settle a due of the same customer' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reversed_at IS NULL AND d.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot pay a reversed due' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- No due is paid beyond its amount; a reversed due keeps no active payments.
  IF EXISTS (
    SELECT 1
      FROM customer_transactions due
      JOIN customer_transactions pay ON pay.due_id = due.id AND pay.reversed_at IS NULL
     WHERE due.customer_id = NEW.customer_id
     GROUP BY due.id, due.amount, due.reversed_at
    HAVING sum(pay.amount) > due.amount OR due.reversed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'customer due payments exceed the due, or a reversed due still has payments'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Refunds never exceed advances received.
  IF (SELECT COALESCE(sum(CASE txn_type WHEN 'advance' THEN amount ELSE -amount END), 0)
        FROM customer_transactions
       WHERE customer_id = NEW.customer_id AND reversed_at IS NULL AND txn_type IN ('advance', 'advance_refund')) < 0 THEN
    RAISE EXCEPTION 'advance refunds exceed the advance received' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_transactions_check_ledger
  AFTER INSERT OR UPDATE ON customer_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_customer_ledger();


CREATE VIEW customer_balances AS
SELECT c.id AS customer_id,
       COALESCE(t.dues, 0)::numeric(20,2)                                    AS total_dues,
       COALESCE(t.due_payments, 0)::numeric(20,2)                            AS due_payments,
       (COALESCE(t.dues, 0) - COALESCE(t.due_payments, 0))::numeric(20,2)    AS due_balance,
       COALESCE(t.advances, 0)::numeric(20,2)                                AS total_advances,
       COALESCE(t.refunds, 0)::numeric(20,2)                                 AS refunds,
       (COALESCE(t.advances, 0) - COALESCE(t.refunds, 0))::numeric(20,2)     AS advance_balance,
       COALESCE(t.txn_count, 0)::int                                         AS transaction_count
  FROM customers c
  LEFT JOIN (
    SELECT customer_id,
           sum(amount) FILTER (WHERE txn_type = 'due' AND reversed_at IS NULL)            AS dues,
           sum(amount) FILTER (WHERE txn_type = 'due_payment' AND reversed_at IS NULL)    AS due_payments,
           sum(amount) FILTER (WHERE txn_type = 'advance' AND reversed_at IS NULL)        AS advances,
           sum(amount) FILTER (WHERE txn_type = 'advance_refund' AND reversed_at IS NULL) AS refunds,
           count(*)                                                                       AS txn_count
      FROM customer_transactions GROUP BY customer_id) t
    ON t.customer_id = c.id;

COMMENT ON VIEW customer_balances IS
  'Derived customer balances (never stored). Due and advance are independent and never netted.';


ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN (
    'expense', 'expense_category', 'supplier', 'supplier_payment', 'customer', 'customer_transaction'));

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_operation_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_operation_check
  CHECK (operation IN ('expense.create', 'supplier_payment.create', 'supplier_payment.allocate',
                       'customer_transaction.create'));
