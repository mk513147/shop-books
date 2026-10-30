import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseMatchesEnvironment,
  getMigrationStatus,
  runMigrations,
  checksumOf,
  computeStatus,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrationFiles,
  MigrationError,
  type AppliedMigration,
} from '../src/database/migrator.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shop-books-mig-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, sql = 'SELECT 1;') {
  await writeFile(join(dir, name), sql);
}

describe('loadMigrationFiles', () => {
  it('loads valid files ordered by version', async () => {
    await write('0002_second.sql');
    await write('0001_first.sql');
    await write('notes.txt', 'ignored');
    const files = await loadMigrationFiles(dir);
    expect(files.map((f) => f.filename)).toEqual(['0001_first.sql', '0002_second.sql']);
  });

  it('rejects badly named files', async () => {
    await write('create_users.sql');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/Invalid migration filename/);
  });

  it('rejects duplicate versions', async () => {
    await write('0001_a.sql');
    await write('0001_b.sql');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/Duplicate migration version 0001/);
  });

  it('rejects empty files and a missing directory', async () => {
    await write('0001_empty.sql', '  \n');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(MigrationError);
    await expect(loadMigrationFiles(join(dir, 'nope'))).rejects.toThrow(/Cannot read migrations directory/);
  });

  it('ships a valid initial infrastructure migration', async () => {
    const files = await loadMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    expect(files[0]?.filename).toBe('0001_initial_infrastructure.sql');
    expect(files[0]?.sql).not.toMatch(/\bCREATE\s+TABLE\b/i);
  });
});

describe('checksumOf', () => {
  it('ignores CRLF vs LF so Windows checkouts match', () => {
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'));
    expect(checksumOf('a')).not.toBe(checksumOf('b'));
  });
});

describe('computeStatus', () => {
  async function filesFor(...names: string[]) {
    await mkdir(dir, { recursive: true });
    for (const n of names) await write(n);
    return loadMigrationFiles(dir);
  }
  const applied = (version: string, name: string, checksum: string): AppliedMigration => ({
    version,
    name,
    checksum,
    appliedAt: new Date(0),
  });

  it('identifies applied and pending migrations', async () => {
    const files = await filesFor('0001_first.sql', '0002_second.sql');
    const status = computeStatus([applied('0001', 'first', files[0]!.checksum)], files);
    expect(status.pending.map((f) => f.version)).toEqual(['0002']);
    expect(status.issues).toEqual([]);
  });

  it('flags a modified applied migration', async () => {
    const files = await filesFor('0001_first.sql');
    const status = computeStatus([applied('0001', 'first', 'different')], files);
    expect(status.issues[0]).toMatch(/modified after it was applied/);
  });

  it('flags an applied migration whose file is missing', async () => {
    const status = computeStatus([applied('0009', 'ghost', 'x')], []);
    expect(status.issues[0]).toMatch(/no matching file/);
  });

  it('flags a pending migration older than one already applied', async () => {
    const files = await filesFor('0001_first.sql', '0002_second.sql');
    const status = computeStatus([applied('0002', 'second', files[1]!.checksum)], files);
    expect(status.issues[0]).toMatch(/older than already-applied/);
  });
});

/** A pool stand-in whose connection reports `databaseName`; records what was executed. */
function fakePool(databaseName: string, options: { failUnlock?: boolean } = {}) {
  const executed: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      executed.push(sql);
      if (/pg_advisory_unlock/.test(sql)) {
        if (options.failUnlock) throw new Error('connection lost');
        return { rows: [{ ok: true }] };
      }
      if (/to_regclass/.test(sql)) return { rows: [{ exists: true }] };
      return { rows: [] };
    }),
    release,
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      executed.push(sql);
      return { rows: [{ name: databaseName }] };
    }),
    connect: vi.fn(async () => client),
  } as unknown as pg.Pool;
  return { pool, executed, release };
}

describe('database/environment isolation at every migration entry point', () => {
  it('refuses a non-test database when NODE_ENV=test, before touching anything', async () => {
    await write('0001_first.sql');
    vi.stubEnv('NODE_ENV', 'test');
    const { pool, executed } = fakePool('shop_books_dev');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/must end in "_test"/);
    await expect(getMigrationStatus(pool, dir)).rejects.toThrow(/must end in "_test"/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(executed.every((sql) => /current_database/.test(sql))).toBe(true);
    vi.unstubAllEnvs();
  });

  it('refuses a *_test database in development and production', async () => {
    await write('0001_first.sql');
    for (const env of ['development', 'production']) {
      vi.stubEnv('NODE_ENV', env);
      const { pool } = fakePool('shop_books_test');
      await expect(runMigrations(pool, dir)).rejects.toThrow(/only be used when NODE_ENV=test/);
    }
    vi.unstubAllEnvs();
  });

  it('allows matching combinations', async () => {
    await expect(assertDatabaseMatchesEnvironment(fakePool('shop_books_test').pool, 'test')).resolves.toBeUndefined();
    await expect(assertDatabaseMatchesEnvironment(fakePool('shop_books_dev').pool, 'development')).resolves.toBeUndefined();
  });
});

describe('advisory lock handling', () => {
  it('releases the lock and returns the connection normally on success', async () => {
    await write('0001_first.sql');
    vi.stubEnv('NODE_ENV', 'test');
    const { pool, executed, release } = fakePool('x_test');
    await runMigrations(pool, dir);
    expect(executed.some((sql) => /pg_advisory_unlock/.test(sql))).toBe(true);
    expect(release).toHaveBeenCalledWith(false);
    vi.unstubAllEnvs();
  });

  it('destroys the connection if the unlock cannot be confirmed, so no lock leaks into the pool', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { pool, release } = fakePool('x_test', { failUnlock: true });
    await runMigrations(pool, dir); // empty directory: nothing to apply
    expect(release).toHaveBeenCalledWith(true);
    vi.unstubAllEnvs();
  });
});
