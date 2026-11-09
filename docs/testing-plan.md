# Testing plan

The project follows a **build-first** approach: each stage runs only the essential checks needed to catch integration errors and prove critical security behaviour. Comprehensive testing happens in a final, project-wide test phase. This document is the backlog for that phase.

## What runs today

| Suite | Command | Needs |
|---|---|---|
| Server unit + integration (Vitest, Supertest) | `npm --prefix server test` | `.env.test` pointing at **exactly** `shop_books_test` for the integration files (otherwise they are skipped, never reported as passing; any other database name, an unreadable name or `SHOP_BOOKS_ENV_FILE` aborts the run). The suite truncates that database. |
| Web unit/component (Vitest, Testing Library) | `npm --prefix web test` | nothing |
| E2E smoke (Playwright, production build) | `npm run test:e2e` | a browser (`PW_CHANNEL=msedge` or `npx playwright install chromium`) |

Existing coverage worth knowing:

- `server/tests/env.test.ts`: configuration validation, database isolation, cookie settings.
- `server/tests/app.test.ts`: health, deny-by-default 401, headers, CORS, body limits, error handler.
- `server/tests/migrator.unit.test.ts`, `database.integration.test.ts`: migration runner, advisory lock, environment guard.
- `server/tests/auth.critical.integration.test.ts`: **Stage 2 critical paths only**: public surface, generic login errors, cookie attributes, token hashing, Origin/JSON/CSRF enforcement, idle and absolute expiry, manager lifecycle (temporary password, forced change, role denial, deactivation, owner reset), single-owner constraint, concurrent lockout, per-IP 429, session + CSRF rotation on password change, racing revocation, session-bound writes, owner recovery logic.
- `server/tests/expenses.critical.integration.test.ts`: **Stage 3A critical paths only**: auth required, category uniqueness, expense without a photo, money as exact strings, derived outstanding, field-level validation (incl. number-typed money rejected), edit with version + 409 + "below paid" rule + before/after history, void/restore with reasons and totals exclusion, archived-category rules, server-side search/pagination/limits, DB refusal of expense delete and audit modification.
- `server/tests/suppliers.critical.integration.test.ts`: **supplier enhancement critical paths only**: supplier create with linked categories, name normalisation + case-insensitive uniqueness, phone validation, auth required; link/unlink with audit and version bump, archived category refused, stale PATCH 409, expenses untouched by link removal; archived supplier refused for new expenses but kept on edits; free-text `supplierName` rejected; supplier search and `supplierId` filter; idempotency (replay with normalised-equal body, `Idempotent-Replayed`, 409 on different body, 5 concurrent requests → one expense, per-user scope, failed request stores nothing, malformed key 400); **0004 backfill** in an isolated schema (conservative merge, every named expense linked, typed names/`updated_at`/`version` preserved, report + possible duplicates, `import` audit rows).
- `server/tests/documents.critical.integration.test.ts`: **Stage 3B critical paths only** (10 tests): type detection and filename sanitising; auth/CSRF/binary-route restriction; all four types; private streaming headers and byte-exact download; disguised/malformed/empty/oversized/mismatched files; exactly 10 MB accepted; duplicate upload; 10-per-expense limit under 12 concurrent uploads; no cross-expense access; removal with reason, owner-only removed files, history, DB refuses delete; voided-expense rules; failed DB write leaves no file; reconciliation finds orphans and missing files.
- `server/tests/supplierPayments.critical.integration.test.ts`: **Stage 3C critical paths only** (10 tests): payment is not an expense; partial, multi-bill and later allocation; limits; other supplier / voided / zero refused (API and DB trigger); 3 concurrent allocations → 1 succeeds; allocated bills cannot be voided, moved or reduced; release; reversal (once, version, releases allocations, DB guards); metadata edits; idempotent creation; ledger reconciliation and summary.
- `server/tests/customers.critical.integration.test.ts`: **Stage 3D critical paths only** (11 tests): customer CRUD, phone duplicates, archive/reactivate; ₹5,000 due + ₹2,000 advance never netted; refund ≤ advance; partial and multiple due payments; validation; 5 concurrent refunds → 1 and 4 concurrent payments → 1; reversal rules (due with payments, refunded advance, once, version) and DB backstops; archived customers; no IDOR; idempotency; ledger reconciliation and summary.
- `server/tests/migrations.upgrade.integration.test.ts`: 0005–0007 applied on top of a 0004 database **with data**: existing rows unchanged, derived supplier balances correct, existing expenses still editable, re-run is a no-op.
- `server/tests/reports.critical.integration.test.ts`: **Stage 4** (10 tests): period presets resolved to exact Asia/Kolkata ranges (week, month, previous month across year end, leap February, quarter, year, custom, all time, invalid ranges), the IST date flip at 18:30 UTC, exact percentage change; dashboard figures equal the expense list totals and the supplier/customer summaries; voided and previous-month expenses excluded; **supplier payments not added to expenses**; customer dues/advances separate; paid-status, payment-mode and supplier breakdowns add up to the total; category shares and previous-period change; supplier report payable unchanged by the period, archived supplier kept, outstanding-only filter; customer due/advance reports reconcile with the summary; transaction history counts per type, pagination, cancelled rows, type filter, invalid filters rejected; monthly summary equals the dashboard.
- `server/tests/exports.critical.integration.test.ts`: **Stage 5 exports** (6 tests): formula-injection guard (unit); auth and filter validation; the expense workbook (header block, frozen header, auto-filter, INR format, dates, voided rows) totals equal the report API; **no cell is a formula** and user text starting with = + - @ is stored as text; supplier, customer due/advance, supplier/customer ledger, supplier payment, transaction and category exports agree with the API and respect filters; monthly workbook sheets and figures, dues and advances separate.
- `server/tests/monthlyReports.critical.integration.test.ts`: **Stage 5 e-mail** (7 tests): owner-only API (manager 403, anonymous 401), validation, duplicate recipient (case-insensitive), audit of every change; scheduler waits for the Asia/Kolkata delivery time, sends the previous month once per active recipient (not to removed ones) with HTML/text/Excel, dues and advances separate; re-running never re-sends; **4 concurrent schedulers → 1 job, each recipient once**; retry with 5-minute backoff without re-sending to others; delivered rows final and attempt log append-only (DB); permanent failure → owner retry → sent; manual "send now" and duplicate refusal; **crash during sending → failed "may or may not have been delivered", not re-sent**; `none` adapter fails honestly, `outbox` records "simulated"; preview.
- `server/tests/stage6.reconciliation.integration.test.ts`: **Stage 6** (18 tests): a seeded random history of ~150 mixed operations through the API (expenses, voids/restores, supplier payments with allocations, later allocations, releases, reversals, customer dues/payments/advances/refunds incl. deliberate over-refunds, reversals, archive/reactivate), then **every surface compared with an independent BigInt recomputation from the raw tables**: raw-row invariants; supplier list, balance, ledger (net and running balance), open bills, summary, supplier report, expense outstanding; customer list, ledgers, summary, due/advance reports; dashboard/expense/category reports and the expense list for this month, previous month, quarter and year (incl. previous-period figures and current balances independent of the period); transaction counts; Excel exports (expenses, suppliers, customer dues/advances, categories, transactions, supplier payments, monthly summary, supplier ledgers) and no formula cells. Seed via `S6_SEED` (run with 4 seeds). Plus races between different operations (void vs allocate, reverse vs allocate, release vs reverse vs release, refund vs advance reversal, due payment vs due reversal, expense edit vs allocation), a route inventory (every route 401 without a session, owner-only routes 403 for managers, CSRF on every write), revoked-session writes refused, storage traversal keys refused and no static serving, and the 20,000/20,001-row export boundary.
- `server/tests/crossOrigin.integration.test.ts`: **staging arrangement** (4 tests): exact-origin CORS with credentials and preflight for the app headers, `__Host-` cookie with `Secure; HttpOnly; SameSite=None; Path=/` and no Domain, `TRUST_PROXY` client address, CSRF/Origin/content-type still enforced cross-site, cross-origin upload, CORS-mode document fetch with `CORP: same-origin` kept, exposed `Content-Disposition`.
- `web/src/lib/api-base-url.test.ts`: `VITE_API_BASE_URL` parsing and the "not configured" rule.
- `web/src/app/App.test.tsx`: login flow, forced password change, owner-only screen.
- `web/src/lib/lib.test.ts`: also the idempotency-key generator (incl. the non-secure-context fallback).

The supplier enhancement was walked through once in Edge (desktop 1280 px and iPhone 13 profile) against the real API with a throwaway script: **42 checks**, after upgrading a Stage 3A database with messy typed supplier names through the real `db:migrate` CLI and `suppliers:backfill-report`. This includes migrated suppliers and import history, inline category creation and duplicate handling, field order and keyboards, supplier picker, suggestions, link offer, add-supplier-keeps-form-values, concurrent idempotency through the browser, archived supplier hidden, bottom navigation and More sheet, no horizontal overflow on 7 pages, the save button clear of the bottom bar, 44 px touch targets, sheet fits phone, and manager access.

Stage 3A was also walked through once in a real browser (Edge) against the real API with a throwaway script (27 checks: categories, add/validate/edit/stale-edit/void/restore, history, filters, sort, archived categories, phone layout). That flow should become a permanent Playwright spec (below).

Stages 3B–3D were walked through once in Edge (headless; desktop 1280 px and phone 375 px) against the real API on the **test** database with a throwaway script: **34 checks, 33 passed**; the remaining check only flagged expected HTTP status messages in the console (the login page's `/auth/me` 401 and the deliberately rejected upload's 400) — no JavaScript errors. Covered: expense with a real photo (preview, upload, thumbnail through the authenticated API, 401 without a session, `no-store`), disguised file rejected with a message, removal with reason and history; supplier summary, supplier page, record payment with "Fill oldest bills first", payable reduced, ledger rows; customer creation, ₹5,000 due + ₹2,000 advance shown separately, refund above advance blocked, refund confirmation, due payment, customer ledger; no horizontal overflow on 11 new or changed pages at 375 px; refund sheet fits the phone screen. One layout issue found on the first run (a customer action label running to the screen edge at 375 px) was fixed and re-checked in the final run (no clipped buttons or links).

Stages 4–5 were walked through once in Edge (headless; desktop 1280 px, phone 375 px) against the real API on the **test** database with the scheduler running and the development outbox: **37 checks, all passed in the final run** (the first run found horizontal overflow on the dashboard and category report at 375 px — fixed by letting cards shrink inside grids — and one script locator error). Covered: dashboard groups and figures equal to the API, period selector and custom range, chart table view, all 8 report pages, Excel downloads from the expense report, supplier ledger and monthly summary opened with ExcelJS, formula text stored as text, outbox warning, adding a recipient, sandboxed preview, "send now" processed by the scheduler and shown as **Simulated (not sent)**, manager cannot see or call the e-mail settings but can export, no overflow on 9 pages at 375 px, no JavaScript errors.

Note: the auth, expenses, suppliers, documents, supplier-payments, customers, reports, exports and monthly-report integration tests **truncate** `users` (cascading to every table that references it) in the test database. The suppliers test also creates and drops a throw-away schema.

## Deferred tests: final test phase

### Authentication
- [ ] Login succeeds with the e-mail in any letter case and surrounding spaces.
- [ ] Every failure mode (unknown e-mail, wrong password, locked, deactivated, malformed body, over-long password) returns the identical status, code and message.
- [ ] Response-time comparison of unknown-e-mail vs wrong-password vs locked (statistical, many samples) stays within an acceptable band.
- [ ] Login while already signed in revokes the previous session of that browser.
- [ ] `/auth/me` responses carry `Cache-Control: no-store`.
- [ ] Passwords and tokens never appear in logs (capture pino output during a full flow and scan it).
- [ ] Argon2id parameters are present in stored hashes (`m=19456,t=2,p=1`).

### Authorization
- [ ] Route inventory test: enumerate every registered route and assert that only `GET /health` and `POST /auth/login` are reachable without a session.
- [ ] Every `/users` endpoint returns 403 for a manager (GET, POST, PATCH, reset-password, revoke-sessions).
- [ ] Role and identity cannot be influenced by request body, query or headers (e.g. `role`, `userId` fields are rejected or ignored).
- [ ] PATCH `/users/:id` rejects unknown fields (`role`, `email`, `passwordHash`) with 400.
- [ ] Invalid / unknown user ids return 404 without leaking details.
- [ ] Future financial routes mounted below `requirePasswordCurrent` are reachable by managers and owners (managers are **not** read-only).

### Sessions
- [ ] Idle timeout boundary (30 days), rolling renewal and the 90-day hard maximum age (covered in `server/tests/sessions.rolling.integration.test.ts`).
- [ ] `last_seen_at` is touched at most once per minute.
- [ ] Revocation on: logout, password change (all sessions, new one issued), owner reset, deactivation, "sign out everywhere".
- [ ] A revoked session cannot be revived by re-sending the old cookie.
- [ ] Concurrent requests during revocation: in-flight request completes, all later ones get 401.
- [ ] Malformed / oversized cookies are rejected cheaply and cleared.
- [ ] Production cookie: `__Host-sb_session`, `Secure`, `HttpOnly`, `Path=/`, no `Domain`, correct `SameSite`, expiry = absolute lifetime.

### CSRF and request guards
- [ ] All state-changing endpoints reject: missing Origin and Referer; foreign Origin; foreign Referer; `Origin: null`; non-JSON content types (form, multipart, text/plain); missing, wrong, or other-session CSRF token.
- [ ] CSRF token rotates after password change and after re-login.
- [ ] `SESSION_SECRET` rotation invalidates outstanding CSRF tokens; the frontend recovers after reload.
- [ ] CORS preflight allows `X-CSRF-Token` only for configured origins.

### Lockout and rate limiting
- [ ] Exactly 5 failures lock; the 4th does not.
- [ ] Progressive durations 15 → 30 → 60 → 120 → 240 min, capped at 4 h.
- [ ] Attempts during a lock do not extend it and do not increase counters.
- [ ] Successful login and owner reset clear the counters.
- [ ] Lock state survives an API restart.
- [ ] Concurrency: many parallel wrong attempts produce exactly one lockout; parallel correct + wrong attempts never bypass a lock.
- [ ] Per-IP limit: 20 failures in 15 min → 429 with `Retry-After`; window expiry restores access; behaviour behind a reverse proxy with `TRUST_PROXY=true` (and that spoofed `X-Forwarded-For` is ignored when it is false).
- [ ] Wrong *current* password on change-password counts toward the lockout.

### Owner bootstrap (`npm run owner:create`)
- [ ] Refuses on an unmigrated database, and when an owner already exists (including a race of two simultaneous runs → exactly one owner).
- [ ] Interactive TTY: password is not echoed; Ctrl+C aborts cleanly; backspace works. *(Only piped input was verified in Stage 2.)*
- [ ] Validation: bad e-mail, empty name, short password, mismatched confirmation, three-strike abort.
- [ ] Neither password nor hash is printed or logged; an `owner_bootstrapped` event is recorded.
- [ ] Works from the compiled build (`owner:create:built`) with `NODE_ENV=production`.

### User management
- [ ] Create manager: e-mail normalisation, duplicate e-mail (case-insensitive) → 409, name limits, temporary password format/entropy, `must_change_password`.
- [ ] Owner cannot deactivate the owner account (API 409 and DB constraint).
- [ ] Deactivated users cannot sign in or use existing sessions; reactivation restores sign-in but not old sessions.
- [ ] Owner cannot reset their own password via `/users/:id/reset-password` (400).
- [ ] Each action writes the expected `auth_events` row with actor and target.

### Password reset and first-login change
- [ ] Temporary password must be changed before any other API use (403 `PASSWORD_CHANGE_REQUIRED`), including after re-login.
- [ ] New password must differ from the current one and meet the policy (12–128 chars, not blank).
- [ ] After change: other sessions revoked, current browser gets a new session and CSRF token.

### Frontend
- [ ] Loading screen shown while the session is checked; no protected content flashes.
- [ ] Session expiry mid-use (any 401) returns to login and clears cached data.
- [ ] Users page: create, deactivate/reactivate, reset, sign-out-everywhere flows incl. confirmations and error states; temporary password shown once and copyable.
- [ ] Keyboard and screen-reader pass over login, change-password and users pages.
- [ ] E2E (Playwright) full flow against a running API: owner login → create manager → manager forced change → role gating → deactivation → logout. *(Run once manually in Stage 2 via a throwaway script; to be added to the suite.)*

### Carried over from Stage 1
- [ ] PWA installation on a real Android and iOS device.
- [ ] Graceful shutdown on the production host (SIGTERM drains requests and closes the pool).
- [ ] Running against the owner's own PostgreSQL instance (only disposable instances used so far).

### Owner recovery (`npm run owner:reset-password`)
- [ ] Interactive TTY run end to end (hidden input, confirmation, success message). *(Stage 2 verified the refusal of non-interactive input and the underlying `resetOwnerPassword()` logic, not an interactive session.)*
- [ ] Refuses: unmigrated database, no owner, more than one owner (simulate by dropping the index in a throwaway DB), e-mail of a manager, unknown e-mail.
- [ ] Afterwards: all owner sessions revoked, lockout cleared, `must_change_password = true`, `password_reset` event with `via = "cli"`, no password/hash in output.

### Session-bound writes
- [ ] Every state-changing service uses `withSessionTransaction` (static check / route inventory), including all future financial modules.
- [ ] Race: a write in flight when its session is revoked either commits before the revocation or is refused with 401 (verified once for the helper in Stage 2; repeat per module).

### Expense categories (Stage 3A)
- [ ] Create/rename: trimming, 80/500 limits, case-insensitive duplicate among active → 409; archived name may be reused; reactivating a category whose name is now taken → 409.
- [ ] Archive/reactivate audited (`archive`/`reactivate` events with before/after); no-op PATCH writes nothing.
- [ ] Archived category: hidden from `status=active`, rejected for new expenses and for category *changes*, kept by existing expenses (including edits of other fields).
- [ ] Race: archiving a category while an expense using it is being created (share lock) never leaves a new expense on an archived category.
- [ ] Unknown/invalid ids → 404; unknown body fields → 400.

### Expenses (Stage 3A)
- [ ] Money validation matrix: `0`, negatives, 3 decimals, 13 integer digits, leading zeros, spaces, numbers instead of strings, max `999999999999.99`; normalisation (`"5"` → `"5.00"`).
- [ ] Payment rules: paid = amount, paid = 0 with/without mode, paid > 0 without mode, invalid mode.
- [ ] Date rules: today (IST) accepted around midnight IST/UTC boundaries; tomorrow rejected; invalid dates (`2026-02-30`); before 2000 rejected.
- [ ] Create without any document → 201 (permanent regression test; documents arrive in 3B).
- [ ] Edit: each field change produces exactly the expected `changes` entry; no-op edit writes no audit row and keeps the version; category change requires active; amount below paid → 400 with the explanatory message; editing voided → 409.
- [ ] Concurrency: two simultaneous edits with the same version → exactly one 200, one 409; edit vs void race; void vs void → one succeeds, one 409.
- [ ] Void/restore: reason required (blank/whitespace/501 chars rejected); version checks; restore of active → 409; values unchanged by void; repeated void/restore cycles fully recorded.
- [ ] List: every filter alone and combined; `q` with `%`, `_`, `\`; date range inclusive bounds; amount bounds inclusive; `paymentMode=none`; status `active`/`voided`/`all`; each sort both directions with stable tie-break; pagination edges (last page, page beyond end, pageSize 1/100/101).
- [ ] Totals equal the sum of all matching non-voided rows across pages (reconciliation); voided rows never counted.
- [ ] `GET /expenses/recorders` returns names only (no e-mails) and is available to managers.
- [ ] Audit: one event per change, same transaction (force a failure after the audit insert → neither row persists); history ordering; snapshots never contain secrets; actor is the session user.
- [ ] DB guarantees: DELETE on `expenses` and UPDATE/DELETE on `financial_audit_events` rejected; CHECK constraints reject invalid rows inserted directly.
- [ ] Managers have full create/edit/void/restore rights (not read-only).

### Expenses UI (Stage 3A)
- [ ] Playwright spec of the full flow (desktop + phone), including the stale-edit conflict message and that a stale form keeps getting 409 after background refetches.
- [ ] Double-tap on "Save expense" creates exactly one expense (UI guard + idempotency key); simulated lost response + retry from the same form replays instead of duplicating.
- [ ] Filters persist in the URL (back/forward, reload, shared link).
- [ ] Reason dialog: keyboard (Esc, focus trap), required reason, error display, works without `showModal` support.
- [ ] Money formatting (Indian grouping) and dates (IST) everywhere; archived category shown as "(archived)".

### Suppliers (Stage 3A enhancement)
- [ ] Validation matrix: name length/whitespace/Unicode spaces (JS vs PostgreSQL `\s` differences must not cause 500s), phone formats, address/notes limits, unknown fields 400, invalid ids 404.
- [ ] Reactivating a supplier whose name is now used by another active supplier → 409; archived name reusable.
- [ ] `categoryIds` set semantics: add+remove in one PATCH produce exactly the expected link/unlink events; duplicates in the array ignored; keeping an already-linked archived category allowed, adding one refused; linking to an archived supplier → 409.
- [ ] No-op PATCH (same values, same links) writes nothing and keeps the version.
- [ ] Races: two PATCHes with the same version → one 409; link endpoint vs PATCH; archiving a supplier while an expense using it is being created (share lock).
- [ ] List: search by phone, prefix-first ordering, `%`/`_` literal, status filters, pagination edges; `expenseCount` correct.
- [ ] History: update/archive/reactivate diffs; link events show category names; `import` events show "System (data migration)".
- [ ] Expenses: changing supplier requires active; `supplierId` filter; search matches supplier name and legacy typed name; history shows supplier name changes.

### Migration 0004 backfill
- [ ] Larger synthetic data set (thousands of expenses, many spellings) completes in one transaction; deterministic choice of canonical spelling; idempotent `suppliers:backfill-report`.
- [ ] Names that are only whitespace variants with tabs/newlines; names at the 120-character limit.
- [ ] Failure path: forcing an unlinked expense aborts the migration and leaves 0003 state intact.
- [ ] Applied against a copy of the owner's real development database before production.

### Idempotency
- [ ] Key format edges (15/16/100/101 chars, illegal characters); header absent still works (no idempotency).
- [ ] Same key, same body after the expense was edited or voided → replays the original 201 body (documented behaviour).
- [ ] Session revoked between original and retry → 401 (no replay without a live session).
- [ ] Retention cleanup (30 days) never deletes newer keys; batched.

### Supplier & redesigned UI
- [ ] Playwright spec of the supplier flows and redesigned form (convert the 42-check walk-through), desktop + phone, plus real-device checks on Android Chrome and iOS Safari (safe areas, keyboard covering inputs, native date/select pickers inside sheets).
- [ ] Supplier picker keyboard and screen-reader behaviour (combobox/listbox semantics, `aria-activedescendant`), very long names, no results, slow network.
- [ ] Category select keeps the visible choice when the supplier (and so the optgroups) changes (regression for a bug found in the walk-through).
- [ ] Supplier edit dialog: stale version → 409 message; inline category creation when the name exists only as **archived** (creates a new active one).
- [ ] Accessibility pass: contrast of the tokens (warning text on white), focus visibility, 44 px targets, reduced motion.

### Retention cleanup (when implemented; policy in [maintenance.md](maintenance.md))
- [ ] Sessions ended more than 90 days ago are deleted; ended less than 90 days ago are kept.
- [ ] **Active sessions are never deleted**, including the boundary cases just inside the 30-day idle limit and the rolling expiry.
- [ ] `auth_events` older than 12 months deleted, newer kept.
- [ ] Batching: large volumes processed in bounded batches; interrupting and re-running converges (idempotent).

### Bill documents (Stage 3B)
- [ ] Real devices: Android Chrome and iOS Safari file pickers, **Take photo** (camera capture, HEIC → JPEG), large real photos (5–10 MB) over a slow mobile connection; progress bar accuracy.
- [ ] Inline viewing of PDFs and images in each browser (new tab); download file names with non-ASCII characters.
- [ ] Malicious inputs: polyglot files (valid JPEG header + HTML/JS payload), PDFs with JavaScript, SVG renamed to .png, truncated files, 10 MB + 1 byte, file names with `../`, NUL, RTL-override characters, 300+ characters.
- [ ] Concurrency: parallel uploads from two users to one expense around the limit; upload racing a void.
- [ ] Failure injection: storage write failure (read-only directory, disk full), DB failure after the storage write, process killed mid-upload → reconciliation reports orphans/strays; `--delete-orphans` respects the grace period and never deletes referenced files.
- [ ] Retry after a partial failure in the expense form: same idempotency key, no duplicate expense, only failed files re-sent.
- [ ] Service worker: no document or API response ever appears in Cache Storage (DevTools).
- [ ] Rate limit: 61st upload within 10 minutes → 429 with `Retry-After`.
- [ ] Backup/restore drill: DB dump + folder copy restored elsewhere; reconciliation reports 0 missing.

### Supplier payments and ledger (Stage 3C)
- [ ] Allocation matrix: exact remaining amounts, ₹0.01 left, 100 bills in one request, bill of another supplier, bill without supplier, bill voided between loading the form and saving.
- [ ] Concurrency: allocation vs expense edit/void on the same bill; release vs allocate; reverse vs allocate on the same payment; two reversals at once.
- [ ] Ledger: ordering of same-day entries, brought-forward with `from`, type/status filters, 2,000-row truncation, archived supplier, supplier with only payments (negative net balance).
- [ ] Reconciliation job (SQL): for every supplier, `supplier_balances` equals a recomputation from raw rows; Σ allocations per bill ≤ payable; no allocation on a voided bill or reversed payment.
- [ ] UI: allocation editor at 320 px, keyboard-only use, screen-reader announcement of totals, allocate dialog double tap (idempotent).
- [ ] Expense form when editing a bill with allocations: outstanding display and refusal messages.

### Customers and customer ledger (Stage 3D)
- [ ] Validation matrix for every entry type (missing/extra fields, payment-mode rules, description rules, dates around IST midnight).
- [ ] Phone duplicate rule: country code, leading zero, spaces/dashes, fewer than 10 digits, reactivation conflicts.
- [ ] Reversal chains: payment → due, refund → advance; the wrong order is refused with clear messages.
- [ ] Concurrency: refund vs advance reversal; payment vs due reversal; many customers in parallel (no cross-customer blocking).
- [ ] Reconciliation job (SQL): `customer_balances` equals a recomputation; no negative advance; Σ payments per due ≤ due.
- [ ] UI: the two balances are never shown as one net number anywhere; refund confirmation; dialogs with the phone keyboard open; screen-reader labels for ± effects.

### Dashboard and reports (Stage 4)
- [ ] Period boundaries around midnight IST (an expense entered at 00:10 IST on the 1st belongs to the new month); week starting Monday; quarter/year rollovers; custom ranges of 1 day and 5 years.
- [ ] Reconciliation property test: random sequences of expenses, voids, payments, allocations, reversals and customer entries; every dashboard/report figure equals an independent recomputation from raw rows.
- [ ] Performance with realistic volume (e.g. 50,000 expenses, 10,000 payments, 20,000 customer entries): dashboard < 1 s, `EXPLAIN ANALYZE` of every report query, index usage.
- [ ] UI: every chart's table view, keyboard focus on chart bars and tooltips, screen-reader labels, filter persistence in the URL, empty states, very long names.
- [ ] Archived categories/suppliers/customers in every report and export.

### Excel exports (Stage 5)
- [ ] Open every workbook in **Microsoft Excel (Windows, Android)** and **LibreOffice**: formatting, ₹ symbol, frozen panes, filters, sorting, date filters, no repair prompts. *(Only ExcelJS read-back was automated.)*
- [ ] Formula-injection corpus (=, +, -, @, tab, CR, DDE strings like `=cmd|' /C calc'!A0`) in every text column of every export.
- [ ] Export limit: 20,000 / 20,001 rows; memory use for the largest export; 31st export within 10 minutes → 429.
- [ ] Downloads on iOS Safari and Android Chrome (file name, opening in Excel/Sheets).

### Monthly e-mail (Stage 5)
- [ ] With the real provider adapter (when implemented): delivery to Gmail/Outlook, rendering of the HTML in major clients, plain-text part, attachment opening, SPF/DKIM, provider error mapping (retryable vs permanent), provider idempotency key.
- [ ] Scheduler under real time: day 28 and 23:59 deliveries, server restart around the delivery minute, two API instances, database outage during a tick, clock skew.
- [ ] Missed months: server off for two months → only the latest month automatic; earlier one via "Send a month now".
- [ ] Recipient changes between job creation and sending; deactivating a recipient with a pending delivery (still sent; document or change).
- [ ] Retention cleanup script for deliveries/attempts (24 months).

### Consolidated final test plan (all stages)

| Layer | Scope |
|---|---|
| Unit (Vitest) | money parsing/formatting (server + web), date rules, document type detection and filename sanitising, allocation editor helpers (`draftProblems`, `draftToAllocations`), idempotency hashing |
| PostgreSQL integration | every migration on an empty DB **and** on a copy of real data at 0004; every CHECK/trigger via direct SQL attempts; views vs raw recomputation; append-only audit |
| API (Supertest) | route inventory (everything authenticated except health/login), owner vs manager matrix, unknown fields rejected everywhere, error envelopes never leaking SQL, idempotency for all creation operations |
| Financial reconciliation | expense totals, supplier balances and customer balances recomputed independently after randomised operation sequences (property-based) |
| Concurrency | the races listed per stage, repeated (e.g. 50×) to catch flakiness |
| File security | malicious file corpus, path traversal, IDOR on document ids, cache headers, storage permissions |
| Browser (Playwright) | turn the walkthroughs (3A: 27 checks, supplier enhancement: 42, 3B–3D: 34, 4–5: 37) into permanent specs; desktop + phone profiles |
| Scheduler | fake-clock tests for every state transition, plus a soak test with two API processes against one database |
| Spreadsheet compatibility | open every export in Excel and LibreOffice (manual or scripted via LibreOffice headless conversion) |
| PWA / mobile | installability, offline shell, no runtime caching, safe areas, keyboard overlap, real Android/iOS devices |
| Accessibility | keyboard-only flows, focus management in sheets, contrast of warning/primary text, screen-reader pass |

## Open items

Decisions or features that affect testing and are not yet implemented:

- **Ownership transfer.** The schema allows exactly one owner, and roles cannot be changed through the API. Transferring ownership would need a dedicated, audited procedure.
- **Retention cleanup job.** Policy approved ([maintenance.md](maintenance.md)); the scheduled job is not implemented yet.
