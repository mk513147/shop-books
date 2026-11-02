-- 0010_expense_payments
--
-- 1. Expense payment allocations: one expense can be paid with several payment methods
--    (e.g. UPI 1000 + Cash 1500). expenses.amount stays the authoritative total;
--    expenses.amount_paid stays the paid-at-purchase total and MUST equal the sum of the
--    allocations (enforced below). These are NOT supplier payments (supplier_payments /
--    supplier_payment_allocations are unrelated and untouched).
-- 2. The expense description becomes optional (NULL when empty).

CREATE TABLE expense_payments (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Expenses are never deleted (trigger), so RESTRICT is only a safeguard.
  expense_id    uuid          NOT NULL REFERENCES expenses (id) ON DELETE RESTRICT,
  -- Order shown to the user; position 1 is the "primary" mode mirrored on expenses.payment_mode.
  position      smallint      NOT NULL,
  payment_mode  text          NOT NULL,
  amount        numeric(14,2) NOT NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT expense_payments_position_valid CHECK (position >= 1),
  CONSTRAINT expense_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT expense_payments_mode_valid CHECK (payment_mode IN ('cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other')),
  CONSTRAINT expense_payments_position_unique UNIQUE (expense_id, position)
);

CREATE INDEX expense_payments_mode_idx ON expense_payments (payment_mode);

-- Existing expenses: every expense with something paid at purchase becomes one allocation.
INSERT INTO expense_payments (expense_id, position, payment_mode, amount)
SELECT id, 1, payment_mode, amount_paid FROM expenses WHERE amount_paid > 0;

-- The allocations of an expense must add up exactly to its amount_paid. Deferred, so a
-- transaction may rewrite the expense and its allocations in any order and is checked at COMMIT.
CREATE FUNCTION check_expense_payments_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eid   uuid;
  paid  numeric;
  total numeric;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    eid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    eid := OLD.expense_id;
  ELSE
    eid := NEW.expense_id;
  END IF;
  SELECT amount_paid INTO paid FROM expenses WHERE id = eid;
  IF paid IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO total FROM expense_payments WHERE expense_id = eid;
  IF total <> paid THEN
    RAISE EXCEPTION 'payment allocations (%) must equal the amount paid on the expense (%)', total, paid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER expenses_check_payments_total
  AFTER INSERT OR UPDATE OF amount_paid ON expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_expense_payments_total();

CREATE CONSTRAINT TRIGGER expense_payments_check_total
  AFTER INSERT OR UPDATE OR DELETE ON expense_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_expense_payments_total();

-- Optional description: NULL when empty (same convention as the other optional text columns).
ALTER TABLE expenses
  ALTER COLUMN description DROP NOT NULL,
  DROP CONSTRAINT expenses_description_valid,
  ADD CONSTRAINT expenses_description_valid CHECK (
    description IS NULL OR (description = btrim(description) AND length(description) BETWEEN 1 AND 500));
