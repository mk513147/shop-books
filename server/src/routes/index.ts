import { Router } from 'express';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../database/connection.js';
import { requireAuth, requireCsrf, requirePasswordCurrent, requireRole } from '../middleware/auth.js';
import { requireJson, verifyOrigin } from '../middleware/requestGuards.js';
import { createAuthRouter, createLoginHandler } from '../modules/auth/auth.routes.js';
import { createBrandsRouter } from '../modules/brands/brands.routes.js';
import { createCategoriesRouter } from '../modules/categories/categories.routes.js';
import { createSyncRouter } from '../modules/sync/sync.routes.js';
import { createCustomersRouter } from '../modules/customers/customers.routes.js';
import { createSalesmenRouter } from '../modules/salesmen/salesmen.routes.js';
import { createExportsRouter } from '../modules/exports/exports.routes.js';
import { createExpensesRouter } from '../modules/expenses/expenses.routes.js';
import { createDocumentStorageStatusRouter } from '../modules/documents/documents.routes.js';
import type { DocumentStorage } from '../modules/documents/storage.js';
import type { EmailSender } from '../modules/email/email.js';
import { createMonthlyReportsRouter } from '../modules/monthlyReports/monthlyReports.routes.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import { createVersionRouter } from '../modules/health/version.routes.js';
import { createReportsRouter } from '../modules/reports/reports.routes.js';
import { createSupplierPaymentsRouter } from '../modules/supplierPayments/supplierPayments.routes.js';
import { createSuppliersRouter } from '../modules/suppliers/suppliers.routes.js';
import { createUsersRouter } from '../modules/users/users.routes.js';

export interface RouteDeps {
  db: Database;
  config: AppConfig;
  storage: DocumentStorage;
  emailSender: EmailSender;
  onReportQueued?: (() => void) | undefined;
}

/**
 * Mounts every module under /api/v1. ORDER MATTERS: this is deny-by-default.
 *
 *   1. cross-site guards for all state-changing requests (Origin/Referer + JSON only)
 *   2. PUBLIC:  /health, /version, POST /auth/login <- nothing else may go above requireAuth
 *   3. requireAuth + requireCsrf                     <- everything below needs a session
 *   4. /auth (me, logout, change-password)           <- usable while a password change is pending
 *   5. requirePasswordCurrent                        <- everything below needs a non-temporary password
 *   6. feature modules (owner-only ones add requireRole('owner'))
 */
export function createApiRouter({ db, config, storage, emailSender, onReportQueued }: RouteDeps): Router {
  const router = Router();

  // API responses (financial data, private documents) must never be stored by browsers or proxies.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.use(verifyOrigin(config.frontendOrigins));
  router.use(requireJson);

  router.use('/health', createHealthRouter({ db, appVersion: config.appVersion }));
  router.use('/version', createVersionRouter({ appVersion: config.appVersion }));
  router.post('/auth/login', createLoginHandler({ db, config }));

  router.use(requireAuth(db, config));
  router.use(requireCsrf(config));

  router.use('/auth', createAuthRouter({ db, config }));

  router.use(requirePasswordCurrent);

  router.use('/users', requireRole('owner'), createUsersRouter({ db }));
  router.use(
    '/monthly-reports',
    requireRole('owner'),
    createMonthlyReportsRouter({
      db,
      sender: emailSender,
      shopName: config.shopName,
      from: config.email.from,
      schedulerEnabled: config.reportScheduler.enabled,
      onQueued: onReportQueued,
    }),
  );
  // Financial modules: owner AND managers (managers are not read-only).
  router.use('/categories', createCategoriesRouter({ db }));
  router.use('/brands', createBrandsRouter({ db }));
  // Change feed for live updates across devices (read-only; no amounts or other figures).
  router.use('/sync', createSyncRouter({ db }));
  router.use('/expenses', createExpensesRouter({ db, storage }));
  router.use('/document-storage', createDocumentStorageStatusRouter({ storage }));
  router.use('/suppliers', createSuppliersRouter({ db }));
  router.use('/supplier-payments', createSupplierPaymentsRouter({ db }));
  router.use('/customers', createCustomersRouter({ db }));
  router.use('/salesmen', createSalesmenRouter({ db }));
  router.use('/reports', createReportsRouter({ db }));
  router.use('/exports', createExportsRouter({ db, shopName: config.shopName }));

  return router;
}
