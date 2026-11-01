import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Database, Queryable } from '../../database/connection.js';
import { perUserRateLimit } from '../../middleware/rateLimit.js';
import { calendarDateSchema, todayInReportingZone } from '../../utils/dates.js';
import { ValidationError } from '../../utils/errors.js';
import { customerLedgerQuerySchema } from '../customers/customers.schemas.js';
import { contentDisposition } from '../documents/documents.routes.js';
import { monthLabel, resolvePeriod, type Period } from '../reports/period.js';
import {
  customerReportQuerySchema,
  expenseReportQuerySchema,
  monthlyQuerySchema,
  supplierReportQuerySchema,
  transactionsQuerySchema,
} from '../reports/reports.schemas.js';
import { ledgerQuerySchema } from '../supplierPayments/supplierPayments.schemas.js';
import { workbookBuffer } from './excel.js';
import {
  exportCategories,
  exportCustomerLedger,
  exportCustomerReport,
  exportExpenses,
  exportMonthly,
  exportSupplierLedger,
  exportSupplierPayments,
  exportSuppliers,
  exportTransactions,
  type ExportResult,
} from './exports.service.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function send(res: Response, shopName: string, result: ExportResult): Promise<void> {
  const buffer = await workbookBuffer(result.workbook);
  const shop = shopName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'shop-books';
  res.set('Content-Type', XLSX);
  res.set('Content-Disposition', contentDisposition('attachment', `${shop}_${result.name}.xlsx`));
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Content-Length', String(buffer.length));
  res.send(buffer);
}

/** Human-readable filter lines for the workbook header (names looked up by id; never raw SQL). */
async function labels(db: Queryable, f: Record<string, unknown>): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const name = async (table: 'expense_categories' | 'suppliers' | 'users' | 'customers', id: unknown) =>
    (await db.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? 'Unknown';
  if (f.categoryId) out.push(['Category', await name('expense_categories', f.categoryId)]);
  if (f.supplierId) out.push(['Supplier', await name('suppliers', f.supplierId)]);
  if (f.recordedBy) out.push(['Recorded by', await name('users', f.recordedBy)]);
  if (f.paymentMode) out.push(['Payment mode', f.paymentMode === 'none' ? 'Nothing paid at purchase' : String(f.paymentMode)]);
  if (f.status && f.status !== 'all') out.push(['Status', String(f.status)]);
  if (f.allocation) out.push(['Allocation', String(f.allocation)]);
  if (f.outstandingOnly) out.push(['Only with a balance', 'Yes']);
  if (f.type) out.push(['Type', Array.isArray(f.type) ? f.type.join(', ') : String(f.type)]);
  if (f.q) out.push(['Search', String(f.q)]);
  return out;
}

const uuid = (what: string) => z.uuid(`Choose a ${what}`);

const supplierPaymentsQuery = z.object({
  supplierId: z.uuid().optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  status: z.enum(['active', 'reversed', 'all']).default('active'),
  allocation: z.enum(['unallocated', 'partial', 'full', 'open']).optional(),
  q: z.string().trim().max(100).optional(),
});

/** A from/to pair (either optional) as a Period for the export header and queries. */
function openPeriod(from?: string, to?: string): Period {
  if (from && to && from > to) throw new ValidationError([{ path: 'to', message: 'The end date must not be before the start date' }]);
  if (!from && !to) return resolvePeriod({ period: 'all_time' });
  const f = from ?? '2000-01-01';
  const t = to ?? todayInReportingZone();
  return { preset: 'custom', from: f, to: t, previous: null, label: `${f} to ${t}` };
}

/**
 * Excel downloads (owner and managers; mounted below requirePasswordCurrent). GET requests with
 * the same validated filters as the report pages. 30 exports per 10 minutes per user.
 */
export function createExportsRouter({ db, shopName }: { db: Database; shopName: string }): Router {
  const router = Router();
  router.use(perUserRateLimit('export', 30, 10 * 60 * 1000));

  router.get('/expenses', async (req, res) => {
    const q = expenseReportQuerySchema.extend({ status: z.enum(['active', 'voided', 'all']).default('all') }).parse(req.query);
    await send(res, shopName, await exportExpenses(db, shopName, resolvePeriod(q), q, await labels(db, q)));
  });

  router.get('/categories', async (req, res) => {
    const q = expenseReportQuerySchema.parse(req.query);
    await send(res, shopName, await exportCategories(db, shopName, resolvePeriod(q), q, await labels(db, q)));
  });

  router.get('/suppliers', async (req, res) => {
    const q = supplierReportQuerySchema.parse(req.query);
    await send(res, shopName, await exportSuppliers(db, shopName, resolvePeriod(q), q, await labels(db, q)));
  });

  router.get('/supplier-payments', async (req, res) => {
    const q = supplierPaymentsQuery.parse(req.query);
    await send(res, shopName, await exportSupplierPayments(db, shopName, openPeriod(q.from, q.to), q, await labels(db, q)));
  });

  router.get('/supplier-ledger', async (req, res) => {
    const { supplierId, ...q } = ledgerQuerySchema.extend({ supplierId: uuid('supplier') }).parse(req.query);
    await send(res, shopName, await exportSupplierLedger(db, shopName, supplierId, q));
  });

  for (const kind of ['due', 'advance'] as const) {
    router.get(kind === 'due' ? '/customer-dues' : '/customer-advances', async (req, res) => {
      const q = customerReportQuerySchema.parse(req.query);
      await send(res, shopName, await exportCustomerReport(db, shopName, kind, resolvePeriod(q), q, await labels(db, q)));
    });
  }

  router.get('/customer-ledger', async (req, res) => {
    const { customerId, ...q } = customerLedgerQuerySchema.extend({ customerId: uuid('customer') }).parse(req.query);
    await send(res, shopName, await exportCustomerLedger(db, shopName, customerId, q));
  });

  router.get('/transactions', async (req, res) => {
    const q = transactionsQuerySchema.parse(req.query);
    await send(res, shopName, await exportTransactions(db, shopName, resolvePeriod(q), { ...q, types: q.type }, await labels(db, q)));
  });

  router.get('/monthly', async (req, res) => {
    const { year, month } = monthlyQuerySchema.parse(req.query);
    if (`${year}-${String(month).padStart(2, '0')}` > todayInReportingZone().slice(0, 7)) {
      throw new ValidationError([{ path: 'month', message: 'That month has not started yet' }]);
    }
    await send(res, shopName, await exportMonthly(db, shopName, year, month, monthLabel(year, month)));
  });

  return router;
}

