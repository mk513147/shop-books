import { z } from 'zod';
import { calendarDateSchema } from '../../utils/dates.js';
import { moneySchema, toPaise } from '../../utils/money.js';

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

/** Upper bound on payment rows per expense (one per method is plenty; protects the UI and DB). */
export const MAX_PAYMENT_LINES = 10;

const paymentLineSchema = z.strictObject({
  amount: moneySchema,
  paymentMode: z.enum(PAYMENT_MODES, 'Choose a valid payment method'),
});
export type PaymentLine = z.infer<typeof paymentLineSchema>;

/**
 * The complete set of editable expense fields. Both create and update (PATCH) send the full set,
 * so an omitted optional field always means "empty", never "unchanged".
 *
 * Payments are sent as `payments` (one row per payment method). The older single-payment fields
 * `amountPaid` + `paymentMode` are still accepted when `payments` is absent and are converted to it.
 */
const expenseFields = {
  expenseDate: calendarDateSchema,
  // A supplier record (never free text); null when no supplier applies.
  supplierId: z.uuid('Choose a supplier from the list').nullish().transform((v) => v ?? null),
  categoryId: z.uuid('Choose a category'),
  // Optional: empty or missing is stored as NULL.
  description: optionalText(500, 'Description'),
  amount: moneySchema,
  payments: z.array(paymentLineSchema).max(MAX_PAYMENT_LINES, `At most ${MAX_PAYMENT_LINES} payments`).optional(),
  amountPaid: moneySchema.optional(),
  paymentMode: z.enum(PAYMENT_MODES, 'Choose a valid payment mode').nullish().transform((v) => v ?? null),
  invoiceReference: optionalText(100, 'Invoice reference'),
};

interface RawExpenseFields {
  payments?: PaymentLine[] | undefined;
  amountPaid?: string | undefined;
  paymentMode: PaymentMode | null;
}

/** Resolves `payments` / legacy `amountPaid` + `paymentMode` into the canonical `payments` list. */
function resolvePayments(v: RawExpenseFields, ctx: z.core.$RefinementCtx): PaymentLine[] {
  if (v.payments !== undefined) {
    if (v.amountPaid !== undefined || v.paymentMode !== null) {
      ctx.issues.push({ code: 'custom', message: 'Send either payments or amountPaid/paymentMode, not both', input: v, path: ['payments'] });
    }
    return v.payments;
  }
  const paid = v.amountPaid ?? '0';
  if (toPaise(paid) === 0n) return [];
  if (v.paymentMode === null) {
    ctx.issues.push({ code: 'custom', message: 'Choose how the payment was made', input: v, path: ['paymentMode'] });
    return [];
  }
  return [{ amount: paid, paymentMode: v.paymentMode }];
}

function toExpenseInput<T extends RawExpenseFields>(v: T, ctx: z.core.$RefinementCtx) {
  const { amountPaid: _amountPaid, paymentMode: _paymentMode, payments: _payments, ...rest } = v;
  return { ...rest, payments: resolvePayments(v, ctx) };
}

export const expenseInputSchema = z.strictObject(expenseFields).transform(toExpenseInput);
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

/** PATCH: all fields plus the version the client last saw (optimistic concurrency). */
export const expenseUpdateSchema = z
  .strictObject({ ...expenseFields, version: z.number().int().positive() })
  .transform(toExpenseInput);

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
