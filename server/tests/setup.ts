import { loadEnvFiles } from '../src/config/loadEnvFiles.js';

// Vitest sets NODE_ENV=test, so this reads <repo>/.env.test (if present) and never .env.development.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('Server tests must run with NODE_ENV=test');
}
loadEnvFiles();
