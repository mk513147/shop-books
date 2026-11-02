/**
 * Essential Stage 5 export checks: workbooks open, match the reporting API, respect filters and
 * permissions, and never let user text become a formula. Real PostgreSQL test database.
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { safeText } from '../src/modules/exports/excel.js';
import { monthRange } from '../src/modules/reports/period.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

describe('formula injection guard (unit)', () => {
  it('prefixes text that a spreadsheet could treat as a formula', () => {
    for (const v of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\t=x', '\r=x']) expect(safeText(v)).toBe(`'${v}`);
    expect(safeText('Plain text')).toBe('Plain text');
    expect(safeText(null)).toBe('');
  });
});

const pool = await connectTestDatabase();

describe.skipIf(!pool)('Excel exports (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  const today = todayInReportingZone();
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  let supplierA: string;
  let supplierEvil: string;
  let customer: string;
  const EVIL = '=HYPERLINK("http://evil.example","click")';

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    return { agent, csrf: res.body.csrfToken };
  }
  const post = async (s: Session, p: string, body: object) => {
    const res = await s.agent.post(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body;
  };
  /** Downloads an export and parses it with ExcelJS (proves it is a valid .xlsx). */
  async function download(s: Session, path: string) {
    const res = await s.agent.get(`/api/v1/exports/${path}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status, res.status === 200 ? '' : res.body.toString()).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="test-shop_.+\.xlsx"/);
    expect(res.headers['cache-control']).toContain('no-store');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    return wb;
  }
  /** Row values of a sheet's data table (after the header row that starts with `firstHeader`). */
  function table(ws: ExcelJS.Worksheet, firstHeader: string) {
    let headerRow = 0;
    ws.eachRow((row, n) => {
      if (!headerRow && row.getCell(1).value === firstHeader) headerRow = n;
    });
    expect(headerRow, `header "${firstHeader}" in ${ws.name}`).toBeGreaterThan(0);
    const headers = (ws.getRow(headerRow).values as unknown[]).slice(1) as string[];
    const rows: Record<string, unknown>[] = [];
    for (let n = headerRow + 1; n <= ws.rowCount; n++) {
      const values = (ws.getRow(n).values as unknown[]).slice(1);
      rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null])));
    }
    return { headerRow, headers, rows };
  }

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner5@example.test', 'Owner', 'owner', $1), ('mgr5@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner5@example.test');
    manager = await signIn('mgr5@example.test');
    const cat = (await post(owner, '/categories', { name: '@SUM(1,1)' })).category.id;
    supplierA = (await post(owner, '/suppliers', { name: 'Alpha' })).supplier.id;
    supplierEvil = (await post(owner, '/suppliers', { name: '+Evil Corp' })).supplier.id;
    const bill = (supplierId: string, amount: string, paid: string, description: string) =>
      post(manager, '/expenses', {
        expenseDate: today,
        supplierId,
        categoryId: cat,
        description,
        amount,
        amountPaid: paid,
        paymentMode: paid === '0' ? null : 'cash',
        invoiceReference: '-1',
      }).then((b) => b.expense);
    const a1 = await bill(supplierA, '1000.50', '200', 'Stock');
    await bill(supplierEvil, '300', '0', EVIL);
    const v = await bill(supplierA, '77', '0', 'Voided one');
    await post(owner, `/expenses/${v.id}/void`, { reason: 'dup', version: 1 });
    await post(manager, '/supplier-payments', {
      supplierId: supplierA,
      amount: '500',
      paymentDate: today,
      paymentMode: 'upi',
      allocations: [{ expenseId: a1.id, amount: '400' }],
    });
    customer = (await post(manager, '/customers', { name: '=cmd|calc' })).customer.id;
    const due = (await post(manager, `/customers/${customer}/dues`, { amount: '5000', txnDate: today, description: 'Credit' })).transaction;
    await post(manager, `/customers/${customer}/due-payments`, { amount: '1000', txnDate: today, paymentMode: 'cash', dueId: due.id });
    await post(manager, `/customers/${customer}/advances`, { amount: '2000', txnDate: today, paymentMode: 'cash' });
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires a session and validates filters', async () => {
    expect((await request(app).get('/api/v1/exports/expenses')).status).toBe(401);
    expect((await manager.agent.get('/api/v1/exports/expenses?paymentMode=x')).status).toBe(400);
    expect((await manager.agent.get('/api/v1/exports/supplier-ledger?supplierId=nope')).status).toBe(400);
    expect((await manager.agent.get(`/api/v1/exports/monthly?year=${ty + 1}&month=1`)).status).toBe(400);
  });

  it('expense export: same totals as the report API, voided rows marked, header block present', async () => {
    const wb = await download(manager, 'expenses?period=this_month');
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Expenses']);
    const ws = wb.getWorksheet('Expenses')!;
    expect(ws.getCell('A1').value).toBe('Shop');
    expect(ws.getCell('B1').value).toBe('Test Shop');
    expect(ws.getCell('B2').value).toBe('Expense report');
    expect(String(ws.getCell('B5').value)).toContain('INR');
    const { rows, headerRow } = table(ws, 'Date');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: headerRow });
    expect(ws.autoFilter).toBeTruthy();
    const data = rows.slice(0, -1);
    const total = rows.at(-1)!;
    expect(data).toHaveLength(3);
    expect(data.find((r) => r.Description === 'Voided one')).toMatchObject({ Status: 'voided' });
    const api = (await manager.agent.get('/api/v1/reports/expenses?period=this_month')).body.totals;
    expect(total).toMatchObject({ Date: 'Total (active)', Amount: Number(api.amount), 'Paid at purchase': Number(api.paidAtPurchase) });
    expect(total['Settled by payments']).toBe(Number(api.settledByPayments));
    expect(total.Outstanding).toBe(Number(api.outstanding));
    expect(api.amount).toBe('1300.50'); // supplier payment NOT added
    expect(ws.getCell(`F${headerRow + 1}`).numFmt).toContain('₹');
    expect(data[0]!.Date).toBeInstanceOf(Date);
  });

  it('never writes user text as a formula (formula injection)', async () => {
    const wb = await download(manager, 'expenses?period=this_month');
    const ws = wb.getWorksheet('Expenses')!;
    let found = 0;
    ws.eachRow((row) =>
      row.eachCell((cell) => {
        expect(cell.formula, `cell ${cell.address}`).toBeUndefined();
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        if (typeof cell.value === 'string' && cell.value.includes('HYPERLINK')) {
          found += 1;
          expect(cell.value).toBe(`'${EVIL}`);
        }
      }),
    );
    expect(found).toBe(1);
    const { rows } = table(ws, 'Date');
    expect(rows.find((r) => r.Supplier === "'+Evil Corp")).toBeTruthy();
    expect(rows[0]!.Category).toBe("'@SUM(1,1)");
    expect(rows[0]!['Invoice ref.']).toBe("'-1");
    const customers = await download(manager, 'customer-dues');
    const c = table(customers.worksheets[0]!, 'Customer').rows;
    expect(c[0]!.Customer).toBe("'=cmd|calc");
  });

  it('filtered exports respect the filters; supplier, customer and ledger exports agree with the API', async () => {
    const onlyA = await download(manager, `expenses?period=this_month&supplierId=${supplierA}`);
    const rowsA = table(onlyA.getWorksheet('Expenses')!, 'Date').rows.slice(0, -1);
    expect(rowsA.map((r) => r.Supplier)).toEqual(['Alpha', 'Alpha']);
    expect(String(onlyA.getWorksheet('Expenses')!.getCell('B6').value)).toBe('Alpha'); // filter line

    const sup = await download(manager, 'suppliers');
    const supRows = table(sup.worksheets[0]!, 'Supplier').rows;
    const api = (await manager.agent.get('/api/v1/reports/suppliers')).body;
    expect(supRows.at(-1)!['Payable now']).toBe(Number(api.totals.payable));
    expect(supRows.find((r) => r.Supplier === 'Alpha')).toMatchObject({ 'Payable now': 400.5, Unallocated: 100 });

    const dues = await download(manager, 'customer-dues');
    const adv = await download(manager, 'customer-advances');
    expect(table(dues.worksheets[0]!, 'Customer').headers).toEqual(['Customer', 'Phone', 'Archived', 'Dues recorded', 'Payments received', 'Outstanding due (now)']);
    expect(table(adv.worksheets[0]!, 'Customer').headers).toEqual(['Customer', 'Phone', 'Archived', 'Advances received', 'Refunds issued', 'Available advance (now)']);
    expect(table(dues.worksheets[0]!, 'Customer').rows.at(-1)!['Outstanding due (now)']).toBe(4000);
    expect(table(adv.worksheets[0]!, 'Customer').rows.at(-1)!['Available advance (now)']).toBe(2000);

    const ledger = await download(manager, `supplier-ledger?supplierId=${supplierA}`);
    expect(ledger.worksheets.map((w) => w.name)).toEqual(['Balance', 'Ledger']);
    const ledgerRows = table(ledger.getWorksheet('Ledger')!, 'Date').rows;
    const apiLedger = (await manager.agent.get(`/api/v1/suppliers/${supplierA}/ledger`)).body;
    expect(ledgerRows).toHaveLength(apiLedger.entries.length);
    const lastCounted = [...ledgerRows].reverse().find((r) => r.Balance !== null)!;
    expect(lastCounted.Balance).toBe(Number(apiLedger.balance.netBalance));

    const cl = await download(manager, `customer-ledger?customerId=${customer}`);
    expect(table(cl.getWorksheet('Ledger')!, 'Date').rows).toHaveLength(3);

    const pays = await download(manager, `supplier-payments?supplierId=${supplierA}&status=all`);
    expect(table(pays.worksheets[0]!, 'Date').rows.at(-1)).toMatchObject({ Amount: 500, Allocated: 400, Unallocated: 100 });

    const txns = await download(manager, 'transactions?period=this_month&type=supplier_payment');
    expect(table(txns.worksheets[0]!, 'Date').rows.map((r) => r.Type)).toEqual(['Supplier payment']);

    const cats = await download(manager, 'categories?period=this_month');
    expect(table(cats.worksheets[0]!, 'Category').rows.at(-1)!.Amount).toBe(1300.5);
  });

  it('monthly summary workbook: expected sheets, dues and advances separate, same figures as the API', async () => {
    const wb = await download(owner, `monthly?year=${ty}&month=${tm}`);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Expense Summary',
      'Category Breakdown',
      'Payment Modes',
      'Supplier Summary',
      'Customer Due Summary',
      'Customer Advance Summary',
      'Transaction Activity',
    ]);
    const summary = (await owner.agent.get(`/api/v1/reports/monthly?year=${ty}&month=${tm}`)).body.summary;
    const values = new Map<string, unknown>();
    wb.getWorksheet('Expense Summary')!.eachRow((row) => values.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(values.get('Total expenses')).toBe(Number(summary.expenses.amount));
    expect(values.get(`Supplier payments in ${summary.label} (not expenses)`)).toBe(500);
    expect(values.get('Outstanding customer dues (now)')).toBe(4000);
    expect(values.get('Available customer advances (now)')).toBe(2000);
    expect([...values.keys()].some((k) => /^net\b|net (balance|position)/i.test(k))).toBe(false);
    const prev = monthRange(ty, tm - 1);
    expect(prev.from < today).toBe(true);
  });

  it('multi-method payments: listed per method in the expense export and the supplier ledger, counted once', async () => {
    const cat = (await post(owner, '/categories', { name: 'Split pay' })).category.id;
    const supplier = (await post(owner, '/suppliers', { name: 'Split Supplier' })).supplier.id;
    await post(manager, '/expenses', {
      expenseDate: '2001-01-15',
      supplierId: supplier,
      categoryId: cat,
      description: null,
      amount: '2500',
      payments: [
        { paymentMode: 'upi', amount: '1000' },
        { paymentMode: 'cash', amount: '1500' },
      ],
      invoiceReference: null,
    });
    const wb = await download(manager, 'expenses?period=custom&from=2001-01-01&to=2001-01-31');
    const { rows } = table(wb.getWorksheet('Expenses')!, 'Date');
    expect(rows[0]).toMatchObject({ Description: null, Category: 'Split pay', Amount: 2500, 'Paid at purchase': 2500, 'Payment methods': 'UPI 1000.00, Cash 1500.00' });

    const ledgerWb = await download(manager, `supplier-ledger?supplierId=${supplier}`);
    const ledger = table(ledgerWb.getWorksheet('Ledger')!, 'Date').rows.filter((r) => r.Date instanceof Date);
    expect(ledger.map((r) => r.Type)).toEqual(['Bill', 'Paid at purchase']); // one paid row, not one per method
    expect(ledger[1]).toMatchObject({ Mode: 'UPI 1000.00, Cash 1500.00', 'Debit (paid)': 2500, Balance: 0 });
  });
});
