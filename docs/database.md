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
| `0002_auth` | `users`, `sessions`, `auth_events` (Stage 2). **No financial tables.** |

### `0002_auth` tables

**`users`**: `id uuid` PK; `email citext` UNIQUE (case-insensitive) with a format check; `name` (1–100 chars); `role` (`owner` \| `manager`); `password_hash` (must be an Argon2id PHC string; there is no plain-password column); `must_change_password`; `is_active`; lockout state (`failed_login_count`, `lockout_count`, `locked_until`); `last_login_at`, `password_changed_at`, `created_by`, `created_at`, `updated_at` (trigger). Constraints worth knowing:
- `users_single_owner`: unique partial index, so the database itself refuses a second owner, even under concurrent inserts.
- `users_owner_active`: the owner row can never be inactive, so there is always an active owner.

**`sessions`**: `id uuid` PK; `user_id` → `users` (cascade); `token_hash bytea` UNIQUE, exactly 32 bytes (SHA-256 of the cookie token; the token itself is never stored); `created_at`, `last_seen_at` (idle timeout), `absolute_expires_at`; `revoked_at` + `revoked_reason` (both set or both null; reason from a fixed list); `ip inet`, `user_agent`. Partial index on live sessions per user.

**`auth_events`**: append-only access log: `event_type` (fixed list), `user_id`, `actor_user_id`, `email_attempted`, `ip`, `user_agent`, `details jsonb`, `created_at`. Indexed per user and for per-IP failure counting. Never contains passwords, hashes or tokens. *(Retention policy not decided yet; see testing plan / open decisions.)*

The financial schema is intentionally not part of Stages 1–2.

## Creating the owner account

After migrating, create the single owner once (interactive; the password is not echoed):

```powershell
npm run owner:create
```

It refuses to run against an unmigrated database and refuses if an owner already exists. Against production, build first and use `$env:NODE_ENV="production"; npm --prefix server run owner:create:built`.
