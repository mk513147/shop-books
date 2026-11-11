# Hosted deployment: Vercel + Render + Neon + desktop document storage

> **Bill attachments are postponed (2026-11-10).** The current release runs **without** the storage agent and Cloudflare Tunnel: `DOCUMENT_STORAGE_DRIVER=disabled` on Render and no `VITE_BILL_ATTACHMENTS` on Vercel. The storage-agent parts below describe how attachments will work when they are reactivated. See [bill-attachments-postponed.md](bill-attachments-postponed.md).

**Status:** configuration and code are prepared and tested locally. Nothing has been deployed. Cloudflare Tunnel, Vercel's proxy and Render were **not** exercised by the automated tests (see "Not yet verified").

```
 Browser / PWA ──HTTPS──► https://<project>.vercel.app          static React app (Vercel)
                              │  /api/*  (Vercel rewrite, same origin for the browser)
                              ▼
                          https://<service>.onrender.com/api/*   Shop-Books API (Render, Node)
                              │                   │
                              │ TLS               │ HTTPS, HMAC-signed requests
                              ▼                   ▼
                          Neon PostgreSQL     https://<storage-host>  Cloudflare Tunnel
                                                  │
                                                  ▼
                                   Windows desktop: storage agent 127.0.0.1:8787
                                                    └── AGENT_STORAGE_DIR (bill files, private)
```

## Why this shape

- **Same-origin API through Vercel.** The browser only talks to the Vercel domain; `web/vercel.json` rewrites `/api/:path*` to Render **before** the SPA fallback. The session cookie is therefore first-party: `SameSite=Lax` and `Secure` work, and nothing depends on third-party cookies (which Safari/iOS block). The browser sends `Origin: https://<project>.vercel.app`, which the API checks against `FRONTEND_URL`; CSRF tokens and authentication are unchanged.
- **Documents never on Render's disk.** Render's filesystem is wiped on each deploy; the API refuses `DOCUMENT_STORAGE_DRIVER=local` when `RENDER=true`. With `DOCUMENT_STORAGE_DRIVER=agent`, files live on the desktop, behind the agent.
- **Desktop offline.** Expenses never need document storage. An upload made while the agent is unreachable is **accepted and kept**: its bytes go into `document_upload_queue` (Neon) in the same transaction as the document record; a database trigger checks they match the recorded size and SHA-256. The API serves queued files from there, shows them as "Waiting for storage", and delivers them every minute once the agent answers (the queue row is deleted only after the agent confirmed). Files already on the desktop answer `503 DOCUMENT_STORAGE_OFFLINE` until it is back.

## Storage agent (desktop)

- Code: `server/src/storageAgent/agentServer.ts`, started by `server/src/cli/storageAgent.ts`; protocol in `server/src/modules/documents/agentProtocol.ts`; API side `agentStorage.ts`, queue `documentQueue.ts`, migration `0011_document_upload_queue`.
- Every request is signed: `HMAC-SHA256(secret, METHOD \n path \n timestamp \n bodySha256)`, timestamps within ±5 minutes; the secret is never sent. Uploads carry the body's SHA-256, re-checked by the agent. Max 10 MB per object.
- Files are written atomically and **never overwritten** (same code as the `local` driver): re-sending identical bytes is accepted as a retry, different bytes under an existing key are refused (409).
- Timeouts never limit a transfer's total length: 30 s for the agent's response headers, then 30 s of *agent* inactivity while the API is waiting for data (a slow phone's download does not count). An agent that refuses the signature (HTTP 401/403) is logged as an error naming `DOCUMENT_STORAGE_AGENT_SECRET` and the desktop clock (never the secret); uploads are still queued.
- No public URLs, no directory browsing: only `/v1/health`, `/v1/objects` (signed list, for `documents:reconcile`) and `/v1/objects/<key>` with validated keys.

Set up on the desktop:

```powershell
cd D:\Projects\Shop-Books
npm --prefix server ci; npm --prefix server run build
Copy-Item .env.agent.example .env.agent; notepad .env.agent      # AGENT_STORAGE_DIR, AGENT_SECRET
$env:SHOP_BOOKS_ENV_FILE = ".env.agent"; npm --prefix server run storage-agent:built
# second window: publish it (named tunnel recommended, see staging-deployment.md → "A stable URL")
cloudflared tunnel run <tunnel-name>      # ingress: https://storage.<your-domain> -> http://127.0.0.1:8787
```

Recommended: protect the tunnel hostname additionally with Cloudflare Access (service token) — not required by the code.

## Render (API)

`render.yaml` (Blueprint) holds the settings; equivalently in the dashboard:

| Setting | Value |
|---|---|
| Root directory | `server` |
| Build command | `npm ci --include=dev && npm run build && npm prune --omit=dev` (TypeScript is a devDependency; `NODE_ENV=production` would otherwise skip it; pruned again before start) |
| Start command | `npm start` |
| Health check path | `/api/v1/health` |
| Node | from `engines` (`>=22.12.0`) |

Environment (names only): `NODE_ENV=production`, `DATABASE_URL` (Neon **direct**, not `-pooler`: advisory locks need a session), `SESSION_SECRET`, `FRONTEND_URL` (exact Vercel origin), `SESSION_COOKIE_SAMESITE=lax`, `TRUST_PROXY=2`, `DOCUMENT_STORAGE_DRIVER=disabled` while attachments are postponed (later: `agent` plus `DOCUMENT_STORAGE_AGENT_URL` and `DOCUMENT_STORAGE_AGENT_SECRET`), `EMAIL_PROVIDER=none`, `REPORT_SCHEDULER_ENABLED=false`, optional `SHOP_NAME`, `APP_VERSION`, `LOG_LEVEL`. Leave `HOST` unset; Render provides `PORT`.

Migrations (once per release, from the Render shell; Neon is a remote host, so the exact name is required; `sslmode` and `channel_binding` in Neon's URL are accepted):

```bash
npm run db:status:built
npm run db:migrate:built -- --yes --confirm-database=<neon database name>
npm run owner:create:built     # first deployment only
```

## Vercel (frontend)

- Root directory `web`; `web/vercel.json` (install/build/output, headers).
- **Edit `web/vercel.json`:** replace `REPLACE-WITH-RENDER-SERVICE.onrender.com` with the Render service host. A Vercel build with `VITE_API_BASE_URL=/api/v1` **fails** while the placeholder is there, or if the `/api` rewrite is missing, not https, or placed after the `/index.html` fallback.
- Environment: `VITE_API_BASE_URL=/api/v1`.

## Not yet verified (needs the real services)

- Through Cloudflare Tunnel: agent reachability, latency and timeouts (only direct local HTTP was tested).
- Vercel's external rewrite: request body size limit for 10 MB uploads, timeouts, and that `Origin` and `Set-Cookie` pass through unchanged.
- `TRUST_PROXY=2`: check after the first deploy that the logged client IPs are the visitors', not Vercel's or Render's. Direct requests to the `onrender.com` URL bypass Vercel; per-account lockout still applies.
- Neon cold starts vs. the 5 s connection timeout.
