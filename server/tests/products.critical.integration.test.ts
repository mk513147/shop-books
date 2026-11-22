/**
 * Product catalogue (migration 0015) against the real PostgreSQL test database: category
 * eligibility, CRUD and validation, SP > MRP confirmation, optimistic locking, idempotency,
 * deactivation / reactivation (code conflicts), no hard delete, search (tokens, structured,
 * typo tolerance, ranking, supplier-only last), search refresh triggers, supplier links,
 * preferred supplier and effective purchase price, and history.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { normaliseSearchText } from '../src/modules/products/search.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('products (critical paths)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  let stationery: string;
  let toys: string;
  let rent: string;
  let classmate: string;
  let doms: string;
  let supplierA: string;
  let supplierB: string;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch' | 'put' | 'delete', p: string, body: object = {}, headers: Record<string, string> = {}) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, ...headers }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);

  const base = (over: object = {}) => ({ name: 'Spiral Notebook', brandId: classmate, categoryId: stationery, sellingPrice: '45', ...over });
  async function create(over: object = {}, s: Session = manager) {
    const res = await send(s, 'post', '/products', base(over));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.product as { id: string; version: number; [k: string]: unknown };
  }

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    const users = await db.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('ownerp@example.test', 'Owner', 'owner', $1), ('mgrp@example.test', 'Manager Asha', 'manager', $1) RETURNING id`,
      [hash],
    );
    const ownerId = users.rows[0]!.id;
    const cat = async (name: string, usable: boolean) =>
      (await db.query<{ id: string }>(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`, [name, usable, ownerId])).rows[0]!.id;
    stationery = await cat('Stationery', true);
    toys = await cat('Toys', true);
    rent = await cat('Rent', false);
    const brand = async (name: string) => (await db.query<{ id: string }>(`INSERT INTO brands (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [name, ownerId])).rows[0]!.id;
    classmate = await brand('Classmate');
    doms = await brand('DOMS');
    const supplier = async (name: string) => (await db.query<{ id: string }>(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [name, ownerId])).rows[0]!.id;
    supplierA = await supplier('Sharma Traders');
    supplierB = await supplier('National Distributors');
    await db.query(`INSERT INTO supplier_brands (supplier_id, brand_id, created_by) VALUES ($1, $2, $3)`, [supplierA, classmate, ownerId]);
    owner = await signIn('ownerp@example.test');
    manager = await signIn('mgrp@example.test');
  });

  afterAll(async () => {
    await db.end();
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/products')).status).toBe(401);
    expect((await request(app).post('/api/v1/products').set(BROWSER_HEADERS).send(base())).status).toBe(401);
  });

  describe('category eligibility', () => {
    it('existing categories default to not usable; the flag is settable, audited and filterable', async () => {
      const created = await send(manager, 'post', '/categories', { name: 'Notebook (Copy)' });
      expect(created.body.category).toMatchObject({ isProductUsable: false, productCount: 0 });
      const marked = await send(manager, 'patch', `/categories/${created.body.category.id}`, { isProductUsable: true });
      expect(marked.body.category.isProductUsable).toBe(true);
      const audit = await db.query(`SELECT before_values, after_values FROM financial_audit_events WHERE entity_type = 'expense_category' AND entity_id = $1 AND action = 'update'`, [
        created.body.category.id,
      ]);
      expect(audit.rows[0]).toMatchObject({ before_values: { isProductUsable: false }, after_values: { isProductUsable: true } });
      const usable = (await get(manager, '/categories?status=active&usage=products')).body.categories.map((c: { name: string }) => c.name);
      expect(usable).toEqual(expect.arrayContaining(['Stationery', 'Toys', 'Notebook (Copy)']));
      expect(usable).not.toContain('Rent');
      // Every other category list is unchanged (expense pickers ignore the flag).
      expect((await get(manager, '/categories?status=active')).body.categories.map((c: { name: string }) => c.name)).toContain('Rent');
    });

    it('a product cannot be put in a category that is not marked for products', async () => {
      const res = await send(manager, 'post', '/products', base({ categoryId: rent }));
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({ path: 'categoryId' });
      expect(res.body.error.details[0].message).toMatch(/not marked for products/);
    });
  });

  describe('create and validate', () => {
    it('creates a product with normalised fields, audit, search document and no purchase price', async () => {
      const res = await send(manager, 'post', '/products', {
        name: '  Spiral   Notebook ',
        brandId: classmate,
        categoryId: stationery,
        size: ' a4 ',
        pageCount: 140,
        gsm: 70,
        binding: ' Spiral ',
        searchAliases: ['Copy', 'copy', 'Long Book'],
        attributes: { ruling: 'Single line' },
        mrp: '50',
        sellingPrice: '45.5',
        sku: 'CM-SP-140',
        barcode: '8901234567890',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const p = res.body.product;
      expect(p).toMatchObject({
        name: 'Spiral Notebook',
        brand: { name: 'Classmate' },
        category: { name: 'Stationery', isProductUsable: true },
        size: 'A4',
        pageCount: 140,
        binding: 'spiral',
        searchAliases: ['copy', 'long book'],
        mrp: '50.00',
        sellingPrice: '45.50',
        sellingUnit: 'piece',
        packQty: 1,
        isActive: true,
        version: 1,
        spAboveMrpConfirmation: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/purchase/i);
      const doc = (await db.query(`SELECT document FROM product_search WHERE product_id = $1`, [p.id])).rows[0].document as string;
      for (const word of ['classmate', 'spiral notebook', 'stationery', 'a4', '140 pages', '140p', '70gsm', 'copy', 'long book', 'single line', 'cm sp 140', '8901234567890']) {
        expect(doc).toContain(word);
      }
      const audit = await db.query(`SELECT action, after_values FROM financial_audit_events WHERE entity_type = 'product' AND entity_id = $1`, [p.id]);
      expect(audit.rows[0]).toMatchObject({ action: 'create', after_values: { name: 'Spiral Notebook', brand: 'Classmate', sellingPrice: '45.50' } });
    });

    it('rejects invalid input with field-level errors (mirrors the database)', async () => {
      const cases: [object, string][] = [
        [{ name: '' }, 'name'],
        [{ name: 'x'.repeat(161) }, 'name'],
        [{ sellingPrice: '0' }, 'sellingPrice'],
        [{ sellingPrice: '-5' }, 'sellingPrice'],
        [{ sellingPrice: '1.234' }, 'sellingPrice'],
        [{ sellingPrice: 45 }, 'sellingPrice'],
        [{ mrp: '0' }, 'mrp'],
        [{ sku: 'bad sku!' }, 'sku'],
        [{ barcode: '12' }, 'barcode'],
        [{ pageCount: 0 }, 'pageCount'],
        [{ gsm: 5000 }, 'gsm'],
        [{ sellingUnit: 'dozen' }, 'sellingUnit'],
        [{ sellingUnit: 'piece', packQty: 10 }, 'packQty'],
        [{ attributes: { 'Bad Key': 'x' } }, 'attributes'],
        [{ searchAliases: Array.from({ length: 21 }, (_, i) => `a${i}`) }, 'searchAliases'],
      ];
      for (const [body, field] of cases) {
        const res = await send(manager, 'post', '/products', base(body));
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.details.map((d: { path: string }) => d.path).join(','), JSON.stringify(body)).toContain(field);
      }
      expect((await send(manager, 'post', '/products', { name: 'No category', sellingPrice: '10' })).status).toBe(400);
      expect((await send(manager, 'post', '/products', base({ unknown: 1 }))).status).toBe(400);
    });

    it('brand is optional; an archived brand cannot be chosen for a new product', async () => {
      const unbranded = await create({ brandId: null, name: 'Loose Sheet' });
      expect(unbranded.brand).toBeNull();
      const old = (await send(owner, 'post', '/brands', { name: 'Old Brand' })).body.brand;
      await send(owner, 'patch', `/brands/${old.id}`, { isActive: false });
      const res = await send(manager, 'post', '/products', base({ brandId: old.id }));
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('brandId');
    });

    it('a pack records its pack quantity', async () => {
      const p = await create({ name: 'Pencil Box', sellingUnit: 'box', packQty: 10, sellingPrice: '50' });
      expect(p).toMatchObject({ sellingUnit: 'box', packQty: 10 });
    });
  });

  describe('selling price above MRP', () => {
    it('needs explicit confirmation, records who confirmed and when, and asks again when prices change', async () => {
      const refused = await send(manager, 'post', '/products', base({ name: 'Above MRP', mrp: '40', sellingPrice: '45' }));
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'PRICE_CONFIRMATION_REQUIRED', details: [{ path: 'sellingPrice' }] });
      expect(await db.query(`SELECT 1 FROM products WHERE name = 'Above MRP'`).then((r) => r.rowCount)).toBe(0);

      const ok = await send(manager, 'post', '/products', base({ name: 'Above MRP', mrp: '40', sellingPrice: '45', confirmations: ['sp_above_mrp'] }));
      expect(ok.status).toBe(201);
      const p = ok.body.product;
      expect(p.spAboveMrpConfirmation).toMatchObject({ by: { name: 'Manager Asha' } });
      expect(p.mrp).toBe('40.00');
      expect(p.sellingPrice).toBe('45.00');

      // An unrelated edit keeps the confirmation.
      const renamed = await send(manager, 'patch', `/products/${p.id}`, { name: 'Above MRP 2', version: p.version });
      expect(renamed.status).toBe(200);
      expect(renamed.body.product.spAboveMrpConfirmation).not.toBeNull();
      // A price change needs a fresh confirmation.
      const again = await send(manager, 'patch', `/products/${p.id}`, { sellingPrice: '46', version: renamed.body.product.version });
      expect(again.status).toBe(422);
      // Bringing SP to MRP or below clears it.
      const fixed = await send(manager, 'patch', `/products/${p.id}`, { sellingPrice: '40', version: renamed.body.product.version });
      expect(fixed.status).toBe(200);
      expect(fixed.body.product.spAboveMrpConfirmation).toBeNull();
      // The database itself refuses SP > MRP without a recorded confirmation.
      await expect(db.query(`UPDATE products SET selling_price = 99 WHERE id = $1`, [p.id])).rejects.toThrow(/products_sp_above_mrp_confirmed/);
    });
  });

  describe('edit, versions, deactivation', () => {
    it('optimistic locking: a stale version is a 409', async () => {
      const p = await create({ name: 'Versioned' });
      expect((await send(manager, 'patch', `/products/${p.id}`, { name: 'Versioned 2', version: p.version })).status).toBe(200);
      const stale = await send(owner, 'patch', `/products/${p.id}`, { name: 'Versioned 3', version: p.version });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('an unchanged category that is no longer usable may stay; a new one must be usable', async () => {
      const p = await create({ name: 'Category Keeper', categoryId: toys });
      await db.query(`UPDATE expense_categories SET is_product_usable = false WHERE id = $1`, [toys]);
      const renamed = await send(manager, 'patch', `/products/${p.id}`, { name: 'Category Keeper 2', version: p.version });
      expect(renamed.status).toBe(200);
      const moved = await send(manager, 'patch', `/products/${p.id}`, { categoryId: rent, version: renamed.body.product.version });
      expect(moved.status).toBe(400);
      await db.query(`UPDATE expense_categories SET is_product_usable = true WHERE id = $1`, [toys]);
    });

    it('deactivates and reactivates (audited); codes are unique among active products only', async () => {
      const a = await create({ name: 'Coded A', sku: 'DUP-1', barcode: 'BC-0001' });
      const clash = await send(manager, 'post', '/products', base({ name: 'Coded B', sku: 'dup-1' }));
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SKU_TAKEN');
      expect((await send(manager, 'post', '/products', base({ name: 'Coded C', barcode: 'BC-0001' }))).body.error.code).toBe('BARCODE_TAKEN');

      const off = await send(manager, 'patch', `/products/${a.id}`, { isActive: false, version: a.version });
      expect(off.body.product.isActive).toBe(false);
      // The code is free again while A is deactivated...
      const b = await create({ name: 'Coded B', sku: 'DUP-1' });
      // ...so reactivating A conflicts, clearly.
      const back = await send(manager, 'patch', `/products/${a.id}`, { isActive: true, version: off.body.product.version });
      expect(back.status).toBe(409);
      expect(back.body.error.code).toBe('SKU_TAKEN');
      expect(back.body.error.message).toMatch(/cannot be reactivated/);
      await send(manager, 'patch', `/products/${b.id}`, { sku: null, version: b.version });
      const ok = await send(manager, 'patch', `/products/${a.id}`, { isActive: true, version: off.body.product.version });
      expect(ok.status).toBe(200);
      const actions = (await db.query(`SELECT action FROM financial_audit_events WHERE entity_type = 'product' AND entity_id = $1 ORDER BY id`, [a.id])).rows.map((r) => r.action);
      expect(actions).toEqual(['create', 'archive', 'reactivate']);
      // Inactive products are hidden by default.
      const listed = (await get(manager, '/products?q=coded')).body.items.map((x: { name: string }) => x.name);
      expect(listed).toContain('Coded A');
    });

    it('products are never deleted', async () => {
      const p = await create({ name: 'Undeletable' });
      await expect(db.query(`DELETE FROM products WHERE id = $1`, [p.id])).rejects.toThrow(/never deleted/);
    });

    it('idempotent create: same key replays, a different product with the same key is refused', async () => {
      const key = 'product-create-key-0001';
      const first = await send(manager, 'post', '/products', base({ name: 'Idem' }), { 'Idempotency-Key': key });
      expect(first.status).toBe(201);
      const replay = await send(manager, 'post', '/products', base({ name: 'Idem' }), { 'Idempotency-Key': key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.product.id).toBe(first.body.product.id);
      expect((await send(manager, 'post', '/products', base({ name: 'Other' }), { 'Idempotency-Key': key })).status).toBe(409);
      expect((await db.query(`SELECT count(*)::int AS n FROM products WHERE name = 'Idem'`)).rows[0].n).toBe(1);
    });
  });

  describe('search', () => {
    beforeAll(async () => {
      const rows: object[] = [
        { name: 'Register', size: 'A4', pageCount: 140, binding: 'register', mrp: '55', sellingPrice: '50' },
        { name: 'Register', size: 'A4', pageCount: 196, binding: 'register', mrp: '85', sellingPrice: '65' },
        { name: 'Practical Notebook', size: 'A4', pageCount: 100, mrp: '70', sellingPrice: '60' },
        { name: 'Drawing Book', brandId: doms, size: 'A4', pageCount: 36, binding: 'spiral', gsm: 150, sellingPrice: '50' },
        { name: 'Crayons', brandId: doms, categoryId: toys, sellingPrice: '30', barcode: '8901230000001' },
        { name: 'Graph Book', brandId: null, size: 'A4', pageCount: 28, sellingPrice: '25', searchAliases: ['graph copy'] },
      ];
      for (const r of rows) await create(r);
    });

    const names = async (q: string) =>
      ((await get(manager, `/products?q=${encodeURIComponent(q)}&pageSize=100`)).body.items as { name: string; brand: { name: string } | null }[]).map(
        (p) => `${p.brand?.name ?? '-'} ${p.name}`,
      );

    it('matches brand, product type, multiple tokens and structured specs', async () => {
      expect((await names('classmate')).every((n) => n.startsWith('Classmate'))).toBe(true);
      expect(await names('register')).toEqual(expect.arrayContaining(['Classmate Register']));
      expect((await names('classmate register')).every((n) => n === 'Classmate Register')).toBe(true);
      const a4140 = await names('a4 140');
      expect(a4140[0]).toMatch(/Classmate (Register|Spiral Notebook)/);
      expect(a4140).not.toContain('Classmate Practical Notebook');
      expect(await names('doms spiral')).toEqual(['DOMS Drawing Book']);
      expect(await names('graph copy')).toEqual(['- Graph Book']);
      expect(await names('stationery')).toContain('Classmate Register');
    });

    it('exact barcode ranks first; a barcode prefix matches', async () => {
      const res = await get(manager, '/products?q=8901230000001');
      expect(res.body.items[0].name).toBe('Crayons');
      expect(await names('890123')).toContain('DOMS Crayons');
      const lookup = await get(manager, '/products/lookup?code=8901230000001');
      expect(lookup.body.products.map((p: { name: string }) => p.name)).toEqual(['Crayons']);
      expect((await get(manager, '/products/lookup?code=cm-sp-140')).body.products[0].name).toBe('Spiral Notebook');
    });

    it('typo tolerance returns close matches when nothing matches exactly', async () => {
      const res = await get(manager, '/products?q=clasmate%20registr');
      expect(res.body.closeMatches).toBe(true);
      expect(res.body.items.map((p: { name: string }) => p.name)).toContain('Register');
      // A misspelt word plus a short token (the short one must still match literally).
      const mixed = await get(manager, '/products?q=clasmate%20a4');
      expect(mixed.status).toBe(200);
      expect(mixed.body.closeMatches).toBe(true);
      expect(mixed.body.items.every((p: { brand: { name: string }; size: string }) => p.brand.name === 'Classmate' && p.size === 'A4')).toBe(true);
      const quick = await get(manager, '/products/quick-search?q=clasmate');
      expect(quick.body.items.length).toBeGreaterThan(0);
      expect(quick.body.items.every((i: { brand: string; close: boolean }) => i.brand === 'Classmate' && i.close)).toBe(true);
    });

    it('supplier-name-only matches rank below product matches; purchase prices are never searched', async () => {
      const national = await create({ name: 'National Register', brandId: null, sellingPrice: '20' });
      const reg = (await get(manager, '/products?q=register%20a4')).body.items[0];
      await send(owner, 'post', `/products/${reg.id}/suppliers`, { supplierId: supplierB, purchasePrice: '31.37' });
      const ranked = (await get(manager, '/products?q=national')).body.items.map((p: { id: string }) => p.id);
      expect(ranked[0]).toBe(national.id);
      expect(ranked).toContain(reg.id);
      expect((await get(manager, '/products?q=31.37')).body.items).toHaveLength(0);
      expect((await get(manager, '/products?q=3137')).body.items).toHaveLength(0);
    });

    it('filters, sorting, pagination and quick search shape', async () => {
      const byBrand = (await get(manager, `/products?brandId=${doms}`)).body;
      expect(byBrand.items.every((p: { brand: { name: string } }) => p.brand.name === 'DOMS')).toBe(true);
      const none = (await get(manager, '/products?brandId=none')).body.items;
      expect(none.every((p: { brand: unknown }) => p.brand === null)).toBe(true);
      const toysOnly = (await get(manager, `/products?categoryId=${toys}`)).body.items.map((p: { name: string }) => p.name);
      expect(toysOnly).toContain('Crayons');
      const cheap = (await get(manager, '/products?sort=selling_price&dir=asc&pageSize=2')).body;
      expect(cheap.items).toHaveLength(2);
      expect(cheap.pagination.total).toBeGreaterThan(2);
      expect(Number(cheap.items[0].sellingPrice)).toBeLessThanOrEqual(Number(cheap.items[1].sellingPrice));
      const quick = (await get(manager, '/products/quick-search?q=register&limit=1')).body;
      expect(quick.items).toHaveLength(1);
      expect(quick.hasMore).toBe(true);
      expect(Object.keys(quick.items[0]).sort()).toEqual(
        ['barcode', 'binding', 'brand', 'category', 'close', 'gsm', 'id', 'mrp', 'name', 'packQty', 'pageCount', 'sellingPrice', 'sellingUnit', 'size', 'sku'].sort(),
      );
    });

    it('search documents follow brand, category and supplier renames without touching the product', async () => {
      const p = await create({ name: 'Rename Probe', brandId: doms });
      const before = (await db.query(`SELECT updated_at, version FROM products WHERE id = $1`, [p.id])).rows[0];
      await send(owner, 'patch', `/brands/${doms}`, { name: 'DOMS Industries' });
      await send(owner, 'patch', `/categories/${stationery}`, { name: 'Stationery Items' });
      await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: supplierA });
      await db.query(`UPDATE suppliers SET name = 'Sharma Traders Pvt' WHERE id = $1`, [supplierA]);
      const doc = (await db.query(`SELECT document, supplier_document FROM product_search WHERE product_id = $1`, [p.id])).rows[0];
      expect(doc.document).toContain('doms industries');
      expect(doc.document).toContain('stationery items');
      expect(doc.supplier_document).toContain('sharma traders pvt');
      const after = (await db.query(`SELECT updated_at, version FROM products WHERE id = $1`, [p.id])).rows[0];
      expect(after).toEqual(before);
      await send(owner, 'patch', `/brands/${doms}`, { name: 'DOMS' });
      await send(owner, 'patch', `/categories/${stationery}`, { name: 'Stationery' });
      await db.query(`UPDATE suppliers SET name = 'Sharma Traders' WHERE id = $1`, [supplierA]);
    });

    it('the API and the database normalise search text the same way', async () => {
      const samples = ['Classmate  A4-140', 'DOMS_Spiral/150G', 'Café Ünïcode 12.5', '  ---  ', 'Graph (Copy) #3'];
      for (const s of samples) {
        const sql = (await db.query<{ n: string }>(`SELECT product_search_norm($1) AS n`, [s])).rows[0]!.n;
        expect(normaliseSearchText(s), s).toBe(sql);
      }
    });

    it('similar products warn about likely duplicates', async () => {
      const res = await get(manager, `/products/similar?name=register&brandId=${classmate}&size=a4&pageCount=140&binding=register`);
      expect(res.body.similar.length).toBeGreaterThan(0);
      expect(res.body.similar[0]).toMatchObject({ sameSpecs: true, product: { name: 'Register', pageCount: 140 } });
      const other = await get(manager, `/products/similar?name=register&brandId=${doms}`);
      expect(other.body.similar).toHaveLength(0);
    });
  });

  describe('suppliers and purchase prices', () => {
    it('links several suppliers; one preferred; effective price follows the rules; prices never overwritten', async () => {
      const p = await create({ name: 'Cost Probe', sellingPrice: '100', mrp: '120' });
      const suggestions = (await get(owner, `/products/${p.id}/supplier-suggestions`)).body.suppliers.map((s: { name: string }) => s.name);
      expect(suggestions).toEqual(['Sharma Traders']);

      expect((await send(owner, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: '70', version: 0 })).body.costs).toMatchObject({
        defaultPurchasePrice: '70.00',
        effectivePurchasePrice: '70.00',
        source: 'default',
        version: 1,
      });
      await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: supplierA, purchasePrice: '65', isPreferred: true, supplierProductCode: 'SH-1' });
      await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: supplierB, purchasePrice: '60' });
      let costs = (await get(owner, `/products/${p.id}/costs`)).body.costs;
      expect(costs).toMatchObject({ effectivePurchasePrice: '65.00', source: 'preferred_supplier', preferredSupplier: { name: 'Sharma Traders' } });

      // Switching preferred moves only the flag.
      const links = (await get(owner, `/products/${p.id}/suppliers`)).body.suppliers;
      const b = links.find((l: { supplierId: string }) => l.supplierId === supplierB);
      expect((await send(owner, 'patch', `/products/${p.id}/suppliers/${supplierB}`, { isPreferred: true, version: b.version })).status).toBe(200);
      costs = (await get(owner, `/products/${p.id}/costs`)).body.costs;
      expect(costs.effectivePurchasePrice).toBe('60.00');
      expect(costs.suppliers).toEqual([
        expect.objectContaining({ supplierName: 'National Distributors', purchasePrice: '60.00', isPreferred: true }),
        expect.objectContaining({ supplierName: 'Sharma Traders', purchasePrice: '65.00', isPreferred: false }),
      ]);
      expect((await db.query(`SELECT count(*)::int AS n FROM product_suppliers WHERE product_id = $1 AND is_preferred`, [p.id])).rows[0].n).toBe(1);

      // An archived preferred supplier falls back to the default price.
      await db.query(`UPDATE suppliers SET is_active = false WHERE id = $1`, [supplierB]);
      costs = (await get(owner, `/products/${p.id}/costs`)).body.costs;
      expect(costs).toMatchObject({ effectivePurchasePrice: '70.00', source: 'default' });
      await db.query(`UPDATE suppliers SET is_active = true WHERE id = $1`, [supplierB]);

      // Duplicate link and stale versions.
      expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: supplierA })).body.error.code).toBe('SUPPLIER_ALREADY_LINKED');
      expect((await send(owner, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: '71', version: 0 })).status).toBe(409);
      // Warnings: purchase above selling price.
      const warn = (await send(owner, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: '150', version: 1 })).body.costs;
      expect(warn.source).toBe('preferred_supplier');
      // Unlinking needs the version the user saw (optimistic locking, migration 0017 hardening).
      const current = (await get(owner, `/products/${p.id}/suppliers`)).body.suppliers as { supplierId: string; version: number }[];
      for (const link of current) {
        expect((await send(owner, 'delete', `/products/${p.id}/suppliers/${link.supplierId}?version=${link.version}`)).status).toBe(204);
      }
      const lossy = (await get(owner, `/products/${p.id}/costs`)).body.costs;
      expect(lossy.warnings.map((w: { code: string }) => w.code)).toEqual(['PURCHASE_ABOVE_SELLING_PRICE', 'PURCHASE_ABOVE_MRP']);

      // History: the ordinary history never has cost events (they come from the protected
      // /cost-history endpoint); the link events carry no prices.
      const history = (await get(owner, `/products/${p.id}/history`)).body.history;
      expect(history.some((h: { entityType: string }) => h.entityType === 'product_cost')).toBe(false);
      const costHistory = (await get(owner, `/products/${p.id}/cost-history`)).body.history;
      expect(costHistory.length).toBeGreaterThan(0);
      expect(costHistory.every((h: { entityType: string }) => h.entityType === 'product_cost')).toBe(true);
      const linkEvents = history.filter((h: { action: string }) => h.action.includes('supplier'));
      expect(linkEvents.length).toBeGreaterThan(0);
      expect(JSON.stringify(linkEvents)).not.toMatch(/purchasePrice|65\.00|60\.00/);
    });

    it('managers without access may link suppliers but not send prices', async () => {
      const p = await create({ name: 'Manager Link' });
      const ok = await send(manager, 'post', `/products/${p.id}/suppliers`, { supplierId: supplierA, isPreferred: true });
      expect(ok.status).toBe(201);
      expect(ok.body.link).not.toHaveProperty('purchasePrice');
      expect((await send(manager, 'post', `/products/${p.id}/suppliers`, { supplierId: supplierB, purchasePrice: '5' })).status).toBe(403);
      expect((await send(manager, 'patch', `/products/${p.id}/suppliers/${supplierA}`, { purchasePrice: '5', version: ok.body.link.version })).status).toBe(403);
      expect((await send(manager, 'post', '/products', base({ name: 'With cost', defaultPurchasePrice: '5' }))).status).toBe(403);
    });
  });

  it('brands and categories report product counts; live updates include products', async () => {
    const brands = (await get(manager, '/brands')).body.brands;
    expect(brands.find((b: { id: string }) => b.id === classmate).productCount).toBeGreaterThan(0);
    const sync = await get(manager, '/sync/changes?after=0');
    const kinds = new Set(sync.body.events.map((e: { entityType: string }) => e.entityType));
    expect(kinds.has('product')).toBe(true);
    expect(kinds.has('product_cost')).toBe(false);
  });
});
