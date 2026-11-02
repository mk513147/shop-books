/**
 * The one database the automated test suite may use. Tests truncate it freely, so nothing else
 * (development, staging, production) may ever point at it, and the suite refuses any other name.
 */
export const DESIGNATED_TEST_DATABASE = 'shop_books_test';

/**
 * Persistent environments (staging, production) are recognised by name. Such a database is never
 * disposable: it may only be opened with NODE_ENV=production, and destructive tooling needs the
 * operator to confirm its exact name.
 */
export function isProtectedDatabaseName(databaseName: string): boolean {
  return /staging|prod/i.test(databaseName);
}

/**
 * Environment/database isolation rule, shared by config validation and the migration runner:
 *  - NODE_ENV=test  => the database name MUST end in "_test"
 *  - any other env  => the database name must NOT end in "_test"
 *  - a staging/production database (see isProtectedDatabaseName) only with NODE_ENV=production
 * Returns a human-readable problem (no secrets) or null when the combination is allowed.
 */
export function databaseNameProblem(nodeEnv: string, databaseName: string): string | null {
  const looksLikeTestDb = databaseName.toLowerCase().endsWith('_test');
  if (isProtectedDatabaseName(databaseName) && nodeEnv !== 'production') {
    return `"${databaseName}" is a staging/production database and may only be used when NODE_ENV=production`;
  }
  if (nodeEnv === 'test' && !looksLikeTestDb) {
    return 'when NODE_ENV=test the database name must end in "_test" (refusing to run tests against a non-test database)';
  }
  if (nodeEnv !== 'test' && looksLikeTestDb) {
    return 'a database whose name ends in "_test" may only be used when NODE_ENV=test';
  }
  return null;
}

/** The development database: routine local commands (e.g. `npm run db:migrate`) need no confirmation only here. */
export const DESIGNATED_DEV_DATABASE = 'shop_books_dev';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/**
 * Query parameters that cannot redirect a connection. The pg driver copies EVERY query parameter
 * into its settings (`?host=`, `?port=`, `?user=`, ... override the URL), so anything else fails closed.
 */
const SAFE_URL_PARAMS = new Set([
  'sslmode',
  // Neon's default URLs carry channel_binding=require: it only hardens authentication (SCRAM channel binding).
  'channel_binding',
  'application_name',
  'connect_timeout',
]);

export interface ConnectionTarget {
  host: string;
  database: string;
  /** localhost / 127.0.0.1 / ::1 over TCP. */
  local: boolean;
}

/**
 * Where a DATABASE_URL really connects (host and database), or why that cannot be trusted:
 * unparseable URL, missing or socket host, missing database name, or a redirecting query parameter.
 */
export function connectionTarget(url: string): { target: ConnectionTarget; problem: null } | { target: null; problem: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { target: null, problem: 'the database URL cannot be parsed' };
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { target: null, problem: 'the database URL is not a postgres:// URL' };
  }
  for (const key of parsed.searchParams.keys()) {
    if (!SAFE_URL_PARAMS.has(key)) {
      return { target: null, problem: `the database URL contains the query parameter "${key}", which can redirect the connection` };
    }
  }
  const host = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  if (host === '' || /%2f/i.test(host)) return { target: null, problem: 'the database host cannot be determined' };
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return { target: null, problem: 'the database name cannot be determined' };
  }
  if (database === '') return { target: null, problem: 'the database name cannot be determined' };
  return { target: { host, database, local: LOCAL_HOSTS.has(host.toLowerCase()) }, problem: null };
}

/**
 * Automated tests: the URL must reach exactly the designated test database on this machine.
 * (connectTestDatabase() additionally checks the name and address PostgreSQL itself reports.)
 */
export function testDatabaseUrlProblem(url: string): string | null {
  const { target, problem } = connectionTarget(url);
  if (problem !== null) return problem;
  if (!target.local) return `the database host "${target.host}" is not local (only localhost / 127.0.0.1 / ::1)`;
  if (target.database !== DESIGNATED_TEST_DATABASE) return `"${target.database}" is not "${DESIGNATED_TEST_DATABASE}"`;
  return null;
}

/**
 * Commands that change a database (db:migrate, documents:reconcile --delete-orphans). Fails closed
 * when the target cannot be determined or the server reports a different database. Only the two
 * routine combinations run without confirmation: NODE_ENV=development on the local shop_books_dev,
 * and NODE_ENV=test on the local shop_books_test. Everything else (any remote host, production
 * mode, any other or protected name, whatever NODE_ENV says) needs `--confirm-database=<exact name>`.
 */
export function operationProblem(nodeEnv: string, databaseUrl: string, connectedDatabase: string, args: string[]): string | null {
  const { target, problem } = connectionTarget(databaseUrl);
  if (problem !== null) return `${problem}. Nothing was changed.`;
  if (connectedDatabase !== target.database) {
    return `the server reports database "${connectedDatabase}" but the URL names "${target.database}". Nothing was changed.`;
  }
  const routine =
    target.local &&
    ((nodeEnv === 'development' && target.database === DESIGNATED_DEV_DATABASE) ||
      (nodeEnv === 'test' && target.database === DESIGNATED_TEST_DATABASE));
  if (routine) return null;
  const given = args.find((a) => a.startsWith('--confirm-database='))?.slice('--confirm-database='.length);
  if (given === connectedDatabase) return null;
  const why = !target.local
    ? `is on the remote host "${target.host}"`
    : nodeEnv === 'production'
      ? 'is used in production mode'
      : isProtectedDatabaseName(connectedDatabase)
        ? 'is a staging/production database'
        : `is not the designated database for NODE_ENV=${nodeEnv}`;
  return given === undefined
    ? `"${connectedDatabase}" ${why}. Check db:status, then re-run with --confirm-database=${connectedDatabase}.`
    : `--confirm-database=${given} does not match the connected database "${connectedDatabase}". Nothing was changed.`;
}
