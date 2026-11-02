import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pino } from 'pino';
import type { AppConfig } from '../src/config/env.js';
import { loadDatabaseConfig } from '../src/config/env.js';
import { configureTypeParsers, type Database } from '../src/database/connection.js';
import { DESIGNATED_TEST_DATABASE, testDatabaseUrlProblem } from '../src/database/isolation.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    databaseUrl: 'postgresql://unused:unused@localhost:5432/unused_test',
    databasePoolMax: 2,
    port: 0,
    host: undefined,
    frontendOrigins: ['http://localhost:5173'],
    logLevel: 'silent',
    trustProxy: false,
    appVersion: '1.2.3-test',
    sessionSecret: 'test-secret-'.padEnd(48, 'x'),
    documentStorage: { driver: 'local', directory: path.join(tmpdir(), 'shop-books-test-documents') },
    shopName: 'Test Shop',
    email: { provider: 'outbox', from: 'Test Shop <reports@example.test>', outboxDirectory: path.join(tmpdir(), 'shop-books-test-outbox') },
    reportScheduler: { enabled: false, intervalMs: 60_000 },
    cookie: { name: 'sb_session', secure: false, sameSite: 'lax' },
    ...overrides,
  };
}

export const silentLogger = pino({ level: 'silent' });

/** A database stand-in for tests that do not need PostgreSQL. */
export function fakeDb(behaviour: 'up' | 'down'): Database {
  const query = (async () => {
    if (behaviour === 'down') throw new Error('connect ECONNREFUSED secret-host:5432');
    return { rows: [], rowCount: 0 };
  }) as unknown as Database['query'];
  const connect = (async () => {
    throw new Error('fakeDb does not support transactions');
  }) as unknown as Database['connect'];
  return { query, connect };
}

/** Headers a browser on the configured frontend origin would send for a state-changing request. */
export const BROWSER_HEADERS = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };

/**
 * Connects to the dedicated test database (from .env.test or the environment) if one is reachable.
 * Returns null when it is not configured or not reachable, so integration tests can skip honestly.
 * Throws (never skips) when the URL is not the local designated test database, or when PostgreSQL
 * itself reports another database or a non-loopback server address. Nothing destructive runs before.
 */
export async function connectTestDatabase(): Promise<pg.Pool | null> {
  configureTypeParsers();
  const url = process.env.DATABASE_URL;
  if (url === undefined) return null;
  const urlProblem = testDatabaseUrlProblem(url);
  if (urlProblem !== null) throw new Error(`Refusing to run integration tests: ${urlProblem}.`);
  let pool: pg.Pool;
  let server: { name: string; addr: string | null };
  try {
    // Enforces NODE_ENV=test => database name ends in "_test".
    const config = loadDatabaseConfig();
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 3000 });
    pool.on('error', () => undefined);
    server = (await pool.query<{ name: string; addr: string | null }>('SELECT current_database() AS name, host(inet_server_addr()) AS addr')).rows[0]!;
  } catch {
    return null;
  }
  // inet_server_addr() is NULL over a Unix socket, otherwise the address the server accepted us on.
  const loopback = server.addr === null || server.addr === '127.0.0.1' || server.addr === '::1';
  if (server.name !== DESIGNATED_TEST_DATABASE || !loopback) {
    await pool.end();
    throw new Error(
      `Refusing to run integration tests: the server reports database "${server.name}" at ${server.addr ?? 'a local socket'}; only "${DESIGNATED_TEST_DATABASE}" on this machine is allowed.`,
    );
  }
  return pool;
}
