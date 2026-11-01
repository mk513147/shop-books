# Staging: frontend on Vercel, backend on your Windows PC (Cloudflare Tunnel)

**Purpose:** test Shop-Books on an Android phone (installed as a PWA) while the API, PostgreSQL and the bill-document folder stay on your PC. This is a **testing** setup, not production. Use **test data only**.

```
 Android phone (Chrome / installed PWA)
        │  HTTPS
        ├──────────────► https://<project>.vercel.app        static React app (Vercel)
        │                     HTML, JS, CSS, manifest, service worker (static files only)
        │  HTTPS (fetch / XHR with cookies, CORS)
        └──────────────► https://<tunnel-host>               Cloudflare edge
                                │ outbound connection started by cloudflared on your PC
                                ▼
                    Windows PC ─ cloudflared ──► http://127.0.0.1:3000   Shop-Books API (Express)
                                                    ├── PostgreSQL localhost:5432  (NOT exposed)
                                                    └── D:\ShopBooksStaging\documents (NOT exposed)
```

Only the API port is published, and only through the tunnel. PostgreSQL (5432) and the document folder are never exposed; the API itself serves no static files.

## 1. What the code expects

| Setting | Where | Public? | Value |
|---|---|---|---|
| `VITE_API_BASE_URL` | Vercel project → Environment Variables | **public** (compiled into the JavaScript) | `https://<tunnel-host>` (`/api/v1` is appended) |
| everything in `.env.staging` | your PC only | **private** | see `.env.staging.example` |

- The frontend decides the API address in one place (`web/src/lib/api-client.ts` → `web/src/lib/api-base-url.ts`). Every request, bill thumbnail/download link and Excel export uses it.
- An empty value means same-origin `/api/v1` — used for local development (Vite proxy) and local preview/e2e. A **Vercel build fails** if the variable is missing or invalid, and a production build opened from any non-local host without it shows "Shop-Books is not configured" instead of calling the wrong server. Only `https://` is accepted (`http://` only for localhost); no query strings, credentials or other paths.
- `VITE_API_URL` (earlier name) is no longer read.
- Never put database URLs, `SESSION_SECRET` or any other secret in a `VITE_` variable or in Vercel.

## 2. One-time preparation on the PC

### 2.1 A separate staging database (do not use your real data or the development database)

The development database is still at migration 0004; the current code needs 0001–0009. Create a **separate** database for staging (PowerShell, `psql` path for PostgreSQL 18):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -c "CREATE DATABASE shop_books_staging OWNER shop_books_app;"
```

### 2.2 Backend configuration

```powershell
cd D:\Projects\Shop-Books
Copy-Item .env.staging.example .env.staging     # gitignored; never commit it
notepad .env.staging
```

Fill in: `DATABASE_URL` (…`/shop_books_staging`), a new `SESSION_SECRET`, your Vercel domain in `FRONTEND_URL`, and `DOCUMENT_STORAGE_DIR`. Keep `HOST=127.0.0.1`, `COOKIE_SECURE=true`, `SESSION_COOKIE_SAMESITE=none`, `TRUST_PROXY=true`, `EMAIL_PROVIDER=none`.

`SHOP_BOOKS_ENV_FILE=.env.staging` makes the server, `db:*` commands and the owner CLI read that file instead of `.env.development` (it must be a `.env.<name>` file in the repository root and must exist).

### 2.3 Migrate the staging database and create its owner (only this database)

```powershell
$env:SHOP_BOOKS_ENV_FILE = ".env.staging"
npm run db:status          # must say: Environment: development … and list the staging database's migrations
npm run db:migrate
npm run owner:create       # owner for STAGING (use a test e-mail/password)
Remove-Item Env:SHOP_BOOKS_ENV_FILE
```

Check the `db:status` output before migrating: it must be the staging database (the URL comes from `.env.staging`).

### 2.4 Install cloudflared

```powershell
winget install --id Cloudflare.cloudflared
cloudflared --version
```

## 3. Vercel project (frontend only)

Import the Git repository in Vercel, then set:

| Vercel setting | Value |
|---|---|
| Root Directory | `web` |
| Framework Preset | Vite (also declared in `web/vercel.json`) |
| Install Command | `npm ci` |
| Build Command | `npm run build` (type check + Vite build) |
| Output Directory | `dist` |
| Node.js Version | 22.x (the project requires ≥ 22.12) |
| Environment Variable | `VITE_API_BASE_URL` = `https://<tunnel-host>` for **Production** |

`web/vercel.json` adds the SPA fallback (any path that is not a file → `index.html`, so refreshing `/expenses/…` works), keeps `sw.js`, `index.html` and the manifest uncached so updates reach phones, caches hashed `/assets/*` for a year, and sends basic security headers. No Vercel Functions, no backend on Vercel.

Use the project's **production domain** (`https://<project>.vercel.app`). Preview deployments get different URLs that are not in `FRONTEND_URL`, so the API refuses them (add a preview URL to `FRONTEND_URL` if you really need one).

## 4. Starting everything (each test session)

```powershell
# 1. PostgreSQL (Windows service; the name depends on the version)
Get-Service postgresql*
Start-Service postgresql-x64-18          # if it is not Running

# 2. Backend (terminal 1)
cd D:\Projects\Shop-Books
$env:SHOP_BOOKS_ENV_FILE = ".env.staging"
npm run dev:server
#   or the compiled server: npm --prefix server run build; npm --prefix server start

# 3. Check it locally (terminal 2)
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health      # status ok, database up

# 4. Tunnel (terminal 2) — quick tunnel, new random URL each time
cloudflared tunnel --url http://127.0.0.1:3000
#   prints https://<random-words>.trycloudflare.com

# 5. Check through the tunnel (terminal 3)
Invoke-RestMethod https://<random-words>.trycloudflare.com/api/v1/health
```

6. If the tunnel URL changed (it does with every quick tunnel): Vercel → Project → Settings → Environment Variables → edit `VITE_API_BASE_URL` → **Redeploy** the latest production deployment (the value is compiled in at build time; changing it without a redeploy has no effect). `FRONTEND_URL` on the PC only changes if the *Vercel* domain changes (then restart the backend).
7. On the phone: open `https://<project>.vercel.app` in **Chrome**, sign in with the staging owner.

Local development keeps working as before: `npm run dev:server` (with `.env.development`) and `npm run dev:web`, no `VITE_API_BASE_URL`.

### A stable URL (optional): named tunnel on your own domain

Requires a domain on Cloudflare. Then the URL never changes and Vercel needs no redeploys:

```powershell
cloudflared tunnel login
cloudflared tunnel create shop-books-staging
cloudflared tunnel route dns shop-books-staging api-staging.your-domain.example
```

`%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: shop-books-staging
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: api-staging.your-domain.example
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```powershell
cloudflared tunnel run shop-books-staging
```

Only the API is listed in `ingress`; never add PostgreSQL or a file share.

## 5. Installing the PWA on Android

1. Open the Vercel URL in Chrome and sign in once.
2. Chrome menu (⋮) → **Install app** (or **Add to Home screen** → Install).
3. Open Shop-Books from the home screen: it runs full-screen (standalone) with the teal theme colour.

The manifest (name/short name "Shop-Books", 192/512 px and maskable icons, `display: standalone`, `start_url`/`scope` `/`, theme `#0f766e`, background `#f8fafc`) and the service worker are generated by the build; installability needs HTTPS, which Vercel provides. The icons are still **placeholders**.

**Caching:** the service worker precaches only the built static files (HTML, JS, CSS, icons, manifest). It has no runtime caching, so API responses, sign-in/session calls, bill photos/PDFs and Excel files are never stored by it; all of them go to the tunnel origin, which the service worker does not handle at all. The API additionally sends `Cache-Control: no-store` (documents: `private, no-store`).

## 6. Cookies, CORS and CSRF across two domains

The web app (`*.vercel.app`) and the API (`*.trycloudflare.com` or your domain) are **different sites**:

- **Cookie:** `SameSite=Lax` cookies are not sent on cross-site `fetch`/XHR, so staging uses `SESSION_COOKIE_SAMESITE=none` with `COOKIE_SECURE=true`. The cookie is `__Host-sb_session; Secure; HttpOnly; SameSite=None; Path=/` with no `Domain` (bound to the tunnel host only). JavaScript cannot read it.
- **CORS:** only the exact origins listed in `FRONTEND_URL` get `Access-Control-Allow-Origin` (never `*`), with `Access-Control-Allow-Credentials: true`. Preflights for the custom headers (`X-CSRF-Token`, `Idempotency-Key`, `X-File-Name`, `X-File-Type`) are answered for those origins only. `Content-Disposition`, `Retry-After` and `Idempotent-Replayed` are exposed so Excel downloads keep their names.
- **CSRF stays fully effective:** every state-changing request still needs (1) an `Origin`/`Referer` from `FRONTEND_URL`, (2) `Content-Type: application/json` (or `application/octet-stream` on the upload route — neither can be sent cross-site without a CORS preflight), and (3) the per-session `X-CSRF-Token`, which a page can only obtain by reading an API response — impossible for any origin not in `FRONTEND_URL`. `SameSite=None` therefore does not open a CSRF hole; it only lets the cookie travel with the app's own requests.
- **Bill thumbnails** load with `crossorigin="use-credentials"` (a CORS request), so the API keeps `Cross-Origin-Resource-Policy: same-origin`, which stops other websites from embedding the files. "View" and "Download" open the file in a new tab (a normal navigation with the cookie).
- **Client addresses:** `TRUST_PROXY=true` (exactly one proxy, cloudflared, and the API only listens on 127.0.0.1) makes the per-IP sign-in limit and the sign-in log use the real phone address instead of 127.0.0.1.

**Browser limitation (important):** the session cookie is a *third-party* cookie from the web page's point of view. It works in Chrome on Android with default settings, but **not** when third-party cookies are blocked: Chrome Incognito, "Block third-party cookies", Brave, and **every browser on iPhone/iPad** (WebKit tracking prevention). There, sign-in appears to succeed but the next request is "Please sign in". The fix for a lasting setup is to put the web app and the API on the **same site**, e.g. `app.your-domain.example` (Vercel custom domain) and `api.your-domain.example` (named tunnel) — then the cookie is first-party and could even return to `SameSite=Lax`.

## 7. Stopping

- Tunnel: `Ctrl+C` in its terminal (quick-tunnel URLs stop working immediately and are never reused).
- Backend: `Ctrl+C` in its terminal. In PowerShell also run `Remove-Item Env:SHOP_BOOKS_ENV_FILE` (or close the terminal) so later commands use `.env.development` again.
- PostgreSQL can keep running (it is only reachable from the PC).

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Vercel build fails: "VITE_API_BASE_URL must be set…" | Add the variable for the Production environment and redeploy. |
| Site shows "Shop-Books is not configured" | The deployment was built without a valid `VITE_API_BASE_URL`. |
| "Cannot reach the server" | Tunnel not running, URL changed (update Vercel + redeploy), or backend stopped. Test `https://<tunnel>/api/v1/health` in the phone's browser. |
| Sign-in → 403 "Request origin is not allowed" | The Vercel origin is not in `FRONTEND_URL` exactly (scheme, no trailing slash, production domain, not a preview URL). Restart the backend after editing. |
| Sign-in seems to work, then "Please sign in" | Third-party cookies blocked (Incognito, iPhone, Brave, setting) — see §6; or `COOKIE_SECURE`/`SESSION_COOKIE_SAMESITE` not set as in the example. |
| "Security check failed. Reload the page" | CSRF token from an older session: reload the page. |
| Bill thumbnails broken but View works | Old cached frontend: close and reopen the PWA (or clear site data) so the new build loads. |
| Backend refuses to start: `SESSION_COOKIE_SAMESITE: "none" requires Secure cookies` | Set `COOKIE_SECURE=true`. |
| `SHOP_BOOKS_ENV_FILE … not found` | Run commands from the repository root and create `.env.staging`. |
| 404 on refresh of a page | `web/vercel.json` missing from the deployment, or Root Directory is not `web`. |
| Features missing / server errors about tables | The staging database is not migrated (`$env:SHOP_BOOKS_ENV_FILE=".env.staging"; npm run db:migrate`). |

## 9. Security limitations of this setup

- While the tunnel runs, the API is reachable from the internet by anyone who knows the URL. It is protected by sign-in, account lockout, the per-IP limit, CSRF and CORS, but it is still your PC: run the tunnel only while testing.
- The Vercel site itself is public (it contains no data; only the API address is visible in its JavaScript).
- Use a separate staging database and document folder with **test data only**; no real financial records.
- No e-mail is sent (`EMAIL_PROVIDER=none`); leave monthly reports disabled in staging.
- Rate limits for uploads/exports are held in memory and reset when the backend restarts.
- Not verified yet (needs your devices): installing the PWA on Android, signing in from the Vercel domain through a real Cloudflare Tunnel, uploads from the phone camera, viewing/downloading bills on the phone.
