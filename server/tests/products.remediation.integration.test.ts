/**
 * Product catalogue audit remediation (migration 0017 and the service/route fixes):
 *
 *  - SEE and CHANGE purchase prices are separate permissions; supplier-link writes that would
 *    delete a stored price or move the effective price need CHANGE (no indirect bypass);
 *  - unlinking a supplier is optimistic (version) and concurrent link changes conflict cleanly;
 *  - an archived supplier cannot become preferred;
 *  - every purchase-price read is logged (who, what, when; never the amount); refused reads are not;
 *  - a reused Idempotency-Key with a different purchase price is refused;
 *  - barcodes are unique and looked up ignoring letter case;
 *  - search documents stay correct when a product edit races a brand / category rename, and
 *    concurrent refreshes do not deadlock (advisory lock + fresh snapshot).
 *
 * Sentinel purchase prices 543.21 / 432.10 must never reach anyone without the SEE permission.
 */
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const SENTINELS = [/543\.21/, /54321/, /432\.10/, /43210/];

describe.skipIf(!pool)('product catalogue remediation', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let blocked: Session; // no permission at all
  let viewer: Session; // may SEE, not CHANGE
  let editor: Session; // may SEE and CHANGE
  let ownerId: string;
  let blockedId: string;
  let editorId: string;
  let categoryId: string;
  let categoryB: string;
  let brandId: string;
  const suppliers: Record<string, string> = {};
  let seq = 0;

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
  async function product(fields: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
    seq += 1;
    const res = await send(owner, 'post', '/products', { name: `Remediation ${seq}`, categoryId, sellingPrice: '100', ...fields });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.product;
  }
  async function links(productId: string): Promise<Record<string, { version: number; isPreferred: boolean }>> {
    const list = (await get(owner, `/products/${productId}/suppliers`)).body.suppliers as { supplierId: string; version: number; isPreferred: boolean }[];
    return Object.fromEntries(list.map((l) => [l.supplierId, l]));
  }
  const storedPrices = async (productId: string) =>
    (await db.query(`SELECT supplier_id, purchase_price FROM product_suppliers WHERE product_id = $1 ORDER BY supplier_id`, [productId])).rows;

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    const users = await db.query<{ id: string; email: string }>(
      `INSERT INTO users (email, name, role, password_hash, can_view_purchase_prices, can_edit_purchase_prices) VALUES
         ('owner@fix.test', 'Owner', 'owner', $1, false, false),
         ('blocked@fix.test', 'Blocked', 'manager', $1, false, false),
         ('viewer@fix.test', 'Viewer', 'manager', $1, true, false),
         ('editor@fix.test', 'Editor', 'manager', $1, true, true) RETURNING id, email`,
      [hash],
    );
    const id = (email: string) => users.rows.find((u) => u.email === email)!.id;
    ownerId = id('owner@fix.test');
    blockedId = id('blocked@fix.test');
    editorId = id('editor@fix.test');
    const cat = async (name: string) =>
      (await db.query<{ id: string }>(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ($1, true, $2, $2) RETURNING id`, [name, ownerId])).rows[0]!.id;
    categoryId = await cat('Remediation Stationery');
    categoryB = await cat('Remediation Registers');
    brandId = (await db.query<{ id: string }>(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Navneet', $1, $1) RETURNING id`, [ownerId])).rows[0]!.id;
    for (const name of ['Priced One', 'Plain Two', 'Plain Three', 'Fourth Supplier', 'Archived Five']) {
      suppliers[name] = (await db.query<{ id: string }>(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [name, ownerId])).rows[0]!.id;
    }
    owner = await signIn('owner@fix.test');
    blocked = await signIn('blocked@fix.test');
    viewer = await signIn('viewer@fix.test');
    editor = await signIn('editor@fix.test');
  });

  afterAll(async () => {
    await db.end();
  });

  describe('purchase prices cannot be changed indirectly through supplier links', () => {
    // P: "Priced One" holds 543.21 and is preferred; "Plain Two" / "Plain Three" hold no price.
    async function setup() {
      const p = await product({ defaultPurchasePrice: '432.10' });
      expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: suppliers['Priced One'], purchasePrice: '543.21', isPreferred: true })).status).toBe(201);
      for (const name of ['Plain Two', 'Plain Three']) {
        expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: suppliers[name] })).status).toBe(201);
      }
      return p;
    }

    for (const who of ['blocked', 'viewer'] as const) {
      it(`a manager without the CHANGE permission (${who}) cannot delete or redirect a stored price`, async () => {
        const actor = who === 'blocked' ? blocked : viewer;
        const p = await setup();
        const before = await storedPrices(p.id);
        let l = await links(p.id);
        const priced = suppliers['Priced One']!;
        const refused = [
          await send(actor, 'delete', `/products/${p.id}/suppliers/${priced}?version=${l[priced]!.version}`),
          await send(actor, 'patch', `/products/${p.id}/suppliers/${suppliers['Plain Two']}`, { isPreferred: true, version: l[suppliers['Plain Two']!]!.version }),
          await send(actor, 'patch', `/products/${p.id}/suppliers/${priced}`, { isPreferred: false, version: l[priced]!.version }),
          await send(actor, 'post', `/products/${p.id}/suppliers`, { supplierId: suppliers['Fourth Supplier'], isPreferred: true }),
          await send(actor, 'patch', `/products/${p.id}/suppliers/${priced}`, { purchasePrice: null, version: l[priced]!.version }),
          await send(actor, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: null, version: 1 }),
        ];
        for (const [i, res] of refused.entries()) {
          expect(res.status, `refusal ${i}: ${JSON.stringify(res.body)}`).toBe(403);
          expect(['PURCHASE_PRICE_CHANGE_FORBIDDEN', 'PURCHASE_PRICE_FORBIDDEN'], `refusal ${i}`).toContain(res.body.error.code);
          noSentinel(`refusal ${i}`, res);
        }
        // Nothing changed: same stored prices, same preferred link, no extra link.
        expect(await storedPrices(p.id)).toEqual(before);
        l = await links(p.id);
        expect(l[priced]!.isPreferred).toBe(true);
        expect(Object.keys(l)).toHaveLength(3);
        expect((await db.query(`SELECT default_purchase_price FROM product_costs WHERE product_id = $1`, [p.id])).rows[0].default_purchase_price).toBe('432.10');

        // Operations that touch no price stay allowed.
        const plainThree = suppliers['Plain Three']!;
        expect((await send(actor, 'patch', `/products/${p.id}/suppliers/${suppliers['Plain Two']}`, { notes: 'Ask for Ramesh', version: l[suppliers['Plain Two']!]!.version })).status).toBe(200);
        expect((await send(actor, 'delete', `/products/${p.id}/suppliers/${plainThree}?version=${l[plainThree]!.version}`)).status).toBe(204);
        // Once no priced link is involved, moving "preferred" between price-less links is allowed.
        await send(owner, 'patch', `/products/${p.id}/suppliers/${priced}`, { isPreferred: false, version: l[priced]!.version });
        l = await links(p.id);
        expect((await send(actor, 'patch', `/products/${p.id}/suppliers/${suppliers['Plain Two']}`, { isPreferred: true, version: l[suppliers['Plain Two']!]!.version })).status).toBe(200);
      });
    }

    it('a manager with the CHANGE permission, and the owner, can make those changes', async () => {
      for (const actor of [editor, owner]) {
        const p = await setup();
        let l = await links(p.id);
        const priced = suppliers['Priced One']!;
        const move = await send(actor, 'patch', `/products/${p.id}/suppliers/${suppliers['Plain Two']}`, { isPreferred: true, version: l[suppliers['Plain Two']!]!.version });
        expect(move.status).toBe(200);
        expect(move.body.link).not.toHaveProperty('purchasePrice');
        l = await links(p.id);
        expect((await send(actor, 'delete', `/products/${p.id}/suppliers/${priced}?version=${l[priced]!.version}`)).status).toBe(204);
        expect((await storedPrices(p.id)).map((r) => r.purchase_price)).toEqual([null, null]);
        // The deleted price is audited as a product_cost change.
        const costEvents = (await get(actor, `/products/${p.id}/cost-history`)).body.history;
        expect(costEvents.some((e: { after: { purchasePrice?: unknown } }) => e.after?.purchasePrice === null)).toBe(true);
      }
    });
  });

  describe('permission management (owner only)', () => {
    it('CHANGE needs SEE; turning SEE off turns CHANGE off; the owner cannot be switched; revocation applies next request', async () => {
      const p = await product({ defaultPurchasePrice: '432.10' });
      const edit = (body: object) => send(owner, 'patch', `/users/${blockedId}`, body);
      expect((await edit({ canEditPurchasePrices: true })).body.error.code).toBe('EDIT_NEEDS_VIEW');
      const both = await edit({ canViewPurchasePrices: true, canEditPurchasePrices: true });
      expect(both.body.user).toMatchObject({ canViewPurchasePrices: true, canEditPurchasePrices: true });
      expect((await get(blocked, '/auth/me')).body.user).toMatchObject({ canViewPurchasePrices: true, canEditPurchasePrices: true });
      expect((await send(blocked, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: '432.11', version: 1 })).status).toBe(200);

      // Revoking CHANGE only: still sees, can no longer change (next request, same session).
      await edit({ canEditPurchasePrices: false });
      expect((await get(blocked, `/products/${p.id}/costs`)).status).toBe(200);
      const refused = await send(blocked, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: '1', version: 2 });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('PURCHASE_PRICE_CHANGE_FORBIDDEN');

      // SEE off clears CHANGE as well.
      await edit({ canEditPurchasePrices: true });
      const off = await edit({ canViewPurchasePrices: false });
      expect(off.body.user).toMatchObject({ canViewPurchasePrices: false, canEditPurchasePrices: false });
      expect((await db.query(`SELECT can_view_purchase_prices v, can_edit_purchase_prices e FROM users WHERE id = $1`, [blockedId])).rows[0]).toEqual({ v: false, e: false });
      expect((await get(blocked, `/products/${p.id}/costs`)).status).toBe(403);
      // The database refuses CHANGE without SEE as well.
      await expect(db.query(`UPDATE users SET can_edit_purchase_prices = true WHERE id = $1`, [blockedId])).rejects.toThrow(/users_edit_prices_needs_view/);

      expect((await send(owner, 'patch', `/users/${ownerId}`, { canEditPurchasePrices: false })).body.error.code).toBe('OWNER_ALWAYS_HAS_ACCESS');
      expect((await send(editor, 'patch', `/users/${editorId}`, { canEditPurchasePrices: true })).status).toBe(403);
      const events = await db.query(`SELECT details FROM auth_events WHERE event_type = 'user_updated' AND user_id = $1 ORDER BY id`, [blockedId]);
      expect(events.rows.at(-1).details).toEqual({ canViewPurchasePrices: false, canEditPurchasePrices: false });
    });
  });

  describe('supplier links: optimistic locking and archived suppliers', () => {
    it('unlinking needs the current version; stale or missing versions are refused', async () => {
      const p = await product();
      const s = suppliers['Plain Two']!;
      await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s });
      const v = (await links(p.id))[s]!.version;
      expect((await send(owner, 'delete', `/products/${p.id}/suppliers/${s}`)).status).toBe(400);
      await send(owner, 'patch', `/products/${p.id}/suppliers/${s}`, { notes: 'changed elsewhere', version: v });
      const stale = await send(owner, 'delete', `/products/${p.id}/suppliers/${s}?version=${v}`);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(Object.keys(await links(p.id))).toEqual([s]);
      // The audit trail has the edit and no unlink.
      const actions = (await get(owner, `/products/${p.id}/history`)).body.history.map((h: { action: string }) => h.action);
      expect(actions).not.toContain('unlink_supplier');
    });

    it('two concurrent changes with the same version: exactly one wins, the other gets 409', async () => {
      for (const second of ['delete', 'patch'] as const) {
        const p = await product();
        const s = suppliers['Plain Three']!;
        await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s });
        const v = (await links(p.id))[s]!.version;
        const results = await Promise.all([
          (async () => await send(owner, 'delete', `/products/${p.id}/suppliers/${s}?version=${v}`))(),
          (async () =>
            second === 'delete'
              ? await send(editor, 'delete', `/products/${p.id}/suppliers/${s}?version=${v}`)
              : await send(editor, 'patch', `/products/${p.id}/suppliers/${s}`, { notes: 'racing', version: v }))(),
        ]);
        const statuses = results.map((r) => r.status);
        const detail = `${second}: ${JSON.stringify(results.map((r) => r.body))}`;
        expect(statuses.filter((x) => x === 409), detail).toHaveLength(1);
        expect(results.find((r) => r.status === 409)!.body.error.code).toBe('VERSION_CONFLICT');
        expect(statuses.filter((x) => x === 200 || x === 204)).toHaveLength(1);
      }
    });

    it('an archived supplier cannot become preferred through a link update', async () => {
      const p = await product();
      const s = suppliers['Archived Five']!;
      await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s });
      await db.query(`UPDATE suppliers SET is_active = false WHERE id = $1`, [s]);
      try {
        let v = (await links(p.id))[s]!.version;
        const refused = await send(owner, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: true, version: v });
        expect(refused.status).toBe(400);
        expect(refused.body.error.details[0].path).toBe('isPreferred');
        expect((await links(p.id))[s]!.isPreferred).toBe(false);
        // Other details of that link can still be corrected.
        const notes = await send(owner, 'patch', `/products/${p.id}/suppliers/${s}`, { notes: 'old supplier', version: v });
        expect(notes.status).toBe(200);
        v = notes.body.link.version;
        expect(v).toBeGreaterThan(1);
      } finally {
        await db.query(`UPDATE suppliers SET is_active = true WHERE id = $1`, [s]);
      }
    });
  });

  describe('access trail of purchase-price reads', () => {
    it('logs every read (owner included) with user, screen and product — never the amount; refused reads are not logged', async () => {
      const p = await product({ defaultPurchasePrice: '543.21' });
      await db.query(`DELETE FROM auth_events WHERE event_type = 'purchase_prices_viewed'`);
      const ok = [
        await get(editor, `/products/${p.id}/costs?scope=form`),
        await get(viewer, `/products/${p.id}/costs`),
        await get(editor, `/products/${p.id}/cost-history`),
        await send(editor, 'put', `/products/${p.id}/costs`, { defaultPurchasePrice: '543.22', version: 1 }),
        await get(owner, `/products/purchase-prices?ids=${p.id}&scope=product`),
      ];
      expect(ok.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const refused = [await get(blocked, `/products/${p.id}/costs`), await get(blocked, `/products/${p.id}/cost-history`), await get(blocked, `/products/purchase-prices?ids=${p.id}`)];
      expect(refused.map((r) => r.status)).toEqual([403, 403, 403]);

      const rows = (
        await db.query<{ user_id: string; created_at: Date; details: Record<string, unknown> }>(
          `SELECT user_id, created_at, details FROM auth_events WHERE event_type = 'purchase_prices_viewed' ORDER BY id`,
        )
      ).rows;
      expect(rows.map((r) => r.details.scope)).toEqual(['form', 'product', 'history', 'after_change', 'product']);
      expect(rows.map((r) => r.user_id)).toEqual([editorId, expect.any(String), editorId, editorId, ownerId]);
      expect(rows.every((r) => r.created_at instanceof Date)).toBe(true);
      for (const r of rows) {
        expect(r.details).toMatchObject({ productCount: 1, productIds: [p.id] });
        expect(JSON.stringify(r.details)).not.toMatch(/543|purchasePrice|price/i);
      }
      expect(rows.some((r) => r.user_id === blockedId)).toBe(false);
      // The ordinary history (everyone) never carries cost events.
      const history = await get(blocked, `/products/${p.id}/history`);
      expect(history.body.history.some((h: { entityType: string }) => h.entityType === 'product_cost')).toBe(false);
      noSentinel('history', history);
    });
  });

  describe('idempotency', () => {
    it('a reused key with a different purchase price is refused; the stored record holds no price', async () => {
      const body = { name: 'Idem Register', categoryId, sellingPrice: '100', defaultPurchasePrice: '543.21' };
      const key = { 'Idempotency-Key': 'remediation-idem-key-0001' };
      expect((await send(owner, 'post', '/products', body, key)).status).toBe(201);
      const replay = await send(owner, 'post', '/products', body, key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const conflict = await send(owner, 'post', '/products', { ...body, defaultPurchasePrice: '432.10' }, key);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      noSentinel('conflict', conflict);
      const withoutPrice = await send(owner, 'post', '/products', { ...body, defaultPurchasePrice: undefined }, key);
      expect(withoutPrice.status).toBe(409);
      expect((await db.query(`SELECT count(*)::int n FROM products WHERE name = 'Idem Register'`)).rows[0].n).toBe(1);
      const stored = (await db.query(`SELECT response_body::text AS b, encode(request_hash, 'hex') AS h FROM idempotency_keys WHERE key = 'remediation-idem-key-0001'`)).rows[0];
      for (const s of SENTINELS) expect(stored.b).not.toMatch(s);
      expect(stored.h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('barcodes', () => {
    it('are unique among active products ignoring letter case, kept as typed, and found in any case', async () => {
      const first = await product({ barcode: 'Ab12-Cd34' });
      const clash = await send(owner, 'post', '/products', { name: 'Clash', categoryId, sellingPrice: '5', barcode: 'AB12-CD34' });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('BARCODE_TAKEN');
      const found = (await get(blocked, '/products/lookup?code=ab12-cd34')).body.products;
      expect(found.map((x: { id: string; barcode: string }) => [x.id, x.barcode])).toEqual([[first.id, 'Ab12-Cd34']]);
      // Deactivated products free the barcode; reactivating then clashes clearly.
      expect((await send(owner, 'patch', `/products/${first.id}`, { isActive: false, version: first.version })).status).toBe(200);
      expect((await send(owner, 'post', '/products', { name: 'Clash', categoryId, sellingPrice: '5', barcode: 'AB12-CD34' })).status).toBe(201);
      const reactivate = await send(owner, 'patch', `/products/${first.id}`, { isActive: true, version: first.version + 1 });
      expect(reactivate.status).toBe(409);
      expect(reactivate.body.error.code).toBe('BARCODE_TAKEN');
    });
  });

  describe('search documents under concurrent changes', () => {
    const doc = async (id: string) => (await db.query<{ document: string }>(`SELECT document FROM product_search WHERE product_id = $1`, [id])).rows[0]!.document;
    const state = async (id: string) => (await db.query(`SELECT version, updated_at FROM products WHERE id = $1`, [id])).rows[0];

    async function race(first: (c: pg.PoolClient) => Promise<unknown>, second: (c: pg.PoolClient) => Promise<unknown>) {
      const a = await db.connect();
      const b = await db.connect();
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        await first(a);
        // The second writer must wait for the first (search refresh lock), not use a stale snapshot.
        const pending = second(b);
        await new Promise((r) => setTimeout(r, 150));
        const waiting = (await db.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n;
        await a.query('COMMIT');
        await pending;
        await b.query('COMMIT');
        return waiting;
      } catch (err) {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        a.release();
        b.release();
      }
    }

    it('brand rename first, product edit second: the document has both changes', async () => {
      const p = await product({ brandId });
      const waiting = await race(
        (c) => c.query(`UPDATE brands SET name = 'Navneet Youva' WHERE id = $1`, [brandId]),
        (c) => c.query(`UPDATE products SET name = 'Long Book Alpha' WHERE id = $1`, [p.id]),
      );
      expect(waiting).toBe(1);
      expect(await doc(p.id)).toMatch(/navneet youva long book alpha/);
    });

    it('product edit first, brand rename second: the document has both changes; the rename does not touch the product', async () => {
      const p = await product({ brandId });
      const before = await state(p.id);
      const waiting = await race(
        (c) => c.query(`UPDATE products SET name = 'Long Book Beta' WHERE id = $1`, [p.id]),
        (c) => c.query(`UPDATE brands SET name = 'Navneet Gala' WHERE id = $1`, [brandId]),
      );
      expect(waiting).toBe(1);
      expect(await doc(p.id)).toMatch(/navneet gala long book beta/);
      // The product's own edit bumped updated_at (raw UPDATE: version unchanged); the rename changed nothing on the row.
      const after = await state(p.id);
      expect(after.version).toBe(before.version);
    });

    it('brand and category renamed at the same time over the same products: no deadlock, both reflected', async () => {
      const ids = [(await product({ brandId, categoryId: categoryB })).id, (await product({ brandId, categoryId: categoryB })).id];
      const versions = await Promise.all(ids.map(state));
      await race(
        (c) => c.query(`UPDATE brands SET name = 'Navneet Final' WHERE id = $1`, [brandId]),
        (c) => c.query(`UPDATE expense_categories SET name = 'Long Registers' WHERE id = $1`, [categoryB]),
      );
      for (const id of ids) expect(await doc(id)).toMatch(/^navneet final .* long registers/);
      // Renames never bump product versions or timestamps, and write no product history.
      expect(await Promise.all(ids.map(state))).toEqual(versions);
    });

    it('a product moved to a brand while that brand is renamed is not missed', async () => {
      const otherBrand = (await db.query<{ id: string }>(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Camlin', $1, $1) RETURNING id`, [ownerId])).rows[0]!.id;
      const p = await product({ brandId: otherBrand });
      await race(
        (c) => c.query(`UPDATE products SET brand_id = $2 WHERE id = $1`, [p.id, brandId]),
        (c) => c.query(`UPDATE brands SET name = 'Navneet Moved' WHERE id = $1`, [brandId]),
      );
      expect(await doc(p.id)).toMatch(/^navneet moved /);
    });
  });
});
