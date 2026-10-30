# Development setup (Windows)

Commands are for **Windows PowerShell**. Docker is **not** required.

## Prerequisites

- Node.js **22.12 or newer** (`node -v`) and npm.
- Git.
- A PostgreSQL server you control (see [database.md](database.md)). Without one you can still run the web app and the non-database tests.
- Optional, for e2e tests: Microsoft Edge/Chrome (used via `PW_CHANNEL`) or Playwright's own browser (`npx playwright install chromium`).

## 1. Install dependencies

```powershell
cd D:\Projects\Shop-Books
npm run install:all
```

## 2. Configure environment files

Environment files live at the repository root and are **gitignored**. Only `.env.example` is committed.

```powershell
Copy-Item .env.example .env.development
Copy-Item .env.example .env.test
```

Edit them:

- `.env.development` → `DATABASE_URL=postgresql://shop_books_app:<password>@localhost:5432/shop_books_dev`
- `.env.test` → `DATABASE_URL=postgresql://shop_books_app:<password>@localhost:5432/shop_books_test` (name **must** end in `_test`)

`FRONTEND_URL=http://localhost:5173` is correct for development. Real environment variables override file values. `SESSION_SECRET` is unused until Stage 2.

The web app needs no configuration in development (Vite proxies `/api` to `localhost:3000`). Optional overrides: `web/.env.example`.

## 3. Create and migrate the database

Create the databases first ([database.md](database.md)), then:

```powershell
npm run db:status
npm run db:migrate
```

Prepare the test database once:

```powershell
$env:NODE_ENV = "test"; npm run db:migrate; Remove-Item Env:NODE_ENV
```

(The integration tests also apply migrations themselves, idempotently.)

## 4. Run

```powershell
npm run dev:server     # API on http://localhost:3000   (check /api/v1/health)
npm run dev:web        # Web on http://localhost:5173
```

The web app shows the login screen. To preview the empty application shell during development only:

```powershell
$env:VITE_PREVIEW_SHELL = "true"; npm run dev:web
```

## 5. Test

```powershell
npm run typecheck
npm test                                   # server + web unit/integration tests
npm --prefix server test                   # server only
npm --prefix web test                      # web only
$env:PW_CHANNEL = "msedge"; npm run test:e2e   # Playwright (omit PW_CHANNEL to use Playwright's Chromium)
```

If `.env.test` is missing or the test database is unreachable, the PostgreSQL integration tests are **skipped** (the summary shows "skipped"); configure the database and re-run to execute them.

## 6. Build

```powershell
npm run build                  # type-checks and builds both apps
npm --prefix server start      # run the built API (needs real env variables)
npm --prefix web run preview   # serve the built web app on http://localhost:4173
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid configuration: DATABASE_URL: …` on start | Missing/invalid variable. Check `.env.development` exists at the repo root. |
| `…when NODE_ENV=test the database name must end in "_test"` | `.env.test` points at the wrong database. Use a dedicated `*_test` database. |
| `password authentication failed` / `ECONNREFUSED` | Wrong credentials, PostgreSQL not running (check the `postgresql-x64-*` service), or wrong port. |
| Health shows `degraded` / dashboard says "Cannot reach the server" | API not running or database down; start `npm run dev:server`. |
| Database tests show as skipped | No reachable test database (see above). |
| `psql` not recognised | Add `C:\Program Files\PostgreSQL\<version>\bin` to PATH or call it by full path. |
| `Port 3000/5173/4173 already in use` | Stop the other process or change `PORT`. |
| CORS errors against a remote API | Add the web origin to `FRONTEND_URL` (comma-separated) and set `VITE_API_URL`. |
| Old UI after a deploy | The service worker caches the app shell; it auto-updates on next load. Unregister it in DevTools › Application when debugging. |
| Graceful shutdown on Windows | The server handles SIGINT/SIGTERM (drains requests, closes the pool). Signal delivery on Windows is limited, so Ctrl+C behaviour is **not yet verified** there; killing the process from Task Manager always skips the handler. Verify on the production host. |
