import { loadEnvFiles } from '../src/config/loadEnvFiles.js';
import { DESIGNATED_TEST_DATABASE, testDatabaseUrlProblem } from '../src/database/isolation.js';

// Vitest sets NODE_ENV=test, so this reads <repo>/.env.test (if present) and never .env.development.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('Server tests must run with NODE_ENV=test');
}
// The suite truncates its database. It only ever reads .env.test: an env-file override (as used to
// start the staging backend) is refused rather than followed.
const envFile = process.env.SHOP_BOOKS_ENV_FILE?.trim();
if (envFile && envFile !== '.env.test') {
  throw new Error(`Refusing to run the server tests with SHOP_BOOKS_ENV_FILE=${envFile}: tests use .env.test only. Unset it first.`);
}
loadEnvFiles();
// Hard guard: the resolved URL must reach exactly the designated test database on this machine,
// whatever set it (.env.test or a DATABASE_URL in the shell): local host, exact name, and no query
// parameter that could redirect the connection. Checked again on the server in connectTestDatabase().
// Without a DATABASE_URL the integration tests skip; anything unknown is refused, never assumed safe.
if (process.env.DATABASE_URL !== undefined) {
  const problem = testDatabaseUrlProblem(process.env.DATABASE_URL);
  if (problem !== null) {
    throw new Error(`Refusing to run the server tests: ${problem}. They may only use "${DESIGNATED_TEST_DATABASE}" on localhost.`);
  }
}
