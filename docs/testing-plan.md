# Testing plan

The project follows a **build-first** approach: each stage runs only the essential checks needed to catch integration errors and prove critical security behaviour. Comprehensive testing happens in a final, project-wide test phase. This document is the backlog for that phase.

## What runs today

| Suite | Command | Needs |
|---|---|---|
| Server unit + integration (Vitest, Supertest) | `npm --prefix server test` | `.env.test` with a `*_test` database for the integration files (otherwise they are skipped, never reported as passing) |
| Web unit/component (Vitest, Testing Library) | `npm --prefix web test` | nothing |
| E2E smoke (Playwright, production build) | `npm run test:e2e` | a browser (`PW_CHANNEL=msedge` or `npx playwright install chromium`) |

Existing coverage worth knowing:

- `server/tests/env.test.ts`: configuration validation, database isolation, cookie settings.
- `server/tests/app.test.ts`: health, deny-by-default 401, headers, CORS, body limits, error handler.
- `server/tests/migrator.unit.test.ts`, `database.integration.test.ts`: migration runner, advisory lock, environment guard.
- `server/tests/auth.critical.integration.test.ts`: **Stage 2 critical paths only**: public surface, generic login errors, cookie attributes, token hashing, Origin/JSON/CSRF enforcement, idle and absolute expiry, manager lifecycle (temporary password, forced change, role denial, deactivation, owner reset), single-owner constraint, concurrent lockout, per-IP 429, session + CSRF rotation on password change, racing revocation, session-bound writes, owner recovery logic.
- `web/src/app/App.test.tsx`: login flow, forced password change, owner-only screen.

Note: the auth integration tests **truncate** `users`, `sessions` and `auth_events` in the test database.

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
- [ ] Idle timeout boundary (just under / just over 12 h) and absolute timeout boundary (7 days).
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

### Retention cleanup (when implemented; policy in [maintenance.md](maintenance.md))
- [ ] Sessions ended more than 90 days ago are deleted; ended less than 90 days ago are kept.
- [ ] **Active sessions are never deleted**, including the boundary cases just inside the 12-hour idle and 7-day absolute limits.
- [ ] `auth_events` older than 12 months deleted, newer kept.
- [ ] Batching: large volumes processed in bounded batches; interrupting and re-running converges (idempotent).

## Open items

Decisions or features that affect testing and are not yet implemented:

- **Ownership transfer.** The schema allows exactly one owner, and roles cannot be changed through the API. Transferring ownership would need a dedicated, audited procedure.
- **Retention cleanup job.** Policy approved ([maintenance.md](maintenance.md)); the scheduled job is not implemented yet.
