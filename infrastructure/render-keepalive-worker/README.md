# Render keep-alive Worker

A tiny Cloudflare Worker (Free plan) that sends **one scheduled GET request every five minutes** to the Shop-Books
API on Render, so the Render service does not go idle and spin down.

**It is a scheduler, not a replacement for Render.** The API, the sessions, the Neon database and the document
storage all stay exactly where they are. The Worker holds no application logic, no secrets, no credentials and
touches no data. If you delete it, Shop-Books keeps working (Render just sleeps when idle again).

## Architecture

```mermaid
flowchart LR
    cron["Cloudflare Cron Trigger<br/>*/5 * * * * (UTC)"] --> worker["Keep-alive Worker<br/>scheduled handler"]
    worker -- "GET /api/v1/health<br/>15 s timeout, max 1 retry" --> render["Render<br/>Shop-Books API"]
    render -- '{"status":"ok"}' --> worker
    worker --> logs["Workers Logs<br/>(structured JSON)"]

    browser["Browser / PWA"] --> vercel["Vercel<br/>frontend + /api rewrite"]
    vercel --> render
    render --> neon[("Neon PostgreSQL")]
    render --> tunnel["Cloudflare Tunnel"] --> desktop["Desktop document storage"]
```

Only the top row is new. The Worker talks to Render's public health endpoint and nothing else. The health endpoint
runs a `SELECT 1` against Neon on the Render side, which is existing behaviour (the Worker sends no queries itself).

## What it does on each run

1. Receives the Cron Trigger and records the scheduled time.
2. `GET https://shop-books-api.onrender.com/api/v1/health` (no cookies, no auth headers, no body, redirects not followed).
3. Aborts if there is no complete answer within **15 seconds**.
4. Requires HTTP 2xx, valid JSON, and `status === "ok"`.
5. Writes one structured log line per attempt: timestamp, target URL, HTTP status, duration, success/failure, error text.
6. On failure, waits 5 s and retries **once** (at most two requests per run), then stops. It never throws, so a bad run
   cannot affect the next one.

It also serves `GET /health` on the Worker's own URL: it answers `{"status":"ok","worker":"shop-books-render-keepalive"}`
**without contacting Render**. There is no endpoint that triggers a ping, so nobody can use the Worker to hammer
the backend. Every other path is 404.

Example log line (one per attempt):

```json
{"event":"render_keepalive","timestamp":"2026-11-08T12:05:00.000Z","target":"https://shop-books-api.onrender.com/api/v1/health","attempt":1,"httpStatus":200,"durationMs":412,"success":true}
```

A failure adds `"reason"` (`network_error`, `timeout`, `http_error`, `invalid_json`, `unexpected_body`), `"error"` and
`"willRetry"`. Response bodies and headers are never logged.

## Files

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Worker name, Cron Trigger `*/5 * * * *`, `TARGET_URL` variable, Workers Logs |
| `src/index.ts` | `scheduled` handler and the `/health` endpoint |
| `src/keepalive.ts` | The ping: timeout, validation, one retry, logging |
| `test/` | Local tests (Vitest, no network, no Cloudflare account needed) |

No runtime dependencies. Dev dependencies: `wrangler`, `typescript`, `vitest`, `@cloudflare/workers-types`.

## Installation

Requires Node 22+ (the same as the rest of the repository).

```
cd infrastructure/render-keepalive-worker
npm install
```

This directory is self-contained: it is not part of the `server/` or `web/` builds and nothing else depends on it.

## Local testing

```
npm run typecheck
npm test
```

The tests cover: success; HTTP 500; HTTP 404; invalid JSON; unexpected bodies; network failure; timeout (including a
stalled body); a failed request followed by a successful retry; the `/health` endpoint making no Render request;
and that the Cron expression is exactly `*/5 * * * *` (12 runs/hour).

To run the Worker locally without touching the real backend, start any local server that answers
`{"status":"ok"}` (for example on port 8899), then:

```
npx wrangler dev --test-scheduled --port 8790 --var "TARGET_URL:http://127.0.0.1:8899/api/v1/health"
curl http://localhost:8790/health                              # Worker is alive (no ping sent)
curl "http://localhost:8790/__scheduled?cron=*%2F5+*+*+*+*"    # simulates one Cron run (dev mode only)
```

`/__scheduled` exists only under `wrangler dev --test-scheduled`; it is not present on the deployed Worker. Plain
`http://` targets are accepted by the Worker only for `localhost`/`127.0.0.1`; the deployed target must be `https://`.

## Cloudflare account setup (one time)

1. Create a free account at <https://dash.cloudflare.com/sign-up> and verify your email.
2. No domain, payment method or other Cloudflare product is required. Workers Free is enough.
3. First deployment asks you to pick a `workers.dev` subdomain (it becomes part of the Worker's URL).
4. Log in from the command line (opens a browser to authorise Wrangler):

   ```
   cd infrastructure/render-keepalive-worker
   npx wrangler login
   npx wrangler whoami        # confirms the account
   ```

## Creating the Worker and configuring the Cron Trigger

There is nothing to create by hand. Both the Worker and its Cron Trigger are defined in `wrangler.jsonc` and created
by the first deployment:

```jsonc
"name": "shop-books-render-keepalive",
"triggers": { "crons": ["*/5 * * * *"] },
"vars": { "TARGET_URL": "https://shop-books-api.onrender.com/api/v1/health" }
```

To change the interval or target later, edit `wrangler.jsonc` and deploy again. Cron times are UTC; `*/5` means
minutes 0, 5, 10, ... 55 of every hour.

## Deploying manually

Do this only when you decide to go live (nothing has been deployed yet):

```
cd infrastructure/render-keepalive-worker
npm install
npm run typecheck && npm test
npx wrangler deploy
```

Wrangler prints the Worker URL (`https://shop-books-render-keepalive.<your-subdomain>.workers.dev`) and the registered
schedule (`*/5 * * * *`). Check it:

```
curl https://shop-books-render-keepalive.<your-subdomain>.workers.dev/health
```

Expected: `{"status":"ok","worker":"shop-books-render-keepalive"}`. This does not ping Render.

## Inspecting execution logs

* **Dashboard:** Workers & Pages -> `shop-books-render-keepalive` -> **Logs** (Workers Logs is enabled in
  `wrangler.jsonc`). Search for `render_keepalive`; filter `success` = false to see failures. **Settings -> Trigger
  Events** (Cron) shows when runs happened.
* **Live from a terminal:** `npm run tail` (`wrangler tail`) streams log lines as runs happen, so wait up to five minutes.

## Verifying Render stays awake

1. **Render dashboard:** open the `shop-books-api` service -> **Logs**. A `GET /api/v1/health` should appear about every
   five minutes, and the service should show as running rather than "spun down".
2. **After a quiet period** (for example, 30+ minutes with nobody using the app), open the app or run
   `curl -s -w "\n%{time_total}s\n" https://shop-books-api.onrender.com/api/v1/health`. A response in well under a second
   means the instance was awake. A response after tens of seconds means it had gone to sleep, so check the Worker logs
   for failures.
3. **Worker side:** the Workers Logs show `success: true` with `httpStatus: 200` and a small `durationMs` for each run.

If your Render plan has a monthly free instance-hour allowance, keeping one service awake around the clock uses
roughly 720-744 hours a month. Check your Render plan's limits; the Worker does not manage that for you.

The Worker only logs. It sends no alerts. If Render is down you will see failed runs in the logs, nothing more.

## Disabling the Cron Trigger

* **From the repository:** set `"crons": []` (or remove the `triggers` block) in `wrangler.jsonc`, then `npx wrangler deploy`.
  The Worker and its `/health` endpoint stay, but nothing is scheduled.
* **From the dashboard:** Workers & Pages -> the Worker -> **Settings -> Trigger Events** -> delete the cron
  `*/5 * * * *`.

## Deleting the Worker

```
npx wrangler delete shop-books-render-keepalive
```

or Workers & Pages -> the Worker -> **Settings -> Delete**. Nothing else depends on it; Render, Vercel, Neon and the
storage tunnel are unaffected. Then delete this directory if you wish.

## Expected Free-plan usage

| Item | Usage | Cloudflare Workers Free allowance |
|---|---|---|
| Scheduled runs | 12/hour, 288/day, about 8,640 per 30 days | 100,000 requests/day (cron runs count as invocations) |
| Outbound requests per run | 1, at most 2 (one retry) | 50 per invocation |
| Cron Triggers used | 1 | 5 per account |
| CPU per run | negligible (one `fetch` and a tiny JSON parse; the work is waiting on Render) | 10 ms per invocation |
| Worker `/health` | only when you call it | counts toward the same 100,000/day |

That is under 0.3% of the daily request allowance. The CPU figure is an estimate (not measured on Cloudflare) but the
code does no meaningful computation. Limits are taken from Cloudflare's published Workers limits page; confirm there
if they matter to you: <https://developers.cloudflare.com/workers/platform/limits/>.

## Safety properties

* No secrets, tokens, database credentials or authentication are involved; no bindings are configured.
* The target URL is configuration (`TARGET_URL`), must be `https://` in production, and redirects are not followed.
* The Worker never reads application data and never sends a database query or login.
* Logs contain the fields listed above only (no headers, cookies or response bodies).
