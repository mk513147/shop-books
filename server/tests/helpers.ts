import pg from 'pg';
import { pino } from 'pino';
import type { AppConfig } from '../src/config/env.js';
import { loadDatabaseConfig } from '../src/config/env.js';
import { configureTypeParsers, type Queryable } from '../src/database/connection.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    databaseUrl: 'postgresql://unused:unused@localhost:5432/unused_test',
    databasePoolMax: 2,
    port: 0,
    frontendOrigins: ['http://localhost:5173'],
    logLevel: 'silent',
    trustProxy: false,
    appVersion: '1.2.3-test',
    sessionSecret: undefined,
    ...overrides,
  };
}

export const silentLogger = pino({ level: 'silent' });

/** A database stand-in for tests that do not need PostgreSQL. */
export function fakeDb(behaviour: 'up' | 'down'): Queryable {
  const query = (async () => {
    if (behaviour === 'down') throw new Error('connect ECONNREFUSED secret-host:5432');
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }) as unknown as Queryable['query'];
  return { query };
}

/**
 * Connects to the dedicated test database (from .env.test or the environment) if one is reachable.
 * Returns null when it is not configured or not reachable, so integration tests can skip honestly.
 */
export async function connectTestDatabase(): Promise<pg.Pool | null> {
  configureTypeParsers();
  try {
    // Enforces NODE_ENV=test => database name ends in "_test".
    const config = loadDatabaseConfig();
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 3000 });
    pool.on('error', () => undefined);
    await pool.query('SELECT 1');
    return pool;
  } catch {
    return null;
  }
}
