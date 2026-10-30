# Architecture

Status: describes the Stage 1 foundation. Items marked *(planned)* do not exist yet.

## Responsibilities

**`web/` (browser / PWA)** renders the UI, validates input for convenience (Zod + React Hook Form), and talks to the API only through `src/lib/api-client.ts`. It holds **no secrets** and does **no authoritative financial calculation**; amounts are decimal strings that it only formats for display (`src/lib/money.ts`).

**`server/` (Express API)** is the single authority for validation, authorization *(planned, Stage 2)*, business rules and database access. Every client check is repeated server-side.

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
        6. /api/v1 router  ──▶ module routers (health today)
        7. notFoundHandler      JSON 404
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

## Authentication placeholder

Stage 1 contains no authentication. The web app's `AuthProvider` is a placeholder whose production state is always `unauthenticated`, so every app route redirects to the login screen; the login form validates input but does nothing. A development-only flag (`VITE_PREVIEW_SHELL=true`) lets developers view the empty shell; it is compiled out of production builds: `isShellPreviewEnabled()` requires `import.meta.env.DEV`, which Vite hard-codes to `false` in production bundles, so supplying the variable manually to a production build has no effect (verified by building with the flag forced on and running the e2e suite). Remove the flag entirely once Stage 2 lands. Stage 2 replaces it.

## Future module organisation

Backend: `server/src/modules/<feature>/` containing `*.routes.ts` (HTTP + validation), `*.service.ts` (business rules, owns transactions), `*.repository.ts` (SQL), registered in `routes/index.ts`. Frontend: `web/src/features/<feature>/` (components, hooks, API calls), pages in `routes/`, registered in `app/AppRoutes.tsx` and `app/navigation.ts`.

## Known deviations from the suggested layout

`web/src/hooks`, `web/src/services` and `server/src/services` were not created: they would be empty. API access lives in `web/src/lib/api-client.ts`; create the folders when there is content for them.
