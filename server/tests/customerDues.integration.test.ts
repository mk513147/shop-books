/**
 * Customer dues with a CATEGORY (migration 0014) and "Pay full outstanding amount": FIFO allocation
 * over every open due in one transaction, idempotent, safe under concurrency, rolled back as a whole.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { allocateFifo } from '../src/modules/customers/customerLedger.service.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

describe('allocateFifo (pure)', () => {
  const d = (id: string, rupees: number) => ({ id, remaining: BigInt(rupees * 100) });
  const r = (a: { dueId: string; amount: bigint }[]) => a.map((x) => [x.dueId, Number(x.amount) / 100]);

  it('one due', () => expect(r(allocateFifo([d('A', 500)], 50000n))).toEqual([['A', 500]]));
  it('several dues, paid in full oldest first', () =>
    expect(r(allocateFifo([d('A', 500), d('B', 800), d('C', 300)], 160000n))).toEqual([['A', 500], ['B', 800], ['C', 300]]));
  it('partially settles the last due reached', () =>
    expect(r(allocateFifo([d('A', 500), d('B', 800), d('C', 300)], 100000n))).toEqual([['A', 500], ['B', 500]]));
  it('skips dues with nothing left', () => expect(r(allocateFifo([d('A', 0), d('B', 200)], 20000n))).toEqual([['B', 200]]));
  it('never over-allocates', () => {
    expect(() => allocateFifo([d('A', 500)], 50001n)).toThrow(/more than the total/);
    expect(() => allocateFifo([d('A', 500)], 0n)).toThrow(/greater than zero/);
  });
});

const pool = await connectTestDatabase();

describe.skipIf(!pool)('customer dues: categories and full outstanding payment', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  let other: Session;
  let goods: string;
  let repairs: string;
  let archived: string;
  const today = todayInReportingZone();
  let keyCounter = 0;
  const key = () => `settle-test-key-${Date.now()}-${++keyCounter}`.padEnd(20, 'x');

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const post = (s: Session, p: string, body: object, headers: Record<string, string> = {}) =>
    s.agent.post(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, ...headers }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);
  const newCustomer = async (name: string) => (await post(manager, '/customers', { name })).body.customer as { id: string };
  const due = async (customerId: string, amount: string, txnDate = today, categoryId = goods) => {
    const res = await post(manager, `/customers/${customerId}/dues`, { amount, txnDate, categoryId });
    expect(res.status).toBe(201);
    return res.body.transaction as { id: string };
  };
  const settle = (s: Session, customerId: string, amount: string, k: string | null = key(), extra: object = {}) =>
    post(s, `/customers/${customerId}/due-payments/settle-all`, { amount, txnDate: today, paymentMode: 'upi', ...extra }, k ? { 'Idempotency-Key': k } : {});
  const balance = async (customerId: string) => (await get(owner, `/customers/${customerId}`)).body.customer.dueBalance as string;
  const payments = async (customerId: string) =>
    (
      await db.query<{ due_id: string; amount: string; settlement_id: string | null }>(
        `SELECT due_id, amount::text, settlement_id FROM customer_transactions
          WHERE customer_id = $1 AND txn_type = 'due_payment' AND reversed_at IS NULL ORDER BY created_at, id`,
        [customerId],
      )
    ).rows;

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('cd-owner@example.test', 'Owner', 'owner', $1), ('cd-mgr@example.test', 'Manager', 'manager', $1),
         ('cd-mgr2@example.test', 'Manager Two', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('cd-owner@example.test');
    manager = await signIn('cd-mgr@example.test');
    other = await signIn('cd-mgr2@example.test');
    const cat = async (name: string) => (await post(owner, '/categories', { name: `${name} ${Date.now()}` })).body.category.id as string;
    goods = await cat('Goods');
    repairs = await cat('Repairs');
    archived = await cat('Old');
    expect((await owner.agent.patch(`/api/v1/categories/${archived}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': owner.csrf }).send({ isActive: false })).status).toBe(200);
  });

  afterAll(async () => {
    await db.end();
  });

  describe('due categories', () => {
    it('a due is recorded with an active expense category and optional notes; the category shows in history and the ledger', async () => {
      const c = await newCustomer('Category Customer');
      const res = await post(manager, `/customers/${c.id}/dues`, { amount: '250', txnDate: today, categoryId: repairs, notes: 'Fan repair on credit' });
      expect(res.status).toBe(201);
      expect(res.body.transaction).toMatchObject({ type: 'due', category: { id: repairs, isActive: true }, description: null, notes: 'Fan repair on credit' });
      const ledger = (await get(manager, `/customers/${c.id}/ledger`)).body;
      expect(ledger.entries[0].category.id).toBe(repairs);
      const history = (await get(owner, `/customers/${c.id}/transactions/${res.body.transaction.id}/history`)).body.history;
      expect(history[0].after).toMatchObject({ categoryId: repairs });
    });

    it('a category is mandatory and must be active and existing', async () => {
      const c = await newCustomer('Strict Customer');
      const missing = await post(manager, `/customers/${c.id}/dues`, { amount: '10', txnDate: today, description: 'Old style' });
      expect(missing.status).toBe(400);
      expect(missing.body.error.details[0].path).toBe('categoryId');
      const old = await post(manager, `/customers/${c.id}/dues`, { amount: '10', txnDate: today, categoryId: archived });
      expect(old.status).toBe(400);
      expect(old.body.error.details[0].message).toMatch(/archived/);
      const unknown = await post(manager, `/customers/${c.id}/dues`, { amount: '10', txnDate: today, categoryId: '00000000-0000-4000-8000-000000000000' });
      expect(unknown.status).toBe(400);
      expect(await balance(c.id)).toBe('0.00');
    });

    it('historical dues without a category stay intact and can still be paid', async () => {
      const c = await newCustomer('Legacy Customer');
      const userId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'cd-mgr@example.test'`)).rows[0]!.id;
      const legacy = (
        await db.query<{ id: string }>(
          `INSERT INTO customer_transactions (customer_id, txn_type, txn_date, amount, description, created_by, updated_by)
           VALUES ($1, 'due', $2, 300, 'Goods taken on credit', $3, $3) RETURNING id`,
          [c.id, today, userId],
        )
      ).rows[0]!.id;
      const read = (await get(manager, `/customers/${c.id}/transactions/${legacy}`)).body.transaction;
      expect(read).toMatchObject({ description: 'Goods taken on credit', category: null });
      await expect(db.query(`UPDATE customer_transactions SET category_id = $2 WHERE id = $1`, [legacy, goods])).rejects.toThrow(/cannot be edited/);
      const pay = await post(manager, `/customers/${c.id}/due-payments`, { amount: '100', txnDate: today, paymentMode: 'cash', dueId: legacy });
      expect(pay.status).toBe(201);
      expect(await balance(c.id)).toBe('200.00');
    });

    it('the ledger can be filtered by category (dues of that category and the payments against them)', async () => {
      const c = await newCustomer('Filter Customer');
      const g = await due(c.id, '100', today, goods);
      await due(c.id, '200', today, repairs);
      await post(manager, `/customers/${c.id}/due-payments`, { amount: '40', txnDate: today, paymentMode: 'cash', dueId: g.id });
      const filtered = (await get(manager, `/customers/${c.id}/ledger?categoryId=${goods}`)).body.entries as { type: string; amount: string }[];
      expect(filtered.map((e) => [e.type, e.amount])).toEqual([
        ['due', '100.00'],
        ['due_payment', '40.00'],
      ]);
    });
  });

  describe('pay full outstanding amount', () => {
    it('one due: settled completely', async () => {
      const c = await newCustomer('Single Due');
      const d1 = await due(c.id, '500');
      const res = await settle(manager, c.id, '500');
      expect(res.status).toBe(201);
      expect(res.body.settlement).toMatchObject({ amount: '500.00', paymentMode: 'upi', allocations: [{ dueId: d1.id, amount: '500.00', dueRemainingAfter: '0.00' }] });
      expect(await balance(c.id)).toBe('0.00');
      expect((await get(manager, `/customers/${c.id}/open-dues`)).body.dues).toEqual([]);
    });

    it('several dues (500 + 800 + 300 = 1,600): each fully paid, oldest first, as separate payments of one settlement', async () => {
      const c = await newCustomer('Many Dues');
      // Inserted out of date order on purpose: allocation follows the due DATE, oldest first.
      const b = await due(c.id, '800', '2026-02-01');
      const a = await due(c.id, '500', '2026-01-01');
      const cc = await due(c.id, '300', '2026-03-01');
      const res = await settle(manager, c.id, '1600');
      expect(res.status).toBe(201);
      expect(res.body.settlement.allocations.map((x: { dueId: string; amount: string }) => [x.dueId, x.amount])).toEqual([
        [a.id, '500.00'],
        [b.id, '800.00'],
        [cc.id, '300.00'],
      ]);
      const rows = await payments(c.id);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.settlement_id))).toEqual(new Set([res.body.settlement.id]));
      expect(await balance(c.id)).toBe('0.00');
      // Every individual due record is preserved and shows as paid.
      for (const id of [a.id, b.id, cc.id]) {
        const t = (await get(manager, `/customers/${c.id}/transactions/${id}`)).body.transaction;
        expect(t).toMatchObject({ status: 'active', remainingAmount: '0.00' });
      }
      // Each payment has its own audit entry naming the settlement.
      const pay = res.body.transactions[0];
      const history = (await get(owner, `/customers/${c.id}/transactions/${pay.id}/history`)).body.history;
      expect(history[0]).toMatchObject({ action: 'create', after: { settlementId: res.body.settlement.id } });
    });

    it('a due that was already part paid gets only its remainder (partial allocation of what is left)', async () => {
      const c = await newCustomer('Part Paid');
      const a = await due(c.id, '500', '2026-01-05');
      const b = await due(c.id, '800', '2026-01-06');
      await post(manager, `/customers/${c.id}/due-payments`, { amount: '200', txnDate: today, paymentMode: 'cash', dueId: a.id });
      const res = await settle(manager, c.id, '1100');
      expect(res.status).toBe(201);
      expect(res.body.settlement.allocations.map((x: { dueId: string; amount: string }) => [x.dueId, x.amount])).toEqual([
        [a.id, '300.00'],
        [b.id, '800.00'],
      ]);
      expect(await balance(c.id)).toBe('0.00');
    });

    it('requires an Idempotency-Key; a duplicate submission is replayed, not recorded twice', async () => {
      const c = await newCustomer('Double Tap');
      await due(c.id, '700');
      expect((await settle(manager, c.id, '700', null)).status).toBe(400);
      const k = key();
      const first = await settle(manager, c.id, '700', k);
      const second = await settle(manager, c.id, '700', k);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.settlement.id).toBe(first.body.settlement.id);
      expect(await payments(c.id)).toHaveLength(1);
      expect(await balance(c.id)).toBe('0.00');
    });

    it('refuses an amount that is no longer the outstanding total (never over- or under-allocates)', async () => {
      const c = await newCustomer('Changed Total');
      await due(c.id, '400');
      const over = await settle(manager, c.id, '450');
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('OUTSTANDING_CHANGED');
      expect(over.body.error.message).toMatch(/400\.00/);
      const under = await settle(manager, c.id, '300');
      expect(under.status).toBe(409);
      expect(await payments(c.id)).toEqual([]);
      const none = await newCustomer('Nothing Owed');
      expect((await settle(manager, none.id, '1')).body.error.code).toBe('NOTHING_DUE');
    });

    it('rolls back completely when any allocation fails: no due is marked paid', async () => {
      const c = await newCustomer('Rollback');
      await due(c.id, '100', '2026-01-01');
      const failing = await due(c.id, '200', '2026-01-02');
      await db.query(`CREATE OR REPLACE FUNCTION test_fail_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.due_id = '${failing.id}' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END; $$`);
      await db.query(`CREATE TRIGGER test_fail_settlement BEFORE INSERT ON customer_transactions FOR EACH ROW EXECUTE FUNCTION test_fail_settlement()`);
      try {
        const res = await settle(manager, c.id, '300');
        expect(res.status).toBe(500);
      } finally {
        await db.query('DROP TRIGGER test_fail_settlement ON customer_transactions');
        await db.query('DROP FUNCTION test_fail_settlement()');
      }
      expect(await payments(c.id)).toEqual([]);
      expect(await balance(c.id)).toBe('300.00');
      // Nothing was stored for the key either, so the same request can simply be sent again.
      expect((await settle(manager, c.id, '300')).status).toBe(201);
    });

    it('concurrent attempts: exactly one settles, the other is refused; no due is paid twice', async () => {
      const c = await newCustomer('Race');
      await due(c.id, '500', '2026-01-01');
      await due(c.id, '800', '2026-01-02');
      const [r1, r2] = await Promise.all([settle(manager, c.id, '1300'), settle(other, c.id, '1300')]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      expect(await payments(c.id)).toHaveLength(2);
      expect(await balance(c.id)).toBe('0.00');

      // A single payment racing a settlement: the ledger never exceeds any due.
      const c2 = await newCustomer('Race Two');
      const a = await due(c2.id, '500', '2026-01-01');
      await due(c2.id, '800', '2026-01-02');
      const [single, all] = await Promise.all([
        post(other, `/customers/${c2.id}/due-payments`, { amount: '500', txnDate: today, paymentMode: 'cash', dueId: a.id }),
        settle(manager, c2.id, '1300'),
      ]);
      const ok = [single.status, all.status].filter((s) => s === 201).length;
      expect(ok).toBeGreaterThanOrEqual(1);
      const paid = (await payments(c2.id)).reduce((n, p) => n + Number(p.amount), 0);
      expect(paid).toBeLessThanOrEqual(1300);
      expect(Number(await balance(c2.id))).toBe(1300 - paid);
    });

    it('the individual payment flow and reversals still work alongside settlements', async () => {
      const c = await newCustomer('Mixed');
      const a = await due(c.id, '300', '2026-01-01');
      await due(c.id, '200', '2026-01-02');
      const single = await post(manager, `/customers/${c.id}/due-payments`, { amount: '100', txnDate: today, paymentMode: 'cash', dueId: a.id });
      expect(single.status).toBe(201);
      const res = await settle(manager, c.id, '400');
      expect(res.status).toBe(201);
      const one = res.body.transactions[0];
      const reversed = await post(manager, `/customers/${c.id}/transactions/${one.id}/reverse`, { reason: 'Cheque bounced', version: one.version });
      expect(reversed.status).toBe(200);
      expect(await balance(c.id)).toBe(one.amount);
    });

    it('reports show the due category and the settlement payments', async () => {
      const c = await newCustomer('Report Customer');
      await due(c.id, '120', today, repairs);
      await settle(manager, c.id, '120');
      const items = (await get(manager, `/reports/transactions?period=this_month&q=${encodeURIComponent('Report Customer')}`)).body.items as {
        type: string;
        description: string;
        amount: string;
      }[];
      const byType = Object.fromEntries(items.map((i) => [i.type, i]));
      expect(byType.customer_due!.description).toMatch(/^Repairs/);
      expect(byType.customer_due_payment).toMatchObject({ description: 'Full outstanding payment', amount: '120.00' });
    });
  });
});
