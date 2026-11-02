/**
 * Upgrade safety of migrations 0005–0010 on a database that already holds Stage 3A data (not just
 * an empty one). Runs in a throw-away schema of the test database, which is dropped afterwards.
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

describe.skipIf(!pool)('migrations 0005–0010 on an existing 0004 database', () => {
  const db = pool!;
  const schema = `up_${randomBytes(4).toString('hex')}`;
  let schemaPool: pg.Pool;
  let upTo4: string;

  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    schemaPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: `-c search_path=${schema},public` });
    schemaPool.on('error', () => undefined);
    upTo4 = await mkdtemp(path.join(tmpdir(), 'sb-up-'));
    for (const f of await readdir(MIGRATIONS_DIR)) {
      if (f < '0005') await cp(path.join(MIGRATIONS_DIR, f), path.join(upTo4, f));
    }
  });

  afterAll(async () => {
    await schemaPool.end();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(upTo4, { recursive: true, force: true });
    await db.end();
  });

  it('keeps every existing row unchanged and derives balances from existing expenses', async () => {
    await runMigrations(schemaPool, upTo4);
    const q = (sql: string, params: unknown[] = []) => schemaPool.query(sql, params);

    // A realistic Stage 3A database.
    const user = (
      await q(`INSERT INTO users (email, name, role, password_hash) VALUES ('o@x.test', 'Owner', 'owner', '$argon2id$x') RETURNING id`)
    ).rows[0].id;
    const cat = (await q(`INSERT INTO expense_categories (name, created_by, updated_by) VALUES ('Stock', $1, $1) RETURNING id`, [user])).rows[0].id;
    const s1 = (await q(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ('One', $1, $1) RETURNING id`, [user])).rows[0].id;
    const s2 = (await q(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ('Two', $1, $1) RETURNING id`, [user])).rows[0].id;
    const insert = (supplier: string | null, amount: string, paid: string, mode: string | null) =>
      q(
        `INSERT INTO expenses (expense_date, supplier_id, category_id, description, amount, amount_paid, payment_mode, created_by, updated_by)
         VALUES (CURRENT_DATE - 3, $1, $2, 'Old bill', $3, $4, $5, $6, $6) RETURNING id`,
        [supplier, cat, amount, paid, mode, user],
      ).then((r) => r.rows[0].id as string);
    const e1 = await insert(s1, '1000.00', '200.00', 'cash');
    await insert(s1, '500.00', '0.00', null);
    const voided = await insert(s1, '600.00', '0.00', null);
    await q(`UPDATE expenses SET voided_at = now(), voided_by = $2, void_reason = 'dup', version = 2 WHERE id = $1`, [voided, user]);
    await insert(s2, '300.00', '300.00', 'upi');
    await insert(null, '50.00', '50.00', 'cash');
    await q(
      `INSERT INTO financial_audit_events (entity_type, entity_id, action, actor_user_id, reason, before_values, after_values)
       VALUES ('expense', $1, 'create', $2, NULL, NULL, '{"amount":"1000.00"}'),
              ('expense', $3, 'void', $2, 'dup', '{}', '{}')`,
      [e1, user, voided],
    );
    await q(
      `INSERT INTO idempotency_keys (user_id, operation, key, request_hash, response_status, response_body, resource_id)
       VALUES ($1, 'expense.create', 'abcdefghijklmnop', decode(repeat('ab', 32), 'hex'), 201, '{}', $2)`,
      [user, e1],
    );

    const snapshot = async () => ({
      expenses: (await q(`SELECT to_jsonb(e) AS r FROM expenses e ORDER BY id`)).rows,
      suppliers: (await q(`SELECT to_jsonb(s) AS r FROM suppliers s ORDER BY id`)).rows,
      audit: (await q(`SELECT to_jsonb(a) AS r FROM financial_audit_events a ORDER BY id`)).rows,
      keys: (await q(`SELECT to_jsonb(k) AS r FROM idempotency_keys k ORDER BY key`)).rows,
    });
    const before = await snapshot();

    const applied = await runMigrations(schemaPool, MIGRATIONS_DIR);
    expect(applied.applied).toEqual(['0005', '0006', '0007', '0008', '0009', '0010']);
    expect(await snapshot()).toEqual(before);

    // 0010: every expense that was paid at purchase gets exactly one matching payment allocation;
    // unpaid expenses get none, and the old columns are untouched (snapshot above).
    const allocations = (await q(`SELECT payment_mode, amount::text AS amount, position FROM expense_payments p ORDER BY p.amount`)).rows;
    expect(allocations).toEqual([
      { payment_mode: 'cash', amount: '50.00', position: 1 },
      { payment_mode: 'cash', amount: '200.00', position: 1 },
      { payment_mode: 'upi', amount: '300.00', position: 1 },
    ]);
    expect(
      (await q(`SELECT count(*)::int AS n FROM expenses e WHERE e.amount_paid <> COALESCE((SELECT sum(amount) FROM expense_payments p WHERE p.expense_id = e.id), 0)`)).rows[0].n,
    ).toBe(0);

    // Payable = amount - paid at purchase over ACTIVE bills (no allocations exist yet).
    const balances = (await q(`SELECT supplier_id, payable, unallocated, total_payments FROM supplier_balances ORDER BY supplier_id`)).rows;
    const byId = Object.fromEntries(balances.map((b) => [b.supplier_id, b]));
    expect(byId[s1]).toMatchObject({ payable: '1300.00', unallocated: '0.00', total_payments: '0.00' });
    expect(byId[s2]).toMatchObject({ payable: '0.00' });
    expect((await q(`SELECT count(*)::int AS n FROM customer_balances`)).rows[0].n).toBe(0);
    // 0009: reports start switched off, with the default schedule.
    expect((await q(`SELECT enabled, delivery_day, to_char(delivery_time, 'HH24:MI') AS t, include_excel FROM report_settings`)).rows).toEqual([
      { enabled: false, delivery_day: 1, t: '08:00', include_excel: true },
    ]);

    // Existing expenses remain fully editable/voidable (the new guard trigger only acts with allocations).
    await q(`UPDATE expenses SET amount = 1100, version = version + 1 WHERE id = $1`, [e1]);
    await q(`UPDATE expenses SET voided_at = now(), voided_by = $2, void_reason = 'test' WHERE id = $1`, [e1, user]);
    // Old idempotency rows still satisfy the widened constraint; new operations are accepted.
    await q(
      `INSERT INTO idempotency_keys (user_id, operation, key, request_hash, response_status, response_body, resource_id)
       VALUES ($1, 'customer_transaction.create', 'qrstuvwxyzabcdef', decode(repeat('cd', 32), 'hex'), 201, '{}', $2)`,
      [user, e1],
    );
    // Re-running is a no-op.
    expect((await runMigrations(schemaPool, MIGRATIONS_DIR)).applied).toEqual([]);
  });
});
