# Shop-Books

A private, shared expense-management application for one physical shop, used by an owner and a few managers through a responsive website or an installable PWA.

> **Status: Stage 2 – authentication and access control.** Implemented: the Stage 1 foundation (React/Vite PWA shell, Express API, PostgreSQL + migration runner, test tooling) plus owner bootstrap, sign-in with server-side sessions, CSRF protection, lockout and rate limiting, owner-only user management and the first-login password change. **No financial features exist yet.** See [Roadmap](#roadmap).

## Conventions

- Currency: INR (₹), two decimal places. Money is `NUMERIC(14,2)` in the database and a **decimal string** in API responses (never a JS float).
- Timezone: timestamps are `TIMESTAMPTZ`; calendar dates are `DATE`; reporting uses **Asia/Kolkata**.
- Financial year: January – December.
- Bill photographs (later stage) are **optional**; JPEG, PNG, WebP and PDF, max 10 MB each.

## Technology

| Area | Choice |
|---|---|
| Web | React, Vite, TypeScript (strict), Tailwind CSS v4, shadcn/ui-style components, TanStack Query, React Hook Form, Zod, React Router |
| PWA | vite-plugin-pwa (Workbox `generateSW`, static assets only) |
| API | Node.js, Express 5, TypeScript (strict), Zod, helmet, cors, pino, Argon2id (`@node-rs/argon2`) |
| Database | PostgreSQL via `pg`, handwritten SQL migrations (no ORM) |
| Tests | Vitest, React Testing Library, Supertest, Playwright |

Hosting, e-mail and object-storage providers are **not yet chosen**; the code is deployment-agnostic.

## Repository structure

```
shop-books/
├── web/                     React + Vite application
│   ├── e2e/                 Playwright tests
│   ├── public/              favicon and PLACEHOLDER PWA icons
│   └── src/
│       ├── app/             providers, routes, navigation, error boundary
│       ├── components/      ui/ (shadcn-style), layout/, shared states
│       ├── features/        feature modules (auth, users, system health)
│       ├── lib/             api-client, money formatting, helpers
│       ├── routes/          page components
│       ├── styles/          Tailwind entry + theme tokens
│       └── types/           API types
├── server/                  Express API
│   ├── scripts/             build helpers
│   ├── src/
│   │   ├── cli/             owner bootstrap command
│   │   ├── config/          env validation, constants, .env loading
│   │   ├── database/        pool, transactions, migration runner + CLI, migrations/
│   │   ├── middleware/      request id, errors, origin/JSON guards, auth/CSRF/role
│   │   ├── modules/         feature modules (health, auth, users)
│   │   ├── routes/          /api/v1 router
│   │   ├── utils/           errors, logger
│   │   ├── app.ts           Express app factory
│   │   └── server.ts        process entry point
│   └── tests/
├── docs/                    architecture, database, development setup
├── .env.example
└── package.json             convenience scripts only (no workspaces)
```

## Quick start (Windows PowerShell)

Prerequisites: Node.js ≥ 22.12 and a PostgreSQL server. Full details in [docs/development-setup.md](docs/development-setup.md).

```powershell
npm run install:all
Copy-Item .env.example .env.development     # then edit DATABASE_URL and SESSION_SECRET
npm run db:migrate
npm run owner:create      # once: creates the single owner account (password prompt is hidden)
npm run dev:server        # terminal 1 -> http://localhost:3000/api/v1/health
npm run dev:web           # terminal 2 -> http://localhost:5173
```

## Commands

| Command (repo root) | Purpose |
|---|---|
| `npm run install:all` | Install server and web dependencies |
| `npm run dev:server` / `npm run dev:web` | Start the API / web dev server |
| `npm run typecheck` | TypeScript check for both apps |
| `npm run build` | Build both apps |
| `npm test` | Unit + integration tests for both apps |
| `npm run test:e2e` | Playwright end-to-end tests (builds and serves the web app) |
| `npm run db:status` / `npm run db:migrate` | Migration status / apply |
| `npm run owner:create` | One-time creation of the owner account |

## Documentation

- [Architecture](docs/architecture.md) (including authentication and security design)
- [Database and migrations](docs/database.md)
- [Development setup and troubleshooting](docs/development-setup.md)
- [Testing plan](docs/testing-plan.md): tests deferred to the final test phase

## Roadmap

1. Stage 1 – foundation. **Done.**
2. **Stage 2 – authentication and access control.** Done (this stage).
3. Later – categories, suppliers, expenses with optional bill photos, supplier payments, customer ledger, financial audit history, dashboard, Excel export, monthly e-mail reports.

Nothing beyond Stage 2 is implemented.
