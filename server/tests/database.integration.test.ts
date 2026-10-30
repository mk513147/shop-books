import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pingDatabase } from '../src/database/connection.js';
import {
  ADVISORY_LOCK_KEY,
  DEFAULT_MIGRATIONS_DIR,
  getMigrationStatus,
  MigrationError,
  runMigrations,
} from '../src/database/migrator.js';
import { connectTestDatabase, silentLogger, testConfig } from './helpers.js';

/**
 * These tests need a reachable PostgreSQL *test* database (DATABASE_URL in .env.test, name ending
 * in "_test"). If none is available they are SKIPPED, never reported as passing.
 */
const adminPool = await connectTestDatabase();
const dbAvailable = adminPool !== null;

describe.skipIf(!dbAvailable)('PostgreSQL integration (dedicated test database)', () => {
  const pool = adminPool!;

  afterAll(async () => {
    await pool.end();
  });

  it('connects and the health endpoint detects database connectivity', async () => {
    expect(await pingDatabase(pool)).toBe(true);
    const app = createApp({ config: testConfig(), db: pool, logger: silentLogger });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('health reports down once the pool is closed', async () => {
    const config = testConfig();
    const closed = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    closed.on('error', () => undefined);
    await closed.end();
    const res = await request(createApp({ config, db: closed, logger: silentLogger })).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('down');
  });

  it('returns NUMERIC as an exact string and DATE as YYYY-MM-DD (type conventions)', async () => {
    const result = await pool.query<{ amount: unknown; day: unknown }>(
      `SELECT 12345678901.10::numeric(14,2) AS amount, DATE '2026-01-31' AS day`,
    );
    expect(result.rows[0]).toEqual({ amount: '12345678901.10', day: '2026-01-31' });
  });

  describe('migration runner (isolated schema)', () => {
    const schema = `mig_${randomBytes(4).toString('hex')}`;
    let schemaPool: pg.Pool;
    let dir: string;

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      // search_path pins schema_migrations and migration objects to the throwaway schema.
      schemaPool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 3,
        options: `-c search_path=${schema}`,
      });
      schemaPool.on('error', () => undefined);
      dir = await mkdtemp(join(tmpdir(), 'shop-books-int-'));
    });

    afterAll(async () => {
      await schemaPool.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await rm(dir, { recursive: true, force: true });
    });

    it('reports everything pending before any run, without creating the history table', async () => {
      await writeFile(join(dir, '0001_make_a.sql'), 'CREATE TABLE a (id int);');
      await writeFile(join(dir, '0002_make_b.sql'), 'CREATE TABLE b (id int);');
      const status = await getMigrationStatus(schemaPool, dir);
      expect(status.applied).toEqual([]);
      expect(status.pending.map((f) => f.version)).toEqual(['0001', '0002']);
      const exists = await schemaPool.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS e`);
      expect(exists.rows[0].e).toBe(false);
    });

    it('applies pending migrations once and identifies them as applied afterwards', async () => {
      const first = await runMigrations(schemaPool, dir);
      expect(first.applied).toEqual(['0001', '0002']);
      const status = await getMigrationStatus(schemaPool, dir);
      expect(status.applied.map((a) => a.version)).toEqual(['0001', '0002']);
      expect(status.pending).toEqual([]);
      expect(status.issues).toEqual([]);
      const second = await runMigrations(schemaPool, dir);
      expect(second.applied).toEqual([]);
    });

    it('rolls back a failing migration completely, reports it, and applies nothing after it', async () => {
      await writeFile(join(dir, '0003_partial.sql'), 'CREATE TABLE c (id int); SELECT * FROM missing_table;');
      await writeFile(join(dir, '0004_after.sql'), 'CREATE TABLE d (id int);');
      await expect(runMigrations(schemaPool, dir)).rejects.toThrow(/0003_partial\.sql failed and was rolled back/);
      const tables = await schemaPool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual(['a', 'b', 'schema_migrations']);
      const status = await getMigrationStatus(schemaPool, dir);
      expect(status.pending.map((f) => f.version)).toEqual(['0003', '0004']);
    });

    it('refuses to run when an applied migration file has been modified', async () => {
      await rm(join(dir, '0003_partial.sql'));
      await rm(join(dir, '0004_after.sql'));
      await writeFile(join(dir, '0001_make_a.sql'), 'CREATE TABLE a (id int, extra int);');
      await expect(runMigrations(schemaPool, dir)).rejects.toThrow(MigrationError);
      const status = await getMigrationStatus(schemaPool, dir);
      expect(status.issues[0]).toMatch(/modified after it was applied/);
    });

    it('serializes concurrent runners so each migration applies exactly once', async () => {
      await writeFile(join(dir, '0001_make_a.sql'), 'CREATE TABLE a (id int);');
      await writeFile(join(dir, '0005_make_e.sql'), 'CREATE TABLE e (id int);');
      const results = await Promise.all([runMigrations(schemaPool, dir), runMigrations(schemaPool, dir)]);
      expect(results.flatMap((r) => r.applied)).toEqual(['0005']);
    });

    it('leaves no advisory lock held after success or failure', async () => {
      // Checked from a different session: advisory locks are re-entrant within one session.
      const held = async (): Promise<number> => {
        const result = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1`,
          [ADVISORY_LOCK_KEY],
        );
        return result.rows[0]!.n;
      };
      expect(await held()).toBe(0);
      await writeFile(join(dir, '0006_bad.sql'), 'SELECT * FROM missing_table_2;');
      await expect(runMigrations(schemaPool, dir)).rejects.toThrow(/rolled back/);
      expect(await held()).toBe(0);
      await rm(join(dir, '0006_bad.sql'));
    });

    it('detects a migration file that has gone missing', async () => {
      await rm(join(dir, '0005_make_e.sql'));
      const status = await getMigrationStatus(schemaPool, dir);
      expect(status.issues.join()).toMatch(/0005_make_e has no matching file/);
      await expect(runMigrations(schemaPool, dir)).rejects.toThrow(/no matching file/);
    });
  });

  it('migration entry points refuse a non-test database even when handed a pool for it', async () => {
    // Same server, but the built-in "postgres" database: its name does not end in "_test".
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/postgres';
    const other = new pg.Pool({ connectionString: url.toString(), max: 1 });
    other.on('error', () => undefined);
    try {
      await expect(runMigrations(other)).rejects.toThrow(/must end in "_test"/);
      await expect(getMigrationStatus(other)).rejects.toThrow(/must end in "_test"/);
      const created = await other.query(`SELECT to_regclass('schema_migrations') AS t`);
      expect(created.rows[0].t).toBeNull(); // nothing was created there
    } finally {
      await other.end();
    }
  });

  it('the shipped migrations apply cleanly and are idempotent on this test database', async () => {
    const first = await runMigrations(pool);
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(first.applied.length + (await getMigrationStatus(pool)).applied.length).toBeGreaterThan(0);
    const status = await getMigrationStatus(pool, DEFAULT_MIGRATIONS_DIR);
    expect(status.pending).toEqual([]);
    expect(status.issues).toEqual([]);
    const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'citext'`);
    expect(ext.rowCount).toBe(1);
  });
});
