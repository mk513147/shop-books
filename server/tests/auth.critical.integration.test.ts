/**
 * Essential Stage 2 security checks against a real PostgreSQL test database.
 * Deliberately compact: the exhaustive suite is deferred (see docs/testing-plan.md).
 * Skipped (never reported as passing) when no test database is reachable.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { resetOwnerPassword } from '../src/modules/auth/ownerRecovery.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { withSessionTransaction } from '../src/modules/auth/sessionTransaction.js';
import { revokeSession } from '../src/modules/auth/sessions.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('authentication and access control (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  const OWNER = { email: 'owner@example.test', password: 'owner-password-123' };

  async function signIn(email: string, password: string) {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password });
    return { agent, res, csrf: res.body.csrfToken as string };
  }

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Owner', 'owner', $2)`, [
      OWNER.email,
      await hashPassword(OWNER.password),
    ]);
  });

  afterAll(async () => {
    await db.end();
  });

  it('denies everything except health and login without a session', async () => {
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
    for (const path of ['/api/v1/auth/me', '/api/v1/users', '/api/v1/anything']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it('gives identical generic answers for unknown e-mail and wrong password', async () => {
    const unknown = await request(app).post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email: 'nobody@example.test', password: 'x' });
    const wrong = await request(app).post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email: OWNER.email, password: 'wrong-password' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
  });

  it('issues an HttpOnly SameSite=Lax session cookie and stores only a token hash', async () => {
    const { res } = await signIn(OWNER.email, OWNER.password);
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sb_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    const token = /sb_session=([^;]+)/.exec(cookie)![1]!;
    // The database holds SHA-256(token), not the token itself.
    const hashed = await db.query(`SELECT 1 FROM sessions WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [token]);
    expect(hashed.rowCount).toBe(1);
    const plain = await db.query(`SELECT 1 FROM sessions WHERE position(convert_to($1, 'UTF8') IN token_hash) > 0`, [token]);
    expect(plain.rowCount).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('enforces Origin, JSON-only and CSRF on state-changing requests', async () => {
    const { agent, csrf } = await signIn(OWNER.email, OWNER.password);
    const evil = await agent.post('/api/v1/auth/logout').set({ ...BROWSER_HEADERS, Origin: 'https://evil.example', 'X-CSRF-Token': csrf }).send({});
    expect(evil.status).toBe(403);
    const noOrigin = await agent.post('/api/v1/auth/logout').set({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }).send({});
    expect(noOrigin.status).toBe(403);
    const form = await agent.post('/api/v1/auth/logout').set({ Origin: BROWSER_HEADERS.Origin, 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf }).send('x');
    expect(form.status).toBe(415);
    const noCsrf = await agent.post('/api/v1/auth/logout').set(BROWSER_HEADERS).send({});
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');
    const ok = await agent.post('/api/v1/auth/logout').set({ ...BROWSER_HEADERS, 'X-CSRF-Token': csrf }).send({});
    expect(ok.status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401); // revoked server-side
  });

  it('expires sessions after 30 days idle and when the rolling expiry has passed', async () => {
    const idle = await signIn(OWNER.email, OWNER.password);
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '30 days 1 minute' WHERE revoked_at IS NULL`);
    expect((await idle.agent.get('/api/v1/auth/me')).status).toBe(401);

    const absolute = await signIn(OWNER.email, OWNER.password);
    await db.query(
      `UPDATE sessions SET created_at = now() - interval '31 days', absolute_expires_at = now() - interval '1 second'
        WHERE revoked_at IS NULL`,
    );
    expect((await absolute.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  describe('manager lifecycle', () => {
    let owner: Awaited<ReturnType<typeof signIn>>;
    let managerId: string;
    let tempPassword: string;
    const MANAGER_EMAIL = 'manager@example.test';

    beforeAll(async () => {
      owner = await signIn(OWNER.email, OWNER.password);
    });

    const ownerSend = (method: 'post' | 'patch', path: string, body: object) =>
      owner.agent[method](path).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': owner.csrf }).send(body);

    it('owner creates a manager with a temporary password that must be changed', async () => {
      const res = await ownerSend('post', '/api/v1/users', { email: MANAGER_EMAIL, name: 'Manager' });
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ role: 'manager', mustChangePassword: true });
      managerId = res.body.user.id;
      tempPassword = res.body.temporaryPassword;
      const roleAttempt = await ownerSend('patch', `/api/v1/users/${managerId}`, { role: 'owner' });
      expect(roleAttempt.status).toBe(400);
    });

    it('manager is limited until the password is changed, and is never owner-privileged', async () => {
      const mgr = await signIn(MANAGER_EMAIL, tempPassword);
      expect(mgr.res.body.user.mustChangePassword).toBe(true);
      const blocked = await mgr.agent.get('/api/v1/users');
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      const changed = await mgr.agent
        .post('/api/v1/auth/change-password')
        .set({ ...BROWSER_HEADERS, 'X-CSRF-Token': mgr.csrf })
        .send({ currentPassword: tempPassword, newPassword: 'manager-password-456' });
      expect(changed.status).toBe(200);
      const forbidden = await mgr.agent.get('/api/v1/users');
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');
      const create = await mgr.agent.post('/api/v1/users').set({ ...BROWSER_HEADERS, 'X-CSRF-Token': changed.body.csrfToken }).send({ email: 'x@example.test', name: 'X' });
      expect(create.status).toBe(403);
    });

    it('deactivation ends existing sessions and blocks sign-in; the owner cannot be deactivated', async () => {
      const mgr = await signIn(MANAGER_EMAIL, 'manager-password-456');
      expect((await mgr.agent.get('/api/v1/auth/me')).status).toBe(200);
      expect((await ownerSend('patch', `/api/v1/users/${managerId}`, { isActive: false })).status).toBe(200);
      expect((await mgr.agent.get('/api/v1/auth/me')).status).toBe(401);
      expect((await signIn(MANAGER_EMAIL, 'manager-password-456')).res.status).toBe(401);

      const ownerId = (await owner.agent.get('/api/v1/auth/me')).body.user.id;
      const self = await ownerSend('patch', `/api/v1/users/${ownerId}`, { isActive: false });
      expect(self.status).toBe(409);
      await expect(
        db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('second@example.test', 'X', 'owner', $1)`, [
          await hashPassword('another-password-1'),
        ]),
      ).rejects.toThrow(/users_single_owner/);
    });

    it('owner password reset revokes sessions and forces a change', async () => {
      await ownerSend('patch', `/api/v1/users/${managerId}`, { isActive: true });
      const mgr = await signIn(MANAGER_EMAIL, 'manager-password-456');
      const reset = await ownerSend('post', `/api/v1/users/${managerId}/reset-password`, {});
      expect(reset.status).toBe(200);
      expect((await mgr.agent.get('/api/v1/auth/me')).status).toBe(401);
      const again = await signIn(MANAGER_EMAIL, reset.body.temporaryPassword);
      expect(again.res.body.user.mustChangePassword).toBe(true);
    });
  });

  it('locks after 5 failures even under concurrent attempts, and the lock persists in the database', async () => {
    const email = 'lockme@example.test';
    const password = 'correct-password-789';
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Lock', 'manager', $2)`, [
      email,
      await hashPassword(password),
    ]);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'wrong-password!' }),
      ),
    );
    expect(attempts.every((r) => r.status === 401)).toBe(true);
    const state = await db.query(
      `SELECT lockout_count, locked_until > now() + interval '14 minutes' AS locked_15m FROM users WHERE email = $1`,
      [email],
    );
    expect(state.rows[0]).toEqual({ lockout_count: 1, locked_15m: true });
    // Correct password is refused while locked, with the same generic answer.
    const correct = await request(app).post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password });
    expect(correct.status).toBe(401);
  });

  describe('session rotation, revocation and owner recovery (Stage 2 finalization)', () => {
    const EMAIL = 'rotate@example.test';
    const FIRST = 'rotate-password-111';
    const SECOND = 'rotate-password-222';
    const cookieOf = (res: request.Response) => /sb_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1];
    const withCookie = (token: string) => ({ ...BROWSER_HEADERS, Cookie: `sb_session=${token}` });

    beforeAll(async () => {
      await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Rotate', 'manager', $2)`, [
        EMAIL,
        await hashPassword(FIRST),
      ]);
    });

    it('password change rotates the session and CSRF token; old ones are rejected on the next request', async () => {
      const a = await signIn(EMAIL, FIRST);
      const other = await signIn(EMAIL, FIRST); // a second device
      const oldToken = cookieOf(a.res)!;

      const changed = await a.agent
        .post('/api/v1/auth/change-password')
        .set({ ...BROWSER_HEADERS, 'X-CSRF-Token': a.csrf })
        .send({ currentPassword: FIRST, newPassword: SECOND });
      expect(changed.status).toBe(200);
      const newToken = cookieOf(changed)!;
      const newCsrf = changed.body.csrfToken as string;
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(oldToken);
      expect(newCsrf).not.toBe(a.csrf);

      // Old cookie and the other device: dead on their very next request.
      expect((await request(app).get('/api/v1/auth/me').set(withCookie(oldToken))).status).toBe(401);
      expect((await other.agent.get('/api/v1/auth/me')).status).toBe(401);

      // New session + OLD CSRF token: rejected. New session + new token: accepted.
      const staleCsrf = await request(app).post('/api/v1/auth/logout').set({ ...withCookie(newToken), 'X-CSRF-Token': a.csrf }).send({});
      expect(staleCsrf.status).toBe(403);
      expect(staleCsrf.body.error.code).toBe('CSRF_REJECTED');
      expect((await request(app).get('/api/v1/auth/me').set(withCookie(newToken))).body.csrfToken).toBe(newCsrf);
      const ok = await request(app).post('/api/v1/auth/logout').set({ ...withCookie(newToken), 'X-CSRF-Token': newCsrf }).send({});
      expect(ok.status).toBe(204);
    });

    it('requests racing a revocation: none succeed once the revocation has committed', async () => {
      const s = await signIn(EMAIL, SECOND);
      const revoke = db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`, [EMAIL]);
      const racing = Promise.all(Array.from({ length: 10 }, () => s.agent.get('/api/v1/auth/me')));
      await revoke;
      await racing; // individual in-flight reads may finish either way
      const after = await Promise.all(Array.from({ length: 10 }, () => s.agent.get('/api/v1/auth/me')));
      expect(after.every((r) => r.status === 401)).toBe(true);
    });

    it('an in-flight write either commits before the revocation or is refused (never after it)', async () => {
      const s = await signIn(EMAIL, SECOND);
      const sessionId = (
        await db.query<{ id: string }>(
          `SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`,
          [EMAIL],
        )
      ).rows[0]!.id;
      expect(s.res.status).toBe(200);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const write = withSessionTransaction(db, sessionId, async () => {
        locked();
        await gate;
        return 'committed';
      });
      await lockTaken;

      let revokedAt = 0;
      const revoke = revokeSession(db, sessionId, 'logout').then(() => (revokedAt = Date.now()));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(revokedAt).toBe(0); // revocation waits for the in-flight write
      release();
      await expect(write).resolves.toBe('committed');
      await revoke;
      expect(revokedAt).toBeGreaterThan(0);
      // Any later write on that session is refused.
      await expect(withSessionTransaction(db, sessionId, async () => 'x')).rejects.toMatchObject({ status: 401 });
    });

    it('owner recovery: refuses a wrong email; otherwise resets, revokes sessions, forces a change and logs it', async () => {
      const owner = await signIn(OWNER.email, OWNER.password);
      expect(owner.res.status).toBe(200);

      expect(await resetOwnerPassword(db, 'not-the-owner@example.test', 'recovered-password-1')).toEqual({
        ok: false,
        reason: 'email_mismatch',
      });
      expect((await owner.agent.get('/api/v1/auth/me')).status).toBe(200); // nothing changed

      const result = await resetOwnerPassword(db, OWNER.email.toUpperCase(), 'recovered-password-1');
      expect(result).toMatchObject({ ok: true });
      expect((await owner.agent.get('/api/v1/auth/me')).status).toBe(401);
      expect((await signIn(OWNER.email, OWNER.password)).res.status).toBe(401);
      const recovered = await signIn(OWNER.email, 'recovered-password-1');
      expect(recovered.res.body.user).toMatchObject({ role: 'owner', mustChangePassword: true });

      const event = await db.query(
        `SELECT details FROM auth_events WHERE event_type = 'password_reset' AND user_agent = 'owner:reset-password CLI'`,
      );
      expect(event.rows[0].details).toMatchObject({ via: 'cli' });
      expect(JSON.stringify(event.rows)).not.toMatch(/recovered-password|argon2/);
      const owners = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'owner'`);
      expect(owners.rows[0].n).toBe(1);
    });
  });

  it('rate-limits an IP after repeated failures (429)', async () => {
    const ip = (await db.query(`SELECT host(ip) AS ip FROM auth_events WHERE ip IS NOT NULL LIMIT 1`)).rows[0].ip;
    await db.query(
      `INSERT INTO auth_events (event_type, ip) SELECT 'login_failure', $1::inet FROM generate_series(1, 20)`,
      [ip],
    );
    const res = await request(app).post('/api/v1/auth/login').set(BROWSER_HEADERS).send(OWNER);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
  });
});
