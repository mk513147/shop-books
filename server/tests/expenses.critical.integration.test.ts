/**
 * Essential Stage 3A checks (categories, expenses, financial audit) against a real PostgreSQL
 * test database. Compact by design; the full suite is deferred (docs/testing-plan.md).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('expenses and categories (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  let categoryId: string;

  async function signIn(email: string, password: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch', path: string, body: object) =>
    s.agent[method](`/api/v1${path}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);

  const baseExpense = () => ({
    expenseDate: todayInReportingZone(),
    supplierId: null,
    categoryId,
    description: 'Packing material',
    amount: '1250.50',
    amountPaid: '500',
    paymentMode: 'upi',
    invoiceReference: 'INV-001',
  });

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner3a@example.test', 'Owner', 'owner', $1), ('mgr3a@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner3a@example.test', 'test-password-123');
    manager = await signIn('mgr3a@example.test', 'test-password-123');
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires authentication for categories and expenses', async () => {
    expect((await request(app).get('/api/v1/expenses')).status).toBe(401);
    expect((await request(app).get('/api/v1/categories')).status).toBe(401);
  });

  it('managers create categories; active names are unique case-insensitively', async () => {
    const created = await send(manager, 'post', '/categories', { name: 'Packaging', description: 'Boxes, tape' });
    expect(created.status).toBe(201);
    categoryId = created.body.category.id;
    const dup = await send(owner, 'post', '/categories', { name: '  packaging ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CATEGORY_NAME_TAKEN');
  });

  it('creates an expense with no bill photo; money is exact decimal strings; outstanding is derived', async () => {
    const res = await send(manager, 'post', '/expenses', baseExpense());
    expect(res.status).toBe(201);
    expect(res.body.expense).toMatchObject({
      amount: '1250.50',
      amountPaid: '500.00',
      outstanding: '750.50',
      status: 'active',
      version: 1,
      createdBy: { name: 'Manager' },
    });
  });

  it('rejects invalid financial input with field-level errors', async () => {
    const cases: [object, string][] = [
      [{ amount: '0' }, 'amount'],
      [{ amount: '-5' }, 'amount'],
      [{ amount: '10.999' }, 'amount'],
      [{ amount: 100 }, 'amount'], // numbers are not accepted for money
      [{ amount: '100', amountPaid: '100.01' }, 'amountPaid'],
      [{ amountPaid: '10', paymentMode: null }, 'paymentMode'],
      [{ paymentMode: 'bitcoin' }, 'paymentMode'],
      [{ expenseDate: '2999-01-01' }, 'expenseDate'],
      [{ description: '   ' }, 'description'],
    ];
    for (const [patch, field] of cases) {
      const res = await send(manager, 'post', '/expenses', { ...baseExpense(), ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    }
    // An unpaid (credit) expense needs no payment mode.
    const credit = await send(manager, 'post', '/expenses', { ...baseExpense(), amountPaid: '0', paymentMode: null });
    expect(credit.status).toBe(201);
  });

  it('edits with optimistic concurrency, refuses amount below paid, and records before/after', async () => {
    const created = (await send(owner, 'post', '/expenses', baseExpense())).body.expense;
    const edit = await send(manager, 'patch', `/expenses/${created.id}`, { ...baseExpense(), amount: '1300', version: 1 });
    expect(edit.status).toBe(200);
    expect(edit.body.expense).toMatchObject({ amount: '1300.00', outstanding: '800.00', version: 2 });

    const stale = await send(owner, 'patch', `/expenses/${created.id}`, { ...baseExpense(), amount: '999', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const belowPaid = await send(owner, 'patch', `/expenses/${created.id}`, { ...baseExpense(), amount: '400', version: 2 });
    expect(belowPaid.status).toBe(400);
    expect(belowPaid.body.error.details[0]).toMatchObject({ path: 'amount' });

    const history = (await owner.agent.get(`/api/v1/expenses/${created.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['update', 'create']);
    expect(history[0].changes).toEqual([{ field: 'amount', before: '1250.50', after: '1300.00' }]);
    expect(history[0].actor.name).toBe('Manager');
  });

  it('voids with a reason (kept, excluded from totals, not editable) and restores explicitly', async () => {
    const created = (await send(owner, 'post', '/expenses', { ...baseExpense(), description: 'To void', amount: '777' })).body.expense;
    const before = (await owner.agent.get('/api/v1/expenses')).body.totals;

    expect((await send(owner, 'post', `/expenses/${created.id}/void`, { reason: '  ', version: 1 })).status).toBe(400);
    const voided = await send(owner, 'post', `/expenses/${created.id}/void`, { reason: 'Duplicate entry', version: 1 });
    expect(voided.body.expense).toMatchObject({ status: 'voided', voidReason: 'Duplicate entry', amount: '777.00' });

    const after = (await owner.agent.get('/api/v1/expenses')).body.totals;
    expect(after.count).toBe(before.count - 1);
    const voidedList = (await owner.agent.get('/api/v1/expenses?status=voided')).body.items;
    expect(voidedList.map((e: { id: string }) => e.id)).toContain(created.id);

    const edit = await send(owner, 'patch', `/expenses/${created.id}`, { ...baseExpense(), version: 2 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('EXPENSE_VOIDED');

    const restored = await send(manager, 'post', `/expenses/${created.id}/restore`, { reason: 'Not a duplicate', version: 2 });
    expect(restored.body.expense).toMatchObject({ status: 'active', voidReason: null, version: 3 });
    const actions = (await owner.agent.get(`/api/v1/expenses/${created.id}/history`)).body.history.map(
      (h: { action: string; reason: string | null }) => [h.action, h.reason],
    );
    expect(actions).toEqual([
      ['restore', 'Not a duplicate'],
      ['void', 'Duplicate entry'],
      ['create', null],
    ]);
  });

  it('archived categories keep existing expenses but cannot be chosen for new ones', async () => {
    const cat = (await send(owner, 'post', '/categories', { name: 'Temporary' })).body.category;
    const exp = (await send(owner, 'post', '/expenses', { ...baseExpense(), categoryId: cat.id })).body.expense;
    const archived = await send(manager, 'patch', `/categories/${cat.id}`, { isActive: false });
    expect(archived.body.category).toMatchObject({ isActive: false, expenseCount: 1 });

    const kept = (await owner.agent.get(`/api/v1/expenses/${exp.id}`)).body.expense;
    expect(kept.category).toMatchObject({ id: cat.id, isActive: false });
    const blocked = await send(owner, 'post', '/expenses', { ...baseExpense(), categoryId: cat.id });
    expect(blocked.status).toBe(400);
    // Editing other fields of an expense whose category was archived is still allowed.
    const edit = await send(owner, 'patch', `/expenses/${exp.id}`, { ...baseExpense(), categoryId: cat.id, description: 'Edited', version: 1 });
    expect(edit.status).toBe(200);
    expect((await owner.agent.get('/api/v1/categories?status=active')).body.categories.map((c: { id: string }) => c.id)).not.toContain(cat.id);
  });

  it('filters, searches and paginates on the server', async () => {
    const page = await owner.agent.get('/api/v1/expenses?pageSize=2&page=1&sort=amount&order=desc');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.pagination.total).toBeGreaterThan(2);
    expect(Number(page.body.items[0].amount)).toBeGreaterThanOrEqual(Number(page.body.items[1].amount));
    const search = await owner.agent.get('/api/v1/expenses?q=' + encodeURIComponent('INV-%'));
    expect(search.body.items).toHaveLength(0); // % is matched literally, not as a wildcard
    const byAmount = await owner.agent.get('/api/v1/expenses?minAmount=1300&maxAmount=1300');
    expect(byAmount.body.items.every((e: { amount: string }) => e.amount === '1300.00')).toBe(true);
    expect((await owner.agent.get('/api/v1/expenses?pageSize=1000')).status).toBe(400);
  });

  it('the database refuses deleting expenses and changing audit history', async () => {
    await expect(db.query('DELETE FROM expenses')).rejects.toThrow(/never deleted/);
    await expect(db.query(`UPDATE financial_audit_events SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM financial_audit_events')).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE expenses SET amount_paid = amount + 1`),
    ).rejects.toThrow(/expenses_paid_within_amount/);
  });
});
