# Bill attachments: postponed

**Decision (2026-11-10):** bill photo/PDF attachments are postponed for roughly 2–3 years, until the
shop can pay for a domain and suitable permanent file storage. Until then Shop-Books runs as an
expense-management and ledger application **without** attachments.

This is a pause, not a removal. All of the attachment code, the database tables and their history
stay in the repository and in the database, so the feature can be switched back on later.

No replacement has been set up: no Cloudflare Quick Tunnel, ngrok, Tailscale, Render disk, browser-only
permanent storage or third-party file host.

## What is switched off

| Area | While postponed |
| --- | --- |
| Expense form | No "Bill photos and documents" step, no file pickers, no draft-recovery prompt. Creating and editing expenses never touches attachment code. |
| Expense details | No upload controls. A **"Bill documents on record"** card appears only when the expense already has document records (see below). |
| Offline attachment queue | Not started: no IndexedDB queue, no background sync, no "Sync now" banner, no calls to `/document-storage/status`. |
| Files left in a browser by the earlier version | Not touched. A notice tells that user how many unsent files the browser still holds. They are never uploaded or deleted. |
| API upload (`POST /expenses/:id/documents`) | Refused with `503 BILL_ATTACHMENTS_DISABLED` before the body is read. Nothing is stored, and nothing is parked in PostgreSQL. |
| Queue delivery worker | Not started (it runs only with `DOCUMENT_STORAGE_DRIVER=agent`). |
| `documents:reconcile` | Refuses to run: there is no storage to compare against. |
| Storage agent / Cloudflare Tunnel | Not needed and not contacted. `npm run storage-agent` still exists for the future. |

Flags:

- **API:** `DOCUMENT_STORAGE_DRIVER=disabled`. This is also the **default in production** when neither
  `DOCUMENT_STORAGE_DRIVER` nor `DOCUMENT_STORAGE_DIR` is set, so missing storage variables no longer
  stop the API from starting. `DOCUMENT_STORAGE_AGENT_URL`/`_SECRET` are ignored in this mode.
- **Web:** attachments are off unless the build sets `VITE_BILL_ATTACHMENTS=enabled`. Leave it unset.

An explicitly requested `agent` driver still fails closed on bad configuration. A placeholder agent
URL (`example.com/.net/.org`, `localhost.localdomain`, or text such as `change-me`, `placeholder`,
`your-…`) is now refused instead of being treated as working storage.

## What keeps working

Expenses (categories, brands, suppliers, split payments, void/restore), suppliers and supplier
payments, customers (dues, categories, settlements, history), salesmen, dashboard, reports, filters,
Excel exports, monthly reports, audit history and live updates are unchanged.

## Existing document records

Nothing is deleted, migrated or hidden. `expense_documents` rows keep their DELETE-refusing trigger,
and `document_upload_queue` rows are left exactly as they are.

| Record | Visible? | File can be opened? |
| --- | --- | --- |
| Document whose bytes are still in `document_upload_queue` (uploaded while the PC was offline) | Yes, on the expense card, to its uploader and the owner, as before | **Yes**: the API serves these bytes from PostgreSQL, so view and download stay available |
| Document stored by the desktop agent (or a `local` directory) | Yes: name, type, size, uploader, date, removal reason | **No**: the bytes are on the shop PC / that directory, which the API no longer contacts. The app says so instead of showing broken links. The files are not deleted; keep that folder backed up. |
| Removed documents | Yes, under "Show removed documents" | Same rules as above, owner only |
| Paperclip count in the expense list, `Documents` column in Excel exports, `document_add`/`document_remove` audit events | Unchanged | — |

Removing a document record with a reason still works (it only changes the database row).

### Checking whether production holds document records (read-only, run by the owner)

Run these from a SQL console against a **read-only** session. They change nothing.

```sql
SELECT status, count(*) FROM expense_documents GROUP BY status;
SELECT count(*), coalesce(sum(octet_length(content)), 0) AS bytes FROM document_upload_queue;
```

If `document_upload_queue` has rows, those files exist **only** in PostgreSQL. Keep them, and include
them in database backups.

## Reactivating attachments later

1. Choose permanent, backed-up storage: the desktop storage agent behind a **named** Cloudflare
   Tunnel on your own domain, or a private object-storage adapter. An adapter implements
   `DocumentStorage` in `server/src/modules/documents/storage.ts` and is wired in `createDocumentStorage`.
2. If you use the agent, follow [hosted-deployment.md → Storage agent](hosted-deployment.md#storage-agent-desktop):
   run `npm run storage-agent` on the PC with `AGENT_STORAGE_DIR` and `AGENT_SECRET`, publish it
   with a named tunnel, and point the old storage folder at `AGENT_STORAGE_DIR` so existing files
   become readable again.
3. Render: set `DOCUMENT_STORAGE_DRIVER=agent`, `DOCUMENT_STORAGE_AGENT_URL=https://<your tunnel hostname>`
   and `DOCUMENT_STORAGE_AGENT_SECRET` (equal to `AGENT_SECRET`, at least 32 random characters).
   Restore those entries in `render.yaml`.
4. Vercel: set `VITE_BILL_ATTACHMENTS=enabled` and redeploy the frontend after the API.
5. Run `npm run documents:reconcile -- --verify` (owner) and confirm there are no missing files.
   Any `document_upload_queue` rows are then delivered automatically by the queue worker.
6. Re-check on a phone: attach a photo, go offline, come back online, and confirm the file reaches the PC.

The code paths for that day (`web/src/features/documents/**`, `server/src/modules/documents/**`,
`server/src/storageAgent/**`) and their tests stay in place and keep running in CI.
