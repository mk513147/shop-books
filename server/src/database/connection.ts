import pg from 'pg';
import type { Logger } from 'pino';
import type { DatabaseConfig } from '../config/env.js';

/** Anything that can run a parameterized query (a Pool or a PoolClient). */
export interface Queryable {
  query: pg.Pool['query'];
}

const PG_TYPE_DATE = 1082;

let parsersConfigured = false;

/**
 * Database type conventions (see docs/database.md):
 *  - NUMERIC is left as a string by `pg` (never parsed to a float) so money stays exact.
 *  - DATE is returned as a 'YYYY-MM-DD' string, not a JS Date, to avoid timezone shifts.
 */
export function configureTypeParsers(): void {
  if (parsersConfigured) return;
  pg.types.setTypeParser(PG_TYPE_DATE, (value: string) => value);
  parsersConfigured = true;
}

export function createPool(config: DatabaseConfig, logger?: Logger): pg.Pool {
  configureTypeParsers();
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'shop-books-api',
  });
  // An error on an idle client must not crash the process.
  pool.on('error', (err) => {
    logger?.error({ err }, 'Unexpected error on idle PostgreSQL client');
  });
  return pool;
}

/** Resolves true when `SELECT 1` succeeds within the timeout; never throws. */
export async function pingDatabase(db: Queryable, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const query = Promise.resolve()
    .then(() => db.query('SELECT 1 AS ok'))
    .then(
      () => true as const,
      () => false as const,
    );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
