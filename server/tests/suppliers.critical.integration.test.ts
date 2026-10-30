/**
 * Essential checks for suppliers, supplier-category links, expense supplier_id, idempotent
 * expense creation and the 0004 backfill, against a real PostgreSQL test database.
 * Compact by design; the full suite is deferred (docs/testing-plan.md).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { buildBackfillReport } from '../src/modules/suppliers/backfillReport.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../src/database/migrations');

describe.skipIf(!pool)('suppliers, idempotency and backfill (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  let packaging: string;
  let transport: string;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch' | 'delete', p: string, body: object, headers: Record<string, string> = {}) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, ...headers }).send(body);

  const expense = (extra: object = {}) => ({
    expenseDate: todayInReportingZone(),
    categoryId: packaging,
    description: 'Boxes',
    amount: '500',
    amountPaid: '0',
    paymentMode: null,
    invoiceReference: null,
    supplierId: null,
    ...extra,
  });

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner4@example.test', 'Owner', 'owner', $1), ('mgr4@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner4@example.test');
    manager = await signIn('mgr4@example.test');
    packaging = (await send(owner, 'post', '/categories', { name: 'Packaging' })).body.category.id;
    transport = (await send(owner, 'post', '/categories', { name: 'Transport' })).body.category.id;
  });

  afterAll(async () => {
    await db.end();
  });

  it('managers create suppliers with linked categories; names unique case-insensitively among active', async () => {
    const res = await send(manager, 'post', '/suppliers', {
      name: '  Sharma   Traders ',
      phone: '+91 98765-43210',
      categoryIds: [packaging, packaging],
    });
    expect(res.status).toBe(201);
    expect(res.body.supplier).toMatchObject({
      name: 'Sharma Traders',
      phone: '+91 98765-43210',
      isActive: true,
      version: 1,
      categories: [{ id: packaging, name: 'Packaging', isActive: true }],
    });
    const dup = await send(owner, 'post', '/suppliers', { name: 'sharma traders' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SUPPLIER_NAME_TAKEN');
    expect((await send(owner, 'post', '/suppliers', { name: 'X', phone: 'call me' })).status).toBe(400);
    expect((await request(app).get('/api/v1/suppliers')).status).toBe(401);
  });

  it('links and unlinks categories with audit, refusing archived categories; expenses are untouched', async () => {
    const s = (await send(owner, 'post', '/suppliers', { name: 'Gupta Logistics' })).body.supplier;
    const e = (await send(owner, 'post', '/expenses', expense({ supplierId: s.id, categoryId: transport }))).body.expense;

    const linked = await send(manager, 'post', `/suppliers/${s.id}/categories`, { categoryId: transport });
    expect(linked.body.supplier.categories.map((c: { id: string }) => c.id)).toEqual([transport]);
    expect(linked.body.supplier.version).toBe(2);

    const archived = (await send(owner, 'post', '/categories', { name: 'Old stuff' })).body.category;
    await send(owner, 'patch', `/categories/${archived.id}`, { isActive: false });
    const refused = await send(owner, 'patch', `/suppliers/${s.id}`, { categoryIds: [transport, archived.id], version: 2 });
    expect(refused.status).toBe(400);

    const stale = await send(owner, 'patch', `/suppliers/${s.id}`, { categoryIds: [], version: 1 });
    expect(stale.status).toBe(409);
    const removed = await send(owner, 'delete', `/suppliers/${s.id}/categories/${transport}`, {});
    expect(removed.body.supplier.categories).toEqual([]);

    const kept = (await owner.agent.get(`/api/v1/expenses/${e.id}`)).body.expense;
    expect(kept).toMatchObject({ supplier: { id: s.id, name: 'Gupta Logistics' }, category: { id: transport }, version: 1 });

    const history = (await owner.agent.get(`/api/v1/suppliers/${s.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['unlink_category', 'link_category', 'create']);
  });

  it('archived suppliers cannot be chosen for new expenses but stay on existing ones', async () => {
    const s = (await send(owner, 'post', '/suppliers', { name: 'Closing Down Co' })).body.supplier;
    const e = (await send(owner, 'post', '/expenses', expense({ supplierId: s.id }))).body.expense;
    const archived = await send(manager, 'patch', `/suppliers/${s.id}`, { isActive: false, version: 1 });
    expect(archived.body.supplier).toMatchObject({ isActive: false, expenseCount: 1 });

    const blocked = await send(owner, 'post', '/expenses', expense({ supplierId: s.id }));
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details[0].path).toBe('supplierId');
    const edit = await send(owner, 'patch', `/expenses/${e.id}`, { ...expense({ supplierId: s.id }), description: 'Edited', version: 1 });
    expect(edit.status).toBe(200);
    expect(edit.body.expense.supplier).toMatchObject({ id: s.id, isActive: false });
    // Free-text supplier names are no longer accepted.
    expect((await send(owner, 'post', '/expenses', { ...expense(), supplierName: 'Anyone' })).status).toBe(400);

    const search = (await owner.agent.get('/api/v1/suppliers?q=closing&status=all')).body.items;
    expect(search.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const filtered = (await owner.agent.get(`/api/v1/expenses?supplierId=${s.id}`)).body.items;
    expect(filtered.map((x: { id: string }) => x.id)).toEqual([e.id]);
  });

  it('idempotency: same key + same body creates once (also concurrently); other body is 409', async () => {
    const key = randomUUID();
    const body = expense({ description: 'Idempotent', amount: '321.5' });
    const first = await send(manager, 'post', '/expenses', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    const retry = await send(manager, 'post', '/expenses', { ...body, amount: '321.50' }, { 'Idempotency-Key': key });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.expense.id).toBe(first.body.expense.id);

    const reused = await send(manager, 'post', '/expenses', { ...body, amount: '999' }, { 'Idempotency-Key': key });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const raceKey = randomUUID();
    const raceBody = expense({ description: 'Race' });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(manager, 'post', '/expenses', raceBody, { 'Idempotency-Key': raceKey })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.expense.id)).size).toBe(1);
    const count = await db.query(`SELECT count(*)::int AS n FROM expenses WHERE description = 'Race'`);
    expect(count.rows[0].n).toBe(1);

    // Keys are per user: the same key from someone else is independent.
    const other = await send(owner, 'post', '/expenses', raceBody, { 'Idempotency-Key': raceKey });
    expect(other.body.expense.id).not.toBe(results[0]!.body.expense.id);
    // A failed request stores nothing, so the key can be used once the input is fixed.
    const badKey = randomUUID();
    expect((await send(owner, 'post', '/expenses', expense({ amount: '0' }), { 'Idempotency-Key': badKey })).status).toBe(400);
    expect((await send(owner, 'post', '/expenses', expense(), { 'Idempotency-Key': badKey })).status).toBe(201);
    expect((await send(owner, 'post', '/expenses', expense(), { 'Idempotency-Key': 'short' })).status).toBe(400);
  });

  describe('0004 backfill (isolated schema)', () => {
    const schema = `bf_${randomBytes(4).toString('hex')}`;
    let schemaPool: pg.Pool;
    let upTo3: string;

    beforeAll(async () => {
      await db.query(`CREATE SCHEMA ${schema}`);
      schemaPool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        options: `-c search_path=${schema},public`,
      });
      schemaPool.on('error', () => undefined);
      upTo3 = await mkdtemp(path.join(tmpdir(), 'sb-mig-'));
      for (const f of await readdir(MIGRATIONS_DIR)) {
        if (f < '0004') await cp(path.join(MIGRATIONS_DIR, f), path.join(upTo3, f));
      }
    });

    afterAll(async () => {
      await schemaPool.end();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await rm(upTo3, { recursive: true, force: true });
    });

    it('creates suppliers conservatively, links every named expense, keeps typed names and timestamps', async () => {
      await runMigrations(schemaPool, upTo3);
      const user = (
        await schemaPool.query(
          `INSERT INTO users (email, name, role, password_hash)
           VALUES ('bf@example.test', 'BF', 'owner', $1) RETURNING id`,
          [await hashPassword('test-password-123')],
        )
      ).rows[0].id;
      const cat = (
        await schemaPool.query(`INSERT INTO expense_categories (name, created_by, updated_by) VALUES ('C', $1, $1) RETURNING id`, [user])
      ).rows[0].id;
      const names = ['Sharma Traders', 'sharma  traders', 'Sharma Traders', 'Sharma Traders.', 'A.K. Traders', 'AK Traders', null];
      for (const [i, name] of names.entries()) {
        await schemaPool.query(
          `INSERT INTO expenses (expense_date, supplier_name, category_id, description, amount, created_by, updated_by, updated_at)
           VALUES ('2026-01-0${i + 1}', $1, $2, 'x', 10, $3, $3, '2026-01-01T00:00:00Z')`,
          [name, cat, user],
        );
      }

      await runMigrations(schemaPool, MIGRATIONS_DIR);

      const suppliers = (await schemaPool.query(`SELECT name FROM suppliers ORDER BY name`)).rows.map((r) => r.name);
      expect(suppliers).toEqual(['A.K. Traders', 'AK Traders', 'Sharma Traders', 'Sharma Traders.']);
      const rows = (
        await schemaPool.query(
          `SELECT e.legacy_supplier_name AS typed, s.name AS supplier, e.updated_at, e.version
             FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id ORDER BY e.expense_date`,
        )
      ).rows;
      expect(rows.map((r) => [r.typed, r.supplier])).toEqual([
        ['Sharma Traders', 'Sharma Traders'],
        ['sharma  traders', 'Sharma Traders'],
        ['Sharma Traders', 'Sharma Traders'],
        ['Sharma Traders.', 'Sharma Traders.'],
        ['A.K. Traders', 'A.K. Traders'],
        ['AK Traders', 'AK Traders'],
        [null, null],
      ]);
      expect(rows.every((r) => r.version === 1 && r.updated_at.toISOString() === '2026-01-01T00:00:00.000Z')).toBe(true);

      const report = await buildBackfillReport(schemaPool);
      expect(report.unlinkedExpenses).toBe(0);
      expect(report.mappings).toContainEqual({
        originalName: 'sharma  traders',
        supplierName: 'Sharma Traders',
        expenseCount: 1,
        matchRule: 'normalised',
      });
      expect(report.possibleDuplicates.map((d) => d.names)).toEqual([
        ['A.K. Traders', 'AK Traders'],
        ['Sharma Traders', 'Sharma Traders.'],
      ]);
      const imports = await schemaPool.query(
        `SELECT count(*)::int AS n FROM financial_audit_events WHERE action = 'import' AND actor_user_id IS NULL`,
      );
      expect(imports.rows[0].n).toBe(4);
    });
  });
});
