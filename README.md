# Shop-Books

A private, shared expense-management application for one physical shop, used by an owner and a few managers through a responsive website or an installable PWA.

> **Status: Stage 3A + supplier enhancement.** Implemented: the Stage 1 foundation, Stage 2 authentication and access control, expense categories, expense entry/listing/editing/voiding with server-side search, filters and pagination, optimistic concurrency, an append-only financial audit history, **suppliers** (with category suggestions and a migration of previously typed supplier names), **server-side idempotent expense creation**, and a **mobile-first design system** across all screens. **Not yet implemented:** bill photos/documents, supplier payments/ledgers, customers, dashboard figures, reports, Excel export and e-mail. See [Roadmap](#roadmap).

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
│       ├── features/        feature modules (auth, users, categories, expenses, suppliers, audit, system health)
│       ├── lib/             api-client, money formatting, helpers
│       ├── routes/          page components
│       ├── styles/          Tailwind entry + design tokens (see docs/architecture.md → Design system)
│       └── types/           API types
├── server/                  Express API
│   ├── scripts/             build helpers
│   ├── src/
│   │   ├── cli/             owner bootstrap/recovery, supplier backfill report
│   │   ├── config/          env validation, constants, .env loading
│   │   ├── database/        pool, transactions, migration runner + CLI, migrations/
│   │   ├── middleware/      request id, errors, origin/JSON guards, auth/CSRF/role
│   │   ├── modules/         feature modules (health, auth, users, categories, expenses, suppliers, idempotency, audit)
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
| `npm run owner:reset-password` | Owner account recovery (server shell only, interactive) |
| `npm run suppliers:backfill-report` | Read-only report of how migration 0004 turned typed supplier names into suppliers (and possible duplicates) |

## Documentation

- [Architecture](docs/architecture.md) (including authentication and security design)
- [Database and migrations](docs/database.md)
- [Development setup and troubleshooting](docs/development-setup.md)
- [Testing plan](docs/testing-plan.md): tests deferred to the final test phase
- [Maintenance](docs/maintenance.md): owner recovery, data-retention policy

## Roadmap

1. Stage 1 – foundation. **Done.**
2. Stage 2 – authentication and access control. **Done.**
3. **Stage 3A – expense categories and expense management** (incl. financial audit history). Done.
   - Enhancement: suppliers + category suggestions, supplier-name migration, idempotent creation, mobile-first redesign. Done (awaiting owner testing).
4. Stage 3B – optional bill photographs/documents for expenses.
5. Later – supplier payments and ledgers, customer ledger, dashboard, Excel export, monthly e-mail reports.

Nothing beyond Stage 3A is implemented.
