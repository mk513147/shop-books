import { isAbsolute } from 'node:path';
import { loadEnvFiles } from '../config/loadEnvFiles.js';
import { LocalDocumentStorage } from '../modules/documents/localStorage.js';
import { createStorageAgent } from '../storageAgent/agentServer.js';
import { reportCliError, UserFacingError } from './shared.js';

/**
 * Runs the document storage agent on the owner's desktop (see docs/staging-deployment.md):
 *
 *   $env:SHOP_BOOKS_ENV_FILE = ".env.agent"; npm --prefix server run storage-agent
 *
 * Settings (environment or the env file):
 *   AGENT_STORAGE_DIR  absolute private folder for the bill documents (required)
 *   AGENT_SECRET       the same value as the API's DOCUMENT_STORAGE_AGENT_SECRET (>= 32 chars)
 *   AGENT_HOST         listen address, default 127.0.0.1 (cloudflared connects locally)
 *   AGENT_PORT         default 8787
 */
function main(): void {
  loadEnvFiles();
  const dir = process.env.AGENT_STORAGE_DIR?.trim() ?? '';
  const secret = process.env.AGENT_SECRET ?? '';
  const host = process.env.AGENT_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.AGENT_PORT ?? 8787);
  if (!dir || !isAbsolute(dir)) throw new UserFacingError('AGENT_STORAGE_DIR must be an absolute folder path.');
  if (secret.length < 32 || /change[_-]?me|placeholder|your[_-]/i.test(secret)) {
    throw new UserFacingError('AGENT_SECRET must be a random value of at least 32 characters.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserFacingError('AGENT_PORT must be a port number.');

  const server = createStorageAgent({
    storage: new LocalDocumentStorage(dir),
    secret,
    // Keys are random and carry no personal data; nothing else about a request is logged.
    log: (e) => console.log(JSON.stringify({ time: new Date().toISOString(), ...e })),
  });
  server.listen(port, host, () => console.log(`Shop-Books storage agent listening on http://${host}:${port} (folder: ${dir})`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

try {
  main();
} catch (err) {
  reportCliError('Storage agent', err);
}
