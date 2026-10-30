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
| `.env.development` | `NODE_ENV` unset/`development` | `postgresql://shop_books_app:…@localhost:5432/shop_books_dev` |
| `.env.test` | `NODE_ENV=test` (automated tests) | `postgresql://shop_books_app:…@localhost:5432/shop_books_test` |
| real environment variables | production | provided by the host |

URL-encode special characters in passwords (`@` → `%40`, etc.).

## Test-database isolation

Tests never touch development or production data:

- With `NODE_ENV=test` the app **refuses to start** unless the database name ends in `_test`; conversely a `_test` database is refused in any other environment.
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
npm --prefix server run db:migrate:built -- --yes     # --yes is mandatory in production
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

### `0002_auth` tables

**`users`**: `id uuid` PK; `email citext` UNIQUE (case-insensitive) with a format check; `name` (1–100 chars); `role` (`owner` \| `manager`); `password_hash` (must be an Argon2id PHC string; there is no plain-password column); `must_change_password`; `is_active`; lockout state (`failed_login_count`, `lockout_count`, `locked_until`); `last_login_at`, `password_changed_at`, `created_by`, `created_at`, `updated_at` (trigger). Constraints worth knowing:
- `users_single_owner`: unique partial index, so the database itself refuses a second owner, even under concurrent inserts.
- `users_owner_active`: the owner row can never be inactive, so there is always an active owner.

**`sessions`**: `id uuid` PK; `user_id` → `users` (cascade); `token_hash bytea` UNIQUE, exactly 32 bytes (SHA-256 of the cookie token; the token itself is never stored); `created_at`, `last_seen_at` (idle timeout), `absolute_expires_at`; `revoked_at` + `revoked_reason` (both set or both null; reason from a fixed list); `ip inet`, `user_agent`. Partial index on live sessions per user.

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

- **Outstanding is not stored**: always `amount - amount_paid`, computed in SQL.
- **No deletes**: a `BEFORE DELETE` trigger rejects deleting expenses; void instead.
- No document/bill columns (documents will be a separate table).
- Indexes: date (+created_at), category, created_by, and a partial index on active rows by date.
- **Suppliers**: added by `0004` (below).
- **Future supplier payments**: `amount_paid` is the simplified "paid at purchase" amount. Supplier payments and allocations will be separate tables; when introduced, outstanding becomes `amount - amount_paid - allocated payments`, and existing rows keep their meaning (no rewrite of history needed).

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

Supplier payments, ledgers and customer schemas are not implemented.

## Creating the owner account

After migrating, create the single owner once (interactive; the password is not echoed):

```powershell
npm run owner:create
```

It refuses to run against an unmigrated database and refuses if an owner already exists. Against production, build first and use `$env:NODE_ENV="production"; npm --prefix server run owner:create:built`.
