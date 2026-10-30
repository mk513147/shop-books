/**
 * Environment/database isolation rule, shared by config validation and the migration runner:
 *  - NODE_ENV=test  => the database name MUST end in "_test"
 *  - any other env  => the database name must NOT end in "_test"
 * Returns a human-readable problem (no secrets) or null when the combination is allowed.
 */
export function databaseNameProblem(nodeEnv: string, databaseName: string): string | null {
  const looksLikeTestDb = databaseName.toLowerCase().endsWith('_test');
  if (nodeEnv === 'test' && !looksLikeTestDb) {
    return 'when NODE_ENV=test the database name must end in "_test" (refusing to run tests against a non-test database)';
  }
  if (nodeEnv !== 'test' && looksLikeTestDb) {
    return 'a database whose name ends in "_test" may only be used when NODE_ENV=test';
  }
  return null;
}
