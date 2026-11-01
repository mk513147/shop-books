import { z } from 'zod';
import { PAYMENT_MODES } from '../expenses/expenses.schemas.js';
import { periodQueryShape } from './period.js';
import { TRANSACTION_TYPES } from './reports.service.js';

/** Query strings: "true"/"1" -> true. */
const flag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');
const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const dashboardQuerySchema = z.object(periodQueryShape);

/** Expense and category reports: period + the expense filters (fixed list; no free-form fields). */
export const expenseReportQuerySchema = z.object({
  ...periodQueryShape,
  categoryId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  paymentMode: z.enum([...PAYMENT_MODES, 'none']).optional(),
  recordedBy: z.uuid().optional(),
});
export type ExpenseReportQuery = z.infer<typeof expenseReportQuerySchema>;

export const supplierReportQuerySchema = z.object({
  ...periodQueryShape,
  period: periodQueryShape.period.removeDefault().default('all_time'),
  supplierId: z.uuid().optional(),
  status: z.enum(['active', 'archived', 'all']).default('all'),
  outstandingOnly: flag,
  ...page,
});

export const customerReportQuerySchema = z.object({
  ...periodQueryShape,
  period: periodQueryShape.period.removeDefault().default('all_time'),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('all'),
  outstandingOnly: flag,
  ...page,
});

/** `type` may repeat or be comma-separated: ?type=expense,supplier_payment */
const typesSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).filter(Boolean)))
  .pipe(z.array(z.enum(TRANSACTION_TYPES)).max(TRANSACTION_TYPES.length).optional());

export const transactionsQuerySchema = z.object({
  ...periodQueryShape,
  period: periodQueryShape.period.removeDefault().default('this_month'),
  type: typesSchema,
  status: z.enum(['active', 'cancelled', 'all']).default('all'),
  q: z.string().trim().max(100).optional(),
  ...page,
});

export const activityQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) });

export const monthlyQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});
