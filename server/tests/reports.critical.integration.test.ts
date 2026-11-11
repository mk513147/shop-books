/**
 * Essential Stage 4 checks: period boundaries (unit) and report figures reconciled against the
 * source ledgers (integration, real PostgreSQL test database). See docs/testing-plan.md.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { monthRange, resolvePeriod } from '../src/modules/reports/period.js';
import { percentChange } from '../src/modules/reports/reports.service.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const paise = (v: string) => BigInt(v.replace('.', '').replace('-', '')) * (v.startsWith('-') ? -1n : 1n);

describe('reporting periods (unit)', () => {
  it('resolves presets to explicit inclusive Asia/Kolkata calendar ranges', () => {
    const today = '2026-11-01'; // a Sunday
    expect(resolvePeriod({ period: 'today' }, today)).toMatchObject({ from: today, to: today, previous: { from: '2026-10-31', to: '2026-10-31' } });
    expect(resolvePeriod({ period: 'this_week' }, today)).toMatchObject({
      from: '2026-10-26',
      to: '2026-11-01',
      previous: { from: '2026-10-19', to: '2026-10-25' },
    });
    expect(resolvePeriod({ period: 'this_month' }, today)).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
      previous: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(resolvePeriod({ period: 'previous_month' }, '2026-03-15')).toMatchObject({
      from: '2026-02-01',
      to: '2026-02-28',
      previous: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(resolvePeriod({ period: 'previous_month' }, '2024-03-01')).toMatchObject({ to: '2024-02-29' });
    expect(resolvePeriod({ period: 'previous_month' }, '2026-01-10')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolvePeriod({ period: 'this_quarter' }, '2026-02-15')).toMatchObject({
      from: '2026-01-01',
      to: '2026-03-31',
      previous: { from: '2025-10-01', to: '2025-12-31' },
    });
    expect(resolvePeriod({ period: 'this_year' }, today)).toMatchObject({ from: '2026-01-01', to: '2026-12-31', previous: { from: '2025-01-01' } });
    expect(resolvePeriod({ period: 'custom', from: '2026-10-10', to: '2026-10-19' }, today)).toMatchObject({
      previous: { from: '2026-09-30', to: '2026-10-09' },
    });
    expect(resolvePeriod({ period: 'all_time' }, today)).toMatchObject({ from: '2000-01-01', to: today, previous: null });
    expect(() => resolvePeriod({ period: 'custom', from: '2026-10-19', to: '2026-10-10' }, today)).toThrow();
    expect(() => resolvePeriod({ period: 'custom' }, today)).toThrow();
  });

  it('uses the Kolkata calendar date around UTC midnight', () => {
    expect(todayInReportingZone(new Date('2026-10-31T18:29:59Z'))).toBe('2026-10-31');
    expect(todayInReportingZone(new Date('2026-10-31T18:30:00Z'))).toBe('2026-11-01');
  });

  it('computes percentage change exactly (no floating point)', () => {
    expect(percentChange('150.00', '100.00')).toBe('50.0');
    expect(percentChange('66.66', '100.00')).toBe('-33.3');
    expect(percentChange('10.00', '0.00')).toBeNull();
  });
});

const pool = await connectTestDatabase();

describe.skipIf(!pool)('reports reconcile with the ledgers (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  const today = todayInReportingZone();
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const lastMonthEnd = monthRange(ty, tm - 1).to;
  let cat1: string;
  let cat2: string;
  let s1: string;
  let s2: string;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const post = async (s: Session, p: string, body: object) => {
    const res = await s.agent.post(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
    expect(res.status, `${p} ${JSON.stringify(res.body)}`).toBeLessThan(300);
    return res.body;
  };
  const patch = (s: Session, p: string, body: object) =>
    s.agent.patch(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const get = async (s: Session, p: string) => {
    const res = await s.agent.get(`/api/v1${p}`);
    expect(res.status, `${p} ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  };
  const expense = (supplierId: string | null, categoryId: string, amount: string, amountPaid: string, date = today) =>
    post(manager, '/expenses', {
      expenseDate: date,
      supplierId,
      categoryId,
      description: `Bill ${amount}`,
      amount,
      amountPaid,
      paymentMode: amountPaid === '0' ? null : 'cash',
      invoiceReference: null,
    }).then((b) => b.expense);

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
    cat1 = (await post(owner, '/categories', { name: 'Stock' })).category.id;
    cat2 = (await post(owner, '/categories', { name: 'Rent' })).category.id;
    s1 = (await post(owner, '/suppliers', { name: 'Alpha' })).supplier.id;
    s2 = (await post(owner, '/suppliers', { name: 'Beta' })).supplier.id;

    // This month: 1000 (200 paid) + 500 unpaid for Alpha, 300 Rent no supplier (paid), a voided 999.
    const a1 = await expense(s1, cat1, '1000', '200');
    await expense(s1, cat1, '500', '0');
    await expense(null, cat2, '300', '300');
    const v = await expense(s2, cat1, '999', '0');
    await post(owner, `/expenses/${v.id}/void`, { reason: 'Duplicate', version: 1 });
    // Last day of the previous month: must NOT count in this month.
    await expense(s2, cat2, '400', '0', lastMonthEnd);
    // Supplier payment of 700 allocating 600 to a1 (not an expense).
    await post(manager, '/supplier-payments', {
      supplierId: s1,
      amount: '700',
      paymentDate: today,
      paymentMode: 'upi',
      allocations: [{ expenseId: a1.id, amount: '600' }],
    });
    // Archive Beta: it must stay in historical reports.
    const beta = (await get(owner, `/suppliers/${s2}`)).supplier;
    expect((await patch(owner, `/suppliers/${s2}`, { isActive: false, version: beta.version })).status).toBe(200);

    // Customers: C1 due 5000 (paid 1000), advance 2000 (refund 500); C2 advance 100.
    const c1 = (await post(manager, '/customers', { name: 'Cust One' })).customer.id;
    const c2 = (await post(manager, '/customers', { name: 'Cust Two' })).customer.id;
    const due = (await post(manager, `/customers/${c1}/dues`, { amount: '5000', txnDate: today, categoryId: cat1, notes: 'Credit' })).transaction;
    await post(manager, `/customers/${c1}/due-payments`, { amount: '1000', txnDate: today, paymentMode: 'cash', dueId: due.id });
    await post(manager, `/customers/${c1}/advances`, { amount: '2000', txnDate: today, paymentMode: 'cash' });
    await post(manager, `/customers/${c1}/refunds`, { amount: '500', txnDate: today, paymentMode: 'cash' });
    await post(manager, `/customers/${c2}/advances`, { amount: '100', txnDate: lastMonthEnd, paymentMode: 'upi' });
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires a session; managers can read reports', async () => {
    expect((await request(app).get('/api/v1/reports/dashboard')).status).toBe(401);
    await get(manager, '/reports/dashboard');
  });

  it('dashboard: period activity matches the ledgers; supplier payments are not expenses; current balances separate', async () => {
    const d = (await get(manager, '/reports/dashboard?period=this_month')).dashboard;
    // Active expenses this month only: 1000 + 500 + 300 (voided 999 and last month's 400 excluded).
    expect(d.expenses).toMatchObject({
      count: 3,
      amount: '1800.00',
      paidAtPurchase: '500.00',
      settledByPayments: '600.00',
      outstanding: '700.00',
      voidedCount: 1,
      voidedAmount: '999.00',
      previous: { count: 1, amount: '400.00' },
      changePercent: '350.0',
    });
    // Same as the expense list endpoint for the same dates.
    const { from, to } = d.period;
    const list = (await get(manager, `/expenses?from=${from}&to=${to}`)).totals;
    expect(list).toMatchObject({ count: 3, amount: '1800.00', amountPaid: '500.00', outstanding: '700.00' });
    expect(d.supplierPaymentsInPeriod).toEqual({ count: 1, amount: '700.00' });

    // Current balances: identical to the supplier/customer summaries used by the ledgers.
    const sup = (await get(manager, '/suppliers/summary')).summary;
    expect(d.suppliers).toEqual({ totalPayable: sup.totalPayable, suppliersWithPayable: sup.suppliersWithPayable, totalUnallocated: sup.totalUnallocated });
    expect(d.suppliers).toMatchObject({ totalPayable: '1100.00', totalUnallocated: '100.00' }); // 700 (Alpha) + 400 (Beta, last month)
    const cus = (await get(manager, '/customers/summary')).summary;
    expect(d.customers).toEqual(cus);
    expect(d.customers).toMatchObject({ totalDue: '4000.00', totalAdvance: '1600.00' });
    expect(d.customerActivity).toMatchObject({
      duesRecorded: '5000.00',
      duePaymentsReceived: '1000.00',
      advancesReceived: '2000.00', // C2's 100 was last month
      refundsIssued: '500.00',
    });
    expect(Object.keys(d.customers).sort()).toEqual(['customersWithAdvance', 'customersWithDue', 'totalAdvance', 'totalDue']);
    expect(d.trend).toHaveLength(6);
    expect(d.trend.at(-1)).toMatchObject({ month: today.slice(0, 7), amount: '1800.00', count: 3 });
    expect(d.recentActivity.length).toBeGreaterThan(5);
    expect(JSON.stringify(d.recentActivity)).not.toMatch(/storage/i);
  });

  it('expense and category reports add up to the same totals', async () => {
    const r = await get(manager, '/reports/expenses?period=this_month');
    expect(r.totals.amount).toBe('1800.00');
    expect(r.paidStatus).toEqual([
      { status: 'paid', count: 1, amount: '300.00', outstanding: '0.00' },
      { status: 'partly_paid', count: 1, amount: '1000.00', outstanding: '200.00' },
      { status: 'unpaid', count: 1, amount: '500.00', outstanding: '500.00' },
    ]);
    const sum = (rows: { amount: string }[]) => rows.reduce((s, x) => s + paise(x.amount), 0n);
    expect(sum(r.paymentModes)).toBe(180000n);
    expect(sum(r.topSuppliers)).toBe(180000n);
    const c = await get(manager, '/reports/categories?period=this_month');
    expect(c.total).toBe('1800.00');
    expect(c.rows.map((x: { name: string; amount: string; percent: string }) => [x.name, x.amount, x.percent])).toEqual([
      ['Stock', '1500.00', '83.3'],
      ['Rent', '300.00', '16.6'],
    ]);
    expect(c.rows.find((x: { name: string }) => x.name === 'Rent')).toMatchObject({ previousAmount: '400.00', changePercent: '-25.0' });
    // Filters are validated; unknown fields cannot inject SQL.
    expect((await manager.agent.get('/api/v1/reports/expenses?paymentMode=1;DROP')).status).toBe(400);
    expect((await manager.agent.get('/api/v1/reports/expenses?period=custom&from=2026-02-30&to=2026-03-01')).status).toBe(400);
  });

  it('supplier report: current payable is never filtered by the period; archived suppliers with history stay', async () => {
    const all = await get(manager, '/reports/suppliers');
    const sup = (await get(manager, '/suppliers/summary')).summary;
    expect(all.totals.payable).toBe(sup.totalPayable);
    const alpha = all.items.find((x: { name: string }) => x.name === 'Alpha');
    expect(alpha).toMatchObject({
      totalExpenses: '1500.00',
      directPayments: '200.00',
      allocatedPayments: '600.00',
      totalSettled: '800.00',
      totalPayments: '700.00',
      unallocated: '100.00',
      payable: '700.00',
      outstandingBills: 2,
    });
    const beta = all.items.find((x: { name: string }) => x.name === 'Beta');
    expect(beta).toMatchObject({ isActive: false, payable: '400.00' });

    const month = await get(manager, '/reports/suppliers?period=this_month');
    const betaMonth = month.items.find((x: { name: string }) => x.name === 'Beta');
    expect(betaMonth).toMatchObject({ periodExpenses: '0.00', payable: '400.00' }); // balance unchanged by the period
    expect(month.totals.payable).toBe(all.totals.payable);
    const active = await get(manager, '/reports/suppliers?status=active&outstandingOnly=true');
    expect(active.items.map((x: { name: string }) => x.name)).toEqual(['Alpha']);
  });

  it('customer due and advance reports are separate and reconcile with the summary', async () => {
    const cus = (await get(manager, '/customers/summary')).summary;
    const dues = await get(manager, '/reports/customers/dues');
    const adv = await get(manager, '/reports/customers/advances');
    expect(dues.totals).toMatchObject({ added: '5000.00', reduced: '1000.00', balance: cus.totalDue });
    expect(adv.totals).toMatchObject({ added: '2100.00', reduced: '500.00', balance: cus.totalAdvance });
    expect(dues.items.map((x: { name: string }) => x.name)).toEqual(['Cust One']); // C2 has no dues
    const advMonth = await get(manager, '/reports/customers/advances?period=this_month');
    expect(advMonth.totals).toMatchObject({ added: '2000.00', balance: '1600.00' });
  });

  it('transaction history: every type, paginated, voided rows marked and excluded from amounts', async () => {
    const page1 = await get(manager, '/reports/transactions?period=this_month&pageSize=3');
    expect(page1.items).toHaveLength(3);
    expect(page1.pagination.total).toBe(9); // 4 expenses + 1 payment + 4 customer entries this month
    const counts = Object.fromEntries(page1.totals.map((t: { type: string; count: number }) => [t.type, t.count]));
    expect(counts).toEqual({ customer_advance: 1, customer_due: 1, customer_due_payment: 1, customer_refund: 1, expense: 4, supplier_payment: 1 });
    const expenseTotal = page1.totals.find((t: { type: string }) => t.type === 'expense');
    expect(expenseTotal.amount).toBe('1800.00');
    const cancelled = await get(manager, '/reports/transactions?period=this_month&status=cancelled');
    expect(cancelled.items.map((x: { status: string; amount: string }) => [x.status, x.amount])).toEqual([['voided', '999.00']]);
    const onlyPayments = await get(manager, '/reports/transactions?period=this_month&type=supplier_payment,customer_refund');
    expect(onlyPayments.pagination.total).toBe(2);
    expect((await manager.agent.get('/api/v1/reports/transactions?type=salary')).status).toBe(400);
  });

  it('monthly summary uses the same figures and never nets customer balances', async () => {
    const s = (await get(manager, `/reports/monthly?year=${ty}&month=${tm}`)).summary;
    const d = (await get(manager, '/reports/dashboard?period=this_month')).dashboard;
    expect(s.expenses.amount).toBe(d.expenses.amount);
    expect(s.supplierActivity).toMatchObject({ supplierExpenses: '1500.00', payments: '700.00' });
    expect(s.customers).toEqual(d.customers);
    expect(s.notes.join(' ')).toContain('higher than the previous month');
    expect((await manager.agent.get(`/api/v1/reports/monthly?year=${ty + 1}&month=1`)).status).toBe(400);
  });
});
