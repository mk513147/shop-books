# Architecture

Status: Stages 1–3D, 4 (dashboard and reports) and 5 (Excel export and monthly e-mail reports) are implemented; see [project-status.md](project-status.md). No real e-mail provider is configured yet. Items marked *(planned)* do not exist yet.

## Responsibilities

**`web/` (browser / PWA)** renders the UI, validates input for convenience (Zod + React Hook Form), and talks to the API only through `src/lib/api-client.ts`. It holds **no secrets** and does **no authoritative financial calculation**; amounts are decimal strings that it only formats for display (`src/lib/money.ts`).

**`server/` (Express API)** is the single authority for validation, authentication, authorization, business rules and database access. Every client check is repeated server-side.

**PostgreSQL** is the system of record. Balances and totals will be *derived* from transactions, never stored as editable numbers *(planned)*.

## Request flow

```
Browser ──HTTPS──▶ (Vite proxy in dev / reverse proxy in prod)
   └─▶ Express
        1. requestId            assign/echo X-Request-Id
        2. pino-http            structured request log (no headers, no query strings)
        3. helmet               security headers
        4. cors                 only origins listed in FRONTEND_URL
        5. express.json         100 kb body limit
        6. /api/v1 router (server/src/routes/index.ts), deny-by-default, in this order:
             a. verifyOrigin         state-changing requests: Origin/Referer must be a FRONTEND_URL origin
             b. requireJson          state-changing requests: Content-Type must be application/json
             c. PUBLIC               GET /health, POST /auth/login       (nothing else is public)
             d. requireAuth          valid server-side session or 401
             e. requireCsrf          state-changing requests: X-CSRF-Token must match the session
             f. /auth                me, logout, change-password
             g. requirePasswordCurrent   403 until a temporary password is replaced
             h. feature modules      /users behind requireRole('owner'); future financial modules here
        7. notFoundHandler      JSON 404 (outside /api; unknown /api paths get 401 when signed out)
        8. errorHandler         one JSON error shape, no internals leaked
```

Error shape (all failures):

```json
{ "error": { "code": "NOT_FOUND", "message": "…", "requestId": "…", "details": [ { "path": "…", "message": "…" } ] } }
```

`details` appears only for validation errors. Stack traces and internal messages are logged server-side only and never returned, in any environment.

## Database connection architecture

`createPool()` (`server/src/database/connection.ts`) builds one `pg.Pool` per process (max from `DATABASE_POOL_MAX`, 5 s connect timeout, 30 s statement timeout). Idle-client errors are logged, not fatal. All SQL must be **parameterized** (`$1, $2 …`). The pool is passed into `createApp()` (dependency injection), which is what lets tests substitute a fake or a test-database pool.

Type conventions enforced at connection setup: `NUMERIC` is returned as a **string**; `DATE` as `'YYYY-MM-DD'` (not a JS `Date`).

Migrations are **never** run at API start-up; they are an explicit CLI step ([database.md](database.md)).

## Configuration and fail-safe start-up

`server/src/config/env.ts` validates the environment with Zod. The process **refuses to start** on missing/invalid configuration and prints the variable *names* at fault, never their values. Environment isolation rules are enforced in code: with `NODE_ENV=test` the database name must end in `_test`, and a `_test` database is rejected in every other environment. Production requires `https` frontend origins.

## Financial data conventions (apply to all future modules)

- Money: `NUMERIC(14,2)`, INR only; JSON carries decimal strings.
- Time: `TIMESTAMPTZ` for instants, `DATE` for calendar dates, reporting in `Asia/Kolkata`; financial year January–December (`server/src/config/constants.ts`).
- Financial records are auditable; deletion preserves history (void/reverse, not hard delete); corrections preserve original values.
- Audit events are written in the **same transaction** as the change.
- Derived balances are never directly editable. Supplier payments are not additional expenses. Customer advances and dues stay separate.

## Expenses and categories (Stage 3A)

Code: `server/src/modules/{categories,expenses,audit}/`, `server/src/utils/{money,dates}.ts`, `web/src/features/{categories,expenses}/`, pages in `web/src/routes/`.

**Access.** Owner and managers have identical rights to categories and expenses (create, edit, archive, void, restore). All routes sit below `requirePasswordCurrent`, so they are authenticated, CSRF-protected and blocked during a pending password change.

**API** (`/api/v1`; money values are decimal strings):

| Route | Purpose |
|---|---|
| `GET /categories?status=active\|archived\|all` | list (with usage counts) |
| `POST /categories` | `{name, description?}` → 201; 409 `CATEGORY_NAME_TAKEN` |
| `PATCH /categories/:id` | `{name?, description?, isActive?}`: rename, archive (`isActive:false`), reactivate |
| `GET /expenses` | server-side filter/sort/page: `q` (supplier name, originally typed supplier name, description, invoice; `%`/`_` matched literally), `from`, `to`, `categoryId`, `supplierId`, `paymentMode` (`none` = unpaid), `recordedBy`, `status` (`active` default, `voided`, `all`), `minAmount`, `maxAmount`, `sort` (`date`\|`amount`\|`created`), `order`, `page`, `pageSize` (≤ 100). Returns `items`, `pagination`, and `totals` over **all** matching rows **excluding voided** |
| `GET /expenses/recorders` | users who have recorded expenses (filter options; names only) |
| `POST /expenses` | create → 201; optional `Idempotency-Key` header (see below) |
| `GET /expenses/:id` | detail |
| `PATCH /expenses/:id` | full set of fields + `version` |
| `POST /expenses/:id/void` | `{reason, version}` |
| `POST /expenses/:id/restore` | `{reason, version}` |
| `GET /expenses/:id/history` | audit history, newest first, with field-level changes |

**Financial rules** (validated by Zod + service code, and again by database CHECKs):
- Money is `NUMERIC(14,2)` / decimal strings (`^\d{1,12}(\.\d{1,2})?$`); JS numbers are rejected. Comparisons use integer paise (`BigInt`); sums and `outstanding` are computed in SQL.
- `amount > 0`; `0 <= amount_paid <= amount`; payment mode required when anything was paid.
- Outstanding = `amount - amount_paid`, derived, never stored or editable.
- An edit that would make `amount` lower than the amount already paid is rejected (the paid amount is never adjusted silently).
- Expense date: real calendar date, not in the future (Asia/Kolkata), not before 2000.
- New expenses and category *changes* require an **active** category (share-locked during the write). An expense keeps an archived category if it is not changed.
- `amount_paid` is "paid at purchase"; it is not a separate payment and never adds to expense totals.

**Concurrency and integrity.** Every write uses `withSessionTransaction`. Edits, voids and restores lock the row (`FOR UPDATE`) and require the client's `version`; a mismatch returns **409 `VERSION_CONFLICT`** and nothing is written. The web form always submits the version it was opened with, so a stale form keeps getting 409 until the user reloads. Voided expenses return **409 `EXPENSE_VOIDED`** for edits; they must be restored first (with a reason). Creation is protected twice against duplicates: a synchronous double-submit guard in the form, and server-side idempotency (below).

**Voiding** sets `voided_at/by/reason` and bumps the version; every original value is kept. Voided rows are hidden from the default list, visible with `status=voided`/`all`, excluded from totals, and never deleted (database trigger).

**Financial audit.** `recordFinancialAudit()` writes a before/after snapshot (`expenseDate, supplierId, supplierName, categoryId, categoryName, description, amount, amountPaid, paymentMode, invoiceReference, status, voidReason`) in the same transaction as each create/update/void/restore, and for category create/update/archive/reactivate. History is served with a computed list of changed fields. (Snapshots written before migration 0004 have `supplierName` = the typed text and no `supplierId`; they are never rewritten.)

## Suppliers and category suggestions (Stage 3A enhancement)

Code: `server/src/modules/suppliers/`, `server/src/modules/idempotency/`, `web/src/features/suppliers/` (`SupplierPicker`, `SupplierForm`), `web/src/routes/SuppliersPage.tsx`. Schema: migration `0004_suppliers` ([database.md](database.md)).

**Access.** Same as expenses: owner and managers, every route below `requirePasswordCurrent`, every write through `withSessionTransaction` and audited.

| Route | Purpose |
|---|---|
| `GET /suppliers?q=&status=active\|archived\|all&page=&pageSize=` | search by name or phone (`%`/`_` literal; names starting with `q` first); each item includes linked `categories` and `expenseCount` |
| `POST /suppliers` | `{name, phone?, address?, notes?, categoryIds?}` → 201; 409 `SUPPLIER_NAME_TAKEN`; 400 if a category is archived/unknown |
| `GET /suppliers/:id` | detail with linked categories |
| `PATCH /suppliers/:id` | any of `{name, phone, address, notes, isActive, categoryIds}` + `version`; `categoryIds` is the complete desired set; 409 `VERSION_CONFLICT` |
| `POST /suppliers/:id/categories` | `{categoryId}`: add one link (no version needed; used by the expense form); already linked → no-op |
| `DELETE /suppliers/:id/categories/:categoryId` | remove one link; missing → no-op |
| `GET /suppliers/:id/history` | audit history (create/update/archive/reactivate/link_category/unlink_category/import) |

**Rules.**
- Names are trimmed with runs of spaces collapsed; unique ignoring case among **active** suppliers (`suppliers_active_name_unique`). Phone: digits, spaces, `+ - ( )`, 6–20 characters. Address ≤ 300, notes ≤ 1000.
- Suppliers are never deleted (archive instead; expenses reference them with `ON DELETE RESTRICT`). Archived suppliers cannot be chosen for new expenses or newly linked to categories; existing expenses keep them, including when other fields are edited.
- Every change to a link (add/remove) bumps the supplier's `version`, so a supplier edit form opened earlier gets 409 instead of silently dropping a link added meanwhile.
- **Categories stay global.** A link only orders suggestions; it never restricts which category an expense may use, and removing a link never touches expenses. Archived categories cannot be newly linked; existing links to a later-archived category remain (shown as archived, removable).
- Lock order: supplier `FOR UPDATE` → categories `FOR SHARE`. Expense writes take category then supplier `FOR SHARE`. No cycles.

**Expenses and suppliers.** `expenses.supplier_id` (nullable) replaces free text: the API accepts `supplierId` and rejects `supplierName` (strict schema). Responses carry `supplier: {id, name, isActive} | null` and `legacySupplierName` (the text typed before suppliers existed, read-only history; the detail page shows it as "Originally typed as …" when it differs from the supplier's name).

**Expense form (web).** Order: 1 Amount (large, focused first, live INR formatting) → 2 Payment (amount paid, "Paid in full"/"Not paid yet", payment-mode chips, live outstanding) → 3 Details (supplier picker, category, description, date, invoice) → Save. The supplier picker searches `GET /suppliers` (active only, debounced) in a sheet/dialog, offers "No supplier" and "Add supplier “typed text”"; adding opens the supplier form in a dialog on top of the expense form, so typed values are kept. After choosing a supplier its detail is fetched and the category `<select>` shows **Suggested for <supplier>** then **All categories**; the chosen category is never changed automatically. Choosing an unlinked category shows an optional "Suggest X for Y next time?" prompt (`POST /suppliers/:id/categories`). The supplier form creates new categories inline as normal global categories (`POST /categories`); a name that already exists (any case) selects the existing category instead.

## Idempotent expense creation

`POST /expenses` accepts `Idempotency-Key` (16–100 of `A-Z a-z 0-9 - _`; malformed → 400 `INVALID_IDEMPOTENCY_KEY`). The web app generates one random key per opened "Add expense" form and reuses it for every retry of that form.

Implementation (`runIdempotent`, `server/src/modules/idempotency/idempotency.ts`), all inside one `withSessionTransaction`:
1. Look up `(user, 'expense.create', key)` in `idempotency_keys`. Found with the same request hash → replay the stored `201` body (header `Idempotent-Replayed: true`); found with a different hash → **409 `IDEMPOTENCY_KEY_REUSED`**; nothing is created either way.
2. Otherwise create the expense (+ audit) and `INSERT … ON CONFLICT DO NOTHING` the key row with the SHA-256 of the **normalised** input (`"500"` and `"500.00"` are the same request) and the response body.
3. If a concurrent request with the same key committed first, the primary-key insert waits for it and inserts nothing: this transaction rolls back its own expense and replays the winner's response.

Keys are scoped per user (the same key from another user is unrelated). Failed requests (validation, conflicts) roll back and store nothing, so the same key can be retried after fixing the input. PostgreSQL is the only store; there is no in-memory cache. Retention: [maintenance.md](maintenance.md).

## Bill documents (Stage 3B)

Code: `server/src/modules/documents/` (`storage.ts` interface, `localStorage.ts` adapter, `documents.validation.ts`, `documents.service.ts`, `documents.routes.ts`, `reconcile.ts`), `server/src/cli/documentsReconcile.ts`, `web/src/features/documents/`. Schema: migration `0005_expense_documents` ([database.md](database.md)).

**Storage abstraction.** Business code depends only on the `DocumentStorage` interface: `put` (all-or-nothing, new key only), `open` (stream), `delete`, `exists`, `list` (for reconciliation) and `createAccessUrl` (short-lived pre-authorised URL where a provider supports it; `null` = the API streams the bytes itself). Keys are generated by the server (`newStorageKey()`: 128 random bits, e.g. `3f/3f9c…`); user file names are display metadata only and never part of a path. Binary content is never stored in PostgreSQL.

| Setting | Meaning |
|---|---|
| `DOCUMENT_STORAGE_DRIVER` | `local` (only adapter implemented). Anything else is refused at start-up. |
| `DOCUMENT_STORAGE_DIR` | Absolute private directory. Defaults to `<repo>/storage/documents` (development) and `<repo>/storage/documents-test` (test), both gitignored. **Required in production.** |

`local` writes to `<dir>/<key>` via a temporary `*.part` file that is hard-linked into place (atomic, never overwrites; FAT/exFAT fall back to rename), mode 0600/0700, and refuses any key that does not match `^[a-z0-9]+(/[a-z0-9]+)*$` or resolves outside the directory. The API has no static-file middleware, so the directory is never web-reachable. **Future object storage:** implement `DocumentStorage` for the chosen provider (private bucket, no public ACLs, server-side encryption), add it to `createDocumentStorage`, and read its settings (`STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, placeholders in `.env.example`). If it issues signed URLs, make them ≤ 60 s, `GET` only, with the content-disposition set; otherwise keep streaming.

**Limits and validation** (server; mirrored in `web/src/features/documents/limits.ts`): JPEG, PNG, WebP, PDF; 1 byte – 10 MB per file (`express.raw` limit → 413 before the body is buffered further); at most **10 active documents per expense**. The server ignores the browser's opinion: it checks the extension (`.jpg/.jpeg/.png/.webp/.pdf`), the real type from the content (magic bytes + basic structure: JPEG SOI/EOI, PNG IHDR, RIFF/WEBP chunk sizes, PDF header + `%%EOF`), that both agree, and, if the browser sent `X-File-Type`, that it agrees too. File names are percent-decoded, reduced to their last path segment, stripped of control characters, ≤ 255 characters.

**API** (below `/api/v1/expenses/:expenseId/documents`; owner and managers):

| Route | Purpose |
|---|---|
| `GET /` | active documents (`?status=all` includes removed) |
| `POST /` | upload **one** file: raw body, `Content-Type: application/octet-stream`, `X-File-Name` (percent-encoded), optional `X-File-Type`. 201 `{document, created:true}`; an identical file (same SHA-256) already active on this expense → 200 `{document, created:false}` (retries and double taps never duplicate). 409 `EXPENSE_VOIDED`, `DOCUMENT_LIMIT_REACHED`; 400 `DOCUMENT_INVALID`/`DOCUMENT_TYPE_NOT_ALLOWED`/`DOCUMENT_TYPE_MISMATCH`/`DOCUMENT_EMPTY`; 413; 429 (60 uploads / 10 min per user) |
| `GET /:documentId` | metadata (never the storage key) |
| `GET /:documentId/content` | the bytes, streamed after authorisation (`?download=1` → attachment). `Cache-Control: private, no-store`, `nosniff`, RFC 5987 file name. Removed documents: **owner only** (403 for managers) |
| `POST /:documentId/remove` | `{reason}` → status `removed` |

Every query is scoped by **both** ids (`WHERE d.id = $doc AND d.expense_id = $expense`), so a document cannot be reached through another expense's URL (404). Multiple files are uploaded as one request each (progress per file, no multipart parser dependency). `requireJson` makes exactly one exception: `POST /expenses/:id/documents` with `application/octet-stream`; Origin, session and CSRF checks still apply, and that type is not a CORS "simple" type, so a cross-site page cannot send it without a preflight.

**Consistency between storage and database.**
1. Pre-checks without locks (expense exists and is not voided, duplicate, count) so rejected files are never stored.
2. File stored under a fresh key.
3. One `withSessionTransaction`: lock the expense row (`FOR UPDATE`, serialises concurrent uploads and void/restore), re-check voided/duplicate/limit, insert metadata, write the `document_add` audit event.
4. If step 3 fails (validation race, revoked session, DB error) the file is deleted again. A crash between 2 and 3, or a failed delete, leaves an **orphan file without metadata**; never a metadata row without a file.
5. `npm run documents:reconcile` reports orphans, stray `*.part` files, rows whose file is **missing** (exit code 1) and, with `--verify`, SHA-256 mismatches. `--delete-orphans` deletes orphan/stray files older than 24 h (`--min-age-hours`, `--yes` in production); it never deletes files that have a metadata row.

**Removal** is a status change with a required reason (`removed_at/by`, `remove_reason`) plus a `document_remove` audit event. Metadata rows are never deleted (trigger), and the file is **kept** as evidence. Uploads and removals are refused while the expense is voided; viewing stays possible. Attaching or removing a document does not change the expense's `version`, so an open edit form is not invalidated.

**Audit.** `document_add` / `document_remove` are recorded on the **expense** (`entity_type = 'expense'`), so they appear in its history, with `{documentId, fileName, mimeType, sizeBytes, attached}`. File contents and storage keys are never logged.

**Web.** The expense form has an optional step 4 "Bill photos and documents": **Choose files** (multiple) and, on phones, **Take photo** (`capture="environment"`); each selected file shows a small preview (images) or a PDF tile, its name, type and size, and can be removed before saving. Files are checked client-side (type, size, count) and uploaded one by one **after** the expense is saved, with a progress bar each. If any upload fails the form stays open with the expense saved, failed files marked, and **Retry upload** / **Continue without them**; nothing typed is lost and the expense is never created twice (the idempotency key and the in-flight guard stay). The expense details page lists documents (lazy thumbnails, PDF tile), with View (new tab), Download and Remove (reason dialog), lets more files be added, and shows removed documents on request. The list shows a paperclip for expenses with documents.

## Supplier payments and ledger (Stage 3C)

Code: `server/src/modules/supplierPayments/` (`supplierPayments.{schemas,service,routes}.ts`, `supplierLedger.service.ts`), additions in `suppliers.routes.ts` and `expenses.service.ts`; `web/src/features/supplierPayments/`, `web/src/components/finance/`, pages `Supplier{Detail,Ledger,Payments,PaymentForm,PaymentDetail}Page.tsx`. Schema: migration `0006_supplier_payments`.

**Model.** A supplier payment is a separate financial transaction, **never an expense** (it does not appear in expense lists or totals). It may be allocated to one or more of the same supplier's bills (expenses), fully or partly; the rest stays **unallocated** and visible until allocated later. Nothing is allocated automatically ("Fill oldest bills first" is an explicit button that only fills the form).

| Figure | Definition (always computed by PostgreSQL from source rows) |
|---|---|
| Bill payable / expense `outstanding` | `amount − amount_paid` (paid at purchase) `− active allocations` |
| Supplier payable | Σ bill payable over the supplier's active (not voided) bills |
| Total payments | Σ active (not reversed) payments |
| Unallocated | total payments − active allocations |
| Net balance | payable − unallocated = bills − paid at purchase − payments |

`supplier_balances` (a view) computes these; no balance is stored or editable. There is no opening-balance transaction type, so none is shown.

**Rules** (service under locks, and again in database triggers):
- Allocation ≤ the payment's unallocated amount; Σ allocations on a bill ≤ `amount − amount_paid`; payment and bill have the **same supplier**; voided bills and reversed payments receive nothing; amounts > 0; a bill appears once per request.
- Lock order: payment `FOR UPDATE` → bills `FOR UPDATE` (id order) → allocation rows. Expense edits/voids lock the expense row, so they serialise with allocations. Verified by a concurrency test (three simultaneous allocations to one bill → exactly one succeeds).
- A bill with active allocations cannot be voided, moved to another supplier, or reduced below `amount_paid + allocated` (409 `EXPENSE_HAS_ALLOCATIONS` / 400 with an explanation); release the allocation first.
- Payment amount and supplier are immutable (trigger). Corrections: **edit** date/mode/reference/notes (versioned, audited), **release** an allocation (reason), **reverse** the payment (reason + version). Reversal releases every active allocation in the same transaction ("Payment reversed: …"), keeps the original values, is final (trigger) and happens once (409 `PAYMENT_ALREADY_REVERSED`); a reversed payment cannot be edited or allocated (409 `PAYMENT_REVERSED`). Rows are never deleted (triggers).
- Payments to **archived** suppliers are allowed (settling old dues); the record-payment picker offers active suppliers, the supplier page offers its own (also archived) supplier.

**API** (`/api/v1`, owner and managers):

| Route | Purpose |
|---|---|
| `GET /supplier-payments` | `supplierId`, `from`, `to`, `status` (`active` default, `reversed`, `all`), `allocation` (`unallocated`/`partial`/`full`/`open`), `q` (reference, notes, supplier), `page`, `pageSize`; `totals` over active matches |
| `POST /supplier-payments` | `{supplierId, amount, paymentDate, paymentMode, reference?, notes?, allocations?: [{expenseId, amount}]}` → 201; `Idempotency-Key` supported (`supplier_payment.create`) |
| `GET /supplier-payments/:id` | detail incl. all allocations (active and released) |
| `PATCH /supplier-payments/:id` | `{paymentDate, paymentMode, reference, notes, version}` (amount/supplier rejected) |
| `POST /supplier-payments/:id/allocations` | `{allocations: [...]}`; `Idempotency-Key` supported (`supplier_payment.allocate`) |
| `POST /supplier-payments/:id/allocations/:allocationId/release` | `{reason}` |
| `POST /supplier-payments/:id/reverse` | `{reason, version}` |
| `GET /supplier-payments/:id/history` | audit history |
| `GET /suppliers/summary` | total payable, total payments, unallocated, suppliers with dues, top 10 payable |
| `GET /suppliers/:id/balance` | the derived balance above |
| `GET /suppliers/:id/open-bills` | active bills with something payable, oldest first |
| `GET /suppliers/:id/ledger` | `from`, `to`, `type` (`bill`/`paid_at_purchase`/`payment`), `status` (`active`/`cancelled`/`all`) |
| `GET /suppliers?balance=payable` | only suppliers with something payable; every supplier item now has `payable` and `unallocated` |

Expenses gain `allocatedPayments`, and `outstanding` now subtracts it (also in list totals).

**Ledger convention.** Shop's books, supplier account: **Credit (+)** = a bill (increases what is owed); **Debit (−)** = money paid (paid at purchase, or a payment). Each bill with `amount_paid > 0` produces a separate "Paid at purchase" debit. The **running balance** is the net amount owed after every *counted* entry, in order (date, created time, bill before its at-purchase payment); its final value equals the net balance. Voided bills and reversed payments are listed (crossed out, status shown) but never change a balance. Filters hide rows without changing balances; with a `from` date, the balance of earlier entries is shown as "balance before …" (derived, not an opening balance). The screen explains this in a "How to read this ledger" panel. At most 2,000 rows per request (`truncated` flag).

**Audit.** `supplier_payment` entity: `create`, `update`, `allocate`, `release_allocation` (reason), `reverse` (reason), with before/after snapshots. Every allocation and release is also recorded on the **expense**, so a bill's history shows which payments settled it.

**Web.** Suppliers page: summary tiles (total payable, total payments, unallocated, suppliers with dues — tap to filter) and a payable column; names open the new **supplier page** (balance tiles, unpaid bills, recent payments, details/edit/archive/history, Record payment, Ledger). **Record payment** (`/supplier-payments/new?supplierId=`) shows the current payable, then amount, mode chips, date, reference, optional notes, and the allocation editor (per-bill amount, "Full", "Fill oldest bills first", live "allocating / stays unallocated"). **Payment page**: amount, allocated/unallocated, allocations with release, "Allocate ₹…" dialog, edit dialog, reverse (reason, explains the effect), history. **Supplier payments** list (filters, totals). Expense page shows "Paid by supplier payments" and links to record a payment. Phones get cards; desktop gets tables; nothing scrolls horizontally except inside the desktop ledger table container.

## Customers and customer ledger (Stage 3D)

Code: `server/src/modules/customers/` (`customers.{schemas,service,routes}.ts`, `customerLedger.service.ts`), `web/src/features/customers/`, pages `Customer{s,Detail,Ledger,Transaction}Page.tsx`. Schema: migration `0007_customers`.

**Scope.** A lightweight ledger of what customers owe and what the shop holds for them. There are **no** sales, orders, invoices, billing or inventory records: a due is a standalone entry with a description.

**Two independent balances** (view `customer_balances`, never stored, never netted):

| Entry (`txn_type`) | Customer due | Customer advance | Payment mode |
|---|---|---|---|
| `due` — the customer owes an amount | **+** | | none (no money moves) |
| `due_payment` — money received against **one** due | **−** | | required |
| `advance` — money received in advance | | **+** | required |
| `advance_refund` — advance given back | | **−** | required |

A customer with a ₹5,000 due and a ₹2,000 advance is shown as exactly that, side by side, with the note "An advance is never used to pay a due automatically". There is no net-balance figure anywhere.

**Rules** (service under the customer row lock, and again by a deferred database trigger at commit):
- Every ledger write (record or reverse) locks the **customer row** `FOR UPDATE` first, so concurrent payments, refunds and reversals for one customer are serialised and always see current balances. Verified: 5 concurrent refunds against a ₹1,500 advance → one succeeds; 4 concurrent ₹2,000 payments against a ₹2,500 due → one succeeds.
- A due payment ≤ what is still owed on that due; it must reference an active due of the same customer. Several partial payments per due are allowed.
- A refund ≤ the available advance (active advances − active refunds). Dues are never used for refunds.
- Amount > 0 (decimal string), date not in the future (Asia/Kolkata), a due needs a description, a due has no payment mode, the others need one (strict schemas reject unknown fields).
- **Corrections = reversal** with a reason and the entry's `version`: the entry stays (crossed out) and stops counting; exactly once (409 `ALREADY_REVERSED`). Refused when it would break the ledger: a due with active payments (409 `DUE_HAS_PAYMENTS`, reverse the payments first) or an advance whose money was already refunded (409 `ADVANCE_ALREADY_REFUNDED`). Recorded values are immutable and rows are never deleted (triggers).
- **Archived customers** stay in lists (`status=archived`/`all`) with their full ledger; new dues and advances are refused (409 `CUSTOMER_ARCHIVED`), but old dues can still be paid and advances refunded.
- **Duplicates.** Names may repeat. A phone number (compared by its last 10 digits, so `+91 98765 43210` = `09876543210`) belongs to at most one **active** customer (409 `CUSTOMER_PHONE_TAKEN`, naming the existing customer; also a unique index). Search matches name, phone text and phone digits.

**API** (`/api/v1/customers`, owner and managers):

| Route | Purpose |
|---|---|
| `GET /` | `q`, `status` (`active`/`archived`/`all`), `balance` (`due`/`advance`/`any`), `page`, `pageSize`; items include `dueBalance` and `advanceBalance` |
| `POST /` | `{name, phone?, address?, notes?}` |
| `GET /summary` | `totalDue`, `totalAdvance`, `customersWithDue`, `customersWithAdvance` |
| `GET /:id`, `PATCH /:id` | detail; edit / archive (`isActive:false`) / reactivate with `version` |
| `GET /:id/history` | profile audit history |
| `POST /:id/dues` | `{amount, txnDate, description, reference?, notes?}` |
| `POST /:id/advances` | `{amount, txnDate, paymentMode, description?, reference?, notes?}` |
| `POST /:id/due-payments` | `{dueId, amount, txnDate, paymentMode, …}` |
| `POST /:id/refunds` | `{amount, txnDate, paymentMode, …}` |
| `GET /:id/open-dues` | active dues with something owed (`paidAmount`, `remainingAmount`) |
| `GET /:id/ledger` | `from`, `to`, `type`, `status` (`active`/`reversed`/`all`) |
| `GET /:id/transactions/:txnId` (`/history`) | one entry (scoped to the customer: another customer's id → 404) |
| `POST /:id/transactions/:txnId/reverse` | `{reason, version}` |

The four `POST` entry routes accept `Idempotency-Key` (`customer_transaction.create`; the hash includes customer and type).

**Ledger.** Each row: date, entry type in plain words ("Due added", "Due payment received", "Advance received", "Advance refunded"), reference, description, **Due ±** and **Advance ±** effects (signed, coloured), running due balance, running advance balance, status. Running balances are computed over all entries in order (date, created time, id) and only counted entries change them; filters hide rows without changing balances; with a `from` date both balances before it are shown. A "How to read this ledger" panel explains the signs.

**Audit.** `customer` (create, update, archive, reactivate) and `customer_transaction` (create, reverse with reason), before/after snapshots, same transaction.

**Web.** Customers list (summary tiles: total dues, total advances; search; balance and status filters; cards on phones, table on desktop). Customer page: the two balance cards, four large actions (Record due, Receive payment, Receive advance, Refund advance — disabled when not applicable or archived), unpaid dues with a one-tap "Receive", recent entries, details/edit/archive/history. One dialog (bottom sheet on phones) handles the four entries with plain-language help, the relevant limit shown ("Available advance", "Still due on this entry"), quick-fill buttons, progressive disclosure for reference/notes, and an explicit **confirmation step for refunds** showing the advance before/after and that the due does not change. Entry page: details, paid/still-due for dues, reverse (reason dialog explaining the effect), history.

## Dashboard and reports (Stage 4)

Code: `server/src/modules/reports/` (`period.ts`, `reports.service.ts`, `reports.schemas.ts`, `reports.routes.ts`); `web/src/features/reports/` (period selector, charts, shared report pieces), `web/src/routes/DashboardPage.tsx`, `web/src/routes/reports/*`. Migration `0008_reporting_indexes`.

**One calculation layer.** `reports.service.ts` is the only place report figures are computed. The dashboard, every report page, the Excel exports and the monthly e-mail call the same functions, and current balances come from the same views as the ledgers (`supplier_balances` via `getSuppliersSummary`, `customer_balances` via `getCustomersSummary`). The detailed expense table on the expense report reuses the existing paginated `GET /expenses`. Nothing is calculated in the browser (bar lengths are display geometry only).

**Periods.** Presets `today`, `this_week` (Mon–Sun), `this_month`, `previous_month`, `this_quarter`, `this_year`, `all_time`, `custom` are resolved on the server (`resolvePeriod`) into explicit **inclusive `DATE` ranges in Asia/Kolkata** ("today" = `todayInReportingZone()`). Transactions are matched on their business date (`expense_date`, `payment_date`, `txn_date`), which is a `DATE`, so no UTC/local conversion happens in SQL. Each period has a *previous equivalent period* (previous calendar unit; custom = same number of days immediately before; `all_time` = none). Custom ranges: start ≤ end, at most 5 years. The resolved dates are returned with every report and shown on screen.

**Definitions.**

| Figure | Definition | Kind |
|---|---|---|
| Expenses | Σ `amount` of **active** expenses with `expense_date` in the period. Voided expenses are excluded (their count/amount is shown separately). | period |
| Paid at purchase | Σ `amount_paid` of those expenses | period |
| Settled by later supplier payments | Σ active allocations to those expenses (as of now) | period expenses, current settlement |
| Still payable on these expenses | `amount − amount_paid − allocations` of those expenses, now | period expenses, current settlement |
| Paid / partly paid / unpaid | by what is outstanding on each expense now | — |
| Supplier payments in period | Σ active supplier payments with `payment_date` in the period — **never added to expenses** | period |
| Supplier payable, unallocated | `supplier_balances` (identical to the supplier ledger) | **current** |
| Customer dues recorded / payments received / advances received / refunds issued | Σ active customer entries of that type dated in the period | period |
| Customer outstanding due, available advance | `customer_balances`; two separate figures, never netted | **current** |
| Change % | `(current − previous) / previous`, BigInt paise, one decimal (truncated); none when previous = 0 | — |
| Category share % | category ÷ period total, one decimal (truncated, so shares can add up to 99.9 %) | period |

Customer entries are reported as what they are (dues, payments, advances, refunds), never as revenue or sales. Archived categories, suppliers and customers stay in reports when they have transactions; nothing is merged.

**API** (`/api/v1/reports`, owner and managers, read-only, Zod-validated query strings; no client-supplied column or sort expressions):

| Route | Purpose |
|---|---|
| `GET /dashboard?period=&from=&to=` | period expenses (+ previous period, change %), supplier payments in period, customer activity, current supplier/customer balances, 6-month trend, 10 most recently recorded transactions |
| `GET /expenses` (+ `categoryId`, `supplierId`, `paymentMode` incl. `none`, `recordedBy`) | totals, previous totals, change %, paid status, payment modes, top 10 suppliers, monthly trend (≥ 6, ≤ 24 months) |
| `GET /categories` (same filters) | categories with amount, count, share, previous amount, change % |
| `GET /suppliers` (`period` default `all_time`, `supplierId`, `status`, `outstandingOnly`, `page`, `pageSize`) | per supplier: period expenses/payments **and** current totals (expenses, paid at purchase, allocated, unallocated, payable, unpaid bills); totals over all matching rows |
| `GET /customers/dues`, `GET /customers/advances` (`period` default `all_time`, `q`, `status`, `outstandingOnly`, paging) | separate due and advance reports: added / reduced in the period + current balance |
| `GET /transactions` (`period`, `type` (comma-separated), `status`, `q`, paging) | unified history of expenses, supplier payments and the four customer entry types; per-type counts and active amounts |
| `GET /activity?limit=` | most recently recorded transactions |
| `GET /monthly?year=&month=` | monthly summary (also used by the e-mail and the monthly Excel export) |

**Performance.** The dashboard runs 8 aggregate queries in parallel (no per-row queries); breakdowns use `FILTER` clauses so the current and previous period come from one scan; paginated reports return totals over all matching rows and only one page of rows. Migration 0008 adds `created_at DESC` indexes on expenses, supplier payments and customer entries (recent-activity feed: each branch reads its newest N rows) and a partial `(txn_date, txn_type) WHERE reversed_at IS NULL` index on customer entries (period activity). No cache or materialized view: figures are always computed from the source rows; TanStack Query keeps them for 30 s on the client.

**Web.** Dashboard: quick actions, period selector (in the URL), an "Activity: <period>" group (expenses with change vs previous period and how they were paid; supplier payments; customer dues/advances side by side) and a separate "Current balances" group (supplier payable, unallocated payments, customer dues, customer advances — each labelled "not affected by the period"), 6-month expense chart, recently recorded transactions. Reports: hub page and tabs for Expenses (filters, tiles, trend, paid vs unpaid, payment modes, top suppliers, paginated expense list), Categories (bars + table with previous-period comparison), Suppliers (period vs current column groups; ledger links), Customers (Dues / Advances tabs), Transactions (all types, filters, paginated), Monthly summary. Charts are dependency-free: single-series bars in the accent colour, 4 px rounded ends, focusable bars with tooltips, a "Show as table" switch for the trend and visible values on every bar list.

## Excel exports (Stage 5)

Code: `server/src/modules/exports/` (`excel.ts` helpers, `exports.service.ts` builders, `exports.routes.ts`), `web/src/features/exports/ExportButton.tsx`. Library: **ExcelJS 4.4.0** (added to the server; it was planned but not yet installed).

**Same numbers as the screen.** Every workbook is filled from the functions behind the report pages and ledgers (`reports.service.ts`, `listExpenses`, `listPayments`, `getSupplierLedger`, `getCustomerLedger`) with the same validated filters; there is no separate calculation. Totals rows contain the backend's totals (not spreadsheet formulas). Money cells are numbers formatted `"₹"#,##0.00` (≤ 14 significant digits, so every `NUMERIC(14,2)` value is exact); dates are real Excel dates (`dd-mmm-yyyy`); percentages use `0.0%`.

| `GET /api/v1/exports/…` | Workbook | Filters |
|---|---|---|
| `expenses` | Summary + Expenses (incl. voided rows marked "voided"; totals = active) | report period + category, supplier, payment mode, recorded by, `status` |
| `categories` | Categories with previous-period comparison | as the category report |
| `suppliers` | Supplier outstanding report (period columns + current balances) | as the supplier report |
| `supplier-payments` | Supplier payments with allocated / unallocated | `supplierId`, `from`, `to`, `status`, `allocation`, `q` |
| `supplier-ledger?supplierId=` | Balance + Ledger (credit/debit/balance) | ledger filters |
| `customer-dues`, `customer-advances` | separate due / advance reports | as the customer reports |
| `customer-ledger?customerId=` | Balances + Ledger (due ± / advance ±) | ledger filters |
| `transactions` | Transaction history | as the transaction report |
| `monthly?year=&month=` | Expense Summary, Category Breakdown, Payment Modes, Supplier Summary, Customer Due Summary, Customer Advance Summary, Transaction Activity | completed or current month |

**Layout.** Each table sheet starts with Shop (`SHOP_NAME`), Report, Period, Generated (Asia/Kolkata), Currency (INR), the active filters (names, not ids) and explanatory notes (e.g. "supplier payments are not expenses", "dues and advances are never netted"), then a teal bold header row that is **frozen** and has an **auto-filter**, the data, and a bold totals row. Column widths are set per column.

**Formula injection.** Every text cell is written as a plain string (never a formula object, number format `@`), and user text starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading apostrophe (`safeText`), so Excel/LibreOffice never evaluate it. Verified by reading the files back.

**Security and limits.** Authenticated (owner and managers), Zod-validated, parameterized SQL, no storage keys or document links, `Cache-Control: private, no-store`, `Content-Disposition: attachment` with an ASCII file name (`<shop>_<report>_<from>_<to>.xlsx`), 30 exports per 10 minutes per user. Exports are **bounded**: more than **20,000 rows** → 422 `EXPORT_TOO_LARGE` ("narrow the period or filters"); ledger exports carry the ledger's 2,000-entry cap with a note. Workbooks are built in memory (largest realistic shop workbook is a few MB) and never written to disk. The web button downloads with `fetch` (so errors are shown), is disabled while a download runs, and works the same on phones.

## Monthly e-mail reports (Stage 5)

Code: `server/src/modules/email/email.ts` (adapter interface), `server/src/modules/monthlyReports/` (`settings.service.ts`, `scheduler.ts`, `deliveries.service.ts`, `template.ts`, `monthlyReports.routes.ts`), `web/src/routes/reports/MonthlyEmailPage.tsx`. Migration `0009_monthly_reports`.

**Content.** For the previous calendar month: expense summary (total, count, paid at purchase, settled by later payments, still payable, change vs previous month, category and payment-mode breakdowns); suppliers (supplier expenses and supplier payments in the month, current payable and number of suppliers owed, current unallocated payments); customer dues (recorded, payments received, current outstanding) and customer advances (received, refunds, current available) in **separate** sections; factual notes (e.g. "Expenses were 12.5 % higher than the previous month", "Largest category: …"); the note that figures are recorded transactions and that dues/advances are not sales or income. HTML (table-based, inline styles, every user value escaped) plus a plain-text part; optional Excel attachment = the monthly workbook. Nothing else is attached; no bill images, no document links. The figures come from `monthlySummary()` — the same function as the Monthly summary page and its export. "Now" balances are as at generation time.

**E-mail adapters** (`EmailSender`: `send(message) → {provider, messageId, simulated}`; failures throw `EmailSendError(retryable)`):

| `EMAIL_PROVIDER` | Behaviour | Status recorded |
|---|---|---|
| `none` (default in production) | not configured; every send fails (non-retryable) with "E-mail is not configured on the server" | `failed` |
| `outbox` (default in development/test; refused in production) | writes `message.json` (marked "NOT sent"), `body.html`, `body.txt` and the attachment to `EMAIL_OUTBOX_DIR/<delivery id>/` | `simulated` — never `sent` |
| *(future real provider)* | implement `EmailSender` (SMTP relay or an HTTP e-mail API), add it to `createEmailSender`, pass `idempotencyKey` (the delivery id) to the provider if it supports idempotency | `sent` = accepted by the provider |

No real provider is implemented yet, so **no e-mail can currently be delivered**; the owner's page says so prominently.

**Scheduler.** `ReportScheduler` runs inside the API process on a timer (`REPORT_SCHEDULER_INTERVAL_SECONDS`, default 60) and also on demand after a manual run or retry. It needs no browser. All state is in PostgreSQL:

1. Take `pg_try_advisory_lock(726001002)` on a dedicated connection; if another instance holds it, skip this tick (any number of API instances is safe).
2. **Due job**: if reports are enabled and this month's delivery moment (`delivery_day` at `delivery_time`, Asia/Kolkata, computed with `make_timestamptz(…, 'Asia/Kolkata')` in SQL) has passed, insert the job for the **previous month** (`report_jobs.period_start` UNIQUE → `ON CONFLICT DO NOTHING`) and one `pending` delivery per **active** recipient (UNIQUE `(job_id, recipient_email)`). Recipients added after the job was created are not included in that month.
3. **Stale recovery**: a delivery left in `processing` for 15 minutes (process died while sending) becomes `failed` with "Interrupted … may or may not have been delivered" and an `interrupted` attempt row. It is **not** re-sent automatically.
4. **Claim** the next due delivery (`pending`/`retry_scheduled`, `next_attempt_at ≤ now`) with `FOR UPDATE SKIP LOCKED`, set `processing`, `locked_at`, `attempt_count + 1` (committed before sending).
5. **Generate** (once per job per tick, in memory) and **send**; record the outcome and an attempt row in one transaction: `sent` / `simulated` (final — a trigger forbids any later change, so a delivered recipient is never re-sent because another failed), `retry_scheduled` (temporary failure: retries after 5 min, 30 min, 2 h, 6 h), or `failed` (permanent failure, or 5 attempts used).

**Edge cases.** Missed run / downtime: the job is created on the first tick after the scheduled moment (only the most recent completed month; older missed months can be sent from the page). Enabling reports after this month's delivery moment sends the previous month on the next tick. Duplicate scheduler execution: advisory lock + unique constraints + `SKIP LOCKED`. Invalid recipient / permanent provider error: `failed` with the provider's message, no automatic retry. Partial success: each recipient is independent. Retry exhaustion: `failed` "(gave up after 5 attempts)"; the owner can **Retry** (one more attempt). Crash after the provider accepted but before the database recorded it: the delivery ends up `failed` (interrupted, outcome unknown) and the owner decides whether to retry. Exactly-once delivery is therefore **not** guaranteed: without provider-side idempotency the system guarantees at-most-once automatically and leaves the uncertain case to the owner.

**Owner page** (`/reports/email`, owner only; API `/api/v1/monthly-reports/*` behind `requireRole('owner')`; every change session-bound and audited): provider/scheduler warnings; schedule (on/off, day 1–28, time HH:MM IST, attach Excel, next run); recipients (add with validation, duplicate active address → 409 `RECIPIENT_EXISTS`, remove = deactivate, restore); **Send a month now** (completed month without a job; 409 `JOB_EXISTS` otherwise) and **Preview e-mail** (sandboxed iframe); delivery history filtered by month and status with attempts, provider reference, last error and **Retry** for failed deliveries (with a warning when the outcome is uncertain). Statuses shown: Pending, Processing, **Accepted by provider** (with the note that this is not guaranteed inbox delivery), Simulated (not sent), Retry scheduled, Failed.

| Route | Purpose |
|---|---|
| `GET/PUT /monthly-reports/settings` | settings (+ provider info); `PUT {enabled, deliveryDay, deliveryTime, includeExcel, version}` |
| `GET/POST /monthly-reports/recipients`, `PATCH /monthly-reports/recipients/:id` | list / add `{email, name?}` / edit or deactivate `{email?, name?, isActive?, version}` |
| `GET /monthly-reports/deliveries?period=YYYY-MM&status=&page=` | history; `GET …/:id/attempts` attempt log |
| `POST /monthly-reports/deliveries/:id/retry` | failed → retry_scheduled |
| `POST /monthly-reports/jobs {year, month}` | manual run for a completed month |
| `GET /monthly-reports/preview?year=&month=` | rendered subject/HTML/text |

## Permission matrix (through Stage 5)

All financial routes are below `requirePasswordCurrent` (authenticated, CSRF-protected writes, no access with a pending temporary password). Managers are **not** read-only.

| Capability | Owner | Manager |
|---|---|---|
| User accounts, roles, password resets, sessions (`/users`) | ✔ | ✘ (403) |
| Categories, suppliers, expenses (create, edit, void, restore) | ✔ | ✔ |
| Upload / list / view / download / remove bill documents | ✔ | ✔ |
| Open **removed** bill documents | ✔ | ✘ (403) |
| Supplier payments: record, allocate, release, edit details, reverse | ✔ | ✔ |
| Supplier ledger, balances, summary | ✔ | ✔ |
| Customers: create, edit, archive, reactivate | ✔ | ✔ |
| Customer dues, payments, advances, refunds, reversals, ledger | ✔ | ✔ |
| Dashboard, all reports, transaction history (`/reports`) | ✔ | ✔ |
| Excel exports (`/exports`) | ✔ | ✔ |
| Monthly e-mail: settings, recipients, manual send, retry, delivery history (`/monthly-reports`) | ✔ | ✘ (403) |
| Server CLIs (`owner:*`, `db:*`, `documents:reconcile`) | shell access to the server only | — |

## Entity relationships (through Stage 5)

```
users ──< sessions, auth_events
users ──< (created_by / updated_by / voided_by / reversed_by / uploaded_by …) every financial table
expense_categories ──< expenses >── suppliers ──< supplier_categories >── expense_categories
expenses ──< expense_documents                        (metadata; bytes in document storage)
suppliers ──< supplier_payments ──< supplier_payment_allocations >── expenses
customers ──< customer_transactions ──< customer_transactions (due_payment.due_id → due)
financial_audit_events (entity_type, entity_id) → expense | expense_category | supplier | supplier_payment | customer | customer_transaction
idempotency_keys (user, operation, key) → created expense | supplier payment | customer transaction
views: supplier_balances (per supplier), customer_balances (per customer)
report_settings (1 row) · report_recipients · report_jobs (one per month) ──< report_deliveries (one per recipient) ──< report_delivery_attempts
```

## Design system (web)

Mobile-first, one accent. Tokens live in `web/src/styles/index.css` (`:root` + `@theme`) and are used only through Tailwind utilities; pages never hard-code colours.

| Token group | Values / usage |
|---|---|
| Colour | neutral surfaces (`background`, `card`, `surface-muted`), text (`foreground`, `muted-foreground`), teal/emerald accent (`primary`, `primary-hover`, `primary-soft`), status (`destructive(-soft)`, `warning(-soft)`), `border`, `input`, `ring` |
| Radius | `--radius` 0.75 rem; controls `rounded-lg`, cards/sheets `rounded-xl`/`2xl`, chips `rounded-full` |
| Shadow | `shadow-card` (subtle, cards/controls), `shadow-raised` (dialogs, bottom bar) |
| Type | system UI font stack (offline-safe); page titles `text-xl md:text-2xl font-semibold`; card titles `text-base`; body `text-sm`; inputs 16 px on phones (no iOS zoom); `.figure` = tabular numbers for money |
| Controls | inputs/selects/buttons 44 px high on phones (`h-11`), 40 px from `md`; `sm` 36 px for dense secondary actions; `lg` 48 px for the main action |
| Focus | 2 px `ring` (+ offset on buttons); invalid fields get a destructive border |
| Spacing | page gutters 16 px (phone) / 32 px (desktop); sections `space-y-5/6`; cards `p-4`/`md:p-5` |

Building blocks: `Button` (variants default/soft/secondary/outline/ghost/destructive/link), `Input`/`Select`/`Textarea` (shared `controlClass`), `Field` (label, hint, error wiring), `Card`, `Badge`, `Dialog` (native `<dialog>`: bottom **sheet** on phones with internal scrolling and safe-area padding, centred panel on desktop; backdrop tap closes only if the press started on the backdrop), `ReasonDialog`, `PageHeader` + `Page` (consistent widths: narrow 42 rem forms/details, medium 56 rem, wide 72 rem lists), `EmptyState`/`ErrorState`/`LoadingState`, `AuthLayout` (sign-in screens).

Layout: desktop keeps a sticky 15 rem sidebar (navigation + user block). Phones get a slim top bar and a fixed bottom bar: Home, Expenses, a central **Add expense** button, Suppliers, **More** (sheet with Categories, Customers, Reports, Users (owner), Change password, Sign out). `main` reserves the bar's height plus `env(safe-area-inset-bottom)` (`.pb-bottom-nav`), and the viewport uses `viewport-fit=cover`. Lists are cards on phones and tables from `md`; filters live in a sheet; no page scrolls horizontally. Money inputs use `inputMode="decimal"`, phone fields `type="tel"`. No decorative animation.

## PWA and caching

The service worker precaches only the built static assets and falls back to `index.html` for navigations (excluding `/api/*`). There is **no runtime caching**: API responses and private documents are never stored. In addition every `/api/v1` response carries `Cache-Control: no-store` (document downloads: `private, no-store`), so browsers and proxies do not keep financial data or bill files either. The navigation fallback denylist lives in `web/pwa-config.ts` (`/api` and everything below it). **Rule: every API endpoint and every private-document endpoint (bill photographs, report downloads) must live under `/api/`.** Production must be served over HTTPS (required for installability and service workers).

## Authentication

Code: `server/src/modules/auth/`, `server/src/middleware/auth.ts`, `server/src/middleware/requestGuards.ts`, `server/src/modules/users/`, `web/src/features/auth/`.

**Accounts.** Exactly one `owner` (created once with `npm run owner:create`; enforced by a unique index) and any number of `manager`s created by the owner. There is no public registration and no default credential. Managers will have full access to financial record management in later stages; only the owner manages users, configuration and report recipients.

**Passwords.** Argon2id (`@node-rs/argon2`, m = 19 MiB, t = 2, p = 1). 12–128 characters. New accounts and owner resets get a random temporary password (shown to the owner once) and `must_change_password = true`; until it is changed, only `/auth/me`, `/auth/logout` and `/auth/change-password` work. Self-service reset does not exist; the owner resets passwords.

**Sessions.** On sign-in the server creates a 256-bit random token, sends it in a cookie and stores only its SHA-256 digest in `sessions`. Every protected request looks the session up in PostgreSQL and loads the user's identity and role from `users`; the client never supplies either. A session is valid only if it is not revoked, was used within the last **12 hours** (idle timeout; `last_seen_at` is refreshed at most once a minute), is less than **7 days** old (absolute timeout), and its user is active. Sessions are revoked on logout, password change (all sessions; a fresh one is issued to the current browser), owner password reset, deactivation, and "sign out everywhere". Every later request is refused. For writes there is a stronger guarantee: state-changing services run inside `withSessionTransaction` (`server/src/modules/auth/sessionTransaction.ts`), which re-checks and share-locks the session row in the same transaction as the change, so a write either commits strictly before a concurrent revocation or is refused with 401. A *read* already in flight when its session is revoked may still complete. Password change rotates both the session and the CSRF token; the browser adopts the new token from the response.

**Cookie.** `HttpOnly`, `Path=/`, no `Domain`, `SameSite` from `SESSION_COOKIE_SAMESITE` (default `Lax`). In production it is `Secure` and named `__Host-sb_session`; in development it is `sb_session` over plain HTTP. Expiry matches the absolute session lifetime.

**CSRF.** Three independent layers on every state-changing request: (1) the `Origin` (or `Referer`) must be one of the `FRONTEND_URL` origins, (2) `Content-Type` must be `application/json`, which plain HTML forms cannot send, (3) for authenticated requests, `X-CSRF-Token` must equal `HMAC-SHA256(SESSION_SECRET, session token)`. The browser receives this token from `/auth/login`, `/auth/me` and `/auth/change-password` and keeps it in memory only. Login itself is protected by (1) and (2).

**Login protection.** All state is in PostgreSQL, so it survives restarts and works across instances.
- Per account: 5 consecutive wrong passwords lock the account for 15 minutes; each further lockout doubles (30 min, 1 h, 2 h) up to a **4-hour maximum**. A successful sign-in or an owner password reset clears the counters. Attempts on one account are serialized with `SELECT … FOR UPDATE`, so parallel guesses cannot exceed the limit.
- Per IP: 20 failed sign-ins within 15 minutes → `429 Too Many Requests` (`Retry-After: 900`), counted from `auth_events`.
- Every failure (unknown e-mail, wrong password, locked, deactivated) returns the same `401` and message and performs the same Argon2 work, to limit account enumeration by response or timing.

**Audit trail for access.** `auth_events` records sign-ins, failures, lockouts, logouts, password changes/resets, user creation/activation/deactivation and session revocations, with actor, IP and user agent. It never contains passwords, hashes or tokens. (Financial changes are recorded separately in `financial_audit_events`.)

**Frontend.** `AuthProvider` loads the session from `GET /auth/me` (a loading screen is shown meanwhile), exposes `login`/`logout`/`changePassword`, and returns to the login screen whenever any API call gets `401` (expired, revoked or deactivated session), clearing cached data. `ProtectedRoute` gates every screen and enforces the first-login password change; `RequireRole` hides owner-only screens. These are conveniences: the API enforces every rule itself.

## Future module organisation

New protected modules are mounted in `server/src/routes/index.ts` **below** `requirePasswordCurrent`, which makes them authenticated, CSRF-protected and unavailable to accounts with a pending password change automatically. Never mount a module above `requireAuth`. Every state-changing service must use `withSessionTransaction(db, sessionId, …)` rather than a plain transaction.

Backend: `server/src/modules/<feature>/` containing `*.routes.ts` (HTTP + validation), `*.service.ts` (business rules, owns transactions), `*.repository.ts` (SQL), registered in `routes/index.ts`. Frontend: `web/src/features/<feature>/` (components, hooks, API calls), pages in `routes/`, registered in `app/AppRoutes.tsx` and `app/navigation.ts`.

## Known deviations from the suggested layout

`web/src/hooks`, `web/src/services` and `server/src/services` were not created: they would be empty. API access lives in `web/src/lib/api-client.ts`; create the folders when there is content for them.
