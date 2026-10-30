import { z } from 'zod';
import { calendarDateSchema } from '../../utils/dates.js';
import { moneySchema } from '../../utils/money.js';

export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Optional free text: trimmed; empty or missing becomes null. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null));

/**
 * The complete set of editable expense fields. Both create and update (PATCH) send the full set,
 * so an omitted optional field always means "empty", never "unchanged".
 */
export const expenseInputSchema = z.strictObject({
  expenseDate: calendarDateSchema,
  // A supplier record (never free text); null when no supplier applies.
  supplierId: z.uuid('Choose a supplier from the list').nullish().transform((v) => v ?? null),
  categoryId: z.uuid('Choose a category'),
  description: z.string().trim().min(1, 'Description is required').max(500, 'Description must be at most 500 characters'),
  amount: moneySchema,
  amountPaid: moneySchema.default('0'),
  paymentMode: z.enum(PAYMENT_MODES, 'Choose a valid payment mode').nullish().transform((v) => v ?? null),
  invoiceReference: optionalText(100, 'Invoice reference'),
});
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

/** PATCH: all fields plus the version the client last saw (optimistic concurrency). */
export const expenseUpdateSchema = expenseInputSchema.extend({
  version: z.number().int().positive(),
});

export const reasonSchema = z.strictObject({
  reason: z.string().trim().min(1, 'A reason is required').max(500, 'Reason must be at most 500 characters'),
  version: z.number().int().positive(),
});

export const SORT_FIELDS = ['date', 'amount', 'created'] as const;

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  categoryId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  paymentMode: z.enum([...PAYMENT_MODES, 'none']).optional(),
  recordedBy: z.uuid().optional(),
  status: z.enum(['active', 'voided', 'all']).default('active'),
  minAmount: moneySchema.optional(),
  maxAmount: moneySchema.optional(),
  sort: z.enum(SORT_FIELDS).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ExpenseListQuery = z.infer<typeof listQuerySchema>;
