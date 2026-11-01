import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Repository root. Works from both src/ (tsx) and dist/ (compiled) because depth is identical. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Loads `.env.<NODE_ENV>` from the repository root, if present. Values already in the process
 * environment are never overwritten, so real environment variables always win.
 * NODE_ENV defaults to "development" when unset.
 */
export function loadEnvFiles(env: NodeJS.ProcessEnv = process.env, rootDir = REPO_ROOT): string | null {
  // Explicit file (e.g. SHOP_BOOKS_ENV_FILE=.env.staging for the staging backend): a ".env.*" file
  // in the repository root only, and it must exist (a typo must not silently fall back).
  const explicit = env.SHOP_BOOKS_ENV_FILE?.trim();
  if (explicit) {
    if (!/^\.env\.[a-z0-9-]+$/.test(explicit)) throw new Error('SHOP_BOOKS_ENV_FILE must be a ".env.<name>" file in the repository root');
    const file = join(rootDir, explicit);
    if (!existsSync(file)) throw new Error(`SHOP_BOOKS_ENV_FILE: ${explicit} not found in the repository root`);
    process.loadEnvFile(file);
    return file;
  }
  const nodeEnv = env.NODE_ENV || 'development';
  if (!/^[a-z]+$/.test(nodeEnv)) return null;
  const file = join(rootDir, `.env.${nodeEnv}`);
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
