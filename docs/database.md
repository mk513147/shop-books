# Database

PostgreSQL, accessed with the `pg` package and **handwritten SQL migrations**. No ORM.

## Setup

1. Install PostgreSQL (the project was verified against PostgreSQL 18; 14+ should work).
2. Create a role and **two separate databases** – one for development and one for tests:

```sql
CREATE ROLE shop_books_app LOGIN PASSWORD 'choose-a-strong-password';
CREATE DATABASE shop_books_dev  OWNER shop_books_app;
CREATE DATABASE shop_books_test OWNER shop_books_app;
```

   On Windows, `psql` is in `C:\Program Files\PostgreSQL\<version>\bin` (not on PATH by default):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost
```

3. Put the connection strings in the environment files (gitignored; see [development-setup.md](development-setup.md)):

| File | Used when | `DATABASE_URL` |
|---|---|---|
| `.env.development` | `NODE_ENV` unset/`development` (`npm run dev:server`) | `postgresql://shop_books_app:…@localhost:5432/shop_books_dev` |
| `.env.staging` | `SHOP_BOOKS_ENV_FILE=.env.staging` (tunnel profile for the Vercel site / phones) | the **same** `…/shop_books_dev` |
| `.env.test` | `NODE_ENV=test` (automated tests) | `postgresql://shop_books_app:…@localhost:5432/shop_books_test` |
| real environment variables | production | provided by the host |

## Databases and what may touch them

There are exactly **two local databases**:

| Database | Purpose | Data |
|---|---|---|
| `shop_books_dev` | Development and **all manual testing** (browser, phone, via the tunnel profile) | **Persistent.** No automated test, script or reset utility may truncate, drop or reset it. |
| `shop_books_test` | **Automated server integration tests only** | **Disposable.** Every test run truncates its tables (users, expenses, payments, audit history…). Never keep anything you need in it, and never point any other environment at it. |

- **Production** will use its own hosted PostgreSQL database, configured only on the host. Nothing in this repository points at it.
- **There is no staging database.** Manual acceptance testing happens on `shop_books_dev` (see [staging-deployment.md](staging-deployment.md)). A separate staging database can be added later: name it with `staging` in the name (e.g. `shop_books_staging`); the guards below then already treat it as protected (only `NODE_ENV=production`, explicit `--confirm-database` for changes).
- Back up `shop_books_dev` before applying migrations to it:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U shop_books_app -h localhost -Fc --no-owner -d shop_books_dev -f "D:\ShopBooksBackups\shop_books_dev_<date>.dump"
# restore into an EMPTY database only: pg_restore.exe -U shop_books_app -h localhost --no-owner -d <empty database> <file>
```

URL-encode special characters in passwords (`@` → `%40`, etc.).

## Test-database isolation

Tests never touch development or production data. `NODE_ENV=test` alone is **not** relied on; the actual database name is checked:

- **Hard guard (tests):** `server/tests/setup.ts` runs before every test file and aborts the run unless the resolved `DATABASE_URL` reaches **exactly** `shop_books_test` (`DESIGNATED_TEST_DATABASE` in `server/src/database/isolation.ts`) on **localhost / 127.0.0.1 / ::1**, whichever way it was set (`.env.test` or the shell). The URL may only carry harmless query parameters (`sslmode`, `application_name`, `connect_timeout`): the pg driver applies every query parameter, so `?host=`, `?port=`, `?user=`, `?options=` … could redirect the connection and are refused. Unparseable URLs, socket or empty hosts and unreadable database names are refused too (fail closed). It also refuses `SHOP_BOOKS_ENV_FILE` (other than `.env.test`), so the tests can never inherit `.env.development` or `.env.staging`.
- **Live check:** every integration test gets its pool from `connectTestDatabase()`, which repeats the URL check and asks the server for `current_database()` and `inet_server_addr()`; it throws (rather than skipping) unless the database is `shop_books_test` on a loopback address (or a local socket). All `TRUNCATE`/`DROP SCHEMA` statements in the tests run through that pool, or through a pool on the same already-checked URL. There are no reset utilities outside the tests.
- With `NODE_ENV=test` the app **refuses to start** unless the database name ends in `_test`; conversely a `_test` database is refused in any other environment.
- A database whose name contains `staging` or `prod` is refused unless `NODE_ENV=production` (so neither tests nor development can open it).
- **Changing commands** (`db:migrate`, `documents:reconcile --delete-orphans`): only `NODE_ENV=development` on the local `shop_books_dev` and `NODE_ENV=test` on the local `shop_books_test` run without confirmation. Any remote host (whatever `NODE_ENV` says), production mode, and any other or protected name need `--confirm-database=<exact name>`, compared with the live `current_database()`. An unknown host, a redirecting query parameter, or a server that reports a different database than the URL fails closed — a confirmation cannot override that.
- The server test runner sets `NODE_ENV=test` and loads only `.env.test`.
- The migration runner re-checks `current_database()` against `NODE_ENV` on every call (`db:status`, `db:migrate`, and the programmatic `runMigrations` / `getMigrationStatus`), whatever pool it was handed, and refuses before reading or changing anything.
- If no test database is reachable, the PostgreSQL integration tests are **skipped** (reported as skipped, never passed).
- Migration-runner tests run inside a throw-away schema that is dropped afterwards.

## Migration runner

Source: `server/src/database/migrator.ts` (CLI: `cli.ts`).

```powershell
npm run db:status      # read-only: lists applied and pending migrations
npm run db:migrate     # applies pending migrations in order
```

Production (after building, `npm run build`):

```powershell
$env:NODE_ENV = "production"
npm --prefix server run db:status:built
npm --prefix server run db:migrate:built -- --yes --confirm-database=<database name>   # both mandatory in production
```

To migrate the test database: `$env:NODE_ENV = "test"; npm run db:migrate`.

Behaviour:

- Applied migrations are recorded in `schema_migrations(version, name, checksum, applied_at)`, created by the runner.
- Each migration runs in **its own transaction together with its history row**; on failure it is rolled back completely, the error names the file, and later migrations are not attempted. The command exits non-zero.
- A **PostgreSQL advisory lock** serializes concurrent runners, so a migration cannot be applied twice. It is released in a `finally` block; if the release cannot be confirmed, the connection is destroyed rather than returned to the pool.
- The runner stops with an error if an **applied migration file was edited** (SHA-256 checksum, line-ending-insensitive), is **missing**, or a pending migration is **older than one already applied**.
- `db:status` never creates or changes anything.
- The API **never** migrates on start-up.

## Migration conventions

- Files live in `server/src/database/migrations/` and are named `NNNN_snake_case_description.sql` (e.g. `0002_create_users.sql`). `NNNN` is a unique, zero-padded, ever-increasing version.
- **Never edit a migration that has been applied anywhere**; add a new one.
- Do not put `BEGIN`/`COMMIT` in a migration (the runner wraps it). Statements that cannot run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`) are not supported by this runner.
- Money columns `NUMERIC(14,2)`; instants `TIMESTAMPTZ`; calendar dates `DATE`.
- Attach the shared trigger to tables with an `updated_at` column:
  `CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at();`
- Parameterize every query in application code.
- Financial tables must be designed for history preservation (void/reverse rather than delete) and transactional audit logging.

## Current migrations

| Version | Purpose |
|---|---|
| `0001_initial_infrastructure` | `citext` extension and the shared `set_updated_at()` trigger function. |
| `0002_auth` | `users`, `sessions`, `auth_events` (Stage 2). |
| `0003_expenses` | `expense_categories`, `expenses`, `financial_audit_events` (Stage 3A). |
| `0004_suppliers` | `suppliers`, `supplier_categories`, `expenses.supplier_id` + backfill from typed names, `supplier_backfill_log`, audit extensions, `idempotency_keys` (Stage 3A enhancement). |
| `0005_expense_documents` | `expense_documents` (bill photo/PDF metadata), audit actions `document_add`/`document_remove` (Stage 3B). |
| `0006_supplier_payments` | `supplier_payments`, `supplier_payment_allocations`, view `supplier_balances`, integrity triggers, audit + idempotency extensions (Stage 3C). |
| `0007_customers` | `customers`, `customer_transactions`, view `customer_balances`, ledger triggers, audit + idempotency extensions (Stage 3D). |
| `0008_reporting_indexes` | four indexes for the dashboard and reports (Stage 4). |
| `0009_monthly_reports` | `report_settings`, `report_recipients`, `report_jobs`, `report_deliveries`, `report_delivery_attempts`, audit extensions (Stage 5). |
| `0010_expense_payments` | `expense_payments` (several payment methods per expense), optional description. |
| `0011_document_upload_queue` | `document_upload_queue` (bill documents waiting for the desktop storage agent). |
| `0012_expense_classification` | `brands`, `supplier_brands`, `expense_category_links` (several categories per expense; backfilled), `expense_brands`; audit extensions. |
| `0013_salesmen` | `salesmen` (standalone directory); audit entity `salesman`. |

### `0002_auth` tables

**`users`**: `id uuid` PK; `email citext` UNIQUE (case-insensitive) with a format check; `name` (1–100 chars); `role` (`owner` \| `manager`); `password_hash` (must be an Argon2id PHC string; there is no plain-password column); `must_change_password`; `is_active`; lockout state (`failed_login_count`, `lockout_count`, `locked_until`); `last_login_at`, `password_changed_at`, `created_by`, `created_at`, `updated_at` (trigger). Constraints worth knowing:
- `users_single_owner`: unique partial index, so the database itself refuses a second owner, even under concurrent inserts.
- `users_owner_active`: the owner row can never be inactive, so there is always an active owner.

**`sessions`**: `id uuid` PK; `user_id` → `users` (cascade); `token_hash bytea` UNIQUE, exactly 32 bytes (SHA-256 of the cookie token; the token itself is never stored); `created_at`, `last_seen_at` (idle timeout, 30 days), `absolute_expires_at` (rolling expiry: 30 days ahead of the last renewal, never beyond `created_at` + 90 days); `revoked_at` + `revoked_reason` (both set or both null; reason from a fixed list); `ip inet`, `user_agent`. Partial index on live sessions per user.

**`auth_events`**: append-only access log: `event_type` (fixed list), `user_id`, `actor_user_id`, `email_attempted`, `ip`, `user_agent`, `details jsonb`, `created_at`. Indexed per user and for per-IP failure counting. Never contains passwords, hashes or tokens. *(Retention policy not decided yet; see testing plan / open decisions.)*

### `0003_expenses` tables

**`expense_categories`**: `id uuid` PK; `name` (1–80, trimmed); optional `description` (≤ 500); `is_active`; `created_at/by`, `updated_at/by`.
- `expense_categories_active_name_unique`: unique on `lower(name)` **among active categories only**, so names are case-insensitively unique, and an archived name can be reused.
- Global: not tied to suppliers. Never deleted while referenced (`expenses.category_id` is `ON DELETE RESTRICT`); archive instead.

**`expenses`**:

| Column | Notes |
|---|---|
| `id` | `uuid` PK |
| `expense_date` | `DATE` (calendar date, Asia/Kolkata business day), 2000-01-01 – 2100-12-31; the API also rejects future dates |
| `supplier_name` → **`legacy_supplier_name`** (renamed in 0004) | free text typed before suppliers existed (≤ 120); read-only history, never written by the application after 0004 |
| `supplier_id` (0004) | nullable → `suppliers`, `RESTRICT`; the supplier of new and edited expenses |
| `category_id` | → `expense_categories`, `RESTRICT` |
| `description` | 1–500 |
| `amount` | `NUMERIC(14,2)`, `> 0` |
| `amount_paid` | `NUMERIC(14,2)`, `>= 0`, `<= amount` (CHECK) |
| `payment_mode` | `cash`/`upi`/`bank_transfer`/`card`/`cheque`/`other`; **required when `amount_paid > 0`**, may be NULL for an unpaid (credit) expense |
| `invoice_reference` | optional (≤ 100) |
| `version` | optimistic-concurrency counter, `+1` on every change |
| `created_*`, `updated_*` | who/when |
| `voided_at`, `voided_by`, `void_reason` | all NULL (active) or all set (voided); reason 1–500 |

- **Outstanding is not stored**: computed in SQL as `amount - amount_paid - active supplier-payment allocations` (allocations since 0006; before any are recorded this equals `amount - amount_paid`).
- **No deletes**: a `BEFORE DELETE` trigger rejects deleting expenses; void instead.
- No document/bill columns (documents will be a separate table).
- Indexes: date (+created_at), category, created_by, and a partial index on active rows by date.
- **Suppliers**: added by `0004` (below).
- **Supplier payments** (0006): `amount_paid` remains the "paid at purchase" amount. Later payments live in `supplier_payments` and settle bills through `supplier_payment_allocations`; existing rows keep their meaning (no rewrite of history).
- **Expense payment allocations** (0010): `expense_payments` holds one row per payment method of an expense (`expense_id`, `position`, `payment_mode`, `amount > 0`). `amount_paid` stays the paid-at-purchase total and a deferred constraint trigger requires it to equal the sum of the allocations; `payment_mode` mirrors the first allocation. These are **not** supplier payments. Existing paid expenses were backfilled with one allocation each. `expenses.description` became optional (NULL when empty). Rollback (only before multi-method data matters): drop both `*_check_*total` triggers, the function `check_expense_payments_total`, the table `expense_payments`, and restore `description NOT NULL` once no NULL descriptions exist.

**`financial_audit_events`**: append-only history of financial changes (separate from `auth_events`).
- `entity_type` (`expense`, `expense_category`), `entity_id`, `action` (`create`, `update`, `void`, `restore`, `archive`, `reactivate`), `actor_user_id`, `occurred_at`, `reason` (required for void/restore, otherwise NULL), `before_values` (NULL only for create), `after_values` (JSONB snapshots of business fields only: never secrets).
- **Append-only at the database level**: a trigger rejects every `UPDATE` and `DELETE`. (`TRUNCATE` is a DBA-only operation outside the application and is used by the test suite to reset the test database.)
- Written by the application in the **same transaction** as the change it records.

### `0004_suppliers`

**`suppliers`**: `id`, `name` (1–120, trimmed, single spaces), `phone` (optional, digits/space/`+-()`, 6–20), `address` (≤ 300), `notes` (≤ 1000), `is_active`, `version` (optimistic concurrency), `created_*`, `updated_*` (trigger).
- `suppliers_active_name_unique`: unique on `lower(name)` among **active** suppliers.
- Never deleted while referenced (`expenses.supplier_id … RESTRICT`); archive instead.
- Multiple contacts per supplier later: a `supplier_contacts` table; `phone` stays the primary number.

**`supplier_categories`**: many-to-many suggestions. `PRIMARY KEY (supplier_id, category_id)` (no duplicates), `created_at`, `created_by`; both FKs `RESTRICT`; index on `category_id`. Categories remain global records. Rows are added/removed by the API (each change is audited); removing a link never changes expenses.

**`expenses`**: `supplier_name` renamed to `legacy_supplier_name`; new nullable `supplier_id` with index.

**Backfill of existing expenses** (runs inside the migration's transaction):
1. Each typed name is normalised to *trim + collapse whitespace*; names whose normalised form is equal **ignoring case** are treated as one supplier. Nothing looser is merged (`Sharma Traders.` ≠ `Sharma Traders`, `A.K. Traders` ≠ `AK Traders`); those become separate suppliers for the owner to review.
2. One supplier per group: its name is the most-used spelling (ties → earliest recorded); `created_by` is the user who first recorded that name.
3. Every expense with a typed name gets `supplier_id`. The trigger that sets `updated_at` is disabled for this update, so `updated_at`/`version` are unchanged (linking is not a user edit). The typed text stays in `legacy_supplier_name`.
4. `supplier_backfill_log` records every distinct typed name → supplier, expense count and rule (`exact` / `normalised`).
5. The migration **aborts and rolls back** if any expense with a typed name is left without a supplier.
6. Each created supplier gets one `import` audit event (actor NULL, "System (data migration)").

Review the result with `npm run suppliers:backfill-report` (read-only): mappings, unlinked count (must be 0), and active suppliers whose names differ only in punctuation/spacing/case (possible duplicates, *not* merged). To merge two duplicates: edit their expenses to the supplier you keep, then archive the other.

**`financial_audit_events`** (altered): `entity_type` adds `supplier`; `action` adds `link_category`, `unlink_category`, `import`; `actor_user_id` is nullable **only** for `import` (`financial_audit_actor_valid`); `before_values` is NULL for `create` and `import`. Existing rows are untouched; still append-only.

**`idempotency_keys`**: `PRIMARY KEY (user_id, operation, key)`; `operation` (`expense.create`), `key` (16–100 of `A-Za-z0-9_-`), `request_hash` (SHA-256 of the normalised body), `response_status`, `response_body` (jsonb), `resource_id`, `created_at` (indexed). Only successful creations are stored, in the same transaction as the expense. Retention: [maintenance.md](maintenance.md).

### `0005_expense_documents` (Stage 3B)

Purely additive: creates one table and widens two audit CHECK constraints. **No existing row is read or changed**, so it is safe on a database with data; the only lock taken on existing tables is the brief `ALTER TABLE financial_audit_events` constraint swap (validated against existing rows, which all satisfy the wider rule). Rollback before any document was uploaded: `DROP TABLE expense_documents; DROP FUNCTION prevent_expense_document_delete(), enforce_expense_document_limit();`, restore the two 0004 constraints, delete the `schema_migrations` row. After documents exist, roll forward instead (fix with a new migration).

**`expense_documents`**: metadata only; the bytes live in document storage ([architecture.md → Bill documents](architecture.md#bill-documents-stage-3b)).

| Column | Notes |
|---|---|
| `id` | `uuid` PK |
| `expense_id` | → `expenses`, `RESTRICT`; indexed with `created_at` |
| `original_filename` | display only: trimmed, 1–255 chars, no control characters or slashes |
| `storage_key` | server-generated, UNIQUE, `^[a-z0-9]+(/[a-z0-9]+)*$` |
| `mime_type` | detected from content: `image/jpeg`, `image/png`, `image/webp`, `application/pdf` |
| `size_bytes` | 1 – 10 485 760 (10 MB) |
| `sha256` | 32 bytes; integrity check and duplicate detection |
| `status` | `active` | `removed` |
| `uploaded_by`, `created_at` | who/when |
| `removed_at`, `removed_by`, `remove_reason` | all NULL while active; all set (reason 1–500) once removed |

- `expense_documents_active_sha_unique`: the same file (SHA-256) can be active only once per expense.
- `expense_documents_no_delete` trigger: rows are never deleted (remove = status change).
- `expense_documents_limit` trigger: at most 10 **active** documents per expense (backstop; the application checks it under a lock on the expense row).
- `financial_audit_events`: actions `document_add` and `document_remove` (recorded on `entity_type = 'expense'`); `reason` is required for `document_remove` as for void/restore.

### `0006_supplier_payments` (Stage 3C)

Additive; **no existing row is changed**. It adds a `BEFORE UPDATE` trigger on `expenses` (`expenses_guard_allocations`) that only acts when an expense has active allocations, so existing expenses behave exactly as before until payments are allocated to them. Existing expenses keep their meaning: payable = `amount − amount_paid` until allocations exist. Constraint swaps on `financial_audit_events` and `idempotency_keys` are validated against existing rows (all satisfy the wider rules). Rollback is only safe before any payment is recorded: drop the trigger `expenses_guard_allocations`, the view, both tables and the functions `prevent_financial_delete`, `guard_supplier_payment_update`, `guard_allocation_update`, `check_allocation_insert`, `check_payment_reversal`, `guard_allocated_expense`; restore the 0005 audit and 0004 idempotency constraints; delete the `schema_migrations` row. Afterwards, roll forward.

**`supplier_payments`**: `id`, `supplier_id` (→ suppliers, RESTRICT), `payment_date` (2000–2100; API: not in the future), `amount` NUMERIC(14,2) > 0, `payment_mode` (same six modes as expenses, required), `reference` (≤ 100), `notes` (≤ 1000), `version`, `created_*`, `updated_*` (trigger), `reversed_at/by`, `reversal_reason` (all NULL or all set, reason 1–500). Indexes: (supplier, date), (date).
- `supplier_payments_guard_update`: amount and supplier immutable; reversal final.
- `supplier_payments_check_reversal` (deferred constraint trigger): a reversed payment cannot keep active allocations.
- `supplier_payments_no_delete`.

**`supplier_payment_allocations`**: `id`, `payment_id` (→ payments), `expense_id` (→ expenses), `amount` > 0, `created_at/by`, `released_at/by`, `release_reason` (all NULL or all set). Indexes: (payment, created_at); partial (expense) where active.
- `supplier_payment_allocations_check_insert`: payment not reversed, expense not voided, same supplier, Σ active per payment ≤ payment amount, Σ active per expense ≤ `amount − amount_paid`.
- `supplier_payment_allocations_guard_update`: the only permitted change is releasing once.
- `supplier_payment_allocations_no_delete`.

**`expenses_guard_allocations`** (on `expenses`): with active allocations, an expense cannot be voided, change supplier, or have `amount − amount_paid` below the allocated total.

**View `supplier_balances`**: per supplier `total_bills`, `paid_at_purchase`, `total_payments`, `allocated`, `payable`, `unallocated`, `bill_count`, `payment_count` (active rows only). Derived on every read; nothing to rebuild.

**`financial_audit_events`**: entity `supplier_payment`; actions `reverse`, `allocate`, `release_allocation` (reason required for `reverse` and `release_allocation`).
**`idempotency_keys.operation`**: adds `supplier_payment.create`, `supplier_payment.allocate`.

### `0007_customers` (Stage 3D)

Additive; no existing row is changed (only the audit entity list and idempotency operation list are widened). Depends on `prevent_financial_delete()` from 0006, so **0006 must be applied first** (the runner enforces order). Rollback before any customer exists: drop the view, both tables and `guard_customer_txn_update`, `check_customer_ledger`; restore the 0006 audit/idempotency constraints; delete the `schema_migrations` row. Afterwards, roll forward.

**`customers`**: `id`, `name` (1–120, trimmed, single spaces; may repeat), `phone` (optional, same format as suppliers), `phone_key` (generated: last 10 digits), `address` (≤ 300), `notes` (≤ 1000), `is_active`, `version`, `created_*`, `updated_*` (trigger). `customers_active_phone_unique` (one active customer per phone key); index on `lower(name)`; `customers_no_delete`.

**`customer_transactions`**: `id`, `customer_id` (→ customers), `txn_type` (`due`, `due_payment`, `advance`, `advance_refund`), `txn_date` (2000–2100; API: not in the future), `amount` NUMERIC(14,2) > 0, `payment_mode` (NULL exactly for `due`), `due_id` (→ customer_transactions; set exactly for `due_payment`), `description` (required for `due`, ≤ 500), `reference` (≤ 100), `notes` (≤ 1000), `version`, `created_*`, `updated_*`, `reversed_at/by`, `reversal_reason` (all NULL or all set). Indexes: (customer, date, created_at); (due_id).
- `customer_transactions_guard_update`: recorded values immutable; the only change is a single, final reversal.
- `customer_transactions_check_ledger` (deferred constraint trigger, at commit): a due payment settles a due of the same customer that is not reversed; Σ active payments per due ≤ due amount; a reversed due keeps no active payments; active advances − active refunds ≥ 0.
- `customer_transactions_no_delete`.

**View `customer_balances`**: per customer `total_dues`, `due_payments`, `due_balance`, `total_advances`, `refunds`, `advance_balance`, `transaction_count` (active rows only). No cached balance exists, so nothing needs rebuilding.

**`financial_audit_events`**: entities `customer`, `customer_transaction`. **`idempotency_keys.operation`**: adds `customer_transaction.create`.

### Migration order and verification

`0001` → `0002` → `0003` → `0004` → `0005` → `0006` → `0007` → `0008` → `0009` → `0010` → `0011` → `0012` → `0013`.

**Status on 2026-11-02 (verified with `db:status` / `schema_migrations`):** `shop_books_dev` and `shop_books_test` both have 0001–0010. 0010 was applied to `shop_books_dev` after a backup (`D:\ShopBooksBackups\shop_books_dev_before_0010_2026-11-02_214312.dump`); a row-by-row comparison showed every existing table unchanged apart from the new `schema_migrations` row and the backfilled `expense_payments` rows. No production database exists yet.

History of the earlier migrations: 0005–0009 were applied (via `runMigrations`, the same code as `npm run db:migrate`) to the **test** database `shop_books_test` by the integration tests, which also exercise every trigger above. An upgrade test (`server/tests/migrations.upgrade.integration.test.ts`) builds a 0004 database **with data** (suppliers, paid/unpaid/voided expenses, audit rows, idempotency keys) in a throw-away schema, applies 0005–0009 and checks that every existing row of `expenses`, `suppliers`, `financial_audit_events` and `idempotency_keys` is byte-for-byte unchanged, that `supplier_balances` equals `amount − amount_paid` over active bills, that existing expenses stay editable/voidable, and that re-running is a no-op. They were later applied to the development database (2026-11-01); never to a production database. Before production: back up, apply to a **copy** of the real database first, then run `npm run db:status`, `npm run documents:reconcile`, and spot-check supplier payables (`SELECT * FROM supplier_balances`), which should equal `amount − amount_paid` per supplier until payments are recorded.

### `0011_document_upload_queue`

Additive; no existing row changes. `document_upload_queue (document_id PK → expense_documents, content bytea ≤ 10 MB, queued_at, attempts, last_attempt_at, last_error)` holds bill documents uploaded while the document storage (desktop agent) was unreachable, written in the same transaction as their `expense_documents` row. A `BEFORE INSERT OR UPDATE` trigger requires the bytes to match the document's `size_bytes` and `sha256` and forbids changing them. Rows are deleted only after the storage confirmed delivery (the document row is never deleted). Applied so far only to `shop_books_test` (by the test suite). Rollback when the queue is empty: drop the trigger, `check_document_upload_queue()` and the table.

### `0012_expense_classification`

Additive; no existing row is changed or deleted (verified by the upgrade test, which also checks the backfill). Categories and brands are **labels**: no money is allocated to them, and an expense is counted once in every total.

| Table | Purpose and constraints |
|---|---|
| `brands` | master data (manufacturers): `name` (trimmed, single spaces, 1–80), `is_active`, `created/updated_*`; `brands_active_name_unique` (case-insensitive among active brands, like categories); never deleted (trigger) |
| `supplier_brands` | supplier ⇄ brand **defaults** (PK `(supplier_id, brand_id)`), the counterpart of the existing `supplier_categories` (reused, not duplicated) |
| `expense_category_links` | expense ⇄ category, ordered: PK `(expense_id, category_id)` (no duplicates), `position ≥ 1` unique per expense. **Backfill:** every existing expense gets its current `category_id` at position 1 |
| `expense_brands` | expense ⇄ brand, ordered: PK `(expense_id, brand_id)`, `position` unique per expense |

- `expenses.category_id` is kept as the **primary** category (the first one selected). A deferred constraint trigger (`check_expense_primary_category`, on `expenses` and `expense_category_links`) requires the position-1 link to equal it at commit, so old code paths and reports that read `category_id` stay correct.
- Category reports attribute each expense's amount to its primary category only (`amount`/`count`), so category amounts add up to the expense total; `taggedCount` counts expenses carrying the category in any position. Category/brand **filters** match any position with `EXISTS` (one row per expense).
- Supplier defaults only pre-select categories/brands on **new** expenses in the web form; the links saved on an expense never follow later default changes. Archived brands/categories are never newly linked or auto-selected; existing links stay.
- Audit: entity `brand`; actions `link_brand`/`unlink_brand` (on the supplier). Expense snapshots now also carry `categories` and `brands` (names, in order).
- Rollback (only before multi-category data matters): drop the two constraint triggers and `check_expense_primary_category()`, the four tables, and restore the 0009 audit CHECK lists.

### `0013_salesmen`

Additive. `salesmen (name 1–120, phone (same rule as suppliers), notes ≤ 1000, is_active, version, created/updated_*)`; names may repeat; never deleted (trigger); audit entity `salesman`. A standalone directory: **no link to any other table** (no sales, orders, commissions or targets). Rollback: drop the table and restore the 0012 audit entity list.

**Status:** 0012 and 0013 have been applied only to `shop_books_test` (by the automated tests). Apply to `shop_books_dev` / production with the normal procedure (backup first, `db:status`, `db:migrate`), then spot-check that `SELECT count(*) FROM expenses` equals `SELECT count(*) FROM expense_category_links`.

### `0014_customer_due_categories`

Additive, backward compatible. `customer_transactions` gets two nullable columns, only ever set on new rows: `category_id → expense_categories` (dues only; CHECK) and `settlement_id uuid` (due payments created together by "Pay full outstanding"; CHECK). The due rule becomes "description **or** category" (existing dues all have a description, so they stay valid). The immutability trigger now also covers both columns. Indexes on both (partial). The idempotency operation list gains `customer_due.settle_all`. No existing row is changed. Rollback (only before any new due was recorded with a category): drop the columns and indexes and restore the 0007 constraint, trigger function and idempotency list.

**Status:** 0014 has been applied only to `shop_books_test` (by the automated tests). Apply to dev/production with the normal procedure (backup first, `db:status`, `db:migrate`).

### `0008_reporting_indexes` (Stage 4)

Indexes only; no data or constraint changes: `expenses_created_at_idx`, `supplier_payments_created_at_idx`, `customer_txn_created_at_idx` (`created_at DESC`, for the "recently recorded" feed) and `customer_txn_active_date_idx` (`(txn_date, txn_type) WHERE reversed_at IS NULL`, for period activity across customers). Plain `CREATE INDEX` (the runner uses a transaction), which briefly blocks writes to those tables while building — negligible at shop scale. Rollback: drop the four indexes.

### `0009_monthly_reports` (Stage 5)

Additive; existing rows unchanged except the audit entity/action CHECK lists (validated against existing rows). Inserts the single default `report_settings` row (**disabled**). Rollback before any report was sent: drop the five tables and `guard_report_delivery_update()`, restore the 0007 audit constraints, delete the `schema_migrations` row.

| Table | Purpose and constraints |
|---|---|
| `report_settings` | one row (`id = true`): `enabled` (default false), `delivery_day` 1–28, `delivery_time` (whole minutes, Asia/Kolkata), `include_excel`, `version`, `updated_at/by` |
| `report_recipients` | `email citext` (format check, ≤ 254), `name`, `is_active`, `version`, `created/updated_*`; `report_recipients_active_email_unique` (one ACTIVE row per address, case-insensitive); never deleted (deactivate) |
| `report_jobs` | one per reporting month: `period_start` **UNIQUE** (first of month), `period_end` (last day; CHECKed), `scheduled_for`, `trigger` (`schedule`/`manual`; manual ⇔ `created_by`), `include_excel` snapshot |
| `report_deliveries` | one per job + recipient (**UNIQUE `(job_id, recipient_email)`**): `status` (`pending`, `processing`, `sent`, `simulated`, `retry_scheduled`, `failed`), `attempt_count`, `next_attempt_at`, `locked_at` (set ⇔ processing), `last_attempt_at`, `sent_at` (set ⇔ sent/simulated), `provider`, `provider_message_id`, `last_error` (≤ 1000). Index on due rows. Trigger: `sent`/`simulated` are final; job and recipient are fixed |
| `report_delivery_attempts` | append-only (trigger) log: `attempt_number` (UNIQUE per delivery), `started_at`, `finished_at`, `outcome` (`sent`, `simulated`, `retryable_failure`, `failed`, `interrupted`), provider reference, error. Never contains message content |

`financial_audit_events`: entities `report_settings` (fixed id `00000000-0000-0000-0000-000000000001`), `report_recipient`, `report_job`, `report_delivery`; action `retry`.

## Creating the owner account

After migrating, create the single owner once (interactive; the password is not echoed):

```powershell
npm run owner:create
```

It refuses to run against an unmigrated database and refuses if an owner already exists. Against production, build first and use `$env:NODE_ENV="production"; npm --prefix server run owner:create:built`.

