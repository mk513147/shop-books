// tsc does not copy .sql files. Copy them next to the compiled migration runner.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(serverDir, 'src', 'database', 'migrations');
const to = join(serverDir, 'dist', 'database', 'migrations');

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log('Copied SQL migrations to dist/database/migrations');
