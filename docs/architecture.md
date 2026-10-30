# Architecture

Status: Stage 1 foundation + Stage 2 authentication and access control. Items marked *(planned)* do not exist yet.

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

The service worker precaches only the built static assets and falls back to `index.html` for navigations (excluding `/api/*`). There is **no runtime caching**: API responses and private documents are never stored. The navigation fallback denylist lives in `web/pwa-config.ts` (`/api` and everything below it). **Rule: every API endpoint and every private-document endpoint (bill photographs, report downloads) must live under `/api/`.** Production must be served over HTTPS (required for installability and service workers).

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
