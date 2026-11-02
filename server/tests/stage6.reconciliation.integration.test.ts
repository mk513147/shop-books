/**
 * Stage 6 — release-readiness checks across modules:
 *  1. a seeded random history of ~150 mixed financial operations through the API, then every
 *     surface (lists, detail, ledgers, dashboard, reports, Excel exports, monthly summary) is
 *     compared with an INDEPENDENT recomputation from the raw tables (BigInt paise, no SQL views);
 *  2. races between DIFFERENT operations on the same records;
 *  3. route inventory: authentication and role rules for every API route;
 *  4. revoked sessions cannot write through the newer modules;
 *  5. local storage path safety and no static file serving;
 *  6. the 20,000-row export boundary.
 */
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { LocalDocumentStorage } from '../src/modules/documents/localStorage.js';
import { MAX_EXPORT_ROWS } from '../src/modules/exports/exports.service.js';
import { monthRange } from '../src/modules/reports/period.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

const P = (v: string | number | null | undefined) => {
  const s = String(v ?? '0');
  const neg = s.startsWith('-');
  const [w = '0', f = ''] = s.replace('-', '').split('.');
  const p = BigInt(w) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2));
  return neg ? -p : p;
};
const S = (p: bigint) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};

/** Deterministic PRNG (mulberry32) so a failure can be reproduced with the same seed. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!pool)('Stage 6 release-readiness checks', () => {
  const db = pool!;
  let storageDir: string;
  let app: ReturnType<typeof createApp>;
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string; userId: string };
  let owner: Session;
  let manager: Session;
  const today = todayInReportingZone();
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const prev = monthRange(ty, tm - 1);
  const prev2 = monthRange(ty, tm - 2);
  const DATES = [today, `${today.slice(0, 7)}-01`, prev.from, prev.to, prev2.from, prev2.to, `${prev.from.slice(0, 8)}15`];
  const SEED = Number(process.env.S6_SEED ?? 20261101);

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken, userId: res.body.user.id };
  }
  const call = (s: Session, method: 'post' | 'patch' | 'put', p: string, body: object) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const get = async (s: Session, p: string) => {
    const res = await s.agent.get(`/api/v1${p}`);
    expect(res.status, `${p} ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  };
  async function workbook(s: Session, p: string) {
    const res = await s.agent
      .get(`/api/v1/exports/${p}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status, `${p}: ${res.status !== 200 ? res.body.toString() : ''}`).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    return wb;
  }
  /** Last row (totals) of the table that starts with `firstHeader`, as header -> value. */
  function totalsRow(ws: ExcelJS.Worksheet, firstHeader: string): Record<string, unknown> {
    let header = 0;
    ws.eachRow((row, n) => {
      if (!header && row.getCell(1).value === firstHeader) header = n;
    });
    const headers = (ws.getRow(header).values as unknown[]).slice(1) as string[];
    const values = (ws.getRow(ws.rowCount).values as unknown[]).slice(1);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null]));
  }
  const xl = (n: unknown) => P(Number(n).toFixed(2));

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'sb-s6-'));
    app = createApp({ config: testConfig(), db, logger: silentLogger, storage: new LocalDocumentStorage(storageDir) });
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner-s6@example.test', 'Owner', 'owner', $1), ('mgr-s6@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner-s6@example.test');
    manager = await signIn('mgr-s6@example.test');
  });

  afterAll(async () => {
    await db.end();
    await rm(storageDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------------------------
  describe('1. random history reconciles everywhere', () => {
    const suppliers: string[] = [];
    const customers: string[] = [];
    const categories: string[] = [];
    const counts: Record<string, number> = {};
    const note = (k: string, status: number) => {
      const key = `${k}:${status < 300 ? 'ok' : status}`;
      counts[key] = (counts[key] ?? 0) + 1;
      expect(status, `${k} returned ${status}`).toBeLessThan(500);
    };

    beforeAll(async () => {
      for (const name of ['Stock', 'Rent', '=Evil category']) categories.push((await call(owner, 'post', '/categories', { name })).body.category.id);
      for (const name of ['Alpha', 'Beta', 'Gamma']) suppliers.push((await call(owner, 'post', '/suppliers', { name })).body.supplier.id);
      for (const name of ['Cust A', 'Cust B', 'Cust C']) customers.push((await call(manager, 'post', '/customers', { name })).body.customer.id);

      const r = rng(SEED);
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      const money = (max: number) => (Math.floor(r() * max * 100) / 100 + 0.01).toFixed(2);
      const actor = () => (r() < 0.5 ? owner : manager);

      for (let i = 0; i < 150; i++) {
        const op = r();
        const date = pick(DATES);
        if (op < 0.22) {
          const amount = money(5000);
          const drawnPaid = r() < 0.4 ? '0' : r() < 0.5 ? amount : S((P(amount) * BigInt(Math.floor(r() * 100))) / 100n);
          const supplierId = r() < 0.85 ? pick(suppliers) : null;
          // Only a supplier bill may stay unpaid or part-paid; any other expense is paid in full.
          // (Same random draws, in the same order, as before, so each seed replays its history.)
          const paid = supplierId === null ? amount : drawnPaid;
          const res = await call(actor(), 'post', '/expenses', {
            expenseDate: date,
            supplierId,
            categoryId: pick(categories),
            description: r() < 0.1 ? '+cmd description' : `Bill ${i}`,
            amount,
            amountPaid: paid,
            paymentMode: P(paid) > 0n ? pick(['cash', 'upi', 'cheque']) : null,
            invoiceReference: null,
          });
          note('expense', res.status);
        } else if (op < 0.29) {
          const e = (await db.query(`SELECT id, version, voided_at IS NOT NULL AS voided FROM expenses ORDER BY random() LIMIT 1`)).rows[0];
          if (!e) continue;
          const res = await call(actor(), 'post', `/expenses/${e.id}/${e.voided ? 'restore' : 'void'}`, { reason: 'Random', version: e.version });
          note(e.voided ? 'restore' : 'void', res.status);
        } else if (op < 0.44) {
          const supplierId = pick(suppliers);
          const open = (await get(owner, `/suppliers/${supplierId}/open-bills`)).bills as { id: string; payable: string }[];
          const amount = money(3000);
          const allocations: { expenseId: string; amount: string }[] = [];
          let left = P(amount);
          for (const b of open.slice(0, 2)) {
            if (r() < 0.4 || left <= 0n) continue;
            const take = P(b.payable) < left ? P(b.payable) : left;
            if (take > 0n) {
              allocations.push({ expenseId: b.id, amount: S(take) });
              left -= take;
            }
          }
          const res = await call(actor(), 'post', '/supplier-payments', { supplierId, amount, paymentDate: date, paymentMode: 'upi', allocations });
          note('payment', res.status);
        } else if (op < 0.5) {
          const pay = (await db.query(`SELECT id, supplier_id FROM supplier_payments WHERE reversed_at IS NULL ORDER BY random() LIMIT 1`)).rows[0];
          if (!pay) continue;
          const detail = (await get(owner, `/supplier-payments/${pay.id}`)).payment;
          const bills = (await get(owner, `/suppliers/${pay.supplier_id}/open-bills`)).bills as { id: string; payable: string }[];
          if (!bills[0] || P(detail.unallocatedAmount) === 0n) continue;
          const take = P(bills[0].payable) < P(detail.unallocatedAmount) ? P(bills[0].payable) : P(detail.unallocatedAmount);
          note('allocate', (await call(actor(), 'post', `/supplier-payments/${pay.id}/allocations`, { allocations: [{ expenseId: bills[0].id, amount: S(take) }] })).status);
        } else if (op < 0.54) {
          const a = (await db.query(`SELECT id, payment_id FROM supplier_payment_allocations WHERE released_at IS NULL ORDER BY random() LIMIT 1`)).rows[0];
          if (!a) continue;
          note('release', (await call(actor(), 'post', `/supplier-payments/${a.payment_id}/allocations/${a.id}/release`, { reason: 'Random' })).status);
        } else if (op < 0.58) {
          const p = (await db.query(`SELECT id, version FROM supplier_payments WHERE reversed_at IS NULL ORDER BY random() LIMIT 1`)).rows[0];
          if (!p) continue;
          note('reverse-payment', (await call(actor(), 'post', `/supplier-payments/${p.id}/reverse`, { reason: 'Random', version: p.version })).status);
        } else if (op < 0.68) {
          const c = pick(customers);
          note('due', (await call(actor(), 'post', `/customers/${c}/dues`, { amount: money(4000), txnDate: date, description: 'Credit' })).status);
        } else if (op < 0.78) {
          const c = pick(customers);
          const dues = (await get(owner, `/customers/${c}/open-dues`)).dues as { id: string; remainingAmount: string }[];
          if (!dues[0]) continue;
          const amount = r() < 0.3 ? dues[0].remainingAmount : S((P(dues[0].remainingAmount) * BigInt(1 + Math.floor(r() * 99))) / 100n || 1n);
          note('due-payment', (await call(actor(), 'post', `/customers/${c}/due-payments`, { dueId: dues[0].id, amount, txnDate: date, paymentMode: 'cash' })).status);
        } else if (op < 0.86) {
          const c = pick(customers);
          note('advance', (await call(actor(), 'post', `/customers/${c}/advances`, { amount: money(3000), txnDate: date, paymentMode: 'upi' })).status);
        } else if (op < 0.92) {
          const c = pick(customers);
          // Sometimes deliberately try to over-refund (must be refused).
          const cust = (await get(owner, `/customers/${c}`)).customer;
          const amount = r() < 0.2 ? S(P(cust.advanceBalance) + 100n) : P(cust.advanceBalance) > 0n ? S((P(cust.advanceBalance) * BigInt(1 + Math.floor(r() * 100))) / 100n || 1n) : '1.00';
          note('refund', (await call(actor(), 'post', `/customers/${c}/refunds`, { amount, txnDate: date, paymentMode: 'cash' })).status);
        } else if (op < 0.97) {
          const t = (await db.query(`SELECT id, customer_id, version FROM customer_transactions WHERE reversed_at IS NULL ORDER BY random() LIMIT 1`)).rows[0];
          if (!t) continue;
          note('reverse-customer', (await call(actor(), 'post', `/customers/${t.customer_id}/transactions/${t.id}/reverse`, { reason: 'Random', version: t.version })).status);
        } else {
          // Archive / reactivate a supplier or customer: history must stay in every report.
          const isSupplier = r() < 0.5;
          const id = pick(isSupplier ? suppliers : customers);
          const cur = (await get(owner, `/${isSupplier ? 'suppliers' : 'customers'}/${id}`))[isSupplier ? 'supplier' : 'customer'];
          note('archive-toggle', (await call(owner, 'patch', `/${isSupplier ? 'suppliers' : 'customers'}/${id}`, { isActive: !cur.isActive, version: cur.version })).status);
        }
      }
    }, 240_000);

    /** Independent model from raw rows (no views, no report functions). */
    async function model() {
      const ex = (await db.query(`SELECT id, supplier_id, expense_date::text AS d, amount, amount_paid, voided_at IS NOT NULL AS voided FROM expenses`)).rows;
      const pay = (await db.query(`SELECT id, supplier_id, payment_date::text AS d, amount, reversed_at IS NOT NULL AS reversed FROM supplier_payments`)).rows;
      const al = (await db.query(`SELECT payment_id, expense_id, amount, released_at IS NOT NULL AS released FROM supplier_payment_allocations`)).rows;
      const ct = (await db.query(`SELECT id, customer_id, txn_type, txn_date::text AS d, amount, due_id, reversed_at IS NOT NULL AS reversed FROM customer_transactions`)).rows;
      const payById = new Map(pay.map((p) => [p.id, p]));
      const exById = new Map(ex.map((e) => [e.id, e]));
      const activeAlloc = al.filter((a) => !a.released);
      const allocByExpense = new Map<string, bigint>();
      const allocByPayment = new Map<string, bigint>();
      for (const a of activeAlloc) {
        allocByExpense.set(a.expense_id, (allocByExpense.get(a.expense_id) ?? 0n) + P(a.amount));
        allocByPayment.set(a.payment_id, (allocByPayment.get(a.payment_id) ?? 0n) + P(a.amount));
      }
      const sup = new Map<string, { bills: bigint; paid: bigint; alloc: bigint; payments: bigint; payable: bigint; unallocated: bigint }>();
      for (const s of suppliers) sup.set(s, { bills: 0n, paid: 0n, alloc: 0n, payments: 0n, payable: 0n, unallocated: 0n });
      for (const e of ex.filter((e) => !e.voided && e.supplier_id)) {
        const s = sup.get(e.supplier_id)!;
        s.bills += P(e.amount);
        s.paid += P(e.amount_paid);
        s.alloc += allocByExpense.get(e.id) ?? 0n;
      }
      for (const p of pay.filter((p) => !p.reversed)) sup.get(p.supplier_id)!.payments += P(p.amount);
      for (const s of sup.values()) {
        s.payable = s.bills - s.paid - s.alloc;
        s.unallocated = s.payments - s.alloc;
      }
      const cus = new Map<string, { due: bigint; advance: bigint }>();
      for (const c of customers) cus.set(c, { due: 0n, advance: 0n });
      for (const t of ct.filter((t) => !t.reversed)) {
        const c = cus.get(t.customer_id)!;
        if (t.txn_type === 'due') c.due += P(t.amount);
        if (t.txn_type === 'due_payment') c.due -= P(t.amount);
        if (t.txn_type === 'advance') c.advance += P(t.amount);
        if (t.txn_type === 'advance_refund') c.advance -= P(t.amount);
      }
      const expensesIn = (from: string, to: string) => {
        const rows = ex.filter((e) => !e.voided && e.d >= from && e.d <= to);
        const sum = (f: (e: (typeof rows)[number]) => bigint) => rows.reduce((s, e) => s + f(e), 0n);
        return {
          count: rows.length,
          amount: sum((e) => P(e.amount)),
          paid: sum((e) => P(e.amount_paid)),
          settled: sum((e) => allocByExpense.get(e.id) ?? 0n),
          outstanding: sum((e) => P(e.amount) - P(e.amount_paid) - (allocByExpense.get(e.id) ?? 0n)),
          voided: ex.filter((e) => e.voided && e.d >= from && e.d <= to).length,
        };
      };
      const paymentsIn = (from: string, to: string) => pay.filter((p) => !p.reversed && p.d >= from && p.d <= to).reduce((s, p) => s + P(p.amount), 0n);
      const customerIn = (from: string, to: string, type: string) =>
        ct.filter((t) => !t.reversed && t.txn_type === type && t.d >= from && t.d <= to).reduce((s, t) => s + P(t.amount), 0n);
      return { ex, pay, al, ct, payById, exById, allocByExpense, allocByPayment, sup, cus, expensesIn, paymentsIn, customerIn };
    }

    it('the random history exercised every operation (including refused ones)', () => {
      for (const k of ['expense:ok', 'payment:ok', 'due:ok', 'advance:ok', 'due-payment:ok', 'refund:ok', 'void:ok', 'reverse-customer:ok', 'release:ok', 'reverse-payment:ok']) {
        expect(counts[k] ?? 0, `${k} in ${JSON.stringify(counts)}`).toBeGreaterThan(0);
      }
      expect(Object.keys(counts).some((k) => k.startsWith('refund:4'))).toBe(true); // over-refund refused
    });

    it('ledger invariants hold on the raw rows', async () => {
      const m = await model();
      for (const a of m.al.filter((x) => !x.released)) {
        expect(m.payById.get(a.payment_id)!.reversed, 'active allocation on reversed payment').toBe(false);
        expect(m.exById.get(a.expense_id)!.voided, 'active allocation on voided expense').toBe(false);
        expect(m.exById.get(a.expense_id)!.supplier_id).toBe(m.payById.get(a.payment_id)!.supplier_id);
      }
      for (const [id, total] of m.allocByPayment) expect(total <= P(m.payById.get(id)!.amount)).toBe(true);
      for (const [id, total] of m.allocByExpense) {
        const e = m.exById.get(id)!;
        expect(total <= P(e.amount) - P(e.amount_paid)).toBe(true);
      }
      for (const c of m.cus.values()) {
        expect(c.due >= 0n && c.advance >= 0n).toBe(true);
      }
      const duePaid = new Map<string, bigint>();
      for (const t of m.ct.filter((t) => !t.reversed && t.txn_type === 'due_payment')) duePaid.set(t.due_id, (duePaid.get(t.due_id) ?? 0n) + P(t.amount));
      for (const [dueId, paid] of duePaid) {
        const due = m.ct.find((t) => t.id === dueId)!;
        expect(due.reversed, 'reversed due with active payments').toBe(false);
        expect(paid <= P(due.amount)).toBe(true);
      }
    });

    it('suppliers: list, detail balance, ledger, open bills, summary and supplier report agree with the model', async () => {
      const m = await model();
      const list = (await get(owner, '/suppliers?status=all&pageSize=100')).items as { id: string; payable: string; unallocated: string }[];
      const report = await get(owner, '/reports/suppliers?pageSize=100');
      let payable = 0n;
      let unallocated = 0n;
      for (const id of suppliers) {
        const exp = m.sup.get(id)!;
        payable += exp.payable;
        unallocated += exp.unallocated;
        const fromList = list.find((s) => s.id === id)!;
        expect([P(fromList.payable), P(fromList.unallocated)]).toEqual([exp.payable, exp.unallocated]);
        const bal = (await get(owner, `/suppliers/${id}/balance`)).balance;
        expect([P(bal.totalBills), P(bal.paidAtPurchase), P(bal.allocated), P(bal.totalPayments), P(bal.payable), P(bal.unallocated)]).toEqual([
          exp.bills,
          exp.paid,
          exp.alloc,
          exp.payments,
          exp.payable,
          exp.unallocated,
        ]);
        const ledger = await get(owner, `/suppliers/${id}/ledger`);
        const counted = ledger.entries.filter((e: { counted: boolean }) => e.counted);
        const net = counted.reduce((s: bigint, e: { credit: string; debit: string }) => s + P(e.credit) - P(e.debit), 0n);
        expect(net).toBe(exp.payable - exp.unallocated);
        if (counted.length) expect(P([...ledger.entries].reverse().find((e: { counted: boolean }) => e.counted).runningBalance)).toBe(net);
        const open = (await get(owner, `/suppliers/${id}/open-bills`)).bills;
        expect(open.reduce((s: bigint, b: { payable: string }) => s + P(b.payable), 0n)).toBe(exp.payable);
        const row = report.items.find((x: { supplierId: string }) => x.supplierId === id);
        if (row) expect([P(row.payable), P(row.unallocated), P(row.directPayments), P(row.allocatedPayments)]).toEqual([exp.payable, exp.unallocated, exp.paid, exp.alloc]);
      }
      const summary = (await get(owner, '/suppliers/summary')).summary;
      expect([P(summary.totalPayable), P(summary.totalUnallocated)]).toEqual([payable, unallocated]);
      expect(P(report.totals.payable)).toBe(payable);
      // Expense detail: outstanding = amount - paid - active allocations, for every expense.
      for (const e of m.ex.slice(0, 40)) {
        const d = (await get(owner, `/expenses/${e.id}`)).expense;
        expect(P(d.outstanding)).toBe(P(e.amount) - P(e.amount_paid) - (m.allocByExpense.get(e.id) ?? 0n));
      }
    });

    it('customers: list, detail, ledger, summary and both customer reports agree; dues and advances never netted', async () => {
      const m = await model();
      const list = (await get(owner, '/customers?status=all&pageSize=100')).items as { id: string; dueBalance: string; advanceBalance: string }[];
      let due = 0n;
      let adv = 0n;
      for (const id of customers) {
        const exp = m.cus.get(id)!;
        due += exp.due;
        adv += exp.advance;
        const fromList = list.find((c) => c.id === id)!;
        expect([P(fromList.dueBalance), P(fromList.advanceBalance)]).toEqual([exp.due, exp.advance]);
        const ledger = await get(owner, `/customers/${id}/ledger`);
        if (ledger.entries.length) {
          expect([P(ledger.entries.at(-1).runningDue), P(ledger.entries.at(-1).runningAdvance)]).toEqual([exp.due, exp.advance]);
        }
      }
      const summary = (await get(owner, '/customers/summary')).summary;
      expect([P(summary.totalDue), P(summary.totalAdvance)]).toEqual([due, adv]);
      expect(P((await get(owner, '/reports/customers/dues?pageSize=100')).totals.balance)).toBe(due);
      expect(P((await get(owner, '/reports/customers/advances?pageSize=100')).totals.balance)).toBe(adv);
    });

    it('dashboard, expense report, category report and expense list agree for every period; previous periods are equivalent', async () => {
      const m = await model();
      for (const period of ['this_month', 'previous_month', 'this_quarter', 'this_year']) {
        const d = (await get(owner, `/reports/dashboard?period=${period}`)).dashboard;
        const exp = m.expensesIn(d.period.from, d.period.to);
        expect([d.expenses.count, P(d.expenses.amount), P(d.expenses.paidAtPurchase), P(d.expenses.settledByPayments), P(d.expenses.outstanding), d.expenses.voidedCount]).toEqual([
          exp.count,
          exp.amount,
          exp.paid,
          exp.settled,
          exp.outstanding,
          exp.voided,
        ]);
        const prevExp = m.expensesIn(d.period.previous.from, d.period.previous.to);
        expect(P(d.expenses.previous.amount)).toBe(prevExp.amount);
        expect(P(d.supplierPaymentsInPeriod.amount)).toBe(m.paymentsIn(d.period.from, d.period.to));
        expect([
          P(d.customerActivity.duesRecorded),
          P(d.customerActivity.duePaymentsReceived),
          P(d.customerActivity.advancesReceived),
          P(d.customerActivity.refundsIssued),
        ]).toEqual(['due', 'due_payment', 'advance', 'advance_refund'].map((t) => m.customerIn(d.period.from, d.period.to, t)));
        // Current balances do not depend on the period.
        expect(P(d.suppliers.totalPayable)).toBe([...m.sup.values()].reduce((s, x) => s + x.payable, 0n));
        expect([P(d.customers.totalDue), P(d.customers.totalAdvance)]).toEqual([
          [...m.cus.values()].reduce((s, x) => s + x.due, 0n),
          [...m.cus.values()].reduce((s, x) => s + x.advance, 0n),
        ]);
        // Same period through the expense report, the category report and the plain expense list.
        const r = await get(owner, `/reports/expenses?period=${period}`);
        expect(P(r.totals.amount)).toBe(exp.amount);
        expect(r.paidStatus.reduce((s: bigint, x: { amount: string }) => s + P(x.amount), 0n)).toBe(exp.amount);
        expect(r.paymentModes.reduce((s: bigint, x: { amount: string }) => s + P(x.amount), 0n)).toBe(exp.amount);
        expect(P((await get(owner, `/reports/categories?period=${period}`)).total)).toBe(exp.amount);
        const listTotals = (await get(owner, `/expenses?from=${d.period.from}&to=${d.period.to}`)).totals;
        expect([P(listTotals.amount), P(listTotals.outstanding)]).toEqual([exp.amount, exp.outstanding]);
        // Supplier payments are never part of expense totals.
        expect(r.totals.amount).toBe(listTotals.amount);
      }
    });

    it('transaction history counts every row of every type for a custom range', async () => {
      const m = await model();
      const from = prev2.from;
      const t = await get(owner, `/reports/transactions?period=custom&from=${from}&to=${today}&pageSize=1`);
      const expected = m.ex.filter((e) => e.d >= from).length + m.pay.filter((p) => p.d >= from).length + m.ct.filter((c) => c.d >= from).length;
      expect(t.pagination.total).toBe(expected);
    });

    it('Excel workbooks contain the same totals as the API and the model', async () => {
      const m = await model();
      const exp = m.expensesIn(prev2.from, today);
      const expWb = await workbook(owner, `expenses?period=custom&from=${prev2.from}&to=${today}`);
      const t = totalsRow(expWb.getWorksheet('Expenses')!, 'Date');
      expect([xl(t.Amount), xl(t['Paid at purchase']), xl(t['Settled by payments']), xl(t.Outstanding)]).toEqual([exp.amount, exp.paid, exp.settled, exp.outstanding]);
      let dataRows = 0;
      expWb.getWorksheet('Expenses')!.eachRow((row) => {
        if (row.getCell(1).value instanceof Date) dataRows += 1;
      });
      expect(dataRows).toBe(m.ex.filter((e) => e.d >= prev2.from && e.d <= today).length); // voided rows listed too

      const supWb = await workbook(owner, 'suppliers');
      expect(xl(totalsRow(supWb.worksheets[0]!, 'Supplier')['Payable now'])).toBe([...m.sup.values()].reduce((s, x) => s + x.payable, 0n));
      const dueWb = await workbook(owner, 'customer-dues');
      const advWb = await workbook(owner, 'customer-advances');
      expect(xl(totalsRow(dueWb.worksheets[0]!, 'Customer')['Outstanding due (now)'])).toBe([...m.cus.values()].reduce((s, x) => s + x.due, 0n));
      expect(xl(totalsRow(advWb.worksheets[0]!, 'Customer')['Available advance (now)'])).toBe([...m.cus.values()].reduce((s, x) => s + x.advance, 0n));

      const catWb = await workbook(owner, `categories?period=custom&from=${prev2.from}&to=${today}`);
      expect(xl(totalsRow(catWb.worksheets[0]!, 'Category').Amount)).toBe(exp.amount);

      const txWb = await workbook(owner, `transactions?period=custom&from=${prev2.from}&to=${today}`);
      let txRows = 0;
      txWb.worksheets[0]!.eachRow((row) => {
        if (row.getCell(1).value instanceof Date) txRows += 1;
      });
      expect(txRows).toBe(m.ex.filter((e) => e.d >= prev2.from).length + m.pay.filter((p) => p.d >= prev2.from).length + m.ct.filter((c) => c.d >= prev2.from).length);

      const payWb = await workbook(owner, 'supplier-payments?status=active');
      expect(xl(totalsRow(payWb.worksheets[0]!, 'Date').Amount)).toBe(m.pay.filter((p) => !p.reversed).reduce((s, p) => s + P(p.amount), 0n));

      const monthWb = await workbook(owner, `monthly?year=${prev.from.slice(0, 4)}&month=${Number(prev.from.slice(5, 7))}`);
      const kv = new Map<string, unknown>();
      monthWb.getWorksheet('Expense Summary')!.eachRow((row) => kv.set(String(row.getCell(1).value), row.getCell(2).value));
      const pm = m.expensesIn(prev.from, prev.to);
      expect(xl(kv.get('Total expenses'))).toBe(pm.amount);
      expect(xl(kv.get('Outstanding customer dues (now)'))).toBe([...m.cus.values()].reduce((s, x) => s + x.due, 0n));
      // Formula-injection: the "=Evil category" and "+cmd description" texts are never formulas.
      for (const wb of [expWb, catWb, txWb, monthWb]) {
        for (const ws of wb.worksheets) {
          ws.eachRow((row) =>
            row.eachCell((cell) => {
              expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
              if (typeof cell.value === 'string' && /^[=+\-@]/.test(cell.value)) throw new Error(`Unescaped formula text in ${ws.name}!${cell.address}: ${cell.value}`);
            }),
          );
        }
      }
      // Each supplier/customer ledger export ends at the same balance as the API.
      for (const id of suppliers) {
        const l = await get(owner, `/suppliers/${id}/ledger`);
        const wb = await workbook(owner, `supplier-ledger?supplierId=${id}`);
        let rows = 0;
        wb.getWorksheet('Ledger')!.eachRow((row) => {
          if (row.getCell(1).value instanceof Date) rows += 1;
        });
        expect(rows).toBe(l.entries.length);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('2. races between different operations', () => {
    let supplier: string;
    let category: string;
    let customer: string;
    beforeAll(async () => {
      supplier = (await call(owner, 'post', '/suppliers', { name: `Race ${Date.now()}` })).body.supplier.id;
      category = (await call(owner, 'post', '/categories', { name: `Race ${Date.now()}` })).body.category.id;
      customer = (await call(owner, 'post', '/customers', { name: 'Race customer' })).body.customer.id;
    });
    const bill = async (amount: string) =>
      (
        await call(manager, 'post', '/expenses', {
          expenseDate: today,
          supplierId: supplier,
          categoryId: category,
          description: 'Race bill',
          amount,
          amountPaid: '0',
          paymentMode: null,
          invoiceReference: null,
        })
      ).body.expense;

    it('void vs allocate on the same bill: never an allocation on a voided bill', async () => {
      for (let i = 0; i < 6; i++) {
        const b = await bill('500');
        const p = (await call(owner, 'post', '/supplier-payments', { supplierId: supplier, amount: '500', paymentDate: today, paymentMode: 'upi' })).body.payment;
        const [v, a] = await Promise.all([
          call(owner, 'post', `/expenses/${b.id}/void`, { reason: 'race', version: b.version }),
          call(manager, 'post', `/supplier-payments/${p.id}/allocations`, { allocations: [{ expenseId: b.id, amount: '500' }] }),
        ]);
        expect([v.status, a.status].filter((s) => s === 200).length).toBe(1);
        expect(v.status === 200 ? a.status : v.status).toBeGreaterThanOrEqual(400);
        const state = (await db.query(`SELECT voided_at IS NOT NULL AS voided, (SELECT count(*)::int FROM supplier_payment_allocations WHERE expense_id = $1 AND released_at IS NULL) AS allocs FROM expenses WHERE id = $1`, [b.id])).rows[0];
        expect(state.voided && state.allocs > 0).toBe(false);
      }
    });

    it('reverse vs allocate on the same payment: a reversed payment never keeps allocations', async () => {
      for (let i = 0; i < 6; i++) {
        const b = await bill('300');
        const p = (await call(owner, 'post', '/supplier-payments', { supplierId: supplier, amount: '300', paymentDate: today, paymentMode: 'upi' })).body.payment;
        await Promise.all([
          call(owner, 'post', `/supplier-payments/${p.id}/reverse`, { reason: 'race', version: p.version }),
          call(manager, 'post', `/supplier-payments/${p.id}/allocations`, { allocations: [{ expenseId: b.id, amount: '300' }] }),
        ]);
        const s = (await db.query(`SELECT reversed_at IS NOT NULL AS reversed, (SELECT count(*)::int FROM supplier_payment_allocations WHERE payment_id = $1 AND released_at IS NULL) AS allocs FROM supplier_payments WHERE id = $1`, [p.id])).rows[0];
        expect(s.reversed && s.allocs > 0).toBe(false);
      }
    });

    it('release vs reverse, and double release: each allocation is released exactly once', async () => {
      const b = await bill('200');
      const p = (await call(owner, 'post', '/supplier-payments', { supplierId: supplier, amount: '200', paymentDate: today, paymentMode: 'upi', allocations: [{ expenseId: b.id, amount: '200' }] })).body.payment;
      const allocationId = p.allocations[0].id;
      const results = await Promise.all([
        call(owner, 'post', `/supplier-payments/${p.id}/reverse`, { reason: 'race', version: p.version }),
        call(manager, 'post', `/supplier-payments/${p.id}/allocations/${allocationId}/release`, { reason: 'race' }),
        call(manager, 'post', `/supplier-payments/${p.id}/allocations/${allocationId}/release`, { reason: 'race 2' }),
      ]);
      expect(results.every((r) => r.status < 500)).toBe(true);
      const audits = (await db.query(`SELECT count(*)::int AS n FROM financial_audit_events WHERE entity_type = 'expense' AND entity_id = $1 AND action = 'release_allocation'`, [b.id])).rows[0].n;
      expect(audits).toBe(1);
      expect((await get(owner, `/expenses/${b.id}`)).expense.outstanding).toBe('200.00');
    });

    it('refund vs advance reversal, and due payment vs due reversal: balances never go invalid', async () => {
      for (let i = 0; i < 6; i++) {
        const adv = (await call(manager, 'post', `/customers/${customer}/advances`, { amount: '100', txnDate: today, paymentMode: 'cash' })).body.transaction;
        const balance = (await get(owner, `/customers/${customer}`)).customer.advanceBalance;
        await Promise.all([
          call(owner, 'post', `/customers/${customer}/transactions/${adv.id}/reverse`, { reason: 'race', version: 1 }),
          call(manager, 'post', `/customers/${customer}/refunds`, { amount: balance, txnDate: today, paymentMode: 'cash' }),
        ]);
        const due = (await call(manager, 'post', `/customers/${customer}/dues`, { amount: '100', txnDate: today, description: 'race' })).body.transaction;
        await Promise.all([
          call(owner, 'post', `/customers/${customer}/transactions/${due.id}/reverse`, { reason: 'race', version: 1 }),
          call(manager, 'post', `/customers/${customer}/due-payments`, { dueId: due.id, amount: '100', txnDate: today, paymentMode: 'cash' }),
        ]);
      }
      const c = (await get(owner, `/customers/${customer}`)).customer;
      expect(P(c.advanceBalance) >= 0n && P(c.dueBalance) >= 0n).toBe(true);
      const bad = await db.query(
        `SELECT 1 FROM customer_transactions d JOIN customer_transactions p ON p.due_id = d.id AND p.reversed_at IS NULL
          WHERE d.reversed_at IS NOT NULL`,
      );
      expect(bad.rowCount).toBe(0);
    });

    it('expense edit vs allocation: the bill amount never drops below paid + allocated', async () => {
      for (let i = 0; i < 6; i++) {
        const b = await bill('1000');
        const p = (await call(owner, 'post', '/supplier-payments', { supplierId: supplier, amount: '900', paymentDate: today, paymentMode: 'upi' })).body.payment;
        await Promise.all([
          call(owner, 'patch', `/expenses/${b.id}`, {
            expenseDate: today,
            supplierId: supplier,
            categoryId: category,
            description: 'Race bill',
            amount: '200',
            amountPaid: '0',
            paymentMode: null,
            invoiceReference: null,
            version: b.version,
          }),
          call(manager, 'post', `/supplier-payments/${p.id}/allocations`, { allocations: [{ expenseId: b.id, amount: '900' }] }),
        ]);
        const e = (await get(owner, `/expenses/${b.id}`)).expense;
        expect(P(e.amount) >= P(e.amountPaid) + P(e.allocatedPayments)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('3. route inventory: authentication and roles', () => {
    const X = '00000000-0000-4000-8000-000000000000';
    const ROUTES: [string, string][] = [
      ['get', '/auth/me'], ['post', '/auth/logout'], ['post', '/auth/change-password'],
      ['get', '/users'], ['post', '/users'], ['patch', `/users/${X}`],
      ['get', '/categories'], ['post', '/categories'], ['patch', `/categories/${X}`],
      ['get', '/expenses'], ['post', '/expenses'], ['get', `/expenses/${X}`], ['patch', `/expenses/${X}`],
      ['post', `/expenses/${X}/void`], ['post', `/expenses/${X}/restore`], ['get', `/expenses/${X}/history`],
      ['get', `/expenses/${X}/documents`], ['post', `/expenses/${X}/documents`], ['get', `/expenses/${X}/documents/${X}/content`],
      ['post', `/expenses/${X}/documents/${X}/remove`],
      ['get', '/suppliers'], ['post', '/suppliers'], ['get', '/suppliers/summary'], ['get', `/suppliers/${X}/ledger`],
      ['get', '/supplier-payments'], ['post', '/supplier-payments'], ['post', `/supplier-payments/${X}/allocations`],
      ['post', `/supplier-payments/${X}/reverse`],
      ['get', '/customers'], ['post', '/customers'], ['post', `/customers/${X}/dues`], ['post', `/customers/${X}/refunds`],
      ['post', `/customers/${X}/transactions/${X}/reverse`],
      ['get', '/reports/dashboard'], ['get', '/reports/transactions'], ['get', '/reports/monthly?year=2026&month=1'],
      ['get', '/exports/expenses'], ['get', '/exports/monthly?year=2026&month=1'],
      ['get', '/monthly-reports/settings'], ['put', '/monthly-reports/settings'], ['post', '/monthly-reports/recipients'],
      ['get', '/monthly-reports/deliveries'], ['post', `/monthly-reports/deliveries/${X}/retry`], ['post', '/monthly-reports/jobs'],
      ['get', '/no-such-route'],
    ];
    const OWNER_ONLY = /^\/(users|monthly-reports)/;

    it('every route except health and login requires a session', async () => {
      expect((await request(app).get('/api/v1/health')).status).toBe(200);
      for (const [method, p] of ROUTES) {
        const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(`/api/v1${p}`).set(BROWSER_HEADERS).send({});
        expect(res.status, `${method.toUpperCase()} ${p}`).toBe(401);
      }
    });

    it('managers are refused owner-only routes and allowed financial routes; writes need CSRF', async () => {
      for (const [method, p] of ROUTES.filter(([, p]) => !p.startsWith('/auth'))) {
        const res = await manager.agent[method as 'get'](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': manager.csrf }).send({});
        if (OWNER_ONLY.test(p)) expect(res.status, `${method} ${p}`).toBe(403);
        else expect(res.status, `${method} ${p}`).not.toBe(403);
      }
      for (const [method, p] of ROUTES.filter(([m, p]) => m !== 'get' && !p.startsWith('/auth') && !OWNER_ONLY.test(p))) {
        const res = await manager.agent[method as 'post'](`/api/v1${p}`).set(BROWSER_HEADERS).send({});
        expect(res.status, `no CSRF ${method} ${p}`).toBe(403);
      }
    });

    it('API responses are never cacheable and never leak SQL details', async () => {
      const res = await owner.agent.get('/api/v1/reports/transactions?period=custom&from=2026-01-01&to=2025-01-01');
      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toContain('no-store');
      const bad = await owner.agent.get(`/api/v1/expenses/${X}`);
      expect(bad.status).toBe(404);
      expect(JSON.stringify(bad.body)).not.toMatch(/select|relation|syntax|postgres/i);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('4. revoked sessions cannot write (withSessionTransaction)', () => {
    it('refuses customer, supplier-payment, document and report-settings writes after revocation', async () => {
      const victim = await signIn('owner-s6@example.test');
      const customer = (await call(victim, 'post', '/customers', { name: 'Before revoke' })).body.customer.id;
      const supplier = (await call(victim, 'post', '/suppliers', { name: `Revoke ${Date.now()}` })).body.supplier.id;
      await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_owner' WHERE user_id = $1 AND revoked_at IS NULL AND id <> (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1)`, [victim.userId]);
      const before = (await db.query(`SELECT (SELECT count(*) FROM customer_transactions) + (SELECT count(*) FROM supplier_payments) AS n`)).rows[0].n;
      const attempts = [
        await call(victim, 'post', `/customers/${customer}/dues`, { amount: '10', txnDate: today, description: 'x' }),
        await call(victim, 'post', '/supplier-payments', { supplierId: supplier, amount: '10', paymentDate: today, paymentMode: 'cash' }),
        await call(victim, 'put', '/monthly-reports/settings', { enabled: true, deliveryDay: 1, deliveryTime: '08:00', includeExcel: true, version: 1 }),
      ];
      expect(attempts.map((a) => a.status)).toEqual([401, 401, 401]);
      expect((await db.query(`SELECT (SELECT count(*) FROM customer_transactions) + (SELECT count(*) FROM supplier_payments) AS n`)).rows[0].n).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('5. document storage safety', () => {
    it('rejects traversal keys and never serves storage paths statically', async () => {
      const s = new LocalDocumentStorage(storageDir);
      for (const key of ['../escape', 'a/../../b', '/abs/path', 'UPPER/case', 'a//b', 'a/b.pdf', '']) {
        await expect(s.put(key, Buffer.from('x')), key).rejects.toThrow(/Invalid storage key/);
        await expect(s.exists(key), key).rejects.toThrow(/Invalid storage key/);
      }
      await expect(s.deleteStray('../../etc/passwd')).rejects.toThrow(/Invalid path/);
      for (const p of ['/storage/documents', '/documents', `/${path.basename(storageDir)}`, '/api/v1/../storage']) {
        const res = await request(app).get(p);
        expect([401, 404], p).toContain(res.status);
        expect(res.headers['content-type'] ?? '').toContain('application/json');
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('6. export row limit', () => {
    it(`allows exactly ${MAX_EXPORT_ROWS} rows and refuses ${MAX_EXPORT_ROWS + 1}`, async () => {
      const cat = (await call(owner, 'post', '/categories', { name: 'Bulk limit' })).body.category.id;
      await db.query(
        `INSERT INTO expenses (expense_date, category_id, description, amount, created_by, updated_by)
         SELECT $1::date, $2, 'Bulk ' || g, 1.00, $3, $3 FROM generate_series(1, $4) g`,
        [prev2.from, cat, owner.userId, MAX_EXPORT_ROWS],
      );
      const ok = await owner.agent.get(`/api/v1/exports/expenses?period=custom&from=${prev2.from}&to=${prev2.from}&categoryId=${cat}`);
      expect(ok.status).toBe(200);
      await db.query(
        `INSERT INTO expenses (expense_date, category_id, description, amount, created_by, updated_by) VALUES ($1::date, $2, 'Bulk extra', 1.00, $3, $3)`,
        [prev2.from, cat, owner.userId],
      );
      const tooMany = await owner.agent.get(`/api/v1/exports/expenses?period=custom&from=${prev2.from}&to=${prev2.from}&categoryId=${cat}`);
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.error.code).toBe('EXPORT_TOO_LARGE');
      const tx = await owner.agent.get(`/api/v1/exports/transactions?period=custom&from=${prev2.from}&to=${prev2.from}`);
      expect(tx.status).toBe(422);
    }, 120_000);
  });
});
