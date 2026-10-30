import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { databaseNameProblem } from './isolation.js';

/** Default location of the SQL files (src/database/migrations, or dist/... once built). */
export const DEFAULT_MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const HISTORY_TABLE = 'schema_migrations';

/** Arbitrary constant: serializes concurrent runners with a PostgreSQL advisory lock. */
export const ADVISORY_LOCK_KEY = 726_001_001;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly version?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  /** Problems that block running migrations (edited, missing, or out-of-order files). */
  issues: string[];
}

/** Line endings are normalised so a Windows checkout (CRLF) matches the recorded checksum. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Reads and validates migration files: `NNNN_snake_case_name.sql`, unique, ordered by NNNN. */
export async function loadMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new MigrationError(`Cannot read migrations directory: ${dir}`, undefined, { cause });
  }

  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const filename of entries.filter((f) => f.toLowerCase().endsWith('.sql')).sort()) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new MigrationError(
        `Invalid migration filename "${filename}". Expected NNNN_snake_case_name.sql (e.g. 0002_create_users.sql).`,
      );
    }
    const [, version, name] = match as unknown as [string, string, string];
    if (seen.has(version)) {
      throw new MigrationError(`Duplicate migration version ${version} (file "${filename}").`, version);
    }
    seen.add(version);
    const sql = await readFile(join(dir, filename), 'utf8');
    if (sql.trim() === '') throw new MigrationError(`Migration "${filename}" is empty.`, version);
    files.push({ version, name, filename, sql, checksum: checksumOf(sql) });
  }
  return files;
}

/**
 * Last line of defence for every migration entry point: whatever pool the caller built, check the
 * database it is *actually connected to* against NODE_ENV before reading or changing anything.
 */
export async function assertDatabaseMatchesEnvironment(
  db: Pick<pg.Pool, 'query'>,
  nodeEnv: string = process.env.NODE_ENV || 'development',
): Promise<void> {
  const result = await db.query<{ name: string }>('SELECT current_database() AS name');
  const problem = databaseNameProblem(nodeEnv, result.rows[0]?.name ?? '');
  if (problem) throw new MigrationError(`Refusing to continue: ${problem}.`);
}

async function historyTableExists(db: pg.ClientBase | pg.Pool): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [HISTORY_TABLE],
  );
  return result.rows[0]?.exists === true;
}

async function readApplied(db: pg.ClientBase | pg.Pool): Promise<AppliedMigration[]> {
  if (!(await historyTableExists(db))) return [];
  const result = await db.query<{ version: string; name: string; checksum: string; applied_at: Date }>(
    `SELECT version, name, checksum, applied_at FROM ${HISTORY_TABLE} ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/** Pure comparison of what is recorded as applied against the files on disk. */
export function computeStatus(applied: AppliedMigration[], files: MigrationFile[]): MigrationStatus {
  const issues: string[] = [];
  const appliedByVersion = new Map(applied.map((a) => [a.version, a]));
  const fileByVersion = new Map(files.map((f) => [f.version, f]));

  for (const row of applied) {
    const file = fileByVersion.get(row.version);
    if (!file) {
      issues.push(`Applied migration ${row.version}_${row.name} has no matching file.`);
    } else if (file.checksum !== row.checksum) {
      issues.push(
        `Applied migration ${file.filename} was modified after it was applied. Never edit an applied migration; add a new one.`,
      );
    }
  }

  const pending = files.filter((f) => !appliedByVersion.has(f.version));
  const highestApplied = applied.reduce((max, a) => (a.version > max ? a.version : max), '');
  for (const file of pending) {
    if (file.version < highestApplied) {
      issues.push(`Pending migration ${file.filename} is older than already-applied migration ${highestApplied}.`);
    }
  }
  return { applied, pending, issues };
}

/** Read-only: never creates the history table or changes the database. */
export async function getMigrationStatus(
  pool: pg.Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationStatus> {
  const files = await loadMigrationFiles(dir);
  await assertDatabaseMatchesEnvironment(pool);
  const applied = await readApplied(pool);
  return computeStatus(applied, files);
}

export interface RunResult {
  applied: string[];
}

/**
 * Applies pending migrations in order. Each migration runs in its own transaction together with
 * its history row, so a failure rolls that migration back completely and stops the run.
 * Migration SQL must therefore not contain its own BEGIN/COMMIT.
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  onApplied?: (file: MigrationFile) => void,
): Promise<RunResult> {
  const files = await loadMigrationFiles(dir);
  await assertDatabaseMatchesEnvironment(pool);
  const client = await pool.connect();
  const applied: string[] = [];
  // If the advisory lock cannot be confirmed released, the connection is destroyed instead of being
  // returned to the pool (closing a session always releases its session-level locks).
  let destroyClient = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
           version    text        PRIMARY KEY,
           name       text        NOT NULL,
           checksum   text        NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );

      const status = computeStatus(await readApplied(client), files);
      if (status.issues.length > 0) {
        throw new MigrationError(`Migration history problems:\n  - ${status.issues.join('\n  - ')}`);
      }

      for (const file of status.pending) {
        try {
          await client.query('BEGIN');
          await client.query(file.sql);
          await client.query(
            `INSERT INTO ${HISTORY_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (cause) {
          await client.query('ROLLBACK').catch(() => undefined);
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new MigrationError(`Migration ${file.filename} failed and was rolled back: ${reason}`, file.version, {
            cause,
          });
        }
        applied.push(file.version);
        onApplied?.(file);
      }
    } finally {
      try {
        const unlocked = await client.query<{ ok: boolean }>('SELECT pg_advisory_unlock($1) AS ok', [
          ADVISORY_LOCK_KEY,
        ]);
        if (unlocked.rows[0]?.ok !== true) destroyClient = true;
      } catch {
        destroyClient = true;
      }
    }
  } finally {
    client.release(destroyClient);
  }
  return { applied };
}
