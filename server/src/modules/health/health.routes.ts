import { Router } from 'express';
import { pingDatabase, type Queryable } from '../../database/connection.js';

export interface HealthDeps {
  db: Queryable;
  appVersion: string | undefined;
}

/**
 * GET /api/v1/health: unauthenticated liveness + database check.
 * Reports only up/down states: no hostnames, credentials, or error text.
 */
export function createHealthRouter({ db, appVersion }: HealthDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const databaseUp = await pingDatabase(db);
    res.status(databaseUp ? 200 : 503).json({
      status: databaseUp ? 'ok' : 'degraded',
      database: databaseUp ? 'up' : 'down',
      version: appVersion ?? null,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
