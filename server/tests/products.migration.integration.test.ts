/**
 * Upgrade safety of migration 0015 (products) on a database that already holds data at 0014:
 * every existing row (users, categories, brands, suppliers, expenses, audit, idempotency keys)
 * is unchanged apart from the two new flags, which default to FALSE; old audit rows still satisfy
 * the extended CHECK lists; the previous application's writes (no new columns) still work.
 * Runs in a throw-away schema of the test database, dropped afterwards.
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrator.js';
import { connectTestDatabase } from './helpers.js';

const pool = await connectTestDatabase();
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../src/database/migrations');

describe.skipIf(!pool)('migrations 0015–0016 on an existing 0014 database', () => {
  const db = pool!;
  const schema = `up15_${randomBytes(4).toString('hex')}`;
  let schemaPool: pg.Pool;
  let upTo14: string;

  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    schemaPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: `-c search_path=${schema},public` });
    schemaPool.on('error', () => undefined);
    upTo14 = await mkdtemp(path.join(tmpdir(), 'sb-up15-'));
    for (const f of await readdir(MIGRATIONS_DIR)) {
      if (f < '0015') await cp(path.join(MIGRATIONS_DIR, f), path.join(upTo14, f));
    }
  });

  afterAll(async () => {
    await schemaPool.end();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(upTo14, { recursive: true, force: true });
    await db.end();
  });

  it('keeps existing data, adds FALSE flags, and the previous application keeps working', async () => {
    await runMigrations(schemaPool, upTo14);
    const q = (sql: string, params: unknown[] = []) => schemaPool.query(sql, params);
    const owner = (await q(`INSERT INTO users (email, name, role, password_hash) VALUES ('o@x.test', 'Owner', 'owner', '$argon2id$x') RETURNING id`)).rows[0].id;
    const manager = (await q(`INSERT INTO users (email, name, role, password_hash) VALUES ('m@x.test', 'Mgr', 'manager', '$argon2id$x') RETURNING id`)).rows[0].id;
    const cat = (await q(`INSERT INTO expense_categories (name, created_by, updated_by) VALUES ('Rent', $1, $1) RETURNING id`, [owner])).rows[0].id;
    const brand = (await q(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Classmate', $1, $1) RETURNING id`, [owner])).rows[0].id;
    const supplier = (await q(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ('One', $1, $1) RETURNING id`, [owner])).rows[0].id;
    const expense = (
      await q(
        `INSERT INTO expenses (expense_date, supplier_id, category_id, description, amount, amount_paid, payment_mode, created_by, updated_by)
         VALUES (CURRENT_DATE, $1, $2, 'Bill', '100.00', '0.00', NULL, $3, $3) RETURNING id`,
        [supplier, cat, owner],
      )
    ).rows[0].id;
    await q(
      `INSERT INTO financial_audit_events (entity_type, entity_id, action, actor_user_id, before_values, after_values)
       VALUES ('expense', $1, 'create', $2, NULL, '{"amount":"100.00"}'), ('brand', $3, 'create', $2, NULL, '{"name":"Classmate"}')`,
      [expense, owner, brand],
    );
    await q(`INSERT INTO auth_events (event_type, user_id) VALUES ('login_success', $1)`, [owner]);

    const snapshot = async () => ({
      users: (await q(`SELECT to_jsonb(u) - 'can_view_purchase_prices' - 'can_edit_purchase_prices' AS r FROM users u ORDER BY id`)).rows,
      categories: (await q(`SELECT to_jsonb(c) - 'is_product_usable' AS r FROM expense_categories c ORDER BY id`)).rows,
      brands: (await q(`SELECT to_jsonb(b) AS r FROM brands b ORDER BY id`)).rows,
      expenses: (await q(`SELECT to_jsonb(e) AS r FROM expenses e ORDER BY id`)).rows,
      audit: (await q(`SELECT to_jsonb(a) AS r FROM financial_audit_events a ORDER BY id`)).rows,
      auth: (await q(`SELECT to_jsonb(a) AS r FROM auth_events a ORDER BY id`)).rows,
    });
    const before = await snapshot();

    const result = await runMigrations(schemaPool);
    expect(result.applied.map((m) => m.slice(0, 4))).toEqual(['0015', '0016', '0017']);
    expect(await snapshot()).toEqual(before);

    // New flags default to FALSE for existing rows.
    expect((await q(`SELECT bool_or(is_product_usable) AS any FROM expense_categories`)).rows[0].any).toBe(false);
    expect((await q(`SELECT bool_or(can_view_purchase_prices) AS any FROM users`)).rows[0].any).toBe(false);
    expect((await q(`SELECT bool_or(can_edit_purchase_prices) AS any FROM users`)).rows[0].any).toBe(false);
    expect((await q(`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`)).rows[0].n).toBe(1);

    // The previous application's writes (which know nothing of the new columns) still work.
    await q(`INSERT INTO expense_categories (name, created_by, updated_by) VALUES ('Stock', $1, $1)`, [owner]);
    await q(`INSERT INTO users (email, name, role, password_hash, created_by) VALUES ('m2@x.test', 'Mgr 2', 'manager', '$argon2id$x', $1)`, [owner]);
    await q(`UPDATE brands SET name = 'Classmate ITC' WHERE id = $1`, [brand]);
    await q(`INSERT INTO idempotency_keys (user_id, operation, key, request_hash, response_status, response_body, resource_id)
             VALUES ($1, 'expense.create', 'abcdefghijklmnop', decode(repeat('ab', 32), 'hex'), 201, '{}', $2)`, [manager, expense]);

    // The new tables work in this schema (trigram index, triggers, constraints).
    const usable = (await q(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ('Notebooks', true, $1, $1) RETURNING id`, [owner])).rows[0].id;
    const product = (
      await q(`INSERT INTO products (name, brand_id, category_id, size, page_count, selling_price, created_by, updated_by) VALUES ('Register', $1, $2, 'A4', 140, 50, $3, $3) RETURNING id`, [
        brand,
        usable,
        owner,
      ])
    ).rows[0].id;
    const doc = (await q(`SELECT document FROM product_search WHERE product_id = $1`, [product])).rows[0].document;
    expect(doc).toBe('classmate itc register notebooks a4 140 pages 140p');
    await expect(q(`DELETE FROM products WHERE id = $1`, [product])).rejects.toThrow(/never deleted/);
    await expect(q(`INSERT INTO products (name, category_id, selling_price, mrp, created_by, updated_by) VALUES ('X', $1, 60, 50, $2, $2)`, [usable, owner])).rejects.toThrow(
      /products_sp_above_mrp_confirmed/,
    );
    await expect(
      q(`INSERT INTO financial_audit_events (entity_type, entity_id, action, actor_user_id, before_values, after_values) VALUES ('product', $1, 'link_supplier', $2, '{}', '{}')`, [
        product,
        owner,
      ]),
    ).resolves.toBeTruthy();
    await expect(q(`INSERT INTO auth_events (event_type, user_id) VALUES ('purchase_prices_viewed', $1)`, [manager])).resolves.toBeTruthy();
  });
});
