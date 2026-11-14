import { Router } from 'express';
import { CLIENT_COMPAT_LEVEL } from '../../config/constants.js';

export interface VersionDeps {
  appVersion: string | undefined;
}

/**
 * GET /api/v1/version: unauthenticated, cheap (no database access), used by installed apps to tell
 * whether they must refresh after a release.
 *
 * - `version`: the release label from APP_VERSION (already public through /health), or null.
 *   It changes only when a release sets a new value, never on a restart.
 * - `clientCompat`: the lowest web-app compatibility level this API works with. Raise it (here and
 *   API_COMPAT_LEVEL in web/src/features/system/app-update.ts) only when an API change needs the
 *   new frontend; older open apps then refresh themselves when it is safe.
 *
 * Deliberately nothing else: no build hashes, hostnames, environment names or configuration.
 */
export function createVersionRouter({ appVersion }: VersionDeps): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ version: appVersion ?? null, clientCompat: CLIENT_COMPAT_LEVEL });
  });
  return router;
}
