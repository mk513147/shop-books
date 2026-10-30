import { Router } from 'express';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../database/connection.js';
import { requireAuth, requireCsrf, requirePasswordCurrent, requireRole } from '../middleware/auth.js';
import { requireJson, verifyOrigin } from '../middleware/requestGuards.js';
import { createAuthRouter, createLoginHandler } from '../modules/auth/auth.routes.js';
import { createCategoriesRouter } from '../modules/categories/categories.routes.js';
import { createExpensesRouter } from '../modules/expenses/expenses.routes.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import { createSuppliersRouter } from '../modules/suppliers/suppliers.routes.js';
import { createUsersRouter } from '../modules/users/users.routes.js';

export interface RouteDeps {
  db: Database;
  config: AppConfig;
}

/**
 * Mounts every module under /api/v1. ORDER MATTERS: this is deny-by-default.
 *
 *   1. cross-site guards for all state-changing requests (Origin/Referer + JSON only)
 *   2. PUBLIC:  /health, POST /auth/login           <- nothing else may go above requireAuth
 *   3. requireAuth + requireCsrf                     <- everything below needs a session
 *   4. /auth (me, logout, change-password)           <- usable while a password change is pending
 *   5. requirePasswordCurrent                        <- everything below needs a non-temporary password
 *   6. feature modules (owner-only ones add requireRole('owner'))
 */
export function createApiRouter({ db, config }: RouteDeps): Router {
  const router = Router();

  router.use(verifyOrigin(config.frontendOrigins));
  router.use(requireJson);

  router.use('/health', createHealthRouter({ db, appVersion: config.appVersion }));
  router.post('/auth/login', createLoginHandler({ db, config }));

  router.use(requireAuth(db, config));
  router.use(requireCsrf(config));

  router.use('/auth', createAuthRouter({ db, config }));

  router.use(requirePasswordCurrent);

  router.use('/users', requireRole('owner'), createUsersRouter({ db }));
  // Financial modules: owner AND managers (managers are not read-only).
  router.use('/categories', createCategoriesRouter({ db }));
  router.use('/expenses', createExpensesRouter({ db }));
  router.use('/suppliers', createSuppliersRouter({ db }));

  return router;
}
