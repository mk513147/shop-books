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

**Audit trail for access.** `auth_events` records sign-ins, failures, lockouts, logouts, password changes/resets, user creation/activation/deactivation and session revocations, with actor, IP and user agent. It never contains passwords, hashes or tokens. (Financial audit logging is a later stage.)

**Frontend.** `AuthProvider` loads the session from `GET /auth/me` (a loading screen is shown meanwhile), exposes `login`/`logout`/`changePassword`, and returns to the login screen whenever any API call gets `401` (expired, revoked or deactivated session), clearing cached data. `ProtectedRoute` gates every screen and enforces the first-login password change; `RequireRole` hides owner-only screens. These are conveniences: the API enforces every rule itself.

## Future module organisation

New protected modules are mounted in `server/src/routes/index.ts` **below** `requirePasswordCurrent`, which makes them authenticated, CSRF-protected and unavailable to accounts with a pending password change automatically. Never mount a module above `requireAuth`. Every state-changing service must use `withSessionTransaction(db, sessionId, …)` rather than a plain transaction.

Backend: `server/src/modules/<feature>/` containing `*.routes.ts` (HTTP + validation), `*.service.ts` (business rules, owns transactions), `*.repository.ts` (SQL), registered in `routes/index.ts`. Frontend: `web/src/features/<feature>/` (components, hooks, API calls), pages in `routes/`, registered in `app/AppRoutes.tsx` and `app/navigation.ts`.

## Known deviations from the suggested layout

`web/src/hooks`, `web/src/services` and `server/src/services` were not created: they would be empty. API access lives in `web/src/lib/api-client.ts`; create the folders when there is content for them.
