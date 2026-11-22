/**
 * OPT-IN product search benchmark (PRODUCT_SEARCH_BENCH=1). Seeds 10,000 synthetic products into
 * the dedicated local test database ONLY (this suite, like every integration suite, refuses any
 * other database), then runs realistic searches through the real service functions and reports
 * p50/p95 plus the query plan of a typical search. Nothing here runs against development or
 * production databases.
 *
 *   PRODUCT_SEARCH_BENCH=1 npx vitest run tests/products.search.bench.integration.test.ts
 *
 * Thresholds are acceptance targets checked by this test (local machine, warm cache); they are
 * not a promise about hosted latency, where the network round trip dominates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrator.js';
import { productListQuerySchema } from '../src/modules/products/products.schemas.js';
import { listProducts, quickSearch } from '../src/modules/products/products.service.js';
import { bulkSeed, connectTestDatabase } from './helpers.js';

const enabled = process.env.PRODUCT_SEARCH_BENCH === '1';
const pool = enabled ? await connectTestDatabase() : null;
const COUNT = 10_000;
const QUERIES = ['classmate', 'register', 'classmate register', 'a4 140', 'doms spiral', 'clasmate', '890123', 'pilot', 'camlin 172', 'drawing a3'];

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]!;

describe.skipIf(!pool)('product search benchmark (opt-in)', () => {
  const db = pool!;

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const owner = (await db.query<{ id: string }>(`INSERT INTO users (email, name, role, password_hash) VALUES ('bench@example.test', 'Bench', 'owner', '$argon2id$x') RETURNING id`)).rows[0]!.id;
    await db.query(
      `INSERT INTO brands (name, created_by, updated_by)
       SELECT b, $1, $1 FROM unnest(ARRAY['Classmate','Classic','Apple','Camlin','Pilot','DOMS','Camel','Neelgagan','National','Oddy','Canson','Paperkraft']) b`,
      [owner],
    );
    await db.query(
      `INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by)
       SELECT c, true, $1, $1 FROM unnest(ARRAY['Notebook (Copy)','Drawing','Stationery','Toys']) c`,
      [owner],
    );
    await bulkSeed(
      db,
      `INSERT INTO products (name, brand_id, category_id, size, page_count, gsm, binding, selling_price, mrp, barcode, created_by, updated_by)
       SELECT (ARRAY['Register','Spiral Notebook','Long Book','Practical','Drawing Book','Graph Book','Scrap Book','Rough Copy'])[1 + (i % 8)] || ' ' || i,
              (SELECT id FROM brands ORDER BY name OFFSET (i % 12) LIMIT 1),
              (SELECT id FROM expense_categories ORDER BY name OFFSET (i % 4) LIMIT 1),
              (ARRAY['A3','A4','A5','SL','D'])[1 + (i % 5)],
              (ARRAY[36,60,100,120,140,172,196,240])[1 + (i % 8)],
              CASE WHEN i % 7 = 0 THEN 150 END,
              (ARRAY['spiral','register',NULL,'pad'])[1 + (i % 4)],
              10 + (i % 200), 20 + (i % 200),
              CASE WHEN i % 3 = 0 THEN '890' || lpad(i::text, 10, '0') END,
              $1, $1
         FROM generate_series(1, ${COUNT}) i`,
      [owner],
    );
    await db.query('ANALYZE products; ANALYZE product_search;');
  }, 180_000);

  afterAll(async () => {
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    await db.end();
  });

  it(`list and quick search over ${COUNT} products`, async () => {
    expect((await db.query(`SELECT count(*)::int AS n FROM product_search`)).rows[0].n).toBe(COUNT);
    const listTimes: number[] = [];
    const quickTimes: number[] = [];
    const perQuery: Record<string, { list: number[]; quick: number[] }> = {};
    for (let round = 0; round < 20; round++) {
      for (const q of QUERIES) {
        let t = performance.now();
        await listProducts(db, productListQuerySchema.parse({ q, pageSize: 25 }));
        const l = performance.now() - t;
        listTimes.push(l);
        t = performance.now();
        await quickSearch(db, q, 10);
        const k = performance.now() - t;
        quickTimes.push(k);
        (perQuery[q] ??= { list: [], quick: [] }).list.push(l);
        perQuery[q].quick.push(k);
      }
    }
    const plan = await db.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT p.id FROM products p JOIN product_search ps ON ps.product_id = p.id
        WHERE p.is_active AND (ps.document LIKE '%classmate%' OR ps.supplier_document LIKE '%classmate%')
          AND (ps.document LIKE '%register%' OR ps.supplier_document LIKE '%register%') LIMIT 26`,
    );
    const report = {
      products: COUNT,
      runs: listTimes.length,
      listMs: { p50: percentile(listTimes, 50).toFixed(1), p95: percentile(listTimes, 95).toFixed(1) },
      quickSearchMs: { p50: percentile(quickTimes, 50).toFixed(1), p95: percentile(quickTimes, 95).toFixed(1) },
    };
    console.log('PRODUCT SEARCH BENCHMARK', JSON.stringify(report));
    for (const [q, t] of Object.entries(perQuery)) {
      console.log('  per query', JSON.stringify(q), 'list p50/p95', percentile(t.list, 50).toFixed(1), percentile(t.list, 95).toFixed(1), 'quick p50/p95', percentile(t.quick, 50).toFixed(1), percentile(t.quick, 95).toFixed(1));
    }
    console.log(plan.rows.map((r) => r['QUERY PLAN']).join('\n'));
    // Acceptance targets on a local machine (see docs/products.md).
    expect(percentile(quickTimes, 95)).toBeLessThan(60);
    expect(percentile(listTimes, 95)).toBeLessThan(120);
  }, 300_000);
});
