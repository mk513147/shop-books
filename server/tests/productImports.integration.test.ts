/**
 * Product import from Excel (migration 0015): file safety, inspect without storing, block
 * selection, header/section detection, the documented ambiguities of the shop's "Copy" sheet
 * (synthetic fixture), explicit rules and brand decisions, splits, review groups, atomic commit,
 * stale previews, double commit, discard, error report and audit.
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { assertSafeXlsx } from '../src/modules/productImports/zipGuard.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';
import { buildZip, copySheetWorkbook, templateWorkbook, WORKBOOK_PARTS } from './productImportFixtures.js';

const pool = await connectTestDatabase();

describe('workbook safety checks (no database)', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (err) {
      return (err as { code?: string }).code ?? 'error';
    }
  };

  it('accepts a real workbook and refuses anything that is not a safe .xlsx', async () => {
    expect(code(() => assertSafeXlsx(Buffer.from(new Uint8Array(0))))).toBe('INVALID_WORKBOOK');
    expect(assertSafeXlsx(await copySheetWorkbook())).toContain('xl/workbook.xml');
    expect(code(() => assertSafeXlsx(Buffer.from('name,price\nx,1')))).toBe('INVALID_WORKBOOK');
    expect(code(() => assertSafeXlsx(Buffer.alloc(3 * 1024 * 1024, 1)))).toBe('FILE_TOO_LARGE');
    // Not a workbook (missing parts), a macro workbook, unsafe names.
    expect(code(() => assertSafeXlsx(buildZip([{ name: 'readme.txt', data: Buffer.from('hi') }])))).toBe('INVALID_WORKBOOK');
    expect(code(() => assertSafeXlsx(buildZip([...WORKBOOK_PARTS, { name: 'xl/vbaProject.bin', data: Buffer.from('macro') }])))).toBe('INVALID_WORKBOOK');
    expect(code(() => assertSafeXlsx(buildZip([...WORKBOOK_PARTS, { name: '../evil.xml', data: Buffer.from('x') }])))).toBe('INVALID_WORKBOOK');
  });

  it('refuses zip bombs, declared or hidden behind a lying size', () => {
    const zeros = Buffer.alloc(11 * 1024 * 1024);
    // Declared: an 11 MB part (compresses to a few KB).
    expect(code(() => assertSafeXlsx(buildZip([...WORKBOOK_PARTS, { name: 'xl/big.xml', data: zeros }])))).toBe('INVALID_WORKBOOK');
    // Hidden: the header claims 100 bytes, the data inflates to 11 MB.
    expect(code(() => assertSafeXlsx(buildZip([...WORKBOOK_PARTS, { name: 'xl/sneaky.xml', data: zeros, declaredSize: 100 }])))).toBe('INVALID_WORKBOOK');
    // Many parts that together exceed 25 MB.
    const parts = Array.from({ length: 4 }, (_, i) => ({ name: `xl/p${i}.xml`, data: Buffer.alloc(8 * 1024 * 1024) }));
    expect(code(() => assertSafeXlsx(buildZip([...WORKBOOK_PARTS, ...parts])))).toBe('INVALID_WORKBOOK');
  });
});

// POSTPONED (Excel import is not part of this release): the import router is not mounted, so these
// end-to-end checks of the workflow cannot run against the app. They are kept, unchanged, for the
// future reactivation (docs/products.md → "Excel import: postponed"); re-enable them with the router.
// The disabled routes themselves are tested in productImports.postponed.integration.test.ts.
describe.skip('product import (integration) [postponed]', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  let notebooks: string;
  let drawing: string;
  let classmate: string;
  let copyFile: Buffer;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch', p: string, body: object = {}) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);
  const upload = (s: Session, p: string, file: Buffer, name = 'copy.xlsx') =>
    s.agent
      .post(`/api/v1${p}`)
      .set({ Origin: BROWSER_HEADERS.Origin, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': s.csrf, 'X-File-Name': encodeURIComponent(name) })
      .send(file);

  type Row = { rowNumber: number; splitIndex: number; group: string; effectiveDecision: string; issues: { code: string; severity: string }[]; proposal: Record<string, unknown>; raw: Record<string, string> };
  const rowsOf = async (id: string): Promise<Row[]> => (await get(owner, `/product-imports/${id}/rows?pageSize=200`)).body.items;
  const codes = (r: Row | undefined) => (r?.issues ?? []).map((i) => i.code);

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    const users = await db.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash, can_view_purchase_prices) VALUES
         ('owneri@example.test', 'Owner', 'owner', $1, false), ('mgri@example.test', 'Manager', 'manager', $1, true) RETURNING id`,
      [hash],
    );
    const ownerId = users.rows[0]!.id;
    const cat = async (name: string) =>
      (await db.query<{ id: string }>(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ($1, true, $2, $2) RETURNING id`, [name, ownerId])).rows[0]!.id;
    notebooks = await cat('Notebook (Copy)');
    drawing = await cat('Drawing');
    classmate = (await db.query<{ id: string }>(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Classmate', $1, $1) RETURNING id`, [ownerId])).rows[0]!.id;
    owner = await signIn('owneri@example.test');
    manager = await signIn('mgri@example.test');
    copyFile = await copySheetWorkbook();
  });

  afterAll(async () => {
    await db.end();
  });

  it('inspect lists sheets, previews and the copied side-by-side block, and stores nothing', async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM product_import_batches`)).rows[0].n;
    const res = await upload(owner, '/product-imports/inspect', copyFile);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const copy = res.body.sheets.find((s: { name: string }) => s.name === 'Copy');
    expect(res.body.sheets.map((s: { name: string }) => s.name)).toEqual(['Copy', 'Daily expenses']);
    expect(copy.preview[2].cells.slice(0, 5)).toEqual(['NAME', 'PAGE ', 'SIZE', 'MRP', 'SP']);
    expect(copy.blocks).toEqual([
      { range: 'A1:E27', duplicateOf: null },
      { range: 'G2:K16', duplicateOf: 'A12:E26' },
    ]);
    expect((await db.query(`SELECT count(*)::int AS n FROM product_import_batches`)).rows[0].n).toBe(before);
  });

  it('refuses bad uploads clearly', async () => {
    expect((await upload(owner, '/product-imports/inspect', copyFile, 'copy.xls')).body.error.code).toBe('INVALID_WORKBOOK');
    expect((await upload(owner, '/product-imports/inspect', Buffer.from('not a zip'))).body.error.code).toBe('INVALID_WORKBOOK');
    const big = await upload(owner, '/product-imports/inspect', Buffer.alloc(2 * 1024 * 1024 + 10, 1));
    expect(big.status).toBe(413);
    expect((await upload(owner, '/product-imports?sheet=Nope&range=A1:E27&headerRow=3', copyFile)).body.error.code).toBe('SHEET_NOT_FOUND');
    expect((await upload(owner, '/product-imports?sheet=Copy&range=A1:AK27&headerRow=3', copyFile)).body.error.code).toBe('RANGE_TOO_WIDE');
    const many = await templateWorkbook(
      Array.from({ length: 2001 }, (_, i) => [`P${i}`, 10]),
      ['Name', 'Selling price'],
    );
    expect((await upload(owner, '/product-imports?sheet=Products&range=A1:B2002&headerRow=1', many)).body.error.code).toBe('TOO_MANY_ROWS');
  });

  let batchId: string;
  let version: number;
  const refresh = async () => {
    const b = (await get(owner, `/product-imports/${batchId}`)).body.batch;
    version = b.version;
    return b;
  };
  const patch = async (body: object) => {
    const res = await send(owner, 'patch', `/product-imports/${batchId}`, { version, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    version = res.body.batch.version;
    return res.body.batch;
  };
  const rowsPatch = async (rows: object[]) => {
    const res = await send(owner, 'patch', `/product-imports/${batchId}/rows`, { version, rows });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    version = res.body.batch.version;
    return res.body.batch;
  };

  it('stores only the selected block, keeps raw values and row numbers, detects headers and sections', async () => {
    const res = await upload(owner, '/product-imports?sheet=Copy&range=A1:E27&headerRow=3&sectionRows=true', copyFile);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const b = res.body.batch;
    batchId = b.id;
    version = b.version;
    expect(b).toMatchObject({ sheetName: 'Copy', blockRange: 'A1:E27', headerRow: 3, status: 'review' });
    expect(b.skippedRows.filter((r: { reason: string }) => r.reason === 'header').map((r: { rowNumber: number }) => r.rowNumber)).toEqual([13, 17]);
    expect(b.sections.map((s: { name: string }) => s.name)).toEqual(['CLASSMATE', 'APPLE', 'PRACTICAL', 'DRAWING COPY', 'SCRAP/GRAPH/DIARY/PAPER']);
    // "SP" is deliberately not guessed; the mapping is unconfirmed.
    expect(b.mapping).toEqual({ columns: { A: 'name', B: 'pages', C: 'size', D: 'mrp' }, confirmed: false });
    expect(b.blockers).toContain('Confirm the column mapping.');
    // Nothing of the other sheet was stored.
    const stored = await db.query(`SELECT raw::text AS r FROM product_import_rows WHERE batch_id = $1`, [batchId]);
    expect(stored.rows.some((r) => /PRIVATE|SHOULD NOT/.test(r.r))).toBe(false);
    const rows = await rowsOf(batchId);
    expect(rows.map((r) => r.rowNumber)).toEqual([4, 5, 6, 7, 10, 11, 14, 15, 18, 19, 21, 22, 23, 24, 25, 26, 27]);
    const apple = rows.find((r) => r.rowNumber === 10)!;
    expect(apple.raw).toEqual({ A: 'APPLE ', B: '120/140', C: 'SL', D: '40', E: '30' });
  });

  it('flags every documented ambiguity instead of guessing', async () => {
    await patch({ mapping: { columns: { A: 'name', B: 'pages', C: 'size', D: 'mrp', E: 'sellingPrice' }, confirmed: true } });
    const rows = await rowsOf(batchId);
    const at = (n: number, split = 0) => rows.find((r) => r.rowNumber === n && r.splitIndex === split);
    expect(codes(at(4))).toEqual(expect.arrayContaining(['NAME_REQUIRED', 'AMBIGUOUS_SIZE', 'CATEGORY_REQUIRED']));
    expect(at(4)!.proposal.brand).toMatchObject({ kind: 'existing', name: 'Classmate' });
    expect(codes(at(5))).toContain('PRICE_CONFLICT');
    expect(codes(at(6))).toContain('PRICE_CONFLICT');
    expect(codes(at(10))).toEqual(expect.arrayContaining(['BRAND_UNDECIDED', 'ALTERNATIVE_VALUES']));
    expect(codes(at(11))).toContain('DEEP_DISCOUNT');
    expect(codes(at(18))).toContain('GSM_IN_NAME');
    expect(codes(at(21))).toContain('DUAL_PRICE');
    expect(codes(at(22))).toContain('PER_PIECE_PRICE');
    expect(codes(at(23))).toContain('MRP_ZERO');
    expect(codes(at(24))).toContain('AMBIGUOUS_SIZE');
    expect(codes(at(26))).toContain('DUAL_PRICE');
    expect(rows.every((r) => r.group === 'error')).toBe(true);
    // No price was calculated for the dual-price cells.
    expect(at(21)!.proposal.sellingPrice).toBeNull();
    const batch = await refresh();
    const keys = batch.brandCandidates.map((c: { key: string }) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['APPLE', 'PILOT', 'DOMS', 'CAMEL', 'CANSON', 'NORMAL', 'MY', 'PAPERKARFT', 'PAPERKART', 'ODDY']));
    // Look-alike spellings are pointed out, never merged.
    expect(batch.brandCandidates.find((c: { key: string }) => c.key === 'PAPERKARFT').similarInFile).toContain('PAPERKART');
    expect(batch.sizeValues.map((s: { value: string }) => s.value)).toEqual(['D', 'MD', 'SL']);
  });

  it('resolves everything only through explicit rules, decisions and row edits', async () => {
    await patch({
      valueRules: { gsmSuffix: true, sizes: { SL: { action: 'attribute', key: 'ruling', value: 'Single line' }, D: { action: 'keep' }, MD: { action: 'keep' } } },
      sectionCategories: {
        CLASSMATE: notebooks,
        APPLE: notebooks,
        PRACTICAL: notebooks,
        'DRAWING COPY': drawing,
        'SCRAP/GRAPH/DIARY/PAPER': drawing,
      },
      brandDecisions: {
        APPLE: { action: 'create', name: 'Apple', prefix: 'APPLE' },
        PILOT: { action: 'create', name: 'Pilot', prefix: 'PILOT' },
        DOMS: { action: 'create', name: 'DOMS', prefix: 'DOMS' },
        CAMEL: { action: 'create', name: 'Camel', prefix: 'CAMEL' },
        CANSON: { action: 'create', name: 'Canson', prefix: 'CANSON' },
        NORMAL: { action: 'not_brand' },
        MY: { action: 'create', name: 'My Scholar', prefix: 'MY SCHOLAR' },
        PAPERKARFT: { action: 'create', name: 'Paperkraft', prefix: 'PAPERKARFT' },
        PAPERKART: { action: 'create', name: 'Paperkraft', prefix: 'PAPERKART' },
        ODDY: { action: 'create', name: 'Oddy', prefix: 'ODDY' },
      },
    });
    let rows = await rowsOf(batchId);
    const at = (n: number, split = 0) => rows.find((r) => r.rowNumber === n && r.splitIndex === split)!;
    expect(at(18).proposal).toMatchObject({ name: 'SPIRAL', gsm: 150, brand: { kind: 'new', name: 'DOMS' } });
    expect(at(7).proposal).toMatchObject({ name: 'SPIRAL', size: null, attributes: { ruling: 'Single line' } });
    expect(at(14).proposal.suggestedName).toBe('PRACTICAL');
    expect(at(23).proposal.brand).toMatchObject({ name: 'My Scholar' });

    // Row edits: names for brand-only rows, one of the conflicting rows skipped, MRP 0 -> no MRP,
    // per-piece price confirmed as a loose-piece product, the formula-looking row skipped.
    await rowsPatch([
      { rowNumber: 4, overrides: { name: 'Notebook' } },
      { rowNumber: 6, decision: 'skip' },
      { rowNumber: 14, overrides: { name: 'Practical Notebook' } },
      { rowNumber: 15, overrides: { name: 'Practical Notebook' } },
      { rowNumber: 22, overrides: { sellingPrice: '10', mrp: null, sellingUnit: 'piece' } },
      { rowNumber: 23, overrides: { name: 'Spiral Diary', mrp: null } },
      { rowNumber: 27, decision: 'skip' },
    ]);
    // Splits: alternative page counts; pack + loose piece (prices typed by the user, never derived).
    const split = async (row: number, parts: object[]) => {
      const res = await send(owner, 'post', `/product-imports/${batchId}/rows/${row}/split`, { version, parts });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      version = res.body.batch.version;
    };
    await split(10, [{ name: 'Notebook', pageCount: 120 }, { name: 'Notebook', pageCount: 140 }]);
    await split(21, [
      { sellingPrice: '170', sellingUnit: 'pack', packQty: 12 },
      { sellingPrice: '15', sellingUnit: 'piece', mrp: null, name: 'DRAWING SHEET' },
    ]);
    await split(26, [
      { sellingPrice: '50', sellingUnit: 'pack', packQty: 20 },
      { sellingPrice: '3', sellingUnit: 'piece', mrp: null, name: 'DESIGN SHEET' },
    ]);
    rows = await rowsOf(batchId);
    const errors = rows.filter((r) => r.effectiveDecision !== 'skip' && r.group === 'error');
    expect(errors.map((r) => [r.rowNumber, r.splitIndex, codes(r)])).toEqual([]);
    expect(at(6).effectiveDecision).toBe('skip');
    expect(at(10).effectiveDecision).toBe('skip');
    expect(rows.find((r) => r.rowNumber === 10 && r.splitIndex === 2)!.proposal).toMatchObject({ pageCount: 140, brand: { name: 'Apple' } });
    const batch = await refresh();
    expect(batch.blockers).toEqual([]);
    expect(batch.counts.toCreate).toBe(18);
  });

  it('a change in the catalogue after the preview makes the commit stale; nothing is written', async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM products`)).rows[0].n;
    // Someone adds the same Classmate Register meanwhile.
    const created = await send(owner, 'post', '/products', { name: 'REGISTER', brandId: classmate, categoryId: notebooks, size: 'A4', pageCount: 140, sellingPrice: '50', mrp: '55' });
    expect(created.status).toBe(201);
    const stale = await send(owner, 'post', `/product-imports/${batchId}/commit`, { version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('IMPORT_STALE');
    expect((await db.query(`SELECT count(*)::int AS n FROM products`)).rows[0].n).toBe(before + 1);
    const batch = await refresh();
    expect(batch.counts.update).toBe(1);
    expect(batch.blockers.join(' ')).toMatch(/need a decision/);
    const row5 = (await rowsOf(batchId)).find((r) => r.rowNumber === 5)!;
    expect(row5).toMatchObject({ group: 'update', effectiveDecision: 'pending' });
    await rowsPatch([{ rowNumber: 5, decision: 'update', overrides: { sellingPrice: '52' } }]);
  });

  it('a failure in the middle of a commit rolls everything back', async () => {
    const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM products)::int AS p, (SELECT count(*) FROM brands)::int AS b`)).rows[0];
    const before = await counts();
    await db.query(`CREATE FUNCTION pg_temp_fail_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'Spiral Diary' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER zz_fail_import BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_import()`);
    try {
      const res = await send(owner, 'post', `/product-imports/${batchId}/commit`, { version });
      expect(res.status).toBe(500);
    } finally {
      await db.query(`DROP TRIGGER zz_fail_import ON products`);
      await db.query(`DROP FUNCTION pg_temp_fail_import()`);
    }
    expect(await counts()).toEqual(before);
    expect((await refresh()).status).toBe('review');
  });

  it('commits atomically: approved brands once, products with audit, updates prices only; never twice', async () => {
    const res = await send(owner, 'post', `/product-imports/${batchId}/commit`, { version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body.batch;
    expect(b.status).toBe('committed');
    expect(b.result).toEqual({ created: 17, updated: 1, skipped: 5, brandsCreated: 8 });
    expect((await db.query(`SELECT count(*)::int AS n FROM brands WHERE name = 'Paperkraft'`)).rows[0].n).toBe(1);
    const sheet = (await db.query(`SELECT p.selling_unit, p.pack_qty, p.mrp, p.selling_price FROM products p WHERE p.name = 'DRAWING SHEET'`)).rows[0];
    expect(sheet).toEqual({ selling_unit: 'piece', pack_qty: 1, mrp: null, selling_price: '15.00' });
    const pad = (await db.query(`SELECT p.selling_unit, p.pack_qty, p.mrp, p.selling_price FROM products p JOIN brands b ON b.id = p.brand_id WHERE b.name = 'Canson' AND p.name = 'DRAWING'`)).rows[0];
    expect(pad).toEqual({ selling_unit: 'pack', pack_qty: 12, mrp: '200.00', selling_price: '170.00' });
    // The matched product only had its price updated.
    const updated = (await db.query(`SELECT name, selling_price, mrp FROM products WHERE name = 'REGISTER' AND brand_id = $1`, [classmate])).rows;
    expect(updated).toEqual([{ name: 'REGISTER', selling_price: '52.00', mrp: '55.00' }]);
    const audit = await db.query(`SELECT count(*)::int AS n FROM financial_audit_events WHERE entity_type = 'product' AND after_values->>'importBatchId' = $1`, [batchId]);
    expect(audit.rows[0].n).toBe(18);
    const actions = (await db.query(`SELECT action FROM financial_audit_events WHERE entity_type = 'product_import' AND entity_id = $1 ORDER BY id`, [batchId])).rows.map((r) => r.action);
    expect(actions).toEqual(['create', 'commit']);
    const again = await send(owner, 'post', `/product-imports/${batchId}/commit`, { version: b.version });
    expect(again.body.error.code).toBe('ALREADY_COMMITTED');
    expect((await send(owner, 'patch', `/product-imports/${batchId}/rows`, { version: b.version, rows: [{ rowNumber: 4, decision: 'skip' }] })).body.error.code).toBe(
      'ALREADY_COMMITTED',
    );
  });

  it('the review report keeps original rows and neutralises formulas', async () => {
    const res = await owner.agent.get(`/api/v1/product-imports/${batchId}/report`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/copy_import-review\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ArrayBuffer);
    const ws = wb.getWorksheet('Import review')!;
    const values: string[] = [];
    ws.eachRow((row) => values.push(JSON.stringify(row.values)));
    expect(values.some((v) => v.includes('"APPLE "'))).toBe(true);
    const formulaRow = values.find((v) => v.includes('HYPERLINK'))!;
    expect(formulaRow).toContain(`"'=HYPERLINK`);
    ws.eachRow((row) => row.eachCell((cell) => expect(typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value).toBe(false)));
  });

  it('a template workbook imports with a purchase price column; discard works', async () => {
    const file = await templateWorkbook(
      [['Classmate', 'Long Book', 'Notebook (Copy)', 120, 45, 30]],
      ['Brand', 'Product name', 'Category', 'Pages', 'Selling price', 'Purchase price'],
    );
    const created = await upload(manager, '/product-imports?sheet=Products&range=A1:F2&headerRow=1', file, 'template.xlsx');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const b = created.body.batch;
    expect(b.mapping.columns).toEqual({ A: 'brand', B: 'name', C: 'category', D: 'pages', E: 'sellingPrice', F: 'purchasePrice' });
    const confirmed = await send(manager, 'patch', `/product-imports/${b.id}`, { version: b.version, mapping: { ...b.mapping, confirmed: true } });
    expect(confirmed.body.batch.blockers).toEqual([]);
    const committed = await send(manager, 'post', `/product-imports/${b.id}/commit`, { version: confirmed.body.batch.version });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    const product = (await db.query(`SELECT id FROM products WHERE name = 'Long Book'`)).rows[0];
    expect((await db.query(`SELECT default_purchase_price FROM product_costs WHERE product_id = $1`, [product.id])).rows[0].default_purchase_price).toBe('30.00');

    const other = await upload(manager, '/product-imports?sheet=Products&range=A1:F2&headerRow=1', file, 'again.xlsx');
    const discarded = await send(manager, 'post', `/product-imports/${other.body.batch.id}/discard`, { version: other.body.batch.version });
    expect(discarded.body.batch.status).toBe('discarded');
    const list = (await get(manager, '/product-imports')).body.batches.map((x: { status: string }) => x.status);
    expect(list).toEqual(expect.arrayContaining(['committed', 'discarded']));
  });
});
