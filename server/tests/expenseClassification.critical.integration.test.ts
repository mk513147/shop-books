/**
 * Migration 0012 and the requested fixes, against the real PostgreSQL TEST database only:
 *  - several categories and brands per expense (labels, never extra money),
 *  - supplier default brands/categories (defaults only; saved expenses never follow later changes),
 *  - reports / filters / Excel exports never double-count an expense,
 *  - expense payment status rules (paid in full / part paid / not paid) and supplier balances,
 *  - the live-update change feed (/sync/changes).
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('expense categories, brands, supplier defaults, payments and live updates', () => {
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
  const send = (s: Session, method: 'post' | 'patch', path: string, body: object) =>
    s.agent[method](`/api/v1${path}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const ok = async (s: Session, method: 'post' | 'patch', path: string, body: object) => {
    const res = await send(s, method, path, body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body;
  };
  const get = async (s: Session, path: string) => {
    const res = await s.agent.get(`/api/v1${path}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  async function download(s: Session, path: string) {
    const res = await s.agent.get(`/api/v1/exports/${path}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    return wb;
  }
  function table(ws: ExcelJS.Worksheet, firstHeader: string) {
    let headerRow = 0;
    ws.eachRow((row, n) => {
      if (!headerRow && row.getCell(1).value === firstHeader) headerRow = n;
    });
    const headers = (ws.getRow(headerRow).values as unknown[]).slice(1) as string[];
    const rows: Record<string, unknown>[] = [];
    for (let n = headerRow + 1; n <= ws.rowCount; n++) {
      const values = (ws.getRow(n).values as unknown[]).slice(1);
      rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null])));
    }
    return rows;
  }

  // Master data
  const cat: Record<string, string> = {};
  const brand: Record<string, string> = {};
  let abc: { id: string; version: number };
  let xyz: { id: string };

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner12@example.test', 'Owner', 'owner', $1), ('asha12@example.test', 'Asha', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner12@example.test');
    manager = await signIn('asha12@example.test');
  });

  afterAll(async () => {
    await db.end();
  });

  it('brands: create, unique active names (any case), rename, archive, audit history', async () => {
    expect((await request(app).get('/api/v1/brands')).status).toBe(401);
    for (const name of ['Samsung', 'LG', 'Sony', 'HP', 'Old Brand']) {
      brand[name] = (await ok(manager, 'post', '/brands', { name: `  ${name}  ` })).brand.id;
    }
    const dup = await send(owner, 'post', '/brands', { name: 'samsung' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('BRAND_NAME_TAKEN');
    const archived = await ok(owner, 'patch', `/brands/${brand['Old Brand']}`, { isActive: false });
    expect(archived.brand.isActive).toBe(false);
    const active = (await get(manager, '/brands?status=active')).brands.map((b: { name: string }) => b.name);
    expect(active).toEqual(['HP', 'LG', 'Samsung', 'Sony']);
    const history = (await get(manager, `/brands/${brand['Old Brand']}/history`)).history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['archive', 'create']);
  });

  it('1. creates a supplier with three brands and two categories (defaults), plus another supplier', async () => {
    for (const name of ['Electronics', 'Packaging', 'Maintenance', 'Transport', 'Retired']) {
      cat[name] = (await ok(manager, 'post', '/categories', { name })).category.id;
    }
    await ok(owner, 'patch', `/categories/${cat.Retired}`, { isActive: false });
    const created = await ok(manager, 'post', '/suppliers', {
      name: 'ABC Distributors',
      brandIds: [brand.Samsung, brand.LG, brand.Sony],
      categoryIds: [cat.Electronics, cat.Packaging],
    });
    abc = created.supplier;
    expect(created.supplier.brands.map((b: { name: string }) => b.name)).toEqual(['LG', 'Samsung', 'Sony']);
    expect(created.supplier.categories.map((c: { name: string }) => c.name)).toEqual(['Electronics', 'Packaging']);
    xyz = (await ok(manager, 'post', '/suppliers', { name: 'XYZ Traders', brandIds: [brand.HP], categoryIds: [cat.Transport] })).supplier;

    // Archived brands cannot be newly linked.
    const bad = await send(manager, 'post', '/suppliers', { name: 'Bad', brandIds: [brand['Old Brand']] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('brandIds');
    // Audit: link_brand entries on the supplier.
    const history = (await get(manager, `/suppliers/${abc.id}/history`)).history;
    expect(history.filter((h: { action: string }) => h.action === 'link_brand')).toHaveLength(3);
  });

  let expenseId: string;

  it('2–9. saves an expense with edited selections; supplier defaults stay unchanged', async () => {
    // The form pre-selects the defaults; the user removes Sony + Packaging and adds HP + Maintenance.
    const res = await ok(manager, 'post', '/expenses', {
      expenseDate: today,
      supplierId: abc.id,
      categoryIds: [cat.Electronics, cat.Maintenance],
      brandIds: [brand.Samsung, brand.LG, brand.HP],
      amount: '5000',
      payments: [{ amount: '5000', paymentMode: 'upi' }],
    });
    const e = res.expense;
    expenseId = e.id;
    expect(e.category).toMatchObject({ id: cat.Electronics, name: 'Electronics' });
    expect(e.categories.map((c: { name: string }) => c.name)).toEqual(['Electronics', 'Maintenance']);
    expect(e.brands.map((b: { name: string }) => b.name)).toEqual(['Samsung', 'LG', 'HP']);
    expect(e.amount).toBe('5000.00');

    const detail = (await get(owner, `/expenses/${e.id}`)).expense;
    expect(detail.categories).toEqual(e.categories);
    expect(detail.brands).toEqual(e.brands);

    const supplier = (await get(owner, `/suppliers/${abc.id}`)).supplier;
    expect(supplier.brands.map((b: { name: string }) => b.name)).toEqual(['LG', 'Samsung', 'Sony']);
    expect(supplier.categories.map((c: { name: string }) => c.name)).toEqual(['Electronics', 'Packaging']);

    const audit = (await get(owner, `/expenses/${e.id}/history`)).history[0];
    expect(audit.after).toMatchObject({ categories: 'Electronics, Maintenance', brands: 'Samsung, LG, HP', categoryName: 'Electronics' });
  });

  it('validates category and brand selections', async () => {
    const base = { expenseDate: today, supplierId: abc.id, amount: '100', payments: [] };
    const cases: [object, string][] = [
      [{ categoryIds: [] }, 'categoryIds'],
      [{}, 'categoryIds'],
      [{ categoryIds: [cat.Electronics, cat.Electronics] }, 'categoryIds'],
      [{ categoryIds: [cat.Electronics], categoryId: cat.Packaging }, 'categoryIds'],
      [{ categoryIds: [cat.Retired] }, 'categoryIds'],
      [{ categoryIds: ['00000000-0000-4000-8000-000000000000'] }, 'categoryIds'],
      [{ categoryIds: [cat.Electronics], brandIds: [brand.HP, brand.HP] }, 'brandIds'],
      [{ categoryIds: [cat.Electronics], brandIds: [brand['Old Brand']] }, 'brandIds'],
    ];
    for (const [patch, path] of cases) {
      const res = await send(manager, 'post', '/expenses', { ...base, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path), JSON.stringify(patch)).toContain(path);
    }
    // Older clients sending one categoryId still work.
    const legacy = await ok(manager, 'post', '/expenses', { ...base, categoryId: cat.Transport });
    expect(legacy.expense.categories.map((c: { name: string }) => c.name)).toEqual(['Transport']);
  });

  it('14–15. editing keeps historical selections; later supplier default changes never touch saved expenses', async () => {
    // Supplier defaults change after the expense was saved.
    const fresh = (await get(owner, `/suppliers/${abc.id}`)).supplier;
    await ok(owner, 'patch', `/suppliers/${abc.id}`, { version: fresh.version, brandIds: [brand.Sony], categoryIds: [cat.Transport] });
    let saved = (await get(owner, `/expenses/${expenseId}`)).expense;
    expect(saved.categories.map((c: { name: string }) => c.name)).toEqual(['Electronics', 'Maintenance']);
    expect(saved.brands.map((b: { name: string }) => b.name)).toEqual(['Samsung', 'LG', 'HP']);

    // Edit: reorder (new primary) and remove brands; an archived category already on the expense may stay.
    await ok(owner, 'patch', `/categories/${cat.Maintenance}`, { isActive: false });
    // Brand-first rule: making LG the primary brand is refused, because ABC is no longer linked to LG
    // (the saved Samsung/ABC pair itself stays valid as history).
    const refused = await send(manager, 'patch', `/expenses/${expenseId}`, {
      expenseDate: today,
      supplierId: abc.id,
      categoryIds: [cat.Maintenance, cat.Electronics],
      brandIds: [brand.LG],
      amount: '5000',
      payments: [{ amount: '5000', paymentMode: 'upi' }],
      version: saved.version,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0]).toMatchObject({ path: 'supplierId', message: expect.stringMatching(/not linked to the brand LG/) });
    const edited = await ok(manager, 'patch', `/expenses/${expenseId}`, {
      expenseDate: today,
      supplierId: abc.id,
      categoryIds: [cat.Maintenance, cat.Electronics],
      brandIds: [brand.Samsung],
      amount: '5000',
      payments: [{ amount: '5000', paymentMode: 'upi' }],
      version: saved.version,
    });
    saved = edited.expense;
    expect(saved.category.name).toBe('Maintenance');
    expect(saved.categories.map((c: { name: string; isActive: boolean }) => [c.name, c.isActive])).toEqual([
      ['Maintenance', false],
      ['Electronics', true],
    ]);
    expect(saved.brands.map((b: { name: string }) => b.name)).toEqual(['Samsung']);
    await ok(owner, 'patch', `/categories/${cat.Maintenance}`, { isActive: true });

    // Saving the same selections again is a no-op (no new version).
    const again = await ok(manager, 'patch', `/expenses/${expenseId}`, {
      expenseDate: today,
      supplierId: abc.id,
      categoryIds: [cat.Maintenance, cat.Electronics],
      brandIds: [brand.Samsung],
      amount: '5000',
      payments: [{ amount: '5000', paymentMode: 'upi' }],
      version: saved.version,
    });
    expect(again.expense.version).toBe(saved.version);

    // The database keeps the primary category and the first link in step: a writer that only knows
    // expenses.category_id (e.g. the previous app version during a deployment) still works ...
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE expenses SET category_id = $2 WHERE id = $1`, [expenseId, cat.Transport]);
      const links = await client.query(`SELECT category_id, position FROM expense_category_links WHERE expense_id = $1 ORDER BY position`, [expenseId]);
      expect(links.rows[0]).toEqual({ category_id: cat.Transport, position: 1 });
      // ... and removing the primary link directly is refused at commit.
      await client.query(`DELETE FROM expense_category_links WHERE expense_id = $1 AND position = 1`, [expenseId]);
      await expect(client.query('COMMIT')).rejects.toThrow(/primary category/);
    } finally {
      client.release();
    }
    expect((await get(owner, `/expenses/${expenseId}`)).expense.category.name).toBe('Maintenance');
  });

  it('17. reports, filters and Excel exports never double-count an expense with several categories', async () => {
    // A second multi-category expense, with a different supplier.
    await ok(manager, 'post', '/expenses', {
      expenseDate: today,
      supplierId: xyz.id,
      categoryIds: [cat.Transport, cat.Packaging, cat.Electronics],
      brandIds: [brand.HP],
      amount: '1000',
      payments: [{ amount: '1000', paymentMode: 'cash' }],
    });
    const all = await get(owner, '/expenses?pageSize=100');
    const overall = all.totals.amount;

    // Category report: amounts by primary category add up exactly to the overall total.
    const report = await get(owner, '/reports/categories?period=this_month');
    expect(report.total).toBe(overall);
    const sum = report.rows.reduce((s: number, r: { amount: string }) => s + Math.round(Number(r.amount) * 100), 0);
    expect(sum).toBe(Math.round(Number(overall) * 100));
    const electronics = report.rows.find((r: { name: string }) => r.name === 'Electronics');
    expect(electronics.amount).toBe('0.00'); // never primary
    expect(electronics.taggedCount).toBe(2); // but carried by two expenses
    const transport = report.rows.find((r: { name: string }) => r.name === 'Transport');
    expect(transport).toMatchObject({ amount: '1100.00', count: 2, taggedCount: 2 });

    // Filtering by a category matches any position and counts each expense once.
    const byElectronics = await get(owner, `/expenses?categoryId=${cat.Electronics}`);
    expect(byElectronics.items).toHaveLength(2);
    expect(byElectronics.totals.amount).toBe('6000.00');
    const byBrand = await get(owner, `/expenses?brandId=${brand.HP}`);
    expect(byBrand.items).toHaveLength(1);
    expect(byBrand.totals.amount).toBe('1000.00');
    const reportByElectronics = await get(owner, `/reports/expenses?period=this_month&categoryId=${cat.Electronics}`);
    expect(reportByElectronics.totals.amount).toBe('6000.00');
    const dashboard = (await get(owner, '/reports/dashboard?period=this_month')).dashboard;
    expect(JSON.stringify(dashboard)).toContain(overall);

    // Expenses export: one row per expense, all categories and brands listed, total = overall.
    const wb = await download(owner, 'expenses?period=this_month');
    const rows = table(wb.getWorksheet('Expenses')!, 'Date');
    const data = rows.filter((r) => r['Date'] !== null && r['Amount'] !== null && typeof r['Date'] !== 'string');
    expect(data).toHaveLength(all.items.length);
    expect(rows.some((r) => r['All categories'] === 'Transport, Packaging, Electronics' && r['Brands'] === 'HP')).toBe(true);
    const totalRow = rows.find((r) => r['Date'] === 'Total (active)')!;
    expect(totalRow['Amount']).toBe(Number(overall));

    // Category export: amounts add up to the overall total too.
    const cwb = await download(owner, 'categories?period=this_month');
    const crows = table(cwb.getWorksheet('Categories')!, 'Category').filter((r) => r['Category'] !== null);
    const catTotal = crows.find((r) => r['Category'] === 'Total')!;
    expect(catTotal['Amount']).toBe(Number(overall));
    expect(crows.find((r) => r['Category'] === 'Electronics')!['Tagged (any position)']).toBe(2);
  });

  it('H2. an older frontend (single categoryId, no brandIds) keeps secondary categories and brands; only explicit arrays clear them', async () => {
    const mk = async (name: string) => (await ok(manager, 'post', '/categories', { name })).category.id as string;
    const [X, Y, Z] = [await mk('LegacyX'), await mk('LegacyY'), await mk('LegacyZ')];
    const b1 = (await ok(manager, 'post', '/brands', { name: 'LegacyB1' })).brand.id as string;
    const b2 = (await ok(manager, 'post', '/brands', { name: 'LegacyB2' })).brand.id as string;
    const base = { expenseDate: today, supplierId: null, amount: '100', payments: [{ amount: '100', paymentMode: 'cash' }] };
    const names = (list: { name: string }[]) => list.map((c) => c.name);

    let e = (await ok(manager, 'post', '/expenses', { ...base, description: 'v1', categoryIds: [X, Y], brandIds: [b1, b2] })).expense;
    expect(names(e.categories)).toEqual(['LegacyX', 'LegacyY']);

    // Legacy payload, same primary: nothing about the classification changes.
    e = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'legacy edit 1', categoryId: X, version: e.version })).expense;
    expect(e.description).toBe('legacy edit 1');
    expect(names(e.categories)).toEqual(['LegacyX', 'LegacyY']);
    expect(names(e.brands)).toEqual(['LegacyB1', 'LegacyB2']);

    // Legacy payload that changes the category replaces the PRIMARY one only (as before); the rest stays.
    e = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'legacy edit 2', categoryId: Z, version: e.version })).expense;
    expect(names(e.categories)).toEqual(['LegacyZ', 'LegacyY']);
    expect(e.category.name).toBe('LegacyZ');
    expect(names(e.brands)).toEqual(['LegacyB1', 'LegacyB2']);

    // Legacy payload naming an existing secondary category promotes it (no duplicate link).
    e = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'legacy edit 3', categoryId: Y, version: e.version })).expense;
    expect(names(e.categories)).toEqual(['LegacyY']);
    expect(names(e.brands)).toEqual(['LegacyB1', 'LegacyB2']);

    // New frontend: categoryIds without brandIds leaves brands alone ...
    e = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'new 1', categoryIds: [Y, X], version: e.version })).expense;
    expect(names(e.categories)).toEqual(['LegacyY', 'LegacyX']);
    expect(names(e.brands)).toEqual(['LegacyB1', 'LegacyB2']);
    // ... an explicit empty brandIds clears them on purpose, categories untouched ...
    e = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'new 2', categoryIds: [Y, X], brandIds: [], version: e.version })).expense;
    expect(e.brands).toEqual([]);
    expect(names(e.categories)).toEqual(['LegacyY', 'LegacyX']);
    // ... and an explicit single-item categoryIds removes the secondary one.
    e = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'new 3', categoryIds: [Y], brandIds: [b2], version: e.version })).expense;
    expect(names(e.categories)).toEqual(['LegacyY']);
    expect(names(e.brands)).toEqual(['LegacyB2']);

    // A legacy edit that changes nothing is a no-op (no new version); a legacy create starts without brands.
    const same = (await ok(manager, 'patch', `/expenses/${e.id}`, { ...base, description: 'new 3', categoryId: Y, version: e.version })).expense;
    expect(same.version).toBe(e.version);
    const created = (await ok(manager, 'post', '/expenses', { ...base, categoryId: X })).expense;
    expect(names(created.categories)).toEqual(['LegacyX']);
    expect(created.brands).toEqual([]);
    // Both forms together are still refused.
    expect((await send(manager, 'patch', `/expenses/${e.id}`, { ...base, categoryId: X, categoryIds: [X], version: e.version })).status).toBe(400);
  });

  it('M1. category report filter lists only the selected category (primary amount, tagged count), API and Excel agree', async () => {
    const mk = async (name: string) => (await ok(manager, 'post', '/categories', { name })).category.id as string;
    const [RX, RY, RZ] = [await mk('RptX'), await mk('RptY'), await mk('RptZ')];
    const add = (amount: string, categoryIds: string[]) =>
      ok(manager, 'post', '/expenses', { expenseDate: today, supplierId: null, categoryIds, amount, payments: [{ amount, paymentMode: 'cash' }] });
    await add('1000', [RX, RY]); // X primary, Y secondary
    await add('500', [RY, RX]); // Y primary, X secondary
    await add('200', [RY]);
    await add('100', [RY, RZ]); // Z only ever secondary

    const all = await get(owner, '/reports/categories?period=this_month');
    const grand = BigInt(Math.round(Number(all.total) * 100));
    const pct = (amount: string) => {
      const t = (BigInt(Math.round(Number(amount) * 100)) * 1000n) / grand;
      return `${t / 10n}.${t % 10n}`;
    };
    expect(all.rows.find((r: { name: string }) => r.name === 'RptX')).toMatchObject({ amount: '1000.00', count: 1, taggedCount: 2 });
    expect(all.rows.find((r: { name: string }) => r.name === 'RptY')).toMatchObject({ amount: '800.00', count: 3, taggedCount: 4 });

    // Selected category is PRIMARY on some expenses.
    const x = await get(owner, `/reports/categories?period=this_month&categoryId=${RX}`);
    expect(x.rows).toHaveLength(1);
    expect(x.rows[0]).toMatchObject({ name: 'RptX', amount: '1000.00', count: 1, taggedCount: 2, percent: pct('1000') });
    expect(x.total).toBe('1000.00');
    const y = await get(owner, `/reports/categories?period=this_month&categoryId=${RY}`);
    expect(y.rows).toHaveLength(1);
    expect(y.rows[0]).toMatchObject({ name: 'RptY', amount: '800.00', count: 3, taggedCount: 4, percent: pct('800') });
    // Selected category is only ever SECONDARY: nothing attributed, but it is still reported as tagged.
    const z = await get(owner, `/reports/categories?period=this_month&categoryId=${RZ}`);
    expect(z.rows).toHaveLength(1);
    expect(z.rows[0]).toMatchObject({ name: 'RptZ', amount: '0.00', count: 0, taggedCount: 1, percent: '0.0' });
    expect(z.total).toBe('0.00');
    // The unfiltered report is unchanged: amounts still add up to the expense total (nothing counted twice).
    const sum = all.rows.reduce((s: number, r: { amount: string }) => s + Math.round(Number(r.amount) * 100), 0);
    expect(BigInt(sum)).toBe(grand);
    // The filter never changes the expense list/report totals semantics: expenses carrying X, each once.
    expect((await get(owner, `/expenses?categoryId=${RX}`)).totals.amount).toBe('1500.00');

    // Excel export of the same filter = the API numbers; no other category row.
    const rowsOf = async (id: string) => {
      const ws = (await download(owner, `categories?period=this_month&categoryId=${id}`)).getWorksheet('Categories')!;
      let header = 0;
      ws.eachRow((row, n) => {
        if (!header && row.getCell(2).value === 'Archived') header = n;
      });
      expect(header).toBeGreaterThan(0);
      const heads = (ws.getRow(header).values as unknown[]).slice(1) as string[];
      const out: Record<string, unknown>[] = [];
      for (let n = header + 1; n <= ws.rowCount; n++) {
        const vals = (ws.getRow(n).values as unknown[]).slice(1);
        out.push(Object.fromEntries(heads.map((h, i) => [h, vals[i] ?? null])));
      }
      return out.filter((r) => r['Category'] !== null);
    };
    const xr = await rowsOf(RX);
    expect(xr.map((r) => r['Category'])).toEqual(['RptX', 'Total']);
    expect(xr[0]).toMatchObject({ Expenses: 1, Amount: 1000, 'Tagged (any position)': 2 });
    expect(xr[1]!['Amount']).toBe(Number(x.total));
    const zr = await rowsOf(RZ);
    expect(zr.map((r) => r['Category'])).toEqual(['RptZ', 'Total']);
    expect(zr[0]).toMatchObject({ Expenses: 0, Amount: 0, 'Tagged (any position)': 1 });
  });

  it('payments: paid in full, part paid and not paid yet keep supplier balances exact', async () => {
    const balanceOf = async (id: string) => (await get(owner, `/suppliers/${id}/balance`)).balance.payable;
    const before = Number(await balanceOf(xyz.id));
    const base = { expenseDate: today, supplierId: xyz.id, categoryIds: [cat.Transport], amount: '900' };
    const full = (await ok(manager, 'post', '/expenses', { ...base, payments: [{ amount: '900', paymentMode: 'cash' }] })).expense;
    expect(full).toMatchObject({ amountPaid: '900.00', outstanding: '0.00' });
    const part = (await ok(manager, 'post', '/expenses', {
      ...base,
      payments: [
        { amount: '200', paymentMode: 'upi' },
        { amount: '100', paymentMode: 'cash' },
      ],
    })).expense;
    expect(part).toMatchObject({ amountPaid: '300.00', outstanding: '600.00' });
    const unpaid = (await ok(manager, 'post', '/expenses', { ...base, payments: [] })).expense;
    expect(unpaid).toMatchObject({ amountPaid: '0.00', outstanding: '900.00', paymentMode: null });
    expect(Number(await balanceOf(xyz.id))).toBe(before + 600 + 900);

    // Overpayment is refused; a supplier-less expense must be paid in full.
    const over = await send(manager, 'post', '/expenses', { ...base, payments: [{ amount: '901', paymentMode: 'cash' }] });
    expect(over.status).toBe(400);
    const noSupplier = await send(manager, 'post', '/expenses', { ...base, supplierId: null, payments: [] });
    expect(noSupplier.status).toBe(400);
    expect(noSupplier.body.error.details[0].path).toBe('payments');

    // Editing an unpaid bill (e.g. its categories) keeps it unpaid: nothing is marked paid silently.
    const edited = (await ok(manager, 'patch', `/expenses/${unpaid.id}`, {
      ...base,
      categoryIds: [cat.Transport, cat.Packaging],
      payments: [],
      version: unpaid.version,
    })).expense;
    expect(edited).toMatchObject({ amountPaid: '0.00', outstanding: '900.00', payments: [] });
    expect(Number(await balanceOf(xyz.id))).toBe(before + 600 + 900);
  });

  it('live updates: authenticated change feed with no amounts, resumable from a cursor', async () => {
    expect((await request(app).get('/api/v1/sync/changes')).status).toBe(401);
    expect((await owner.agent.get('/api/v1/sync/changes?after=abc')).status).toBe(400);

    // First poll: only a cursor (nothing that happened before the app was opened).
    const start = await get(owner, '/sync/changes');
    expect(start.events).toEqual([]);
    expect(start.cursor).toMatch(/^\d+$/);

    const created = (await ok(manager, 'post', '/expenses', {
      expenseDate: today,
      supplierId: xyz.id,
      categoryIds: [cat.Transport],
      amount: '42.50',
      description: 'Secret description',
      payments: [{ amount: '42.50', paymentMode: 'cash' }],
    })).expense;
    await ok(manager, 'patch', `/expenses/${created.id}`, {
      expenseDate: today,
      supplierId: xyz.id,
      categoryIds: [cat.Transport],
      amount: '42.50',
      description: 'Changed',
      payments: [{ amount: '42.50', paymentMode: 'cash' }],
      version: created.version,
    });

    const next = await get(owner, `/sync/changes?after=${start.cursor}`);
    const mine = next.events.filter((e: { entityId: string }) => e.entityId === created.id);
    expect(mine.map((e: { action: string }) => e.action)).toEqual(['create', 'update']);
    expect(mine[0]).toMatchObject({ entityType: 'expense', actor: { name: 'Asha' } });
    expect(Object.keys(mine[0]).sort()).toEqual(['action', 'actor', 'entityId', 'entityType', 'id', 'occurredAt']);
    expect(JSON.stringify(next)).not.toMatch(/42\.50|Secret|Changed/);
    expect(BigInt(next.cursor)).toBeGreaterThan(BigInt(start.cursor));

    // Polling again from the new cursor brings nothing NEW (recent events may repeat; ids de-duplicate).
    const again = await get(owner, `/sync/changes?after=${next.cursor}`);
    expect(again.events.every((e: { id: string }) => BigInt(e.id) <= BigInt(next.cursor))).toBe(true);
    expect(again.cursor).toBe(next.cursor);

    // Owner-only monthly-report configuration never appears in the feed.
    const settings = (await get(owner, '/monthly-reports/settings')).settings;
    await ok(owner, 'post', '/monthly-reports/recipients', { email: 'feed@example.test' });
    expect(settings).toBeTruthy();
    const after = await get(manager, `/sync/changes?after=${next.cursor}`);
    expect(after.events.some((e: { entityType: string }) => e.entityType.startsWith('report_'))).toBe(false);

    // A device that was away for a very long time is told to reload everything.
    const far = await get(owner, '/sync/changes?after=0');
    expect(far.truncated || far.events.length <= 200).toBe(true);
  });
});
