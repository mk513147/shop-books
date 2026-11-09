/**
 * 30-day rolling sessions against the real (local, designated) PostgreSQL test database.
 *
 * Time is controlled without waiting: the server reads time from the database (now()), so the tests
 * "advance the clock" by shifting a session's own timestamps into the past (created_at, last_seen_at,
 * absolute_expires_at together), which is exactly what the passing of time does to those rows.
 * Skipped (never reported as passing) when no test database is reachable.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AUTH } from '../src/config/constants.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const DAY_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = '__Host-sb_session';

describe.skipIf(!pool)('30-day rolling sessions', () => {
  const db = pool!;
  const config = testConfig({ cookie: { name: COOKIE_NAME, secure: true, sameSite: 'lax' } });
  const app = createApp({ config, db, logger: silentLogger });
  const USERS = {
    anna: { email: 'anna@example.test', password: 'anna-password-123' },
    ben: { email: 'ben@example.test', password: 'ben-password-1234' },
  };

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events RESTART IDENTITY CASCADE');
    for (const [name, u] of Object.entries(USERS)) {
      await db.query(
        `INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES ($1, $2, 'manager', $3, false)`,
        [u.email, name, await hashPassword(u.password)],
      );
    }
  });

  afterAll(async () => {
    await db.end();
  });

  // --- helpers -------------------------------------------------------------------------------

  const setCookieOf = (res: request.Response): string | undefined =>
    (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const tokenOf = (setCookie: string) => /=([^;]+);/.exec(setCookie)![1]!;
  const expiresOf = (setCookie: string) => Date.parse(/Expires=([^;]+)/.exec(setCookie)![1]!);

  async function signIn(user: { email: string; password: string }) {
    const res = await request(app).post('/api/v1/auth/login').set(BROWSER_HEADERS).send(user);
    expect(res.status).toBe(200);
    const cookie = setCookieOf(res)!;
    return { res, cookie, token: tokenOf(cookie), csrf: res.body.csrfToken as string };
  }

  const me = (token: string) => request(app).get('/api/v1/auth/me').set('Cookie', `${COOKIE_NAME}=${token}`);

  /** Moves time forward by `ms` for one session (or all live sessions) by shifting its timestamps back. */
  async function advance(ms: number, token?: string) {
    await db.query(
      `UPDATE sessions
          SET created_at = created_at - make_interval(secs => $1::float8 / 1000),
              last_seen_at = last_seen_at - make_interval(secs => $1::float8 / 1000),
              absolute_expires_at = absolute_expires_at - make_interval(secs => $1::float8 / 1000)
        WHERE revoked_at IS NULL AND ($2::text IS NULL OR token_hash = sha256(convert_to($2, 'UTF8')))`,
      [ms, token ?? null],
    );
  }

  const row = async (token: string) =>
    (
      await db.query<{ created_at: Date; last_seen_at: Date; absolute_expires_at: Date; revoked_at: Date | null }>(
        `SELECT created_at, last_seen_at, absolute_expires_at, revoked_at FROM sessions WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
        [token],
      )
    ).rows[0]!;

  const remainingMs = async (token: string) => (await row(token)).absolute_expires_at.getTime() - Date.now();

  // --- tests ---------------------------------------------------------------------------------

  it('policy constants: 30-day idle and lifetime, a finite hard cap, daily renewal granularity', () => {
    expect(AUTH.sessionIdleTimeoutMs).toBe(30 * DAY_MS);
    expect(AUTH.sessionLifetimeMs).toBe(30 * DAY_MS);
    expect(AUTH.sessionMaxAgeMs).toBeGreaterThan(30 * DAY_MS);
    expect(Number.isFinite(AUTH.sessionMaxAgeMs)).toBe(true);
    expect(AUTH.sessionTouchIntervalMs).toBe(DAY_MS);
  });

  it('successful login sets the correct 30-day cookie: __Host- name, HttpOnly, Secure, Lax, Path=/, no Domain', async () => {
    const { cookie, token, res } = await signIn(USERS.anna);
    expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/;\s*HttpOnly/);
    expect(cookie).toMatch(/;\s*Secure/);
    expect(cookie).toMatch(/;\s*SameSite=Lax/);
    expect(cookie).toMatch(/;\s*Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(Math.abs(expiresOf(cookie) - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(await me(token)).toMatchObject({ status: 200 });
  });

  it('ordinary requests write nothing and set no cookie; the session stays valid after 1 day (and is renewed once)', async () => {
    const s = await signIn(USERS.anna);
    const before = await row(s.token);
    const first = await me(s.token);
    expect(first.status).toBe(200);
    expect(setCookieOf(first)).toBeUndefined(); // no Set-Cookie churn
    expect((await row(s.token)).last_seen_at).toEqual(before.last_seen_at); // no database write

    await advance(DAY_MS + 60_000, s.token);
    const next = await me(s.token);
    expect(next.status).toBe(200);
    const renewal = setCookieOf(next)!;
    expect(tokenOf(renewal)).toBe(s.token); // the token is never rotated
    expect(renewal).toMatch(/HttpOnly/);
    expect(renewal).toMatch(/Secure/);
    expect(renewal).toMatch(/SameSite=Lax/);
    expect(renewal).not.toMatch(/Domain=/i);
    expect(Math.abs((await remainingMs(s.token)) - 30 * DAY_MS)).toBeLessThan(60_000);
    expect(Math.abs(expiresOf(renewal) - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000);
    // A second request right away: no further write.
    const again = await me(s.token);
    expect(setCookieOf(again)).toBeUndefined();
  });

  it('is still valid after 7 days without activity', async () => {
    const s = await signIn(USERS.anna);
    await advance(7 * DAY_MS, s.token);
    expect((await me(s.token)).status).toBe(200);
  });

  it('stays valid for 29 days when used (renewed) every day, and keeps its original token', async () => {
    const s = await signIn(USERS.anna);
    for (let day = 1; day <= 29; day++) {
      await advance(DAY_MS, s.token);
      const res = await me(s.token);
      expect(res.status, `day ${day}`).toBe(200);
    }
    // 29 days after sign-in, with 30 days of lifetime still ahead.
    const r = await row(s.token);
    expect(Date.now() - r.created_at.getTime()).toBeGreaterThan(28.9 * DAY_MS);
    expect(await remainingMs(s.token)).toBeGreaterThan(29 * DAY_MS);
    expect((await me(s.token)).status).toBe(200);
  });

  it('expires after 30 days of inactivity', async () => {
    const s = await signIn(USERS.anna);
    await advance(30 * DAY_MS - 60_000, s.token);
    expect((await me(s.token)).status).toBe(200); // just inside the window: valid (and renewed)
    const t = await signIn(USERS.anna);
    await advance(30 * DAY_MS + 60_000, t.token);
    const res = await me(t.token);
    expect(res.status).toBe(401);
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`${COOKIE_NAME}=;`)); // stale cookie cleared
  });

  it('is never permanent: renewal stops at the hard maximum age', async () => {
    const s = await signIn(USERS.anna);
    const capDays = AUTH.sessionMaxAgeMs / DAY_MS;
    let lastOk = 0;
    for (let day = 1; day <= capDays + 2; day++) {
      await advance(DAY_MS, s.token);
      const res = await me(s.token);
      if (res.status === 200) lastOk = day;
      else expect(res.status).toBe(401);
      // The expiry never exceeds created_at + maximum age.
      const r = await row(s.token);
      expect(r.absolute_expires_at.getTime()).toBeLessThanOrEqual(r.created_at.getTime() + AUTH.sessionMaxAgeMs + 1000);
    }
    expect(lastOk).toBeGreaterThanOrEqual(capDays - 1);
    expect(lastOk).toBeLessThanOrEqual(capDays);
    expect((await me(s.token)).status).toBe(401);
  }, 60_000);

  it('rejects an expired session', async () => {
    const s = await signIn(USERS.anna);
    await db.query(`UPDATE sessions SET absolute_expires_at = created_at + interval '1 second' WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [s.token]);
    await db.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', last_seen_at = last_seen_at - interval '1 hour', absolute_expires_at = absolute_expires_at - interval '1 hour' WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [s.token]);
    expect((await me(s.token)).status).toBe(401);
  });

  it('rejects an invalid, malformed or unknown session token', async () => {
    expect((await me('not-a-token')).status).toBe(401);
    expect((await me('A'.repeat(43))).status).toBe(401); // well-formed but unknown
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  });

  it('explicit logout invalidates the current session immediately and clears the cookie', async () => {
    const s = await signIn(USERS.anna);
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, Cookie: `${COOKIE_NAME}=${s.token}` })
      .send({});
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`${COOKIE_NAME}=;`));
    expect((await me(s.token)).status).toBe(401);
    expect((await row(s.token)).revoked_at).not.toBeNull();
  });

  it('a revoked session is never renewed, even after a long time', async () => {
    const s = await signIn(USERS.anna);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [s.token]);
    await advance(2 * DAY_MS, s.token); // (no-op for revoked rows; the session stays dead)
    expect((await me(s.token)).status).toBe(401);
    expect(await remainingMs(s.token)).toBeLessThan(31 * DAY_MS);
  });

  it('keeps CSRF protection: the token is stable across renewal and still required for writes', async () => {
    const s = await signIn(USERS.anna);
    await advance(2 * DAY_MS, s.token);
    const renewed = await me(s.token);
    expect(renewed.status).toBe(200);
    expect(setCookieOf(renewed)).toBeDefined();
    expect(renewed.body.csrfToken).toBe(s.csrf); // derived from the (unchanged) session token

    const headers = { ...BROWSER_HEADERS, Cookie: `${COOKIE_NAME}=${s.token}` };
    const noCsrf = await request(app).post('/api/v1/auth/logout').set(headers).send({});
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');
    const wrongOrigin = await request(app).post('/api/v1/auth/logout').set({ ...headers, Origin: 'https://evil.example', 'X-CSRF-Token': s.csrf }).send({});
    expect(wrongOrigin.status).toBe(403);
    expect((await me(s.token)).status).toBe(200); // both attempts left the session intact
    const ok = await request(app).post('/api/v1/auth/logout').set({ ...headers, 'X-CSRF-Token': s.csrf }).send({});
    expect(ok.status).toBe(204);
  });

  it('keeps existing sessions working: a session created under the old 7-day policy is accepted and lifted to 30 days', async () => {
    const s = await signIn(USERS.ben);
    // Re-shape the row exactly as the old code stored it: created 6 days ago, expiry = created + 7 days,
    // used 2 hours ago (no idle problem, and no renewal due under the old 1-minute touch).
    await db.query(
      `UPDATE sessions
          SET created_at = now() - interval '6 days',
              absolute_expires_at = now() - interval '6 days' + interval '7 days',
              last_seen_at = now() - interval '2 hours'
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [s.token],
    );
    expect(Math.abs((await remainingMs(s.token)) - DAY_MS)).toBeLessThan(60_000);
    const res = await me(s.token);
    expect(res.status).toBe(200);
    expect(tokenOf(setCookieOf(res)!)).toBe(s.token); // same token, same hashing
    expect(await remainingMs(s.token)).toBeGreaterThan(29.9 * DAY_MS);
    // ...but still bounded by the cap from its creation date.
    const r = await row(s.token);
    expect(r.absolute_expires_at.getTime()).toBeLessThanOrEqual(r.created_at.getTime() + AUTH.sessionMaxAgeMs);
  });

  it('multiple managers keep independent sessions', async () => {
    const anna = await signIn(USERS.anna);
    const ben = await signIn(USERS.ben);
    const annaTwo = await signIn(USERS.anna); // a second device for the same manager
    expect(new Set([anna.token, ben.token, annaTwo.token]).size).toBe(3);

    expect((await me(anna.token)).body.user.email).toBe(USERS.anna.email);
    expect((await me(ben.token)).body.user.email).toBe(USERS.ben.email);

    // Anna's first session ages out; Ben's and Anna's second one are unaffected.
    await advance(31 * DAY_MS, anna.token);
    expect((await me(anna.token)).status).toBe(401);
    expect((await me(ben.token)).status).toBe(200);
    expect((await me(annaTwo.token)).status).toBe(200);

    // Ben signs out; the others stay signed in.
    const out = await request(app).post('/api/v1/auth/logout').set({ ...BROWSER_HEADERS, 'X-CSRF-Token': ben.csrf, Cookie: `${COOKIE_NAME}=${ben.token}` }).send({});
    expect(out.status).toBe(204);
    expect((await me(ben.token)).status).toBe(401);
    expect((await me(annaTwo.token)).status).toBe(200);
  });

  it('password change and deactivation keep their security behaviour with long sessions', async () => {
    const s = await signIn(USERS.ben);
    await advance(10 * DAY_MS, s.token);
    expect((await me(s.token)).status).toBe(200);
    // Deactivating the account ends even a freshly renewed 30-day session on the next request.
    await db.query(`UPDATE users SET is_active = false WHERE email = $1`, [USERS.ben.email]);
    expect((await me(s.token)).status).toBe(401);
    await db.query(`UPDATE users SET is_active = true WHERE email = $1`, [USERS.ben.email]);
    // Password change revokes the old session and issues a new one (covered in the auth suite; verified here for rolling sessions).
    const t = await signIn(USERS.ben);
    const changed = await request(app)
      .post('/api/v1/auth/change-password')
      .set({ ...BROWSER_HEADERS, 'X-CSRF-Token': t.csrf, Cookie: `${COOKIE_NAME}=${t.token}` })
      .send({ currentPassword: USERS.ben.password, newPassword: 'ben-new-password-9876' });
    expect(changed.status).toBe(200);
    const fresh = tokenOf(setCookieOf(changed)!);
    expect(fresh).not.toBe(t.token);
    expect((await me(t.token)).status).toBe(401);
    expect((await me(fresh)).status).toBe(200);
    expect(Math.abs(expiresOf(setCookieOf(changed)!) - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000);
    USERS.ben.password = 'ben-new-password-9876';
  });
});
