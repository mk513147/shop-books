import { Router } from 'express';
import type { Queryable } from '../database/connection.js';
import { createHealthRouter } from '../modules/health/health.routes.js';

export interface RouteDeps {
  db: Queryable;
  appVersion: string | undefined;
}

/** Mounts every feature module under /api/v1. Future modules are registered here. */
export function createApiRouter(deps: RouteDeps): Router {
  const router = Router();
  router.use('/health', createHealthRouter(deps));
  return router;
}
