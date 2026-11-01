# Project status

This is the project's status record (the equivalent of a `PHASE_1_STATUS.md`). It lists what is implemented, how it was verified, and what is still open. "Verified" means an automated check was **actually executed**; nothing here claims manual or real-device testing unless stated.

| Stage | Scope | Status |
|---|---|---|
| 1 | Foundation | Done |
| 2 | Authentication and access control | Done |
| 3A | Categories, expenses, audit, suppliers, idempotent creation, mobile-first design | Done |
| 3B | Bill attachments and private document storage | Implemented; awaiting owner's manual testing |
| 3C | Supplier payments and supplier ledger | Implemented; awaiting owner's manual testing |
| 3D | Customer management and customer ledger | Implemented; awaiting owner's manual testing |
| 4 | Dashboard figures, reports, Excel export, e-mail | Not started |

## Stage 3B — Bill attachments and private document storage

Implemented (details: [architecture.md → Bill documents](architecture.md#bill-documents-stage-3b), [database.md → 0005](database.md)):

- [x] Provider-independent `DocumentStorage` interface (put/open/delete/exists/list/createAccessUrl) and a `local` adapter (private directory, atomic writes, key validation, no static serving). Configuration: `DOCUMENT_STORAGE_DRIVER`, `DOCUMENT_STORAGE_DIR` (required in production).
- [x] Documented configuration path for a future private object-storage adapter (settings placeholders in `.env.example`).
- [x] Migration `0005_expense_documents`: metadata table (filename, random storage key, verified MIME, size, SHA-256, uploader, timestamps, removal metadata), indexes, FK, no-delete trigger, 10-per-expense trigger, audit actions.
- [x] JPEG/PNG/WebP/PDF only; 10 MB per file; 10 per expense; extension + magic bytes + structure + declared type checked server-side; client-side pre-checks.
- [x] Server-generated random keys; user filenames never used as paths.
- [x] Endpoints: upload (one file per request), list, metadata, content (streamed, `no-store`), remove (reason).
- [x] Every endpoint: authenticated, CSRF on writes, document scoped to its expense (no IDOR), expense state checked (voided → no upload/remove).
- [x] Audit: `document_add`/`document_remove` on the expense, same transaction, reason for removal.
- [x] Failure handling: file stored before metadata; metadata transaction failure deletes the file; crash leaves only orphan files; `npm run documents:reconcile` reports orphans/strays/missing/checksum mismatches and can delete old orphans.
- [x] Identical re-upload returns the existing document (no duplicates).
- [x] Per-user upload rate limit (60 / 10 min, in memory).
- [x] All `/api/v1` responses `Cache-Control: no-store`; service worker still has no runtime caching.
- [x] Web: optional attachments step in the expense form (choose files / take photo, previews, size/type, remove before upload, per-file progress, retry after partial failure without losing the draft or duplicating the expense), documents card on the expense page (thumbnails, view, download, remove with reason, add more, show removed), paperclip in the list.

Automated verification executed:

- `server`: `tsc --noEmit` ✔, `npm run build` ✔.
- `web`: `tsc --noEmit` ✔, `npm run build` ✔ (generated `sw.js` checked: only the navigation route with the `/api` denylist, no runtime caching), `vitest run` 33/33 ✔.
- `server/tests/documents.critical.integration.test.ts` against the PostgreSQL test database (applies 0005): **10/10 passed** — type detection and filename sanitising; auth/CSRF/binary-route restriction; all four types upload, metadata without storage key, private streaming headers, byte-exact download; disguised/malformed/empty/oversized/mismatched files rejected, exactly 10 MB accepted; identical re-upload not duplicated; 10-file limit under 12 concurrent uploads; no cross-expense access; removal with reason, owner-only access to removed files, history, DB refuses DELETE; voided expense rules; failed DB write leaves no file; reconciliation detects orphan and missing files.
- Existing `env`, `app`, `expenses` and `suppliers` tests re-run after the change: all passed (env fixtures updated for the new production requirement).

Not verified (deferred to manual testing): real browsers/devices (camera capture, file pickers, upload progress, inline PDF viewing, thumbnails), behaviour on a FAT/exFAT volume, large real photos over a slow network.

Known limitations: one file per upload request (the web app sends several sequentially); the rate limiter is per API process; only the local adapter exists; removed documents keep their files indefinitely (no purge procedure yet).

## Stage 3C — Supplier payments and supplier ledger

Implemented (details: [architecture.md → Supplier payments](architecture.md#supplier-payments-and-ledger-stage-3c), [database.md → 0006](database.md)):

- [x] Payments are separate transactions, never expenses; supplier payable derived from bills, paid-at-purchase and active allocations (view `supplier_balances`); no editable balance.
- [x] Record payment (supplier, amount, mode, date, reference, notes) with optional allocations in the same transaction; idempotent creation.
- [x] Full, partial and multi-bill allocation; allocate later; unallocated amounts shown everywhere (payment, supplier, list totals, summary).
- [x] Limits enforced server-side under row locks and by DB triggers (payment total, bill payable, same supplier, no voided bills / reversed payments).
- [x] Corrections: metadata edit (versioned), release allocation (reason), reverse payment (reason, version, releases allocations, final, once). Nothing deleted.
- [x] Expense rules updated: outstanding subtracts allocations; allocated bills cannot be voided, moved or reduced below allocations.
- [x] Supplier ledger (bills, paid at purchase, payments; credit/debit; running balance; status; filters by date, type, status; explanation; no invented opening balance).
- [x] Supplier summary on the Suppliers page; supplier detail page; payments list; payment detail page.
- [x] Audit on payment and on the affected expenses.

Automated verification executed:

- `server`: `tsc --noEmit` ✔, `npm run build` ✔. `web`: `tsc --noEmit` ✔, `npm run build` ✔, `vitest run` 33/33 ✔.
- `server/tests/supplierPayments.critical.integration.test.ts` (applies 0006 to the test database): **10/10 passed** — auth; payment is not an expense; partial allocation and derived balances (bills/at-purchase/payments/allocated/payable/unallocated/net); allocate later across bills, refusals above bill payable or payment unallocated, duplicates; other supplier / voided bill / zero refused, DB trigger refuses cross-supplier insert; **three concurrent allocations → exactly one succeeds**; allocated bill cannot be voided/moved/reduced (API and direct SQL), release with reason then void works, expense history; reversal (version check, releases allocations, balances restored, second reversal 409, no allocate/edit after, DB refuses delete/amount change/un-reverse); metadata edit versioned and audited, amount not editable, future date refused; idempotent creation under 3 concurrent retries; **ledger reconciliation** (counted credits − debits = net balance = last running balance; payable = Σ open bills; filters do not change balances; summary = Σ supplier balances).
- Re-run after the change: expenses, suppliers and documents suites all passed (34 tests together with 3C).

Not verified (deferred to manual testing): all new screens in a real browser/phone; the allocation editor's usability on a small screen; keyboard/screen-reader pass.

Known limitations: one payment cannot be split across suppliers (by design); no opening-balance entries (balances start with the first recorded bill); the ledger returns at most 2,000 rows per request.

## Stage 3D — Customer management and customer ledger

Implemented (details: [architecture.md → Customers](architecture.md#customers-and-customer-ledger-stage-3d), [database.md → 0007](database.md)):

- [x] Customers: create, view, edit, search (name / phone / phone digits), archive, reactivate; never deleted; archived customers keep their ledger. Duplicate rule: one active customer per phone number (last 10 digits); names may repeat.
- [x] Ledger entries: due, due payment (against one due; partial and multiple payments), advance, advance refund. No sales/orders/billing/inventory.
- [x] Due and advance are independent derived balances (view `customer_balances`); never netted anywhere in API or UI.
- [x] Refund ≤ available advance; due payment ≤ remaining due; same customer; reversed dues not payable — server-side under a customer row lock, plus deferred DB trigger.
- [x] Corrections by reversal (reason, version, once); refused when it would break the ledger (due with payments, already-refunded advance). Values immutable, rows never deleted.
- [x] Idempotent recording of entries; audit for customer profile and every entry (create, reverse).
- [x] Ledger with due ± / advance ± effects, two running balances, status, filters (date, type, status), brought-forward balances, plain-language explanation.
- [x] Web: customers list (summary, search, filters), customer page (two balance cards, four actions, unpaid dues with quick receive, recent entries, details/archive/history), entry dialog with refund confirmation, entry page with reversal, ledger page.

Automated verification executed:

- `server/tests/customers.critical.integration.test.ts` (applies 0007): **11/11 passed** (see testing-plan.md for the list), including 5 concurrent refunds → 1 succeeds and 4 concurrent due payments → 1 succeeds, the ₹5,000 due + ₹2,000 advance example, and ledger reconciliation for every customer.

## Final verification (end of Stage 3D)

Commands executed on 2026-11-01 (Windows, PostgreSQL test database `shop_books_test`):

| Command | Result |
|---|---|
| `npm run typecheck` (server + web) | ✔ no errors |
| `npm --prefix server exec vitest run` (full server suite) | ✔ 10 files, **112/112** tests passed, none skipped |
| `npx vitest run tests/migrations.upgrade.integration.test.ts` (added after the full run) | ✔ 1/1 |
| `npm --prefix web exec vitest run` | ✔ 3 files, 33/33 |
| `npm run build` (server + web) | ✔ (web: pre-existing "chunk > 500 kB" warning, also present before these stages) |
| `npm run db:status` (test) | 0001–0007 applied |
| `npm run db:status` (development) | 0001–0004 applied; **0005–0007 pending (deliberately not applied)** |
| Browser walkthrough (Edge headless, desktop 1280 px + phone 375 px, API on the test DB) | 34 checks, 33 passed; the 1 flagged item is expected HTTP-status console messages, no JS errors |

Not verified: real phones (camera, pickers, keyboard), iOS Safari, inline PDF viewing, screen readers, behaviour on the owner's real data (migrations not applied to development or production), a non-local storage provider (none exists yet), load/performance with large ledgers.
