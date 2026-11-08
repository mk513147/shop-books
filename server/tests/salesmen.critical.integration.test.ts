/**
 * Salesmen directory (migration 0013) against a real PostgreSQL test database: authentication,
 * create, validation, edit with optimistic concurrency, deactivate / reactivate (history kept),
 * search by name and phone, and audit history.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('salesmen (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch', p: string, body: object) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);

  beforeAll(async () => {
    await runMigrations(db);
    // CASCADE also empties salesmen and financial_audit_events (they reference users).
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('ownersm@example.test', 'Owner', 'owner', $1), ('mgrsm@example.test', 'Manager Asha', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('ownersm@example.test');
    manager = await signIn('mgrsm@example.test');
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/salesmen')).status).toBe(401);
    const res = await request(app).post('/api/v1/salesmen').set(BROWSER_HEADERS).send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('managers create salesmen; input is normalised', async () => {
    const res = await send(manager, 'post', '/salesmen', { name: '  Ravi   Kumar ', phone: '+91 98765 43210', notes: ' Visits Mondays ' });
    expect(res.status).toBe(201);
    expect(res.body.salesman).toMatchObject({
      name: 'Ravi Kumar',
      phone: '+91 98765 43210',
      notes: 'Visits Mondays',
      isActive: true,
      version: 1,
      createdBy: { name: 'Manager Asha' },
    });
    // Names may repeat (two people can share a name).
    expect((await send(owner, 'post', '/salesmen', { name: 'Ravi Kumar' })).status).toBe(201);
  });

  it('rejects invalid input with field-level errors', async () => {
    const cases: [object, string][] = [
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ name: 'Ok', phone: 'call me' }, 'phone'],
      [{ name: 'Ok', notes: 'n'.repeat(1001) }, 'notes'],
    ];
    for (const [body, field] of cases) {
      const res = await send(manager, 'post', '/salesmen', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    }
    // Unknown fields (e.g. invented commission data) are refused.
    expect((await send(manager, 'post', '/salesmen', { name: 'Ok', commission: '5' })).status).toBe(400);
  });

  it('edits with optimistic concurrency', async () => {
    const created = (await send(manager, 'post', '/salesmen', { name: 'Suresh', phone: '9811122233' })).body.salesman;
    const edit = await send(owner, 'patch', `/salesmen/${created.id}`, { phone: '9811122299', notes: 'New number', version: 1 });
    expect(edit.status).toBe(200);
    expect(edit.body.salesman).toMatchObject({ phone: '9811122299', notes: 'New number', version: 2, updatedBy: { name: 'Owner' } });

    const stale = await send(manager, 'patch', `/salesmen/${created.id}`, { name: 'Suresh B', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await get(owner, `/salesmen/${created.id}`)).body.salesman.name).toBe('Suresh');

    // An unchanged save does not bump the version or write history.
    const same = await send(manager, 'patch', `/salesmen/${created.id}`, { name: 'Suresh', version: 2 });
    expect(same.body.salesman.version).toBe(2);
  });

  it('deactivates without deleting; history stays accessible; reactivates', async () => {
    const created = (await send(manager, 'post', '/salesmen', { name: 'Mahesh Old', phone: '9000000001' })).body.salesman;
    const off = await send(manager, 'patch', `/salesmen/${created.id}`, { isActive: false, version: 1 });
    expect(off.status).toBe(200);
    expect(off.body.salesman.isActive).toBe(false);

    const activeNames = (await get(owner, '/salesmen')).body.items.map((s: { name: string }) => s.name);
    expect(activeNames).not.toContain('Mahesh Old');
    const archived = (await get(owner, '/salesmen?status=archived')).body.items.map((s: { name: string }) => s.name);
    expect(archived).toContain('Mahesh Old');
    const all = (await get(owner, '/salesmen?status=all')).body.items.map((s: { name: string }) => s.name);
    expect(all).toContain('Mahesh Old');

    const detail = await get(owner, `/salesmen/${created.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.salesman).toMatchObject({ name: 'Mahesh Old', phone: '9000000001', isActive: false });

    const on = await send(owner, 'patch', `/salesmen/${created.id}`, { isActive: true, version: 2 });
    expect(on.body.salesman).toMatchObject({ isActive: true, version: 3 });

    const history = (await get(manager, `/salesmen/${created.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['reactivate', 'archive', 'create']);
    expect(history[1]).toMatchObject({ actor: { name: 'Manager Asha' }, changes: [{ field: 'isActive', before: true, after: false }] });

    // Rows are never deleted (database trigger).
    await expect(db.query('DELETE FROM salesmen WHERE id = $1', [created.id])).rejects.toThrow(/never deleted/);
  });

  it('searches by name and by phone digits', async () => {
    await send(manager, 'post', '/salesmen', { name: 'Kiran Patel', phone: '+91 77777 12345' });
    const byName = (await get(manager, '/salesmen?q=kiran')).body;
    expect(byName.items.map((s: { name: string }) => s.name)).toEqual(['Kiran Patel']);
    const byPhone = (await get(manager, '/salesmen?q=7777712345')).body;
    expect(byPhone.items.map((s: { name: string }) => s.name)).toEqual(['Kiran Patel']);
    // % and _ are matched literally.
    expect((await get(manager, '/salesmen?q=%25')).body.items).toEqual([]);
    expect((await get(manager, '/salesmen?pageSize=2')).body.pagination).toMatchObject({ pageSize: 2, page: 1 });
  });

  it('returns 404 for unknown or malformed ids', async () => {
    expect((await get(owner, '/salesmen/not-a-uuid')).status).toBe(404);
    expect((await get(owner, '/salesmen/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
