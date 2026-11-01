-- 0008_reporting_indexes
--
-- Stage 4: indexes for the dashboard and reports. Indexes only: no table, row or constraint changes.
-- Each one supports a specific report query (reports.service.ts):
--
--  * recent activity feed: "latest N by created_at" per transaction table, merged;
--  * customer period activity (dashboard, monthly summary, customer reports): active entries by
--    business date (the existing index starts with customer_id, so it does not help cross-customer
--    date ranges).
--
-- Expense date ranges use the existing expenses_active_date_idx / expenses_date_idx and supplier
-- payment date ranges use supplier_payments_date_idx. Plain CREATE INDEX (the runner wraps each
-- migration in a transaction, so CONCURRENTLY is not available); tables are small for one shop.

CREATE INDEX expenses_created_at_idx ON expenses (created_at DESC);
CREATE INDEX supplier_payments_created_at_idx ON supplier_payments (created_at DESC);
CREATE INDEX customer_txn_created_at_idx ON customer_transactions (created_at DESC);
CREATE INDEX customer_txn_active_date_idx ON customer_transactions (txn_date, txn_type) WHERE reversed_at IS NULL;
