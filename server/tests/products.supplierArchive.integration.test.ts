/**
 * Release-blocker F1: archiving / reactivating a supplier must not silently change a product's
 * effective purchase price.
 *
 * Rule: a supplier that is the PREFERRED supplier of any product (active or inactive) cannot be
 * archived or reactivated. The user first chooses another preferred supplier (or none) on those
 * products, which is an explicit supplier-link change under the purchase-price CHANGE rules. The
 * rule is the same for the owner and every manager; the refusal names products, never a price.
 *
 * Concurrency: the archive holds the supplier row FOR UPDATE while it checks; every path that makes
 * a link preferred takes the supplier row FOR SHARE and re-checks it is active. Both orders are
 * exercised below with a real second transaction.
 *
 * Sentinel purchase price 654.32 must never appear in any refusal.
 */
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const SENTINELS = [/654\.32/, /65432/];

describe.skipIf(!pool)('supplier archiving and preferred suppliers (F1)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let blocked: Session;
  let viewer: Session;
  let editor: Session;
  let ownerId: string;
  let categoryId: string;
  let seq = 0;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'patch' | 'put' | 'delete', p: string, body: object = {}) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const get = (s: Session, p: string) => s.agent.get(`/api/v1${p}`);
  const noSentinel = (label: string, res: request.Response) => {
    const text = JSON.stringify(res.body) + (res.text ?? '');
    for (const s of SENTINELS) expect(text, `${label} leaked a purchase price`).not.toMatch(s);
  };

  async function supplier(): Promise<string> {
    seq += 1;
    const res = await send(owner, 'post', '/suppliers', { name: `Archive Test Supplier ${seq}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.supplier.id;
  }
  async function product(defaultPurchasePrice?: string): Promise<{ id: string; name: string; version: number }> {
    seq += 1;
    const res = await send(owner, 'post', '/products', {
      name: `Archive Test Product ${seq}`,
      categoryId,
      sellingPrice: '900',
      ...(defaultPurchasePrice ? { defaultPurchasePrice } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.product;
  }
  const supplierVersion = async (id: string) => (await get(owner, `/suppliers/${id}`)).body.supplier.version as number;
  const supplierActive = async (id: string) => (await db.query<{ is_active: boolean }>(`SELECT is_active FROM suppliers WHERE id = $1`, [id])).rows[0]!.is_active;
  const linkOf = async (productId: string, supplierId: string) =>
    ((await get(owner, `/products/${productId}/suppliers`)).body.suppliers as { supplierId: string; version: number; isPreferred: boolean }[]).find(
      (l) => l.supplierId === supplierId,
    )!;
  const effective = async (productId: string) => (await get(owner, `/products/${productId}/costs`)).body.costs.effectivePurchasePrice as string | null;
  const archive = (s: Session, id: string, version: number, isActive = false) => send(s, 'patch', `/suppliers/${id}`, { isActive, version });

  /** A product whose PREFERRED supplier holds the sentinel price (default 100.00). */
  async function pricedPreferred() {
    const s = await supplier();
    const p = await product('100.00');
    expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s, purchasePrice: '654.32', isPreferred: true })).status).toBe(201);
    return { s, p };
  }

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    const users = await db.query<{ id: string; email: string }>(
      `INSERT INTO users (email, name, role, password_hash, can_view_purchase_prices, can_edit_purchase_prices) VALUES
         ('owner@archive.test', 'Owner', 'owner', $1, false, false),
         ('blocked@archive.test', 'Blocked', 'manager', $1, false, false),
         ('viewer@archive.test', 'Viewer', 'manager', $1, true, false),
         ('editor@archive.test', 'Editor', 'manager', $1, true, true) RETURNING id, email`,
      [hash],
    );
    ownerId = users.rows.find((u) => u.email === 'owner@archive.test')!.id;
    categoryId = (
      await db.query<{ id: string }>(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ('Archive Test Stationery', true, $1, $1) RETURNING id`, [ownerId])
    ).rows[0]!.id;
    owner = await signIn('owner@archive.test');
    blocked = await signIn('blocked@archive.test');
    viewer = await signIn('viewer@archive.test');
    editor = await signIn('editor@archive.test');
  });

  afterAll(async () => {
    await db.end();
  });

  it('nobody (owner included) can archive the preferred supplier of a product; the refusal names the product, never a price', async () => {
    const { s, p } = await pricedPreferred();
    for (const [who, actor] of [['owner', owner], ['editor', editor], ['viewer', viewer], ['blocked', blocked]] as const) {
      const res = await archive(actor, s, await supplierVersion(s));
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body.error.code).toBe('SUPPLIER_IS_PREFERRED');
      expect(res.body.error.message).toContain(p.name);
      noSentinel(who, res);
    }
    expect(await supplierActive(s)).toBe(true);
    expect(await effective(p.id)).toBe('654.32');
  });

  it('the same applies when the product is inactive (it could be reactivated later)', async () => {
    const { s, p } = await pricedPreferred();
    expect((await send(owner, 'patch', `/products/${p.id}`, { isActive: false, version: p.version })).status).toBe(200);
    const res = await archive(owner, s, await supplierVersion(s));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUPPLIER_IS_PREFERRED');
    expect(await supplierActive(s)).toBe(true);
  });

  it('other edits of a preferred supplier (name, phone) are not blocked', async () => {
    const { s } = await pricedPreferred();
    const res = await send(viewer, 'patch', `/suppliers/${s}`, { phone: '9876543210', version: await supplierVersion(s) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('explicit resolution: someone allowed to change prices moves "preferred" away, then archiving works and the effective price changes only through that explicit step', async () => {
    const { s, p } = await pricedPreferred();
    const link = await linkOf(p.id, s);
    // A manager who may only SEE prices cannot take "preferred" off a priced link, so cannot resolve it.
    const viewerTry = await send(viewer, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: false, version: link.version });
    expect(viewerTry.status).toBe(403);
    expect(viewerTry.body.error.code).toBe('PURCHASE_PRICE_CHANGE_FORBIDDEN');
    noSentinel('viewer resolution', viewerTry);
    expect((await archive(viewer, s, await supplierVersion(s))).status).toBe(409);

    const resolved = await send(editor, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: false, version: link.version });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(await effective(p.id)).toBe('100.00');
    // The audited, explicit step is the one that moved the price source.
    const history = (await get(owner, `/products/${p.id}/history`)).body.history as { action: string }[];
    expect(history.some((h) => h.action === 'update_supplier_link')).toBe(true);

    const archived = await archive(viewer, s, await supplierVersion(s));
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(await supplierActive(s)).toBe(false);
    expect(await effective(p.id)).toBe('100.00');
  });

  it('a preferred link WITHOUT a price can be resolved by any manager, then the supplier archived', async () => {
    const s = await supplier();
    const p = await product('100.00');
    expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s, isPreferred: true })).status).toBe(201);
    expect((await archive(blocked, s, await supplierVersion(s))).status).toBe(409);
    const link = await linkOf(p.id, s);
    expect((await send(blocked, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: false, version: link.version })).status).toBe(200);
    expect((await archive(blocked, s, await supplierVersion(s))).status).toBe(200);
  });

  it('reactivation cannot silently switch a price: a supplier still marked preferred (data from before this rule) must be resolved first', async () => {
    const { s, p } = await pricedPreferred();
    // Simulate a supplier archived while preferred before this rule existed.
    await db.query(`UPDATE suppliers SET is_active = false WHERE id = $1`, [s]);
    expect(await effective(p.id)).toBe('100.00');
    const refused = await archive(owner, s, await supplierVersion(s), true);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SUPPLIER_IS_PREFERRED');
    expect(refused.body.error.message).toContain('reactivate');
    noSentinel('reactivation', refused);
    expect(await supplierActive(s)).toBe(false);
    expect(await effective(p.id)).toBe('100.00');

    const link = await linkOf(p.id, s);
    expect((await send(owner, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: false, version: link.version })).status).toBe(200);
    expect((await archive(owner, s, await supplierVersion(s), true)).status).toBe(200);
    // Reactivated, but no longer preferred: the effective price did not move.
    expect(await effective(p.id)).toBe('100.00');
  });

  it('an ordinary supplier (not preferred anywhere) archives and reactivates as before', async () => {
    const s = await supplier();
    const p = await product();
    expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s })).status).toBe(201);
    expect((await archive(blocked, s, await supplierVersion(s))).status).toBe(200);
    expect((await archive(blocked, s, await supplierVersion(s), true)).status).toBe(200);
  });

  describe('concurrency (a second real transaction)', () => {
    /** Runs `request` while `holder` keeps its transaction open; returns the HTTP result after `holder` commits. */
    async function whileHeld(hold: (c: pg.PoolClient) => Promise<unknown>, send: () => Promise<request.Response>) {
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await hold(c);
        // supertest sends only once `.then` is called: start the request now.
        const pending = send().then((r) => r);
        // The request must be WAITING on the held supplier row, not deciding on stale data.
        let waiting = 0;
        for (let i = 0; i < 40 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          waiting = (await db.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype IN ('tuple', 'transactionid') AND NOT granted`)).rows[0].n;
        }
        await c.query('COMMIT');
        return { res: await pending, waiting };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    }

    it('archive committed first: a concurrent "make preferred" waits, then is refused (archived)', async () => {
      const s = await supplier();
      const p = await product('100.00');
      expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s, purchasePrice: '654.32' })).status).toBe(201);
      const link = await linkOf(p.id, s);
      const { res, waiting } = await whileHeld(
        (c) => c.query(`UPDATE suppliers SET is_active = false WHERE id = $1`, [s]),
        () => send(owner, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: true, version: link.version }),
      );
      expect(waiting).toBeGreaterThan(0);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.details[0].path).toBe('isPreferred');
      expect((await linkOf(p.id, s)).isPreferred).toBe(false);
      expect(await effective(p.id)).toBe('100.00');
    });

    it('archive committed first: a concurrent new preferred link waits, then is refused (archived)', async () => {
      const s = await supplier();
      const p = await product('100.00');
      const { res, waiting } = await whileHeld(
        (c) => c.query(`UPDATE suppliers SET is_active = false WHERE id = $1`, [s]),
        () => send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s, purchasePrice: '654.32', isPreferred: true }),
      );
      expect(waiting).toBeGreaterThan(0);
      expect(res.status).toBe(400);
      expect(await linkOf(p.id, s)).toBeUndefined();
    });

    it('preferred link committed first: a concurrent archive waits, then is refused (preferred)', async () => {
      const s = await supplier();
      const p = await product('100.00');
      expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s, purchasePrice: '654.32' })).status).toBe(201);
      const version = await supplierVersion(s);
      const { res, waiting } = await whileHeld(
        // What the link service holds while making the link preferred (supplier FOR SHARE).
        async (c) => {
          await c.query(`SELECT 1 FROM suppliers WHERE id = $1 FOR SHARE`, [s]);
          await c.query(`UPDATE product_suppliers SET is_preferred = true, version = version + 1 WHERE product_id = $1 AND supplier_id = $2`, [p.id, s]);
        },
        () => archive(owner, s, version),
      );
      expect(waiting).toBeGreaterThan(0);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe('SUPPLIER_IS_PREFERRED');
      noSentinel('concurrent archive', res);
      expect(await supplierActive(s)).toBe(true);
      expect(await effective(p.id)).toBe('654.32');
    });

    it('two real requests racing (archive vs make preferred): never an archived preferred supplier', async () => {
      for (let round = 0; round < 5; round++) {
        const s = await supplier();
        const p = await product('100.00');
        expect((await send(owner, 'post', `/products/${p.id}/suppliers`, { supplierId: s, purchasePrice: '654.32' })).status).toBe(201);
        const link = await linkOf(p.id, s);
        const [a, b] = await Promise.all([
          archive(owner, s, await supplierVersion(s)),
          send(owner, 'patch', `/products/${p.id}/suppliers/${s}`, { isPreferred: true, version: link.version }),
        ]);
        // Exactly one wins.
        expect([a.status, b.status].filter((x) => x === 200)).toHaveLength(1);
        const bad = await db.query(`SELECT 1 FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.supplier_id = $1 AND ps.is_preferred AND NOT s.is_active`, [s]);
        expect(bad.rowCount).toBe(0);
      }
    });
  });
});
