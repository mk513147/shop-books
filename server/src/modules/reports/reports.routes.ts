import { Router } from 'express';
import type { Database } from '../../database/connection.js';
import { todayInReportingZone } from '../../utils/dates.js';
import { ValidationError } from '../../utils/errors.js';
import { monthLabel, monthRange, resolvePeriod } from './period.js';
import {
  activityQuerySchema,
  customerReportQuerySchema,
  dashboardQuerySchema,
  expenseReportQuerySchema,
  monthlyQuerySchema,
  supplierReportQuerySchema,
  transactionsQuerySchema,
} from './reports.schemas.js';
import {
  categoryBreakdown,
  customerReport,
  dashboard,
  expenseTotals,
  listTransactions,
  monthlyExpenseTrend,
  monthlySummary,
  percentChange,
  paidStatusBreakdown,
  paymentModeBreakdown,
  recentActivity,
  supplierBreakdown,
  supplierReport,
} from './reports.service.js';

/**
 * Read-only financial reports (owner and managers; mounted below requirePasswordCurrent).
 * Every figure is computed in PostgreSQL by reports.service.ts; nothing is calculated in the browser.
 *
 *   GET /dashboard              period activity + current balances + 6-month trend + recent activity
 *   GET /expenses               totals, paid status, payment modes, top suppliers, monthly trend
 *   GET /categories             category breakdown with previous-period comparison
 *   GET /suppliers              supplier report (period activity + current balances), paginated
 *   GET /customers/dues         customer DUE report, paginated
 *   GET /customers/advances     customer ADVANCE report, paginated
 *   GET /transactions           unified transaction history, paginated
 *   GET /activity               most recently recorded transactions
 *   GET /monthly?year=&month=   monthly financial summary (same as the monthly e-mail)
 */
export function createReportsRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/dashboard', async (req, res) => {
    res.json({ dashboard: await dashboard(db, resolvePeriod(dashboardQuerySchema.parse(req.query))) });
  });

  router.get('/expenses', async (req, res) => {
    const q = expenseReportQuerySchema.parse(req.query);
    const period = resolvePeriod(q);
    const f = { ...q, from: period.from, to: period.to };
    // Trend: whole months covering the period, at least the last 6 and at most the last 24 months.
    const [ty, tm] = period.to.split('-').map(Number) as [number, number];
    const sixBack = monthRange(ty, tm - 5).from;
    const cap = monthRange(ty, tm - 23).from;
    const trendFrom = [period.from < sixBack ? period.from : sixBack, cap].sort().at(-1)!;
    const [totals, previous, paidStatus, modes, suppliers, trend] = await Promise.all([
      expenseTotals(db, f),
      period.previous ? expenseTotals(db, { ...f, ...period.previous }) : null,
      paidStatusBreakdown(db, f),
      paymentModeBreakdown(db, f),
      supplierBreakdown(db, f, 10),
      monthlyExpenseTrend(db, { ...f, from: trendFrom }),
    ]);
    const changePercent = previous ? percentChange(totals.amount, previous.amount) : null;
    res.json({ period, totals, previous, changePercent, paidStatus, paymentModes: modes, topSuppliers: suppliers, trend });
  });

  router.get('/categories', async (req, res) => {
    const q = expenseReportQuerySchema.parse(req.query);
    const period = resolvePeriod(q);
    res.json({ period, ...(await categoryBreakdown(db, { ...q, from: period.from, to: period.to }, period.previous)) });
  });

  router.get('/suppliers', async (req, res) => {
    const q = supplierReportQuerySchema.parse(req.query);
    const period = resolvePeriod(q);
    const all = period.preset === 'all_time';
    res.json({
      period,
      ...(await supplierReport(db, { ...q, from: all ? null : period.from, to: all ? null : period.to })),
    });
  });

  for (const kind of ['due', 'advance'] as const) {
    router.get(kind === 'due' ? '/customers/dues' : '/customers/advances', async (req, res) => {
      const q = customerReportQuerySchema.parse(req.query);
      const period = resolvePeriod(q);
      const all = period.preset === 'all_time';
      res.json({ period, ...(await customerReport(db, { ...q, kind, from: all ? null : period.from, to: all ? null : period.to })) });
    });
  }

  router.get('/transactions', async (req, res) => {
    const q = transactionsQuerySchema.parse(req.query);
    const period = resolvePeriod(q);
    res.json({
      period,
      ...(await listTransactions(db, { ...q, types: q.type, from: period.from, to: period.to })),
    });
  });

  router.get('/activity', async (req, res) => {
    res.json({ items: await recentActivity(db, activityQuerySchema.parse(req.query).limit) });
  });

  router.get('/monthly', async (req, res) => {
    const { year, month } = monthlyQuerySchema.parse(req.query);
    if (`${year}-${String(month).padStart(2, '0')}` > todayInReportingZone().slice(0, 7)) {
      throw new ValidationError([{ path: 'month', message: 'That month has not started yet' }]);
    }
    res.json({ summary: await monthlySummary(db, year, month, monthLabel(year, month)) });
  });

  return router;
}
