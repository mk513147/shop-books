# Project status

This is the project's status record (the equivalent of a `PHASE_1_STATUS.md`). It lists what is implemented, how it was verified, and what is still open. "Verified" means an automated check was **actually executed**; nothing here claims manual or real-device testing unless stated.

| Stage | Scope | Status |
|---|---|---|
| 1 | Foundation | Done |
| 2 | Authentication and access control | Done |
| 3A | Categories, expenses, audit, suppliers, idempotent creation, mobile-first design | Done |
| 3B | Bill attachments and private document storage | Implemented, then **postponed** (2026-11-10): switched off in the release, code kept. See [bill-attachments-postponed.md](bill-attachments-postponed.md) |
| 3C | Supplier payments and supplier ledger | Implemented; awaiting owner's manual testing |
| 3D | Customer management and customer ledger | Implemented; awaiting owner's manual testing |
| 4 | Dashboard and financial reports | Implemented; awaiting owner's manual testing |
| 5 | Excel export and automated monthly e-mail reports | Implemented; awaiting owner's manual testing. **E-mail delivery needs a real provider adapter + credentials (not implemented)** |

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

## Verification at the end of Stage 3D

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

## Stage 4 — Dashboard and financial reports

Implemented (details: [architecture.md → Dashboard and reports](architecture.md#dashboard-and-reports-stage-4), migration 0008):

- [x] One reporting service used by dashboard, reports, exports and e-mail; current balances from the same views as the ledgers.
- [x] Periods: today, this week, this month, previous month, this quarter, this year, all time, custom; explicit Asia/Kolkata dates; previous equivalent period for comparisons.
- [x] Dashboard: expense overview (total, count, paid at purchase, settled by later payments, still payable, change vs previous period), supplier payments in period, customer dues/advances activity (separate), current balances (supplier payable and count, unallocated, customer dues and count, customer advances and count — never netted), 6-month trend, recently recorded transactions, quick actions.
- [x] Expense report (totals, count, average, paid/partly/unpaid, payment modes, top suppliers, monthly trend, filters: category, supplier, payment mode, recorded by; paginated detail list via the existing expense API).
- [x] Category analysis (amount, count, share, change vs previous period, archived kept; bars + table).
- [x] Supplier report (period expenses/payments vs current expenses, paid at purchase, allocated, total settled, total payments, unallocated, payable, unpaid bills; filters; paginated; ledger links).
- [x] Customer due report and customer advance report (separate; period added/reduced + current balance; filters; paginated).
- [x] Transaction history across all six transaction types (filters, paginated, links to each record).
- [x] Indexes justified per query; no cache/materialized view (always computed from source rows).
- [x] Mobile-first pages; charts without a library (single hue, focusable, tooltips, table view).

Automated verification: `reports.critical.integration.test.ts` **10/10 passed** (one real defect found and fixed: a UNION without column aliases failed when expenses were filtered out). Browser walkthrough (see testing-plan.md).

## Stage 5 — Excel export and automated monthly e-mail reports

Implemented (details: [architecture.md → Excel exports / Monthly e-mail reports](architecture.md#excel-exports-stage-5), migration 0009):

- [x] ExcelJS added; 10 exports (expenses, categories, supplier outstanding, supplier payments, supplier ledger, customer dues, customer advances, customer ledger, transaction history, monthly summary) built from the same services and filters; header block, INR/date/percent formats, bold totals, frozen headers, auto-filters; formula-injection protection; bounded at 20,000 rows; Excel buttons on every report, both ledgers and the supplier payments list.
- [x] Provider-independent `EmailSender` with `none` (honest failure) and `outbox` (development; "simulated") adapters, and a recording adapter for tests.
- [x] Monthly report content (expenses, categories, payment modes, suppliers, customer dues, customer advances, notes), HTML + plain text + optional Excel attachment.
- [x] PostgreSQL-backed scheduler: advisory lock, unique month jobs and recipient deliveries, `SKIP LOCKED` claims, state machine, retries with backoff, crash recovery without automatic re-send, catch-up after downtime, Asia/Kolkata delivery time.
- [x] Owner page: schedule, recipients, send a month now, preview, delivery history with retry; manager has no access (API 403).
- [x] Settings, recipient changes, manual runs and retries audited.

Automated verification: `exports.critical.integration.test.ts` **6/6**, `monthlyReports.critical.integration.test.ts` **7/7**, upgrade test extended to 0008–0009 **1/1**, `env.test.ts` updated **15/15**. Browser walkthrough 37/37 (final run).

**Not implemented / blocked by missing configuration:** a real e-mail provider adapter (SMTP or HTTP API) and its credentials — until then no e-mail can be delivered (deliveries are recorded as failed or simulated, never as sent). Not verified: opening the workbooks in Microsoft Excel/LibreOffice (only ExcelJS read-back), e-mail rendering in real mail clients, behaviour over real calendar time and with two API processes, performance with large data volumes.

## Expense payment improvements and database separation (2026-11-02, uncommitted)

Implemented:
- [x] Optional expense description (NULL when empty); the category name is shown instead in lists, details, reports and the supplier ledger.
- [x] Several payment methods per expense: `payments` API field, table `expense_payments` (migration 0010, backfilled from `amount_paid`/`payment_mode`), deferred trigger "rows = amount paid", rules in [architecture.md](architecture.md#expenses-and-categories-stage-3a). Supplier bills may stay unpaid or part-paid; other expenses must be paid in full. New supplier bills start **unpaid** in the form; payments the user entered are never changed by choosing or removing a supplier.
- [x] Form: dynamic payment rows (add/remove, focus handling, per-field error messages), live total/allocated/remaining, exact BigInt arithmetic. Reports, Excel exports, supplier ledger and audit history show every method.
- [x] Database separation: `shop_books_dev` (persistent, manual testing, also served by the tunnel profile `.env.staging`) and `shop_books_test` (automated tests only, disposable). Test guards check the URL (local host, exact name, no redirecting query parameters) and the server (`current_database()`, loopback address). `db:migrate` and `documents:reconcile --delete-orphans` need `--confirm-database=<name>` for anything but the local dev/test database. See [database.md](database.md#test-database-isolation).

Verification: see the final report of the change; migration 0010 applied to `shop_books_dev` (after a backup) and `shop_books_test`.

## Stage 6 — Release-readiness review (2026-11-01)

Scope: verification, defect fixing and documentation only; no new business features. Nothing committed, pushed, deployed or migrated outside the test database.

**Defects found and fixed**
1. *Stale reports after changes (web):* no mutation invalidated the dashboard/report queries (30 s cache), so the dashboard could show totals from before a just-recorded expense, payment or customer entry. Fix: every mutation now invalidates `['reports']` (`web/src/app/query-client.ts`).
2. *Monthly e-mail to withdrawn recipients (privacy):* a recipient removed, or whose address was changed, after the month's job was created still received the report. Fix: such deliveries are marked failed and never sent; their manual retry is refused (`RECIPIENT_REMOVED`). Regression test added.
3. *Cross-origin downloads (deployment):* `Content-Disposition`/`Retry-After` were not exposed via CORS, so a frontend on another origin lost Excel file names. Fix: `exposedHeaders`.

**Reviewed without finding defects:** migrations 0001–0009 (order, FKs, unique/check constraints, triggers, append-only audit, idempotency, reversal consistency; the 0004→0009 upgrade test), session-bound writes (every business write uses `withSessionTransaction`; only the scheduler uses system transactions), document validation/storage/IDOR/removed-document access/cleanup/reconciliation, report and export authorization, validation, parameterization and pagination, scheduler locking/state machine/retries/crash handling, `EMAIL_PROVIDER=none` default in production.

**Cosmetic, not changed:** the append-only trigger on `report_delivery_attempts` reuses the audit table's error text ("financial_audit_events is append-only"). Changing it would require editing an already-applied migration (or a new migration); left as is.

**Dependencies:** 9 moderate npm advisories, all inside ExcelJS's dependencies, not reachable; no non-breaking fix exists (npm offers only a downgrade). Details and action in [maintenance.md](maintenance.md#dependency-advisories-reviewed-in-stage-6).

**Verification executed (final run, after all fixes):**

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | ✔ |
| Server suite `vitest run` (PostgreSQL `shop_books_test`) | ✔ **16 files, 161/161**, none skipped |
| — of which `stage6.reconciliation` (random-history reconciliation, cross-operation races, route inventory, revoked sessions, storage safety, export row limit) | ✔ 18/18; reconciliation part also run with seeds 7, 4242, 99991 ✔ |
| — `crossOrigin` (staging arrangement) | ✔ 4/4 |
| — migration upgrade 0004 → 0009 with data | ✔ |
| Web `vitest run` | ✔ 4 files, 36/36 |
| `npm run build` (server + web) | ✔ (pre-existing >500 kB chunk warning) |
| Playwright e2e smoke on the production build (Edge, desktop + mobile profiles) | ✔ 12/12 (incl. manifest validity and "service worker does not cache API responses") |
| `npm audit --omit=dev` (server) | 9 moderate (see above) |

Not re-run in Stage 6: the throw-away browser walkthrough scripts of Stages 3B–5 (last results 34 and 37 checks). UI changes since then are limited to the report-cache invalidation, the thumbnail `crossorigin` attribute and the configuration guard (covered by unit and e2e tests).

## Staging preparation: Vercel frontend + local backend via Cloudflare Tunnel

See [staging-deployment.md](staging-deployment.md). Implemented: `VITE_API_BASE_URL` (one central resolver, build fails on Vercel without it, runtime "not configured" screen), `web/vercel.json` (SPA fallback, cache headers), `HOST`, `COOKIE_SECURE`, `SameSite=None` with Secure, `SHOP_BOOKS_ENV_FILE`, `.env.staging.example`, `web/.env.staging.example`, CORS exposed headers, credentialed thumbnail requests. Verified: build guard (4 scenarios), bundle contains the configured URL, manifest/icons/service worker, cross-origin server behaviour (`crossOrigin.integration.test.ts`). **Not verified (needs your Vercel project, a running tunnel and your phone):** sign-in from the Vercel domain through Cloudflare, cookie acceptance on the phone, PWA installation, camera uploads and bill viewing on the phone.

## Production-readiness checklist

Blocking items are marked **[blocker]**.

- [ ] **[blocker]** Choose hosting; serve web and API over HTTPS, ideally on the **same site** (e.g. `app.` and `api.` of one domain) so the session cookie is first-party (`SameSite=Lax`) and works on iPhone too.
- [ ] **[blocker]** E-mail: implement a real `EmailSender` adapter for the chosen provider, credentials as server environment variables, `EMAIL_FROM` with SPF/DKIM; until then keep `EMAIL_PROVIDER=none` and monthly reports disabled.
- [ ] **[blocker]** Production database: back up, apply migrations 0005–0009 to a **copy** of the real database first, then to production (`db:migrate:built -- --yes`); verify with `db:status`, `documents:reconcile` and supplier balances.
- [ ] **[blocker]** Owner's manual acceptance of Stages 3B–5 (checklists in testing-plan.md / earlier reports) on real phones.
- [ ] Document storage: production `DOCUMENT_STORAGE_DIR` on a backed-up disk (or implement a private object-storage adapter); backup procedure = database dump first, then the folder (maintenance.md).
- [ ] Production env: `NODE_ENV=production`, strong unique `SESSION_SECRET`, `FRONTEND_URL` (https), `TRUST_PROXY` only behind exactly one proxy, `SHOP_NAME`, `HOST` as appropriate.
- [ ] Replace the placeholder PWA icons.
- [ ] Open Excel exports in Microsoft Excel and LibreOffice once.
- [ ] Scheduled maintenance not yet automated: retention cleanups (sessions, auth events, idempotency keys, report deliveries) per maintenance.md.
- [ ] In-memory rate limits (uploads, exports) are per process: acceptable for one instance; revisit if several API instances run.
- [ ] Re-check `npm audit` when ExcelJS 4.4.1 is released.
- [ ] Turn the throw-away browser walkthroughs into permanent Playwright specs (testing-plan.md).
