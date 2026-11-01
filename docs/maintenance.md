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

Keys only protect against retries of the same form (seconds to minutes), so 30 days is generous. They cover expense creation, supplier payment creation and allocation, and customer ledger entries. A key stays honoured for as long as its row exists; after deletion a reused key would create a new record, which cannot happen in practice because the web app generates a fresh random key per form. Deleting these rows never touches financial records or audit history. Until the scheduler exists, the owner may run the cleanup manually in batches (same batching/idempotency rules as above):

```sql
DELETE FROM idempotency_keys
 WHERE (user_id, operation, key) IN (
   SELECT user_id, operation, key FROM idempotency_keys
    WHERE created_at < now() - interval '30 days' LIMIT 1000);
-- repeat until it deletes 0 rows
```

`supplier_backfill_log` is a permanent record of migration 0004 and is never cleaned up.

Retention of **financial** records and their audit history will be decided separately; financial history must be preserved and is out of scope for this policy.

## Bill documents: backup, recovery and reconciliation (Stage 3B)

Bill photos/PDFs are stored **outside** PostgreSQL in `DOCUMENT_STORAGE_DIR` (local adapter). A complete backup therefore has two parts that must be taken **together**:

1. the database (`pg_dump`), which holds the metadata (`expense_documents`) and audit history;
2. the document directory (copy/sync the whole folder, preserving the relative paths).

Take the database dump **first**, then copy the folder: files are always written before their metadata row, so a folder copied after the dump contains every file the dump references (plus, at worst, a few newer orphan files). Restore both from the same backup set, then run the check below. Removed documents are kept on purpose (evidence); they are part of the backup.

```powershell
npm run documents:reconcile                    # report only; exit code 1 if a referenced file is missing
npm run documents:reconcile -- --verify        # also re-hash every file against its stored SHA-256
npm run documents:reconcile -- --delete-orphans   # delete orphan/stray files older than 24 h
# production build: $env:NODE_ENV="production"; npm --prefix server run documents:reconcile:built -- --delete-orphans --yes
```

- **Orphan file**: stored but never recorded (upload interrupted between storing and recording, or a failed clean-up after an error). Harmless; delete with `--delete-orphans`. The 24-hour grace period (`--min-age-hours=N`, minimum 1) protects uploads in progress.
- **Stray entry**: a leftover `*.part` temp file from an interrupted write. Same treatment.
- **Missing file**: a metadata row whose file is gone (disk loss, manual deletion). Users see "file could not be found". Restore the file from backup to the same relative path; nothing else needs changing.
- **Checksum mismatch** (`--verify`): the stored bytes changed. Restore from backup.

Suggested routine: run the report after every restore and monthly; run `--verify` occasionally (it reads every file). The tool never deletes a file that has a metadata row.

## Monthly e-mail reports: operations and retention (Stage 5)

**Production configuration required before any e-mail can be delivered**: a real `EmailSender` adapter for the chosen provider (SMTP relay or HTTP e-mail API — not implemented yet; see [architecture.md](architecture.md#monthly-e-mail-reports-stage-5)), its credentials as environment variables, `EMAIL_FROM` on a domain with SPF/DKIM set up for that provider, `SHOP_NAME`. Until then keep `EMAIL_PROVIDER=none`: reports are generated and every delivery is recorded as **failed – not configured** (nothing is claimed as sent).

**Scheduler**: runs inside each API process (`REPORT_SCHEDULER_ENABLED`, default on outside tests; `REPORT_SCHEDULER_INTERVAL_SECONDS`, default 60). The API must therefore be running around the delivery time; if it is down, the report goes out on the first tick after it comes back. Several API instances are safe (advisory lock). No OS cron job is needed. Keep the server clock correct (NTP); delivery times are evaluated in Asia/Kolkata by PostgreSQL.

**When something fails**: open *Reports → Monthly e-mail* (owner). `Failed` rows show the error; fix the cause (address, provider settings) and press **Retry**. An *interrupted* delivery may already have reached the recipient — ask before retrying. A month that never ran (e.g. the server was off for two months) can be sent with **Send a month now**.

| Data | Retention | Rule |
|---|---|---|
| `report_jobs` (month, trigger, time) | indefinitely | tiny; documents which months were reported |
| `report_deliveries` and `report_delivery_attempts` (recipient, status, times, provider reference, error text) | **24 months** | delete attempts first, then deliveries, of jobs whose `period_start` is older than 24 months, in batches (same rules as above); never touches financial data |
| Failed-delivery error text | with the delivery | truncated to 1,000 characters; never contains message content |
| Excel attachments / e-mail bodies | **not stored** | generated in memory for each send and discarded; nothing is written to disk by the server except by the development `outbox` adapter |
| Development outbox folder (`EMAIL_OUTBOX_DIR`) | developer's choice | contains full report copies: delete it freely; `outbox` is refused in production |

```sql
-- manual cleanup (repeat until 0 rows), oldest first
DELETE FROM report_delivery_attempts WHERE id IN (
  SELECT a.id FROM report_delivery_attempts a JOIN report_deliveries d ON d.id = a.delivery_id
  JOIN report_jobs j ON j.id = d.job_id WHERE j.period_start < now() - interval '24 months' LIMIT 1000);
-- report_delivery_attempts is append-only: run the line above as the database owner with the
-- trigger temporarily disabled (ALTER TABLE … DISABLE TRIGGER report_delivery_attempts_append_only),
-- then re-enable it. Afterwards delete the matching report_deliveries rows the same way.
```

## Excel exports: limits

At most 20,000 rows per export (larger requests are refused with a message to narrow the filters); ledger exports include at most 2,000 entries (as the ledger screens). Exports are built in memory and never stored on the server.
