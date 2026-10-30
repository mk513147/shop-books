# Maintenance and operations

## Owner account recovery

If the owner forgets their password or is locked out, someone with **shell access to the server** (the machine that has the server's environment / `DATABASE_URL`) can reset it. There is deliberately no web or API route for this.

```powershell
npm run owner:reset-password
# production build:  $env:NODE_ENV="production"; npm --prefix server run owner:reset-password:built
```

- Must be run from an interactive terminal (it refuses piped input); the password is not echoed.
- Asks for the owner's e-mail (must match the existing owner account) and a new password (12–128 characters, entered twice).
- Stores a new Argon2id hash, clears any lockout, **signs the owner out everywhere**, sets *must change password* so the owner chooses a fresh password at the next sign-in, and records a `password_reset` event (`details.via = "cli"`).
- Refuses if there is no owner (use `npm run owner:create`) or, defensively, more than one. It never creates an owner, changes roles or transfers ownership.
- The password and hash are never printed or logged.

Managers' passwords are reset by the owner in the web app (**Users → Reset password**).

## Data retention: authentication data *(policy approved, not yet implemented)*

| Data | Retention | Rule |
|---|---|---|
| `sessions`: expired or revoked | **90 days** after it ended | Delete when `revoked_at < now() - 90 days`, or (not revoked and) `absolute_expires_at < now() - 90 days`, or (not revoked and) idle-expired with `last_seen_at < now() - 90 days - 12 hours`. |
| `sessions`: active | Never removed by cleanup | A session that is not revoked and is within both the idle and absolute timeouts must never match the delete condition. |
| `auth_events` | **12 months** | Delete rows with `created_at < now() - 12 months`. |

Implementation requirements for the future cleanup job (no scheduler exists yet):

- **Safe batches**: delete in bounded batches (e.g. `DELETE … WHERE id IN (SELECT id … LIMIT 1000)`), each in its own short transaction, looping until a batch deletes nothing, so locks stay short and the job can be interrupted at any point.
- **Idempotent**: the delete conditions depend only on timestamps, so re-running (or running after a crash mid-way) is harmless and converges to the same result.
- Supported by existing indexes where possible; add an index on `sessions (revoked_at)` / `auth_events (created_at)` if batch scans become slow.
- Record a summary (counts only, no personal data) in the job's log.
- Covered by tests in the final test phase (see [testing-plan.md](testing-plan.md)), including a test that an active session is never deleted.
- Runs from the same backend scheduler that will send monthly reports (later stage).

## Data retention: idempotency keys *(policy, cleanup not yet automated)*

| Data | Retention | Rule |
|---|---|---|
| `idempotency_keys` | **30 days** | Delete rows with `created_at < now() - interval '30 days'`. |

Keys only protect against retries of the same form (seconds to minutes), so 30 days is generous. A key stays honoured for as long as its row exists; after deletion a reused key would create a new expense, which cannot happen in practice because the web app generates a fresh random key per form. Deleting these rows never touches expenses or audit history. Until the scheduler exists, the owner may run the cleanup manually in batches (same batching/idempotency rules as above):

```sql
DELETE FROM idempotency_keys
 WHERE (user_id, operation, key) IN (
   SELECT user_id, operation, key FROM idempotency_keys
    WHERE created_at < now() - interval '30 days' LIMIT 1000);
-- repeat until it deletes 0 rows
```

`supplier_backfill_log` is a permanent record of migration 0004 and is never cleaned up.

Retention of **financial** records and their audit history will be decided separately; financial history must be preserved and is out of scope for this policy.
