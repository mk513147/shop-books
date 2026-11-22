/**
 * Purchase-price confidentiality. A sentinel purchase price (987.65, also as a supplier price
 * 876.54) is stored on a product; a manager WITHOUT permission must not be able to obtain it
 * through ANY route: list, search, quick search, lookup, detail, similar, history, supplier links,
 * supplier suggestions, sync, error responses, idempotency replay and import. Protected routes
 * answer 403. Granting and revoking take effect on the next request; the owner always has access.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const SENTINELS = [/987\.65/, /98765/, /876\.54/, /87654/];

describe.skipIf(!pool)('purchase-price security', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let blocked: Session;
  let allowed: Session;
  let blockedId: string;
  let productId: string;
  let categoryId: string;
  let supplierId: string;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch' | 'put' | 'delete', p: string, body: object = {}, headers: Record<string, string> = {}) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, ...headers }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);

  const noSentinel = (label: string, res: request.Response) => {
    const text = JSON.stringify(res.body) + (res.text ?? '');
    for (const s of SENTINELS) expect(text, `${label} leaked a purchase price`).not.toMatch(s);
  };

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    const users = await db.query<{ id: string; email: string }>(
      `INSERT INTO users (email, name, role, password_hash, can_view_purchase_prices) VALUES
         ('owners@example.test', 'Owner', 'owner', $1, false),
         ('blocked@example.test', 'Blocked Manager', 'manager', $1, false),
         ('allowed@example.test', 'Allowed Manager', 'manager', $1, true) RETURNING id, email`,
      [hash],
    );
    const ownerId = users.rows[0]!.id;
    blockedId = users.rows.find((u) => u.email === 'blocked@example.test')!.id;
    categoryId = (
      await db.query<{ id: string }>(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ('Stationery', true, $1, $1) RETURNING id`, [ownerId])
    ).rows[0]!.id;
    const brandId = (await db.query<{ id: string }>(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Classmate', $1, $1) RETURNING id`, [ownerId])).rows[0]!.id;
    supplierId = (await db.query<{ id: string }>(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ('Sharma Traders', $1, $1) RETURNING id`, [ownerId])).rows[0]!.id;
    await db.query(`INSERT INTO supplier_brands (supplier_id, brand_id, created_by) VALUES ($1, $2, $3)`, [supplierId, brandId, ownerId]);
    owner = await signIn('owners@example.test');
    blocked = await signIn('blocked@example.test');
    allowed = await signIn('allowed@example.test');

    const created = await send(
      owner,
      'post',
      '/products',
      { name: 'Register', brandId, categoryId, size: 'A4', pageCount: 140, sellingPrice: '1000', mrp: '1200', defaultPurchasePrice: '987.65', barcode: '8901234500001' },
      { 'Idempotency-Key': 'security-create-key-01' },
    );
    expect(created.status).toBe(201);
    productId = created.body.product.id;
    noSentinel('create response', created);
    expect((await send(owner, 'post', `/products/${productId}/suppliers`, { supplierId, purchasePrice: '876.54', isPreferred: true })).status).toBe(201);
  });

  afterAll(async () => {
    await db.end();
  });

  it('owner and authorised managers can read the prices', async () => {
    for (const s of [owner, allowed]) {
      const costs = await get(s, `/products/${productId}/costs`);
      expect(costs.status).toBe(200);
      expect(costs.body.costs).toMatchObject({ defaultPurchasePrice: '987.65', effectivePurchasePrice: '876.54', source: 'preferred_supplier' });
      const page = await get(s, `/products/purchase-prices?ids=${productId}`);
      expect(page.body.prices[0].effectivePurchasePrice).toBe('876.54');
      expect(costs.body.costs.suppliers[0]).toMatchObject({ supplierName: 'Sharma Traders', purchasePrice: '876.54', isPreferred: true });
      // The ordinary supplier list never carries prices, even for permitted users (browser cache).
      const links = await get(s, `/products/${productId}/suppliers`);
      expect(links.body.suppliers[0]).not.toHaveProperty('purchasePrice');
      noSentinel('supplier list (permitted user)', links);
    }
    expect((await get(owner, '/auth/me')).body.user.canViewPurchasePrices).toBe(true);
    expect((await get(allowed, '/auth/me')).body.user.canViewPurchasePrices).toBe(true);
  });

  it('an unauthorised manager cannot obtain the price through any route', async () => {
    expect((await get(blocked, '/auth/me')).body.user.canViewPurchasePrices).toBe(false);
    const reads: [string, string][] = [
      ['list', '/products'],
      ['list search', '/products?q=register'],
      ['search by price text', '/products?q=987.65'],
      ['search by price digits', '/products?q=98765'],
      ['search by supplier price', '/products?q=876.54'],
      ['quick search', '/products/quick-search?q=register'],
      ['quick search price', '/products/quick-search?q=987'],
      ['lookup', '/products/lookup?code=8901234500001'],
      ['detail', `/products/${productId}`],
      ['similar', '/products/similar?name=register'],
      ['history', `/products/${productId}/history`],
      ['supplier links', `/products/${productId}/suppliers`],
      ['supplier suggestions', `/products/${productId}/supplier-suggestions`],
      ['sync feed', '/sync/changes?after=0'],
      ['brands', '/brands'],
      ['categories', '/categories'],
    ];
    for (const [label, path] of reads) {
      const res = await get(blocked, path);
      expect(res.status, label).toBe(200);
      noSentinel(label, res);
    }
    const links = await get(blocked, `/products/${productId}/suppliers`);
    expect(links.body.suppliers[0]).not.toHaveProperty('purchasePrice');
    const history = await get(blocked, `/products/${productId}/history`);
    expect(history.body.history.every((h: { entityType: string }) => h.entityType === 'product')).toBe(true);
    // Price searches find nothing (prices are never searched).
    expect((await get(blocked, '/products?q=987.65')).body.items).toHaveLength(0);
  });

  it('protected reads and writes answer 403 without revealing anything', async () => {
    const forbidden: [string, () => request.Test][] = [
      ['costs', () => get(blocked, `/products/${productId}/costs`)],
      ['reveal', () => get(blocked, `/products/purchase-prices?ids=${productId}`)],
      ['set cost', () => send(blocked, 'put', `/products/${productId}/costs`, { defaultPurchasePrice: '1', version: 1 })],
      ['create with cost', () => send(blocked, 'post', '/products', { name: 'X', categoryId, sellingPrice: '5', defaultPurchasePrice: '1' })],
      ['link with price', () => send(blocked, 'post', `/products/${productId}/suppliers`, { supplierId, purchasePrice: '1' })],
      ['update link price', () => send(blocked, 'patch', `/products/${productId}/suppliers/${supplierId}`, { purchasePrice: '1', version: 1 })],
      ['cost history', () => get(blocked, `/products/${productId}/cost-history`)],
    ];
    // Reads answer PURCHASE_PRICE_FORBIDDEN; writes answer it or PURCHASE_PRICE_CHANGE_FORBIDDEN
    // (seeing and changing prices are separate permissions). Import is postponed (503, tested in
    // productImports.postponed.integration.test.ts).
    for (const [label, req] of forbidden) {
      const res = await req();
      expect(res.status, label).toBe(403);
      expect(['PURCHASE_PRICE_FORBIDDEN', 'PURCHASE_PRICE_CHANGE_FORBIDDEN'], label).toContain(res.body.error.code);
      noSentinel(label, res);
    }
    // The stored price was not changed by any of those.
    expect((await get(owner, `/products/${productId}/costs`)).body.costs.defaultPurchasePrice).toBe('987.65');
  });

  it('error responses carry no prices (validation, conflicts, confirmation)', async () => {
    const product = (await get(blocked, `/products/${productId}`)).body.product;
    const errors = [
      await send(blocked, 'patch', `/products/${productId}`, { sellingPrice: '0', version: product.version }),
      await send(blocked, 'patch', `/products/${productId}`, { name: 'Stale', version: product.version + 5 }),
      await send(blocked, 'patch', `/products/${productId}`, { mrp: '900', version: product.version }),
      await send(blocked, 'post', `/products/${productId}/suppliers`, { supplierId }),
    ];
    expect(errors.map((e) => e.status)).toEqual([400, 409, 422, 409]);
    errors.forEach((e, i) => noSentinel(`error ${i}`, e));
    // Selling far below the purchase price produces no cost warning for this manager.
    const cheaper = await send(blocked, 'patch', `/products/${productId}`, { sellingPrice: '10', version: product.version });
    expect(cheaper.status).toBe(200);
    noSentinel('below-cost edit', cheaper);
    expect(JSON.stringify(cheaper.body)).not.toMatch(/warning|loss|PURCHASE/i);
  });

  it('an idempotent replay never contains the price; nor do the stored records it uses', async () => {
    const replay = await send(
      owner,
      'post',
      '/products',
      {
        name: 'Register',
        brandId: (await get(owner, `/products/${productId}`)).body.product.brand.id,
        categoryId,
        size: 'A4',
        pageCount: 140,
        sellingPrice: '1000',
        mrp: '1200',
        defaultPurchasePrice: '987.65',
        barcode: '8901234500001',
      },
      { 'Idempotency-Key': 'security-create-key-01' },
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    noSentinel('replay', replay);
    const stored = await db.query(`SELECT response_body::text AS body FROM idempotency_keys`);
    for (const row of stored.rows) for (const s of SENTINELS) expect(row.body).not.toMatch(s);
    // Product audit snapshots never hold purchase prices (those are product_cost events).
    const productAudit = await db.query(`SELECT after_values::text AS a, before_values::text AS b FROM financial_audit_events WHERE entity_type = 'product'`);
    for (const row of productAudit.rows) for (const s of SENTINELS) expect(`${row.a}${row.b}`).not.toMatch(s);
    // Search documents never hold them.
    const docs = await db.query(`SELECT document || ' ' || supplier_document AS d FROM product_search`);
    for (const row of docs.rows) for (const s of SENTINELS) expect(row.d).not.toMatch(s);
  });

  it('granting and revoking takes effect on the next request (no new sign-in)', async () => {
    expect((await get(blocked, `/products/${productId}/costs`)).status).toBe(403);
    const grant = await send(owner, 'patch', `/users/${blockedId}`, { canViewPurchasePrices: true });
    expect(grant.status).toBe(200);
    expect(grant.body.user.canViewPurchasePrices).toBe(true);
    expect((await get(blocked, `/products/${productId}/costs`)).status).toBe(200);
    expect((await get(blocked, '/auth/me')).body.user.canViewPurchasePrices).toBe(true);
    await send(owner, 'patch', `/users/${blockedId}`, { canViewPurchasePrices: false });
    expect((await get(blocked, `/products/${productId}/costs`)).status).toBe(403);
    const events = await db.query(`SELECT details FROM auth_events WHERE event_type = 'user_updated' AND user_id = $1 ORDER BY id`, [blockedId]);
    expect(events.rows.map((r) => r.details.canViewPurchasePrices)).toEqual([true, false]);
    // Managers cannot grant themselves; the owner's access cannot be switched.
    expect((await send(allowed, 'patch', `/users/${blockedId}`, { canViewPurchasePrices: true })).status).toBe(403);
    const ownerRow = (await get(owner, '/users')).body.users.find((u: { role: string }) => u.role === 'owner');
    expect((await send(owner, 'patch', `/users/${ownerRow.id}`, { canViewPurchasePrices: false })).body.error.code).toBe('OWNER_ALWAYS_HAS_ACCESS');
  });

  it('every reveal is logged as an access trail (owner included; no prices recorded)', async () => {
    await db.query(`DELETE FROM auth_events WHERE event_type = 'purchase_prices_viewed'`);
    await get(allowed, `/products/purchase-prices?ids=${productId}&scope=page`);
    await get(owner, `/products/purchase-prices?ids=${productId}`);
    const rows = await db.query(`SELECT user_id, details FROM auth_events WHERE event_type = 'purchase_prices_viewed' ORDER BY id`);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(row.details).toEqual({ scope: 'page', productCount: 1, productIds: [productId] });
  });
});
