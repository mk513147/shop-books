// Builds two real production versions of the frontend for the deployment simulation:
// .deploy-sim/a (build id "sim-a") and .deploy-sim/b (build id "sim-b"). Same source; the build id
// alone makes every hashed file, index.html and sw.js differ, exactly as two Vercel deployments do.
import { execSync } from 'node:child_process';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '../..');
for (const version of ['a', 'b']) {
  execSync(`npx vite build --outDir .deploy-sim/${version} --emptyOutDir --logLevel warn`, {
    cwd: web,
    stdio: 'inherit',
    env: { ...process.env, SHOP_BOOKS_BUILD_ID: `sim-${version}` },
  });
}
console.log('Built .deploy-sim/a and .deploy-sim/b');
