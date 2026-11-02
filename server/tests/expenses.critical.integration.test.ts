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
  // A supplier bill may be left unpaid or part-paid; any other expense must be paid in full.
  let supplierId: string;

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
    supplierId,
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
    supplierId = (await send(manager, 'post', '/suppliers', { name: 'Pack Supplies' })).body.supplier.id;
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
      [{ amount: '100', amountPaid: '100.01' }, 'payments'],
      [{ amountPaid: '10', paymentMode: null }, 'paymentMode'],
      [{ paymentMode: 'bitcoin' }, 'paymentMode'],
      [{ expenseDate: '2999-01-01' }, 'expenseDate'],
      [{ supplierId: null }, 'payments'], // part-paid expenses need a supplier
      [{ description: 'x'.repeat(501) }, 'description'],
    ];
    for (const [patch, field] of cases) {
      const res = await send(manager, 'post', '/expenses', { ...baseExpense(), ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    }
    // An unpaid (credit) supplier bill needs no payment mode.
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

  describe('optional description', () => {
    const noDescription = () => ({ ...baseExpense(), supplierId: null, amount: '90', amountPaid: '90', paymentMode: 'cash' });

    it('creates an expense without a description (missing, null, empty or blank) and stores NULL', async () => {
      for (const description of [undefined, null, '', '   ']) {
        const body: Record<string, unknown> = { ...noDescription() };
        if (description === undefined) delete body.description;
        else body.description = description;
        const res = await send(manager, 'post', '/expenses', body);
        expect(res.status, String(description)).toBe(201);
        expect(res.body.expense.description).toBeNull();
        expect(res.body.expense.category.id).toBe(categoryId);
      }
    });

    it('still requires a category and limits the description length', async () => {
      expect((await send(manager, 'post', '/expenses', { ...noDescription(), categoryId: undefined })).status).toBe(400);
      expect((await send(manager, 'post', '/expenses', { ...noDescription(), description: 'x'.repeat(501) })).status).toBe(400);
    });

    it('edits an expense to remove its description; existing descriptions are kept as saved', async () => {
      const created = (await send(owner, 'post', '/expenses', { ...noDescription(), description: 'Tape rolls' })).body.expense;
      expect(created.description).toBe('Tape rolls');
      const cleared = await send(manager, 'patch', `/expenses/${created.id}`, { ...noDescription(), description: '', version: 1 });
      expect(cleared.status).toBe(200);
      expect(cleared.body.expense).toMatchObject({ description: null, version: 2 });
      const history = (await owner.agent.get(`/api/v1/expenses/${created.id}/history`)).body.history;
      expect(history[0].changes).toEqual([{ field: 'description', before: 'Tape rolls', after: null }]);
    });

    it('shows the category name as the label where descriptions are read for supplier bills and the ledger', async () => {
      const s = (await send(manager, 'post', '/suppliers', { name: 'No Description Supplier' })).body.supplier.id;
      await send(manager, 'post', '/expenses', { ...baseExpense(), supplierId: s, description: null });
      const ledger = (await owner.agent.get(`/api/v1/suppliers/${s}/ledger`)).body.entries.map((x: { description: string }) => x.description);
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger).toContain('Packaging');
      expect(ledger.some((d: string) => d.includes('null'))).toBe(false);
    });
  });

  describe('multiple payment methods', () => {
    const full = () => ({ ...baseExpense(), supplierId: null, amount: '2500' });
    const pay = (...rows: [string, string][]) => rows.map(([paymentMode, amount]) => ({ paymentMode, amount }));
    const body = (extra: object) => {
      const { amountPaid: _a, paymentMode: _m, ...base } = full();
      return { ...base, ...extra };
    };
    const create = (extra: object) => send(manager, 'post', '/expenses', body(extra));
    const rowCount = async (expenseId: string) =>
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM expense_payments WHERE expense_id = $1', [expenseId])).rows[0]!.n;
    const totals = async () =>
      (
        await db.query(
          `SELECT (SELECT count(*) FROM expenses) AS e, (SELECT count(*) FROM expense_payments) AS p,
                  (SELECT count(*) FROM financial_audit_events) AS a`,
        )
      ).rows[0];

    it('saves one, two and three or more allocations that equal the expense amount', async () => {
      const one = await create({ payments: pay(['cash', '2500']) });
      expect(one.status).toBe(201);
      expect(one.body.expense).toMatchObject({ amountPaid: '2500.00', outstanding: '0.00', paymentMode: 'cash' });

      const two = await create({ payments: pay(['upi', '1000'], ['cash', '1500']) });
      expect(two.status).toBe(201);
      expect(two.body.expense).toMatchObject({
        amountPaid: '2500.00',
        outstanding: '0.00',
        paymentMode: 'upi',
        payments: [
          { paymentMode: 'upi', amount: '1000.00' },
          { paymentMode: 'cash', amount: '1500.00' },
        ],
      });

      // Exact decimal arithmetic: 1000.10 + 1000 + 499.90 = 2500.00 (not 2499.9999… as floats would risk).
      const three = await create({ payments: pay(['upi', '1000.10'], ['cash', '1000'], ['card', '499.90']) });
      expect(three.status).toBe(201);
      expect(three.body.expense.payments).toHaveLength(3);
      expect(await rowCount(three.body.expense.id)).toBe(3);

      const six = await create({ payments: pay(['upi', '500'], ['cash', '500'], ['card', '500'], ['cheque', '500'], ['other', '250'], ['upi', '250']) });
      expect(six.status).toBe(201);
      expect(six.body.expense.payments).toHaveLength(6);
    });

    it('still accepts the older single amountPaid + paymentMode fields', async () => {
      const res = await send(manager, 'post', '/expenses', { ...full(), amountPaid: '2500', paymentMode: 'bank_transfer' });
      expect(res.status).toBe(201);
      expect(res.body.expense.payments).toEqual([{ paymentMode: 'bank_transfer', amount: '2500.00' }]);
    });

    it('rejects zero or negative amounts, missing or unknown methods, and totals that do not match', async () => {
      const bad: [object, string][] = [
        [{ payments: pay(['cash', '0'], ['upi', '2500']) }, 'payments.0.amount'],
        [{ payments: pay(['cash', '-5'], ['upi', '2505']) }, 'payments.0.amount'],
        [{ payments: [{ amount: '2500' }] }, 'payments.0.paymentMode'],
        [{ payments: [{ amount: '2500', paymentMode: null }] }, 'payments.0.paymentMode'],
        [{ payments: pay(['bitcoin', '2500']) }, 'payments.0.paymentMode'],
        [{ payments: pay(['upi', '1000'], ['cash', '1499.99']) }, 'payments'], // lower
        [{ payments: pay(['upi', '1000'], ['cash', '1500.01']) }, 'payments'], // higher
        [{ payments: [] }, 'payments'], // nothing allocated on a supplier-less expense
        [{ payments: pay(['cash', '2500']), amountPaid: '2500' }, 'payments'], // both formats at once
      ];
      for (const [patch, field] of bad) {
        const res = await create(patch);
        expect(res.status, JSON.stringify(patch)).toBe(400);
        expect(res.body.error.details.map((d: { path: string }) => d.path), JSON.stringify(patch)).toContain(field);
      }
      const lower = await create({ payments: pay(['upi', '1000'], ['cash', '1499.99']) });
      expect(lower.body.error.details[0].message).toMatch(/₹2499\.99.*₹2500\.00/);
      const higher = await create({ payments: pay(['upi', '1000'], ['cash', '1500.01']) });
      expect(higher.body.error.details[0].message).toMatch(/₹2500\.01.*more than.*₹2500\.00/);
    });

    it('a supplier bill may keep a remainder payable, but allocations can never exceed the amount', async () => {
      const part = await create({ supplierId, payments: pay(['upi', '1000']) });
      expect(part.status).toBe(201);
      expect(part.body.expense).toMatchObject({ amountPaid: '1000.00', outstanding: '1500.00' });
      const unpaid = await create({ supplierId, payments: [] });
      expect(unpaid.status).toBe(201);
      expect(unpaid.body.expense).toMatchObject({ amountPaid: '0.00', outstanding: '2500.00', paymentMode: null, payments: [] });
      expect((await create({ supplierId, payments: pay(['upi', '2500.01']) })).status).toBe(400);
    });

    it('commits the expense, allocations and audit together; a failed save leaves nothing behind', async () => {
      const before = await totals();
      expect((await create({ payments: pay(['upi', '1000'], ['cash', '1000']) })).status).toBe(400);
      expect((await create({ payments: pay(['upi', '1000'], ['cash', '1500.01']) })).status).toBe(400);
      expect(await totals()).toEqual(before);

      const ok = await create({ payments: pay(['upi', '1000'], ['cash', '1500']) });
      const after = await totals();
      expect([Number(after.e) - Number(before.e), Number(after.p) - Number(before.p), Number(after.a) - Number(before.a)]).toEqual([1, 2, 1]);
      expect(ok.status).toBe(201);

      // Database level: allocations that do not add up make the whole transaction fail at COMMIT.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO expenses (expense_date, category_id, amount, amount_paid, payment_mode, created_by, updated_by)
           SELECT CURRENT_DATE, $1, 100, 100, 'cash', u.id, u.id FROM users u LIMIT 1 RETURNING id`,
          [categoryId],
        );
        await client.query(`INSERT INTO expense_payments (expense_id, position, payment_mode, amount) VALUES ($1, 1, 'cash', 60)`, [rows[0]!.id]);
        await expect(client.query('COMMIT')).rejects.toThrow(/must equal the amount paid/);
      } finally {
        client.release();
      }
      expect(await totals()).toEqual(after);
    });

    it('edits allocations with version checks and audit history; void and restore keep them', async () => {
      const created = (await create({ payments: pay(['upi', '1000'], ['cash', '1500']) })).body.expense;
      const three = pay(['cash', '500'], ['upi', '1000'], ['card', '1000']);
      const edit = await send(manager, 'patch', `/expenses/${created.id}`, body({ payments: three, version: 1 }));
      expect(edit.status).toBe(200);
      expect(edit.body.expense).toMatchObject({ version: 2, paymentMode: 'cash' });
      expect(edit.body.expense.payments).toHaveLength(3);
      expect(await rowCount(created.id)).toBe(3);

      const stale = await send(owner, 'patch', `/expenses/${created.id}`, body({ payments: pay(['cash', '2500']), version: 1 }));
      expect(stale.status).toBe(409);
      const invalid = await send(owner, 'patch', `/expenses/${created.id}`, body({ payments: pay(['cash', '2400']), version: 2 }));
      expect(invalid.status).toBe(400);
      expect(await rowCount(created.id)).toBe(3); // rejected edits changed nothing

      const same = await send(manager, 'patch', `/expenses/${created.id}`, body({ payments: three, version: 2 }));
      expect(same.body.expense.version).toBe(2); // identical payments are not a change

      const history = (await owner.agent.get(`/api/v1/expenses/${created.id}/history`)).body.history;
      expect(history[0].changes.find((c: { field: string }) => c.field === 'payments')).toMatchObject({
        before: 'upi:1000.00,cash:1500.00',
        after: 'cash:500.00,upi:1000.00,card:1000.00',
      });

      expect((await send(owner, 'post', `/expenses/${created.id}/void`, { reason: 'Test', version: 2 })).status).toBe(200);
      const restored = await send(owner, 'post', `/expenses/${created.id}/restore`, { reason: 'Back', version: 3 });
      expect(restored.body.expense.payments).toHaveLength(3);
    });

    it('the database refuses allocations that do not add up to the amount paid', async () => {
      const created = (await create({ payments: pay(['upi', '1000'], ['cash', '1500']) })).body.expense;
      await expect(db.query(`UPDATE expense_payments SET amount = amount + 1 WHERE expense_id = $1 AND position = 1`, [created.id])).rejects.toThrow(
        /must equal the amount paid/,
      );
      await expect(db.query(`DELETE FROM expense_payments WHERE expense_id = $1 AND position = 2`, [created.id])).rejects.toThrow(/must equal the amount paid/);
      await expect(db.query(`UPDATE expense_payments SET amount = 0 WHERE expense_id = $1`, [created.id])).rejects.toThrow(/expense_payments_amount_positive/);
    });

    it('report breakdown reconciles: per-method paid amounts + unpaid remainder = expense total; supplier payments stay out', async () => {
      const s = (await send(manager, 'post', '/suppliers', { name: 'Reconcile Supplier' })).body.supplier.id;
      const day = '2001-01-15';
      const at = (extra: object) => create({ expenseDate: day, ...extra });
      expect((await at({ payments: pay(['upi', '1000'], ['cash', '1500']) })).status).toBe(201); // 2500, fully paid, two methods
      expect((await at({ supplierId: s, amount: '1000', payments: pay(['upi', '400']) })).status).toBe(201); // part-paid bill
      const unpaid = (await at({ supplierId: s, amount: '600', payments: [] })).body.expense; // unpaid bill
      const voided = (await at({ amount: '300', payments: pay(['cash', '300']) })).body.expense;
      expect((await send(owner, 'post', `/expenses/${voided.id}/void`, { reason: 'dup', version: 1 })).status).toBe(200);
      // A supplier payment settling part of the unpaid bill is NOT an expense payment allocation.
      const sp = await send(manager, 'post', '/supplier-payments', {
        supplierId: s,
        amount: '300',
        paymentDate: day,
        paymentMode: 'upi',
        allocations: [{ expenseId: unpaid.id, amount: '300' }],
      });
      expect(sp.status).toBe(201);

      const period = 'period=custom&from=2001-01-01&to=2001-01-31';
      const r = (await owner.agent.get(`/api/v1/reports/expenses?${period}`)).body;
      expect(r.totals).toMatchObject({ count: 3, amount: '4100.00', paidAtPurchase: '2900.00' });
      const byMode = Object.fromEntries(r.paymentModes.map((m: { paymentMode: string | null }) => [m.paymentMode ?? 'unpaid', m]));
      expect(byMode.upi).toMatchObject({ count: 2, amount: '1400.00', paidAtPurchase: '1400.00' }); // supplier payment's 300 UPI excluded
      expect(byMode.cash).toMatchObject({ count: 1, amount: '1500.00', paidAtPurchase: '1500.00' }); // voided cash excluded
      expect(byMode.unpaid).toMatchObject({ count: 2, amount: '1200.00', paidAtPurchase: '0.00' }); // 600 remainder + 600 unpaid bill
      expect(Object.keys(byMode).sort()).toEqual(['cash', 'unpaid', 'upi']);
      const sum = (rows: { amount: string }[]) => rows.reduce((acc, m) => acc + BigInt(m.amount.replace('.', '')), 0n);
      expect(sum(r.paymentModes)).toBe(410000n);

      // Filtered by a method: the breakdown covers exactly the matching expenses, and still adds up.
      const upi = (await owner.agent.get(`/api/v1/reports/expenses?${period}&paymentMode=upi`)).body;
      expect(upi.totals).toMatchObject({ count: 2, amount: '3500.00' });
      expect(sum(upi.paymentModes)).toBe(350000n);
      const none = (await owner.agent.get(`/api/v1/reports/expenses?${period}&paymentMode=none`)).body;
      expect(none.totals).toMatchObject({ count: 1, amount: '600.00' });
      expect(none.paymentModes).toEqual([expect.objectContaining({ paymentMode: null, amount: '600.00' })]);
    });

    it('supplier ledger: one "paid at purchase" entry per bill with every method listed; balances unchanged', async () => {
      const s = (await send(manager, 'post', '/suppliers', { name: 'Ledger Split Supplier' })).body.supplier.id;
      const e = (await create({ supplierId: s, payments: pay(['upi', '1000'], ['cash', '1500']) })).body.expense;
      const part = (await create({ supplierId: s, amount: '800', payments: pay(['card', '300']) })).body.expense;
      const ledger = (await owner.agent.get(`/api/v1/suppliers/${s}/ledger`)).body;
      const forBill = ledger.entries.filter((x: { sourceId: string }) => x.sourceId === e.id);
      expect(forBill.map((x: { type: string }) => x.type)).toEqual(['bill', 'paid_at_purchase']);
      expect(forBill[1]).toMatchObject({
        debit: '2500.00',
        payments: [
          { paymentMode: 'upi', amount: '1000.00' },
          { paymentMode: 'cash', amount: '1500.00' },
        ],
      });
      expect(forBill[0].payments).toBeNull();
      const partPaid = ledger.entries.find((x: { sourceId: string; type: string }) => x.sourceId === part.id && x.type === 'paid_at_purchase');
      expect(partPaid).toMatchObject({ debit: '300.00', paymentMode: 'card', payments: [{ paymentMode: 'card', amount: '300.00' }] });
      expect(ledger.balance).toMatchObject({ totalBills: '3300.00', paidAtPurchase: '2800.00', payable: '500.00' });
      expect(ledger.entries.at(-1).runningBalance).toBe('500.00');
    });

    it('historical audit entries (before 0010) keep their recorded fields; payments are never invented for them', async () => {
      // An expense exactly as a pre-0010 database held it: payment on the row, a create event
      // without a "payments" field, and the single allocation the migration backfills.
      const client = await db.connect();
      let old: { id: string; uid: string };
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string; uid: string }>(
          `INSERT INTO expenses (expense_date, category_id, description, amount, amount_paid, payment_mode, created_by, updated_by)
           SELECT $2::date, $1, 'Old bill', 700, 700, 'cheque', u.id, u.id FROM users u WHERE u.role = 'owner' LIMIT 1
           RETURNING id, created_by AS uid`,
          [categoryId, todayInReportingZone()],
        );
        old = rows[0]!;
        await client.query(`INSERT INTO expense_payments (expense_id, position, payment_mode, amount) VALUES ($1, 1, 'cheque', 700)`, [old.id]);
        await client.query(
          `INSERT INTO financial_audit_events (entity_type, entity_id, action, actor_user_id, before_values, after_values)
           VALUES ('expense', $1, 'create', $2, NULL, $3::jsonb)`,
          [old.id, old.uid, JSON.stringify({ description: 'Old bill', amount: '700.00', amountPaid: '700.00', paymentMode: 'cheque', status: 'active' })],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const base = { ...baseExpense(), supplierId: null, amount: '700', amountPaid: '700', paymentMode: 'cheque', invoiceReference: null };
      const renamed = await send(owner, 'patch', `/expenses/${old.id}`, { ...base, description: 'Old bill (renamed)', version: 1 });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      let history = (await owner.agent.get(`/api/v1/expenses/${old.id}/history`)).body.history;
      // Editing something else does not report a payments change.
      expect(history[0].changes).toEqual([{ field: 'description', before: 'Old bill', after: 'Old bill (renamed)' }]);
      // The historical create event is returned exactly as recorded: no payments field added.
      expect(history[1].after).not.toHaveProperty('payments');
      expect(history[1].after).toMatchObject({ amountPaid: '700.00', paymentMode: 'cheque' });

      const { amountPaid: _a, paymentMode: _m, ...rest } = base;
      const split = await send(owner, 'patch', `/expenses/${old.id}`, { ...rest, description: 'Old bill (renamed)', payments: pay(['cash', '200'], ['upi', '500']), version: 2 });
      expect(split.status, JSON.stringify(split.body)).toBe(200);
      history = (await owner.agent.get(`/api/v1/expenses/${old.id}/history`)).body.history;
      // The "before" is the recorded single cheque payment (amount_paid + payment_mode), not an empty list.
      expect(history[0].changes.find((c: { field: string }) => c.field === 'payments')).toEqual({
        field: 'payments',
        before: 'cheque:700.00',
        after: 'cash:200.00,upi:500.00',
      });
    });

    it('legacy supplier-less part-paid expenses stay editable only while amount and paid total are unchanged', async () => {
      // As recorded before the full-payment rule: no supplier, 1000 of which 400 paid by UPI.
      const client = await db.connect();
      let id: string;
      try {
        await client.query('BEGIN');
        id = (
          await client.query<{ id: string }>(
            `INSERT INTO expenses (expense_date, category_id, description, amount, amount_paid, payment_mode, created_by, updated_by)
             SELECT $2::date, $1, 'Legacy part-paid', 1000, 400, 'upi', u.id, u.id FROM users u WHERE u.role = 'owner' LIMIT 1 RETURNING id`,
            [categoryId, todayInReportingZone()],
          )
        ).rows[0]!.id;
        await client.query(`INSERT INTO expense_payments (expense_id, position, payment_mode, amount) VALUES ($1, 1, 'upi', 400)`, [id]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const base = { ...baseExpense(), supplierId: null, description: 'Legacy part-paid', amount: '1000', invoiceReference: null };
      const { amountPaid: _a, paymentMode: _m, ...rest } = base;
      const patch = (extra: object, version: number) => send(owner, 'patch', `/expenses/${id}`, { ...rest, ...extra, version });

      // Permitted: unrelated fields, and the same paid total by other methods.
      const renamed = await patch({ description: 'Legacy (renamed)', payments: pay(['upi', '400']) }, 1);
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const methods = await patch({ description: 'Legacy (renamed)', payments: pay(['upi', '150'], ['cash', '250']) }, 2);
      expect(methods.status, JSON.stringify(methods.body)).toBe(200);

      // Rejected: changing the amount (up or down) while still relying on the exemption.
      for (const amount of ['1200', '900']) {
        const res = await patch({ description: 'Legacy (renamed)', amount, payments: pay(['upi', '150'], ['cash', '250']) }, 3);
        expect(res.status, amount).toBe(400);
        expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('payments');
      }
      // Rejected: a different partial total.
      expect((await patch({ description: 'Legacy (renamed)', payments: pay(['upi', '500']) }, 3)).status).toBe(400);

      // Permitted: settling it in full (it then follows the normal rule) — also with a new amount.
      const settled = await patch({ description: 'Legacy (renamed)', amount: '1100', payments: pay(['upi', '400'], ['cash', '700']) }, 3);
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect(settled.body.expense).toMatchObject({ amount: '1100.00', amountPaid: '1100.00', outstanding: '0.00', version: 4 });
      // Once settled, it cannot drop back to part-paid without a supplier.
      expect((await patch({ description: 'Legacy (renamed)', amount: '1100', payments: pay(['upi', '400']) }, 4)).status).toBe(400);

      const history = (await owner.agent.get(`/api/v1/expenses/${id}/history`)).body.history;
      expect(history.map((h: { action: string }) => h.action)).toEqual(['update', 'update', 'update']);
    });

    it('filters by payment method across all allocations; the report splits paid amounts per method and adds up', async () => {
      const upi = (await owner.agent.get('/api/v1/expenses?paymentMode=upi&pageSize=100')).body.items;
      expect(upi.length).toBeGreaterThan(0);
      expect(upi.every((e: { payments: { paymentMode: string }[] }) => e.payments.some((p) => p.paymentMode === 'upi'))).toBe(true);
      const report = (await owner.agent.get('/api/v1/reports/expenses?period=this_month')).body;
      const sum = report.paymentModes.reduce((acc: bigint, m: { amount: string }) => acc + BigInt(m.amount.replace('.', '')), 0n);
      expect(sum).toBe(BigInt(report.totals.amount.replace('.', '')));
      expect(report.paymentModes.find((m: { paymentMode: string | null }) => m.paymentMode === 'upi')).toBeDefined();
    });
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
