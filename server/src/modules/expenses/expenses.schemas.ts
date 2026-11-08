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
 * so an omitted optional field means "empty", never "unchanged" — with ONE exception: the
 * classification. `brandIds`, and the other categories behind a legacy single `categoryId`, are
 * KEPT when omitted on an update, so an older frontend cannot clear them without knowing about them.
 *
 * Payments are sent as `payments` (one row per payment method). The older single-payment fields
 * `amountPaid` + `paymentMode` are still accepted when `payments` is absent and are converted to it.
 */
/** Most categories / brands on one expense (protects the UI and the database). */
export const MAX_EXPENSE_CATEGORIES = 20;
export const MAX_EXPENSE_BRANDS = 50;

/** An ordered list of distinct ids (the order is the user's; the first category is the primary one). */
const idList = (label: string, max: number) =>
  z
    .array(z.uuid(`Invalid ${label}`))
    .max(max, `At most ${max} ${label === 'category' ? 'categories' : `${label}s`}`)
    .refine((ids) => new Set(ids).size === ids.length, `Each ${label} can be chosen only once`);

const expenseFields = {
  expenseDate: calendarDateSchema,
  // A supplier record (never free text); null when no supplier applies.
  supplierId: z.uuid('Choose a supplier from the list').nullish().transform((v) => v ?? null),
  // Classification (migration 0012): one or more categories, the first being the primary one, and
  // any number of brands. Labels only: they never split or multiply the amount.
  categoryIds: idList('category', MAX_EXPENSE_CATEGORIES).optional(),
  // Older clients send a single category; still accepted (never together with categoryIds).
  categoryId: z.uuid('Choose a category').optional(),
  brandIds: idList('brand', MAX_EXPENSE_BRANDS).optional(),
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
  categoryIds?: string[] | undefined;
  categoryId?: string | undefined;
  brandIds?: string[] | undefined;
}

/**
 * Resolves `categoryIds` / legacy `categoryId` into an ordered list (at least one). With the legacy
 * single field the list has just that category; `categoriesFromLegacy` tells the update to keep the rest.
 */
function resolveCategories(v: RawExpenseFields, ctx: z.core.$RefinementCtx): string[] {
  if (v.categoryIds !== undefined && v.categoryId !== undefined) {
    ctx.issues.push({ code: 'custom', message: 'Send either categoryIds or categoryId, not both', input: v, path: ['categoryIds'] });
    return [];
  }
  const ids = v.categoryIds ?? (v.categoryId !== undefined ? [v.categoryId] : []);
  if (ids.length === 0) {
    ctx.issues.push({ code: 'custom', message: 'Choose at least one category', input: v, path: ['categoryIds'] });
  }
  return ids;
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
  const {
    amountPaid: _amountPaid,
    paymentMode: _paymentMode,
    payments: _payments,
    categoryId: _categoryId,
    categoryIds: _categoryIds,
    brandIds: _brandIds,
    ...rest
  } = v;
  return {
    ...rest,
    categoryIds: resolveCategories(v, ctx),
    // True when only the older single `categoryId` was sent: it names the PRIMARY category only,
    // so on an update the expense's other categories are kept (see updateExpense).
    categoriesFromLegacy: v.categoryIds === undefined,
    // undefined = "not sent": an update keeps the saved brands; a create starts with none. An explicit
    // empty array is the only way to clear them.
    brandIds: v.brandIds,
    payments: resolvePayments(v, ctx),
  };
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
  /** Matches expenses that carry this category in ANY position (each expense still counted once). */
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
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
