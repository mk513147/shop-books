/**
 * Essential Stage 3D checks (customers, dues, advances, due payments, refunds, reversals, ledger)
 * against a real PostgreSQL test database. Compact by design; see docs/testing-plan.md.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { withTransaction } from '../src/database/transaction.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const paise = (v: string) => BigInt(v.replace('.', ''));

describe.skipIf(!pool)('customers and customer ledger (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  const today = todayInReportingZone();

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch', p: string, body: object, headers: Record<string, string> = {}) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, ...headers }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);
  const newCustomer = async (name: string, phone: string | null = null) =>
    (await send(manager, 'post', '/customers', { name, phone })).body.customer as { id: string; version: number };
  const due = (id: string, amount: string, extra: object = {}) =>
    send(manager, 'post', `/customers/${id}/dues`, { amount, txnDate: today, description: 'Goods on credit', ...extra });
  const advance = (id: string, amount: string) => send(manager, 'post', `/customers/${id}/advances`, { amount, txnDate: today, paymentMode: 'cash' });
  const payDue = (id: string, dueId: string, amount: string) =>
    send(manager, 'post', `/customers/${id}/due-payments`, { amount, txnDate: today, paymentMode: 'upi', dueId });
  const refund = (id: string, amount: string) => send(manager, 'post', `/customers/${id}/refunds`, { amount, txnDate: today, paymentMode: 'cash' });
  const balances = async (id: string) => {
    const c = (await get(owner, `/customers/${id}`)).body.customer;
    return { due: c.dueBalance as string, advance: c.advanceBalance as string };
  };

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner3d@example.test', 'Owner', 'owner', $1), ('mgr3d@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner3d@example.test');
    manager = await signIn('mgr3d@example.test');
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/customers')).status).toBe(401);
  });

  it('creates and manages customers; a phone identifies one active customer; names may repeat', async () => {
    const res = await send(manager, 'post', '/customers', { name: '  Ravi   Kumar ', phone: '+91 98765 43210', address: 'Main road' });
    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({ name: 'Ravi Kumar', dueBalance: '0.00', advanceBalance: '0.00', isActive: true });
    const id = res.body.customer.id;

    const samePhone = await send(owner, 'post', '/customers', { name: 'Someone', phone: '09876543210' });
    expect(samePhone.status).toBe(409);
    expect(samePhone.body.error.code).toBe('CUSTOMER_PHONE_TAKEN');
    expect((await send(owner, 'post', '/customers', { name: 'Ravi Kumar' })).status).toBe(201);
    expect((await send(owner, 'post', '/customers', { name: 'Bad', phone: 'abc' })).status).toBe(400);

    const archived = await send(owner, 'patch', `/customers/${id}`, { isActive: false, version: 1 });
    expect(archived.body.customer).toMatchObject({ isActive: false, version: 2 });
    const reuse = await send(owner, 'post', '/customers', { name: 'New owner of number', phone: '9876543210' });
    expect(reuse.status).toBe(201);
    expect((await send(owner, 'patch', `/customers/${id}`, { isActive: true, version: 2 })).body.error.code).toBe('CUSTOMER_PHONE_TAKEN');

    expect((await get(owner, '/customers?q=ravi')).body.items.length).toBe(1);
    expect((await get(owner, '/customers?q=ravi&status=all')).body.items.length).toBe(2);
    expect((await get(owner, '/customers?q=43210&status=all')).body.items.length).toBe(2);
    const history = (await get(owner, `/customers/${id}/history`)).body.history.map((h: { action: string }) => h.action);
    expect(history).toEqual(['archive', 'create']);
  });

  it('due and advance stay independent (₹5,000 due and ₹2,000 advance are never netted)', async () => {
    const c = await newCustomer('Independent Balances');
    expect((await due(c.id, '5000')).status).toBe(201);
    expect((await advance(c.id, '2000')).status).toBe(201);
    expect(await balances(c.id)).toEqual({ due: '5000.00', advance: '2000.00' });
    // A refund draws only on the advance, never on the due.
    const tooMuch = await refund(c.id, '2000.01');
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.details[0].message).toContain('₹2000.00');
    expect((await refund(c.id, '500')).status).toBe(201);
    expect(await balances(c.id)).toEqual({ due: '5000.00', advance: '1500.00' });

    const onlyDue = await newCustomer('Only Due');
    await due(onlyDue.id, '100');
    expect((await refund(onlyDue.id, '1')).body.error.details[0].message).toContain('no advance');
  });

  it('partial and multiple payments against a due, never beyond what is owed or across customers', async () => {
    const c = await newCustomer('Partial Payer');
    const other = await newCustomer('Other Customer');
    const d = (await due(c.id, '5000')).body.transaction;
    expect((await payDue(c.id, d.id, '1500')).status).toBe(201);
    expect((await payDue(c.id, d.id, '1000')).status).toBe(201);
    const open = (await get(owner, `/customers/${c.id}/open-dues`)).body.dues;
    expect(open[0]).toMatchObject({ id: d.id, paidAmount: '2500.00', remainingAmount: '2500.00' });
    const over = await payDue(c.id, d.id, '2500.01');
    expect(over.status).toBe(400);
    expect(over.body.error.details[0].message).toContain('₹2500.00');
    expect((await payDue(other.id, d.id, '1')).body.error.details[0].path).toBe('dueId');
    expect((await payDue(c.id, d.id, '2500')).status).toBe(201);
    expect((await get(owner, `/customers/${c.id}/open-dues`)).body.dues).toHaveLength(0);
    expect((await payDue(c.id, d.id, '1')).body.error.details[0].message).toContain('fully paid');
    expect(await balances(c.id)).toEqual({ due: '0.00', advance: '0.00' });
  });

  it('validates entry fields', async () => {
    const c = await newCustomer('Validation');
    expect((await due(c.id, '0')).status).toBe(400);
    expect((await due(c.id, '10', { description: ' ' })).status).toBe(400);
    expect((await due(c.id, '10', { paymentMode: 'cash' })).status).toBe(400); // a due moves no money
    expect((await due(c.id, '10', { txnDate: '2999-01-01' })).status).toBe(400);
    expect((await send(manager, 'post', `/customers/${c.id}/advances`, { amount: '10', txnDate: today })).status).toBe(400); // mode required
    expect((await due(c.id, 10 as unknown as string)).status).toBe(400); // numbers are not money
  });

  it('concurrent refunds and payments cannot create invalid balances', async () => {
    const c = await newCustomer('Concurrent');
    await advance(c.id, '1500');
    const refunds = await Promise.all([1, 2, 3, 4, 5].map(() => refund(c.id, '1000')));
    expect(refunds.filter((r) => r.status === 201)).toHaveLength(1);
    const d = (await due(c.id, '2500')).body.transaction;
    const payments = await Promise.all([1, 2, 3, 4].map(() => payDue(c.id, d.id, '2000')));
    expect(payments.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await balances(c.id)).toEqual({ due: '500.00', advance: '500.00' });
  });

  it('reversals keep history, refuse inconsistent states and happen once', async () => {
    const c = await newCustomer('Reversals');
    const d = (await due(c.id, '1000')).body.transaction;
    const p = (await payDue(c.id, d.id, '400')).body.transaction;
    const reverse = (txnId: string, version = 1, reason = 'Entered by mistake') =>
      send(owner, 'post', `/customers/${c.id}/transactions/${txnId}/reverse`, { reason, version });

    expect((await reverse(d.id)).body.error.code).toBe('DUE_HAS_PAYMENTS');
    expect((await reverse(p.id, 1, '')).status).toBe(400);
    expect((await reverse(p.id, 7)).body.error.code).toBe('VERSION_CONFLICT');
    const reversedPayment = await reverse(p.id);
    expect(reversedPayment.body.transaction).toMatchObject({ status: 'reversed', amount: '400.00', reversalReason: 'Entered by mistake' });
    expect((await reverse(p.id, 2)).body.error.code).toBe('ALREADY_REVERSED');
    expect(await balances(c.id)).toEqual({ due: '1000.00', advance: '0.00' });
    expect((await reverse(d.id)).status).toBe(200);
    expect((await payDue(c.id, d.id, '1')).body.error.details[0].message).toContain('reversed');
    expect(await balances(c.id)).toEqual({ due: '0.00', advance: '0.00' });

    const a = (await advance(c.id, '800')).body.transaction;
    await refund(c.id, '300');
    const blocked = await reverse(a.id);
    expect(blocked.body.error.code).toBe('ADVANCE_ALREADY_REFUNDED');

    const history = (await get(owner, `/customers/${c.id}/transactions/${p.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['reverse', 'create']);
    expect(history[0].actor.name).toBe('Owner');

    // Database backstops.
    await expect(db.query(`DELETE FROM customer_transactions WHERE id = $1`, [p.id])).rejects.toThrow(/never deleted/);
    await expect(db.query(`UPDATE customer_transactions SET amount = 1 WHERE id = $1`, [a.id])).rejects.toThrow(/cannot be edited/);
    await expect(
      withTransaction(db, (client) =>
        client.query(
          `INSERT INTO customer_transactions (customer_id, txn_type, txn_date, amount, payment_mode, created_by, updated_by)
           SELECT $1, 'advance_refund', CURRENT_DATE, 10000, 'cash', created_by, created_by FROM customers WHERE id = $1`,
          [c.id],
        ),
      ),
    ).rejects.toThrow(/refunds exceed/);
  });

  it('archived customers keep their ledger; old dues can still be settled and advances refunded', async () => {
    const c = await newCustomer('Archived Later');
    const d = (await due(c.id, '300')).body.transaction;
    await advance(c.id, '100');
    await send(owner, 'patch', `/customers/${c.id}`, { isActive: false, version: c.version });
    expect((await due(c.id, '1')).body.error.code).toBe('CUSTOMER_ARCHIVED');
    expect((await advance(c.id, '1')).body.error.code).toBe('CUSTOMER_ARCHIVED');
    expect((await payDue(c.id, d.id, '300')).status).toBe(201);
    expect((await refund(c.id, '100')).status).toBe(201);
    const ledger = (await get(owner, `/customers/${c.id}/ledger`)).body;
    expect(ledger.customer.isActive).toBe(false);
    expect(ledger.entries).toHaveLength(4);
  });

  it('never exposes an entry through another customer (no IDOR)', async () => {
    const a = await newCustomer('IDOR A');
    const b = await newCustomer('IDOR B');
    const t = (await due(a.id, '10')).body.transaction;
    expect((await get(owner, `/customers/${b.id}/transactions/${t.id}`)).status).toBe(404);
    expect((await send(owner, 'post', `/customers/${b.id}/transactions/${t.id}/reverse`, { reason: 'x', version: 1 })).status).toBe(404);
  });

  it('idempotent recording: retries record one entry', async () => {
    const c = await newCustomer('Idempotent');
    const key = 'cust-key-0123456789abcdef';
    const body = { amount: '250', txnDate: today, paymentMode: 'cash' };
    const results = await Promise.all([1, 2, 3].map(() => send(manager, 'post', `/customers/${c.id}/advances`, body, { 'Idempotency-Key': key })));
    expect(new Set(results.map((r) => r.body.transaction.id)).size).toBe(1);
    expect(await balances(c.id)).toEqual({ due: '0.00', advance: '250.00' });
  });

  it('the ledger reconciles with transaction records; filters never change running balances', async () => {
    const all = (await get(owner, '/customers?status=all&pageSize=100')).body.items as { id: string; dueBalance: string; advanceBalance: string }[];
    let totalDue = 0n;
    let totalAdvance = 0n;
    for (const c of all) {
      const ledger = (await get(owner, `/customers/${c.id}/ledger`)).body;
      const counted = ledger.entries.filter((e: { counted: boolean }) => e.counted);
      const sum = (key: 'dueEffect' | 'advanceEffect') =>
        counted.reduce((s: bigint, e: Record<string, string | null>) => s + (e[key] ? paise(e[key]!.replace('+', '')) : 0n), 0n);
      expect(sum('dueEffect')).toBe(paise(c.dueBalance));
      expect(sum('advanceEffect')).toBe(paise(c.advanceBalance));
      if (ledger.entries.length > 0) {
        expect(ledger.entries.at(-1).runningDue).toBe(c.dueBalance);
        expect(ledger.entries.at(-1).runningAdvance).toBe(c.advanceBalance);
        const refundsOnly = (await get(owner, `/customers/${c.id}/ledger?type=advance_refund`)).body.entries;
        for (const e of refundsOnly) {
          const full = ledger.entries.find((x: { id: string }) => x.id === e.id);
          expect([e.runningDue, e.runningAdvance]).toEqual([full.runningDue, full.runningAdvance]);
        }
      }
      totalDue += paise(c.dueBalance);
      totalAdvance += paise(c.advanceBalance);
      expect(paise(c.dueBalance) >= 0n && paise(c.advanceBalance) >= 0n).toBe(true);
    }
    const summary = (await get(manager, '/customers/summary')).body.summary;
    expect(paise(summary.totalDue)).toBe(totalDue);
    expect(paise(summary.totalAdvance)).toBe(totalAdvance);
    const withFrom = (await get(owner, `/customers/${all[0]!.id}/ledger?from=${today}`)).body;
    expect(withFrom.broughtForward).toEqual({ due: '0.00', advance: '0.00' });
  });
});
