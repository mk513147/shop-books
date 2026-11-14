/**
 * Supplier payments may only be recorded for suppliers that are still owed money, and the
 * record-payment picker lists exactly those suppliers (GET /suppliers?balance=payable).
 *
 * "Owed" = supplier_balances.payable > 0: the sum over the supplier's non-voided bills of
 * amount - paid at purchase - active supplier-payment allocations. Covers unpaid, partly paid
 * (at purchase and by allocation), several open bills, fully paid, voided, and no bills at all.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('supplier payments: only suppliers with an outstanding balance', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let categoryId: string;
  const today = todayInReportingZone();

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch', p: string, body: object) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);

  async function supplier(name: string): Promise<string> {
    const res = await send(owner, 'post', '/suppliers', { name });
    expect(res.status).toBe(201);
    return res.body.supplier.id;
  }
  async function bill(supplierId: string, amount: string, amountPaid = '0') {
    const res = await send(owner, 'post', '/expenses', {
      expenseDate: today,
      supplierId,
      categoryId,
      description: `Bill ${amount}`,
      amount,
      amountPaid,
      paymentMode: amountPaid === '0' ? null : 'cash',
      invoiceReference: null,
    });
    expect(res.status).toBe(201);
    return res.body.expense as { id: string; version: number };
  }
  const pay = (supplierId: string, amount: string, allocations: { expenseId: string; amount: string }[] = []) =>
    send(owner, 'post', '/supplier-payments', { supplierId, amount, paymentDate: today, paymentMode: 'upi', allocations });
  async function payableIds(q = ''): Promise<string[]> {
    const res = await get(owner, `/suppliers?balance=payable&status=all&pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    expect(res.status).toBe(200);
    return res.body.items.map((s: { id: string }) => s.id);
  }

  let unpaid: string;
  let partlyAtPurchase: string;
  let partlyByPayment: string;
  let severalBills: string;
  let fullyPaid: string;
  let fullyPaidAtPurchase: string;
  let voidedOnly: string;
  let noBills: string;

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('owner-out@example.test', 'Owner', 'owner', $1)`, [hash]);
    owner = await signIn('owner-out@example.test');
    categoryId = (await send(owner, 'post', '/categories', { name: 'Outstanding stock' })).body.category.id;

    unpaid = await supplier('Out Unpaid');
    await bill(unpaid, '500');

    partlyAtPurchase = await supplier('Out Partly At Purchase');
    await bill(partlyAtPurchase, '1000', '400');

    partlyByPayment = await supplier('Out Partly By Payment');
    const pb = await bill(partlyByPayment, '1000');
    expect((await pay(partlyByPayment, '300', [{ expenseId: pb.id, amount: '300' }])).status).toBe(201);

    severalBills = await supplier('Out Several Bills');
    await bill(severalBills, '200');
    await bill(severalBills, '300', '100');

    fullyPaid = await supplier('Out Fully Paid');
    const fp = await bill(fullyPaid, '700');
    expect((await pay(fullyPaid, '700', [{ expenseId: fp.id, amount: '700' }])).status).toBe(201);

    fullyPaidAtPurchase = await supplier('Out Paid At Purchase');
    await bill(fullyPaidAtPurchase, '250', '250');

    voidedOnly = await supplier('Out Voided Only');
    const vb = await bill(voidedOnly, '900');
    expect((await send(owner, 'post', `/expenses/${vb.id}/void`, { reason: 'Entered twice', version: vb.version })).status).toBe(200);

    noBills = await supplier('Out No Bills');
  });

  afterAll(async () => {
    await db.end();
  });

  it('the payable list includes unpaid, partly paid and multi-bill suppliers and excludes the rest', async () => {
    const ids = await payableIds('Out ');
    expect(ids).toEqual(expect.arrayContaining([unpaid, partlyAtPurchase, partlyByPayment, severalBills]));
    for (const excluded of [fullyPaid, fullyPaidAtPurchase, voidedOnly, noBills]) expect(ids).not.toContain(excluded);
  });

  it('reports the correct outstanding amount (partial payments and several bills)', async () => {
    const res = await get(owner, '/suppliers?balance=payable&status=all&pageSize=100&q=Out%20');
    const payable = Object.fromEntries(res.body.items.map((s: { id: string; payable: string }) => [s.id, s.payable]));
    expect(payable[unpaid]).toBe('500.00');
    expect(payable[partlyAtPurchase]).toBe('600.00');
    expect(payable[partlyByPayment]).toBe('700.00');
    expect(payable[severalBills]).toBe('400.00');
  });

  it('refuses a payment to a supplier with nothing outstanding (fully paid, voided, no bills)', async () => {
    for (const supplierId of [fullyPaid, fullyPaidAtPurchase, voidedOnly, noBills]) {
      const res = await pay(supplierId, '100');
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ path: 'supplierId', message: 'This supplier has no outstanding bills to pay' }]);
    }
    // Nothing was recorded for them.
    for (const supplierId of [fullyPaidAtPurchase, voidedOnly, noBills]) {
      expect((await get(owner, `/supplier-payments?supplierId=${supplierId}&status=all`)).body.items).toHaveLength(0);
    }
  });

  it('accepts payments while a balance remains, and drops the supplier once it is fully paid', async () => {
    const [first, second] = (await get(owner, `/suppliers/${severalBills}/open-bills`)).body.bills as { id: string; payable: string }[];
    expect([first!.payable, second!.payable].sort()).toEqual(['200.00', '200.00']);

    // Pay one of the two bills: still owed on the other, so still listed and still payable.
    expect((await pay(severalBills, '200', [{ expenseId: first!.id, amount: '200' }])).status).toBe(201);
    expect(await payableIds('Out Several')).toEqual([severalBills]);

    // Settle the last bill: the supplier leaves the list and a further payment is refused.
    expect((await pay(severalBills, '200', [{ expenseId: second!.id, amount: '200' }])).status).toBe(201);
    expect(await payableIds('Out Several')).toEqual([]);
    expect((await pay(severalBills, '50')).status).toBe(400);
  });

  it('a stale picker cannot pay a supplier that became fully paid meanwhile', async () => {
    const supplierId = await supplier('Out Stale');
    const b = await bill(supplierId, '150');
    expect(await payableIds('Out Stale')).toEqual([supplierId]); // what the phone loaded
    expect((await pay(supplierId, '150', [{ expenseId: b.id, amount: '150' }])).status).toBe(201); // paid elsewhere
    const late = await pay(supplierId, '150'); // the phone submits its stale choice
    expect(late.status).toBe(400);
    expect(late.body.error.details[0].path).toBe('supplierId');
  });

  it('a voided bill becomes payable again when restored', async () => {
    const list = (await get(owner, `/expenses?supplierId=${voidedOnly}&status=voided`)).body.items as { id: string; version: number }[];
    expect(list).toHaveLength(1);
    const vb = list[0]!;
    expect((await send(owner, 'post', `/expenses/${vb.id}/restore`, { reason: 'Was real', version: vb.version })).status).toBe(200);
    expect(await payableIds('Out Voided')).toEqual([voidedOnly]);
    expect((await pay(voidedOnly, '100', [{ expenseId: vb.id, amount: '100' }])).status).toBe(201);
  });
});
