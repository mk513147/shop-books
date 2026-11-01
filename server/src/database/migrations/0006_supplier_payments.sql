-- 0006_supplier_payments
--
-- Stage 3C: supplier payments, their allocation to supplier bills (expenses), and derived balances.
--
-- A supplier payment is NOT an expense: it never adds to expense totals. It settles bills:
--
--   bill payable      = expenses.amount - expenses.amount_paid (paid at purchase) - active allocations
--   supplier payable  = sum of bill payable over the supplier's ACTIVE (not voided) expenses
--   unallocated       = active payments - active allocations
--
-- Nothing is stored as an editable balance: `supplier_balances` is a VIEW over the source rows.
-- Payments are never deleted (reverse instead); allocations are never deleted or changed (release
-- instead). The application enforces every rule under row locks; the triggers below are the
-- database-level backstop so no code path can create an inconsistent ledger.
--
-- Existing data: no existing row is changed. Existing expenses simply have no allocations, so their
-- payable is unchanged (amount - amount_paid).

-- 1. Payments -------------------------------------------------------------------------------------

CREATE TABLE supplier_payments (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id      uuid          NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  payment_date     date          NOT NULL,
  amount           numeric(14,2) NOT NULL,
  payment_mode     text          NOT NULL,
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

  CONSTRAINT supplier_payments_date_range CHECK (payment_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  CONSTRAINT supplier_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT supplier_payments_mode_valid CHECK (
    payment_mode IN ('cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other')),
  CONSTRAINT supplier_payments_reference_valid CHECK (
    reference IS NULL OR (reference = btrim(reference) AND length(reference) BETWEEN 1 AND 100)),
  CONSTRAINT supplier_payments_notes_valid CHECK (
    notes IS NULL OR (notes = btrim(notes) AND length(notes) BETWEEN 1 AND 1000)),
  CONSTRAINT supplier_payments_version_positive CHECK (version >= 1),
  CONSTRAINT supplier_payments_reversal_consistent CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL) OR
    (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL
       AND reversal_reason = btrim(reversal_reason) AND length(reversal_reason) BETWEEN 1 AND 500))
);

CREATE INDEX supplier_payments_supplier_idx ON supplier_payments (supplier_id, payment_date DESC, created_at DESC);
CREATE INDEX supplier_payments_date_idx ON supplier_payments (payment_date DESC, created_at DESC);

CREATE TRIGGER supplier_payments_set_updated_at
  BEFORE UPDATE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION prevent_financial_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted; reverse or release them instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER supplier_payments_no_delete
  BEFORE DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

-- Amount and supplier are fixed once recorded (corrections = reverse + record again), and a
-- reversal is final.
CREATE FUNCTION guard_supplier_payment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.supplier_id <> OLD.supplier_id THEN
    RAISE EXCEPTION 'supplier payment amount and supplier cannot be changed; reverse the payment instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND (NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
       OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason) THEN
    RAISE EXCEPTION 'a reversed supplier payment cannot be un-reversed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_payments_guard_update
  BEFORE UPDATE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION guard_supplier_payment_update();


-- 2. Allocations ----------------------------------------------------------------------------------

CREATE TABLE supplier_payment_allocations (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid          NOT NULL REFERENCES supplier_payments (id) ON DELETE RESTRICT,
  expense_id      uuid          NOT NULL REFERENCES expenses (id) ON DELETE RESTRICT,
  amount          numeric(14,2) NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  created_by      uuid          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Released = no longer counts (wrong allocation corrected, or the payment was reversed).
  released_at     timestamptz,
  released_by     uuid          REFERENCES users (id) ON DELETE RESTRICT,
  release_reason  text,

  CONSTRAINT supplier_allocations_amount_positive CHECK (amount > 0),
  CONSTRAINT supplier_allocations_release_consistent CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL) OR
    (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL
       AND release_reason = btrim(release_reason) AND length(release_reason) BETWEEN 1 AND 500))
);

CREATE INDEX supplier_allocations_payment_idx ON supplier_payment_allocations (payment_id, created_at);
CREATE INDEX supplier_allocations_expense_active_idx ON supplier_payment_allocations (expense_id) WHERE released_at IS NULL;

CREATE TRIGGER supplier_payment_allocations_no_delete
  BEFORE DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

-- The only permitted change to an allocation is releasing it, once.
CREATE FUNCTION guard_allocation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_id <> OLD.payment_id OR NEW.expense_id <> OLD.expense_id OR NEW.amount <> OLD.amount
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
     OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'allocations are immutable; they can only be released once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_payment_allocations_guard_update
  BEFORE UPDATE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_allocation_update();

-- A new allocation: payment active, bill active, same supplier, and neither the payment nor the
-- bill becomes over-allocated. (The application locks payment then bills FOR UPDATE first, so
-- these sums are stable; this is the backstop.)
CREATE FUNCTION check_allocation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p supplier_payments%ROWTYPE;
  e expenses%ROWTYPE;
BEGIN
  SELECT * INTO p FROM supplier_payments WHERE id = NEW.payment_id;
  SELECT * INTO e FROM expenses WHERE id = NEW.expense_id;
  IF NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new allocation cannot already be released' USING ERRCODE = 'check_violation';
  END IF;
  IF p.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot allocate a reversed payment' USING ERRCODE = 'check_violation';
  END IF;
  IF e.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot allocate to a voided expense' USING ERRCODE = 'check_violation';
  END IF;
  IF e.supplier_id IS DISTINCT FROM p.supplier_id THEN
    RAISE EXCEPTION 'payment and expense belong to different suppliers' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT sum(amount) FROM supplier_payment_allocations WHERE payment_id = NEW.payment_id AND released_at IS NULL) > p.amount THEN
    RAISE EXCEPTION 'allocations exceed the payment amount' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT sum(amount) FROM supplier_payment_allocations WHERE expense_id = NEW.expense_id AND released_at IS NULL)
       > e.amount - e.amount_paid THEN
    RAISE EXCEPTION 'allocations exceed the amount payable on the expense' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER supplier_payment_allocations_check_insert
  AFTER INSERT ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION check_allocation_insert();

-- A reversed payment cannot keep active allocations (they must be released in the same transaction).
CREATE FUNCTION check_payment_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reversed_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM supplier_payment_allocations WHERE payment_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'release all allocations before reversing a payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_payments_check_reversal
  AFTER UPDATE ON supplier_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_payment_reversal();

-- Expenses with active allocations cannot be voided, moved to another supplier, or reduced below
-- what is already allocated + paid at purchase.
CREATE FUNCTION guard_allocated_expense() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated numeric;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO allocated
    FROM supplier_payment_allocations WHERE expense_id = NEW.id AND released_at IS NULL;
  IF allocated = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'expense has supplier payment allocations; release them before voiding'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    RAISE EXCEPTION 'expense has supplier payment allocations; its supplier cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount - NEW.amount_paid < allocated THEN
    RAISE EXCEPTION 'expense amount would be less than paid at purchase plus allocated payments'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expenses_guard_allocations
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_allocated_expense();


-- 3. Derived balances -----------------------------------------------------------------------------

CREATE VIEW supplier_balances AS
SELECT s.id AS supplier_id,
       COALESCE(b.bills, 0)::numeric(20,2)                                   AS total_bills,
       COALESCE(b.paid_at_purchase, 0)::numeric(20,2)                        AS paid_at_purchase,
       COALESCE(p.payments, 0)::numeric(20,2)                                AS total_payments,
       COALESCE(a.allocated, 0)::numeric(20,2)                               AS allocated,
       (COALESCE(b.bills, 0) - COALESCE(b.paid_at_purchase, 0) - COALESCE(a.allocated, 0))::numeric(20,2) AS payable,
       (COALESCE(p.payments, 0) - COALESCE(a.allocated, 0))::numeric(20,2)  AS unallocated,
       COALESCE(b.bill_count, 0)::int                                        AS bill_count,
       COALESCE(p.payment_count, 0)::int                                     AS payment_count
  FROM suppliers s
  LEFT JOIN (SELECT supplier_id, sum(amount) AS bills, sum(amount_paid) AS paid_at_purchase, count(*) AS bill_count
               FROM expenses WHERE voided_at IS NULL AND supplier_id IS NOT NULL GROUP BY supplier_id) b
         ON b.supplier_id = s.id
  LEFT JOIN (SELECT supplier_id, sum(amount) AS payments, count(*) AS payment_count
               FROM supplier_payments WHERE reversed_at IS NULL GROUP BY supplier_id) p
         ON p.supplier_id = s.id
  LEFT JOIN (SELECT sp.supplier_id, sum(al.amount) AS allocated
               FROM supplier_payment_allocations al
               JOIN supplier_payments sp ON sp.id = al.payment_id
              WHERE al.released_at IS NULL AND sp.reversed_at IS NULL
              GROUP BY sp.supplier_id) a
         ON a.supplier_id = s.id;

COMMENT ON VIEW supplier_balances IS
  'Derived supplier balances (never stored). payable = active bills - paid at purchase - active allocations; unallocated = active payments - active allocations.';


-- 4. Audit and idempotency ------------------------------------------------------------------------

ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  DROP CONSTRAINT financial_audit_action_valid,
  DROP CONSTRAINT financial_audit_reason_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN (
    'expense', 'expense_category', 'supplier', 'supplier_payment')),
  ADD CONSTRAINT financial_audit_action_valid CHECK (action IN (
    'create', 'update', 'void', 'restore', 'archive', 'reactivate', 'link_category', 'unlink_category', 'import',
    'document_add', 'document_remove', 'reverse', 'allocate', 'release_allocation')),
  ADD CONSTRAINT financial_audit_reason_valid CHECK (
    (action IN ('void', 'restore', 'document_remove', 'reverse', 'release_allocation')
       AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500)
    OR (action NOT IN ('void', 'restore', 'document_remove', 'reverse', 'release_allocation') AND reason IS NULL));

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_operation_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_operation_check
  CHECK (operation IN ('expense.create', 'supplier_payment.create', 'supplier_payment.allocate'));
