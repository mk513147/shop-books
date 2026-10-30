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
  const nodeEnv = env.NODE_ENV || 'development';
  if (!/^[a-z]+$/.test(nodeEnv)) return null;
  const file = join(rootDir, `.env.${nodeEnv}`);
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
