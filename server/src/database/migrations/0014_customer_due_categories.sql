-- 0014_customer_due_categories
--
-- 1. Customer dues get a CATEGORY (the existing expense_categories master list; no second list).
--    New dues are recorded with a category instead of a free-text description; notes stay optional.
--    Existing dues keep their description and have no category: nothing is backfilled or changed.
--    A due must have a description OR a category (old rows: description; new rows: category).
-- 2. "Pay full outstanding": one payment that settles several dues oldest-first is still stored as
--    one due_payment row per due (the ledger model is unchanged: every payment settles exactly one
--    due). Rows created together share a settlement_id so the history can show them as one payment.
--
-- Both columns are nullable and only ever set on new rows, so the previous application version
-- keeps working during a deployment. No existing row is updated or deleted.

ALTER TABLE customer_transactions
  ADD COLUMN category_id   uuid REFERENCES expense_categories (id) ON DELETE RESTRICT,
  ADD COLUMN settlement_id uuid;

ALTER TABLE customer_transactions
  DROP CONSTRAINT customer_txn_due_description,
  ADD CONSTRAINT customer_txn_due_description CHECK (txn_type <> 'due' OR description IS NOT NULL OR category_id IS NOT NULL),
  ADD CONSTRAINT customer_txn_category_only_dues CHECK (category_id IS NULL OR txn_type = 'due'),
  ADD CONSTRAINT customer_txn_settlement_only_payments CHECK (settlement_id IS NULL OR txn_type = 'due_payment');

CREATE INDEX customer_txn_category_idx ON customer_transactions (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX customer_txn_settlement_idx ON customer_transactions (settlement_id) WHERE settlement_id IS NOT NULL;

-- Recorded values stay fixed (the new columns too); the only change is a (final) reversal.
CREATE OR REPLACE FUNCTION guard_customer_txn_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.txn_type <> OLD.txn_type OR NEW.txn_date <> OLD.txn_date
     OR NEW.amount <> OLD.amount OR NEW.payment_mode IS DISTINCT FROM OLD.payment_mode
     OR NEW.due_id IS DISTINCT FROM OLD.due_id OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id THEN
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

-- Idempotency for the new "pay full outstanding" request.
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_operation_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_operation_check
  CHECK (operation IN ('expense.create', 'supplier_payment.create', 'supplier_payment.allocate',
                       'customer_transaction.create', 'customer_due.settle_all'));
