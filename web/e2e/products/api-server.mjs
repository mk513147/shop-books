// Starts the REAL API for the product e2e suite against the LOCAL TEST DATABASE only:
// seeds shop_books_test (server/tests/e2e/productsE2eSeed.ts, which refuses any other database),
// then runs the API on :3000 with NODE_ENV=test, accepting requests from the preview origin.
// The Vite preview (:4173) proxies /api to it. Nothing here touches development or production.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server');
const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: '3000',
  FRONTEND_URL: 'http://localhost:4173',
  REPORT_SCHEDULER_ENABLED: 'false',
  LOG_LEVEL: 'warn',
};
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const seed = spawnSync(npx, ['tsx', 'tests/e2e/productsE2eSeed.ts'], { cwd: serverDir, env, stdio: 'inherit', shell: process.platform === 'win32' });
if (seed.status !== 0) process.exit(seed.status ?? 1);

const api = spawn(npx, ['tsx', 'src/server.ts'], { cwd: serverDir, env, stdio: 'inherit', shell: process.platform === 'win32' });
const stop = () => api.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => process.exit(code ?? 0));
