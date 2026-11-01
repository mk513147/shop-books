/**
 * Essential Stage 3C checks (supplier payments, allocations, reversals, supplier ledger) against a
 * real PostgreSQL test database. Compact by design; see docs/testing-plan.md.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('supplier payments and ledger (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  let categoryId: string;
  let supplierA: string;
  let supplierB: string;
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

  async function bill(supplierId: string, amount: string, amountPaid = '0') {
    const res = await send(manager, 'post', '/expenses', {
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
  const pay = (s: Session, body: object, headers: Record<string, string> = {}) =>
    send(s, 'post', '/supplier-payments', { paymentDate: today, paymentMode: 'upi', ...body }, headers);
  const balanceOf = async (id: string) => (await get(owner, `/suppliers/${id}/balance`)).body.balance;

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner3c@example.test', 'Owner', 'owner', $1), ('mgr3c@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner3c@example.test');
    manager = await signIn('mgr3c@example.test');
    categoryId = (await send(owner, 'post', '/categories', { name: 'Stock' })).body.category.id;
    supplierA = (await send(owner, 'post', '/suppliers', { name: 'Alpha Traders' })).body.supplier.id;
    supplierB = (await send(owner, 'post', '/suppliers', { name: 'Beta Traders' })).body.supplier.id;
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/supplier-payments')).status).toBe(401);
    expect((await request(app).get(`/api/v1/suppliers/${supplierA}/ledger`)).status).toBe(401);
  });

  it('a payment is not an expense; partial allocation; payable and unallocated are derived', async () => {
    const a1 = await bill(supplierA, '1000', '200');
    await bill(supplierA, '500');
    const expensesBefore = (await get(owner, '/expenses')).body.totals;

    const res = await pay(manager, { supplierId: supplierA, amount: '600', allocations: [{ expenseId: a1.id, amount: '500' }] });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({
      amount: '600.00',
      allocatedAmount: '500.00',
      unallocatedAmount: '100.00',
      status: 'active',
      version: 1,
    });

    const expensesAfter = (await get(owner, '/expenses')).body.totals;
    expect(expensesAfter.count).toBe(expensesBefore.count);
    expect(expensesAfter.amount).toBe(expensesBefore.amount);
    // Outstanding now also subtracts allocated payments.
    expect((await get(owner, `/expenses/${a1.id}`)).body.expense).toMatchObject({ allocatedPayments: '500.00', outstanding: '300.00' });

    expect(await balanceOf(supplierA)).toMatchObject({
      totalBills: '1500.00',
      paidAtPurchase: '200.00',
      totalPayments: '600.00',
      allocated: '500.00',
      payable: '800.00',
      unallocated: '100.00',
      netBalance: '700.00',
    });
  });

  it('allocates later across several bills and never beyond the payment or a bill', async () => {
    const b1 = await bill(supplierA, '300');
    const b2 = await bill(supplierA, '400');
    const payment = (await pay(manager, { supplierId: supplierA, amount: '600' })).body.payment;
    expect(payment.unallocatedAmount).toBe('600.00');

    const tooMuch = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations`, {
      allocations: [{ expenseId: b1.id, amount: '301' }],
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.details[0].message).toContain('₹300.00');

    const overPayment = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations`, {
      allocations: [
        { expenseId: b1.id, amount: '300' },
        { expenseId: b2.id, amount: '301' },
      ],
    });
    expect(overPayment.status).toBe(400);
    expect(overPayment.body.error.details[0].path).toBe('allocations');

    const dup = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations`, {
      allocations: [
        { expenseId: b1.id, amount: '1' },
        { expenseId: b1.id, amount: '1' },
      ],
    });
    expect(dup.status).toBe(400);

    const ok = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations`, {
      allocations: [
        { expenseId: b1.id, amount: '300' },
        { expenseId: b2.id, amount: '250.50' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.payment).toMatchObject({ allocatedAmount: '550.50', unallocatedAmount: '49.50', version: 2 });
    expect(ok.body.payment.allocations).toHaveLength(2);

    const full = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations`, {
      allocations: [{ expenseId: b1.id, amount: '1' }],
    });
    expect(full.body.error.details[0].message).toMatch(/fully paid|unallocated/);
  });

  it('refuses other suppliers, voided bills, zero amounts and bills without supplier', async () => {
    const other = await bill(supplierB, '300');
    const voided = await bill(supplierA, '100');
    await send(owner, 'post', `/expenses/${voided.id}/void`, { reason: 'Mistake', version: 1 });
    const payment = (await pay(manager, { supplierId: supplierA, amount: '100' })).body.payment;
    for (const [expenseId, amount, fragment] of [
      [other.id, '10', 'different supplier'],
      [voided.id, '10', 'voided'],
      [other.id, '0', 'greater than zero'],
    ] as const) {
      const res = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations`, { allocations: [{ expenseId, amount }] });
      expect(res.status, fragment).toBe(400);
      expect(res.body.error.details[0].message).toContain(fragment);
    }
    // The database refuses a cross-supplier allocation even without the service.
    await expect(
      db.query(
        `INSERT INTO supplier_payment_allocations (payment_id, expense_id, amount, created_by)
         SELECT $1, $2, 10, created_by FROM supplier_payments WHERE id = $1`,
        [payment.id, other.id],
      ),
    ).rejects.toThrow(/different suppliers/);
  });

  it('concurrent allocations never over-allocate a bill or a payment', async () => {
    const target = await bill(supplierA, '400');
    const p1 = (await pay(manager, { supplierId: supplierA, amount: '300' })).body.payment;
    const p2 = (await pay(owner, { supplierId: supplierA, amount: '300' })).body.payment;
    const results = await Promise.all([
      send(manager, 'post', `/supplier-payments/${p1.id}/allocations`, { allocations: [{ expenseId: target.id, amount: '300' }] }),
      send(owner, 'post', `/supplier-payments/${p2.id}/allocations`, { allocations: [{ expenseId: target.id, amount: '300' }] }),
      send(manager, 'post', `/supplier-payments/${p1.id}/allocations`, { allocations: [{ expenseId: target.id, amount: '300' }] }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const expense = (await get(owner, `/expenses/${target.id}`)).body.expense;
    expect(expense.allocatedPayments).toBe('300.00');
    expect(expense.outstanding).toBe('100.00');
  });

  it('bills with allocations cannot be voided, moved or reduced below what is allocated', async () => {
    const target = await bill(supplierA, '500');
    const payment = (await pay(manager, { supplierId: supplierA, amount: '400', allocations: [{ expenseId: target.id, amount: '400' }] }))
      .body.payment;
    const voidRes = await send(owner, 'post', `/expenses/${target.id}/void`, { reason: 'x', version: target.version });
    expect(voidRes.body.error.code).toBe('EXPENSE_HAS_ALLOCATIONS');
    const base = { expenseDate: today, supplierId: supplierA, categoryId, description: 'Bill 500', amount: '500', amountPaid: '0', paymentMode: null, invoiceReference: null };
    expect((await send(owner, 'patch', `/expenses/${target.id}`, { ...base, supplierId: supplierB, version: 1 })).body.error.code).toBe(
      'EXPENSE_HAS_ALLOCATIONS',
    );
    const reduce = await send(owner, 'patch', `/expenses/${target.id}`, { ...base, amount: '399', version: 1 });
    expect(reduce.status).toBe(400);
    expect(reduce.body.error.details[0].path).toBe('amount');
    expect((await send(owner, 'patch', `/expenses/${target.id}`, { ...base, amount: '450', version: 1 })).status).toBe(200);
    await expect(db.query(`UPDATE expenses SET amount = 100 WHERE id = $1`, [target.id])).rejects.toThrow(/allocated/);

    // Release with a reason: the bill is payable again and can then be voided.
    const allocationId = payment.allocations[0].id;
    expect((await send(manager, 'post', `/supplier-payments/${payment.id}/allocations/${allocationId}/release`, { reason: '' })).status).toBe(
      400,
    );
    const released = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations/${allocationId}/release`, {
      reason: 'Wrong bill',
    });
    expect(released.body.payment).toMatchObject({ allocatedAmount: '0.00', unallocatedAmount: '400.00' });
    expect(released.body.payment.allocations[0]).toMatchObject({ status: 'released', releaseReason: 'Wrong bill' });
    const again = await send(manager, 'post', `/supplier-payments/${payment.id}/allocations/${allocationId}/release`, { reason: 'x' });
    expect(again.body.error.code).toBe('ALLOCATION_RELEASED');
    const fresh = (await get(owner, `/expenses/${target.id}`)).body.expense;
    expect(fresh.outstanding).toBe('450.00');
    expect((await send(owner, 'post', `/expenses/${target.id}/void`, { reason: 'Now ok', version: fresh.version })).status).toBe(200);
    const history = (await get(owner, `/expenses/${target.id}/history`)).body.history.map((h: { action: string }) => h.action);
    expect(history).toEqual(['void', 'release_allocation', 'update', 'allocate', 'create']);
  });

  it('reversal is final, releases allocations, keeps history and cannot happen twice', async () => {
    const target = await bill(supplierB, '1000');
    const before = await balanceOf(supplierB);
    const payment = (await pay(manager, { supplierId: supplierB, amount: '700', allocations: [{ expenseId: target.id, amount: '600' }] }))
      .body.payment;
    expect(BigInt((await balanceOf(supplierB)).payable.replace('.', ''))).toBe(BigInt(before.payable.replace('.', '')) - 60000n);

    expect((await send(owner, 'post', `/supplier-payments/${payment.id}/reverse`, { reason: 'Bounced', version: 99 })).body.error.code).toBe(
      'VERSION_CONFLICT',
    );
    const reversed = await send(owner, 'post', `/supplier-payments/${payment.id}/reverse`, { reason: 'Cheque bounced', version: 1 });
    expect(reversed.status).toBe(200);
    expect(reversed.body.payment).toMatchObject({
      status: 'reversed',
      amount: '700.00',
      allocatedAmount: '0.00',
      unallocatedAmount: '0.00',
      reversalReason: 'Cheque bounced',
      reversedBy: { name: 'Owner' },
    });
    expect(reversed.body.payment.allocations[0]).toMatchObject({ status: 'released', amount: '600.00' });
    expect(await balanceOf(supplierB)).toMatchObject({ payable: before.payable, totalPayments: before.totalPayments, unallocated: before.unallocated });

    const twice = await send(owner, 'post', `/supplier-payments/${payment.id}/reverse`, { reason: 'again', version: 2 });
    expect(twice.body.error.code).toBe('PAYMENT_ALREADY_REVERSED');
    expect(
      (await send(owner, 'post', `/supplier-payments/${payment.id}/allocations`, { allocations: [{ expenseId: target.id, amount: '1' }] }))
        .body.error.code,
    ).toBe('PAYMENT_REVERSED');
    expect(
      (await send(owner, 'patch', `/supplier-payments/${payment.id}`, { paymentDate: today, paymentMode: 'cash', version: 2 })).body.error.code,
    ).toBe('PAYMENT_REVERSED');

    const history = (await get(owner, `/supplier-payments/${payment.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['reverse', 'allocate', 'create']);
    expect(history[0].reason).toBe('Cheque bounced');
    await expect(db.query(`DELETE FROM supplier_payments WHERE id = $1`, [payment.id])).rejects.toThrow(/never deleted/);
    await expect(db.query(`UPDATE supplier_payments SET amount = 1 WHERE id = $1`, [payment.id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query(`UPDATE supplier_payments SET reversed_at = NULL, reversed_by = NULL, reversal_reason = NULL WHERE id = $1`, [payment.id])).rejects.toThrow(
      /un-reversed/,
    );
  });

  it('metadata corrections are versioned and audited; amount/supplier are not editable', async () => {
    const payment = (await pay(manager, { supplierId: supplierB, amount: '50', reference: 'UTR1' })).body.payment;
    const future = '2999-01-01';
    expect((await send(owner, 'patch', `/supplier-payments/${payment.id}`, { paymentDate: future, paymentMode: 'upi', version: 1 })).status).toBe(400);
    expect((await send(owner, 'patch', `/supplier-payments/${payment.id}`, { paymentDate: today, paymentMode: 'upi', amount: '5', version: 1 })).status).toBe(
      400,
    );
    const edit = await send(owner, 'patch', `/supplier-payments/${payment.id}`, {
      paymentDate: today,
      paymentMode: 'cheque',
      reference: 'CHQ 4411',
      notes: 'Handed over',
      version: 1,
    });
    expect(edit.body.payment).toMatchObject({ paymentMode: 'cheque', reference: 'CHQ 4411', version: 2 });
    expect((await send(owner, 'patch', `/supplier-payments/${payment.id}`, { paymentDate: today, paymentMode: 'cash', version: 1 })).body.error.code).toBe(
      'VERSION_CONFLICT',
    );
    const history = (await get(owner, `/supplier-payments/${payment.id}/history`)).body.history;
    expect(history[0].changes.map((c: { field: string }) => c.field).sort()).toEqual(['notes', 'paymentMode', 'reference']);
  });

  it('idempotent creation: a retried submit records one payment', async () => {
    const key = 'pay-key-0123456789abcdef';
    const body = { supplierId: supplierB, amount: '75' };
    const results = await Promise.all([1, 2, 3].map(() => pay(manager, body, { 'Idempotency-Key': key })));
    const ids = new Set(results.map((r) => r.body.payment.id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const reused = await pay(manager, { ...body, amount: '76' }, { 'Idempotency-Key': key });
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const list = (await get(owner, `/supplier-payments?supplierId=${supplierB}&q=`)).body.items.filter(
      (p: { amount: string }) => p.amount === '75.00',
    );
    expect(list).toHaveLength(1);
  });

  it('the ledger reconciles with its source transactions', async () => {
    for (const supplierId of [supplierA, supplierB]) {
      const ledger = (await get(owner, `/suppliers/${supplierId}/ledger`)).body;
      const counted = ledger.entries.filter((e: { counted: boolean }) => e.counted);
      const paise = (v: string) => BigInt(v.replace('.', ''));
      const net = counted.reduce((s: bigint, e: { credit: string; debit: string }) => s + paise(e.credit) - paise(e.debit), 0n);
      expect(net).toBe(paise(ledger.balance.netBalance));
      expect(ledger.entries.at(-1).runningBalance).toBe(ledger.balance.netBalance);
      // Every voided bill / reversed payment is listed but not counted.
      expect(ledger.entries.filter((e: { status: string; counted: boolean }) => e.status !== 'active' && e.counted)).toHaveLength(0);
      // Payable equals the sum of what is still payable on open bills.
      const open = (await get(owner, `/suppliers/${supplierId}/open-bills`)).body.bills;
      expect(open.reduce((s: bigint, b: { payable: string }) => s + paise(b.payable), 0n)).toBe(paise(ledger.balance.payable));
      // Filters hide rows but never change running balances.
      const paymentsOnly = (await get(owner, `/suppliers/${supplierId}/ledger?type=payment`)).body.entries;
      for (const e of paymentsOnly) {
        expect(e.runningBalance).toBe(ledger.entries.find((x: { key: string }) => x.key === e.key).runningBalance);
      }
    }
    const withFrom = (await get(owner, `/suppliers/${supplierA}/ledger?from=${today}`)).body;
    expect(withFrom.broughtForward).toBe('0.00');

    const summary = (await get(manager, '/suppliers/summary')).body.summary;
    const a = await balanceOf(supplierA);
    const b = await balanceOf(supplierB);
    const paise = (v: string) => BigInt(v.replace('.', ''));
    expect(paise(summary.totalPayable)).toBe(paise(a.payable) + paise(b.payable));
    expect(paise(summary.totalUnallocated)).toBe(paise(a.unallocated) + paise(b.unallocated));
    expect(summary.suppliersWithPayable).toBe(2);
    const list = (await get(manager, '/suppliers?balance=payable')).body.items;
    expect(list.map((s: { payable: string }) => s.payable)).toEqual(expect.arrayContaining([a.payable, b.payable]));
  });
});
