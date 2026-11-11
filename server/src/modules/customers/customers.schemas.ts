import { z } from 'zod';
import { calendarDateSchema } from '../../utils/dates.js';
import { moneySchema } from '../../utils/money.js';
import { PAYMENT_MODES } from '../expenses/expenses.schemas.js';

/** Trimmed, runs of whitespace collapsed (the database requires this form, see customers_name_valid). */
const nameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Name is required').max(120, 'Name must be at most 120 characters'));

/** Optional text: trimmed; empty or missing becomes null. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null));

const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ' '))
  .refine((v) => v === '' || /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/.test(v), 'Enter a phone number using digits, spaces, +, - or ( )')
  .nullish()
  .transform((v) => (v ? v : null));

export const customerCreateSchema = z.strictObject({
  name: nameSchema,
  phone: phoneSchema,
  address: optionalText(300, 'Address'),
  notes: optionalText(1000, 'Notes'),
});
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

export const customerUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    phone: phoneSchema.optional(),
    address: optionalText(300, 'Address').optional(),
    notes: optionalText(1000, 'Notes').optional(),
    isActive: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => Object.keys(v).length > 1, 'Nothing to update');
export type CustomerUpdateInput = Omit<z.infer<typeof customerUpdateSchema>, 'version'>;

export const customerListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  /** due = due balance > 0; advance = advance balance > 0; any = either. */
  balance: z.enum(['all', 'due', 'advance', 'any']).default('all'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const CUSTOMER_TXN_TYPES = ['due', 'due_payment', 'advance', 'advance_refund'] as const;
export type CustomerTxnType = (typeof CUSTOMER_TXN_TYPES)[number];

const common = {
  amount: moneySchema,
  txnDate: calendarDateSchema,
  reference: optionalText(100, 'Reference'),
  notes: optionalText(1000, 'Notes'),
};
const mode = z.enum(PAYMENT_MODES, 'Choose how the money was paid');

/**
 * POST /customers/:id/dues: an amount the customer owes (no money moves). The CATEGORY (one of the
 * active expense categories) says what it is for; details go in `notes`. `description` is still
 * accepted (optional) for older clients, but a category is always required for new dues.
 */
export const dueSchema = z.strictObject({
  ...common,
  categoryId: z.uuid('Choose a category'),
  description: optionalText(500, 'Description'),
});
/** POST /customers/:id/advances: money received in advance. */
export const advanceSchema = z.strictObject({ ...common, paymentMode: mode, description: optionalText(500, 'Description') });
/** POST /customers/:id/due-payments: money received against ONE due. */
export const duePaymentSchema = z.strictObject({
  ...common,
  paymentMode: mode,
  dueId: z.uuid('Choose the due being paid'),
  description: optionalText(500, 'Description'),
});
/** POST /customers/:id/refunds: advance money given back (never more than the advance balance). */
export const refundSchema = z.strictObject({ ...common, paymentMode: mode, description: optionalText(500, 'Description') });

/**
 * POST /customers/:id/due-payments/settle-all: "Pay full outstanding amount". `amount` is the total
 * the user saw and confirmed; it must still equal the customer's outstanding due when the request
 * is processed (otherwise 409 OUTSTANDING_CHANGED and nothing is recorded).
 */
export const settleAllSchema = z.strictObject({
  amount: moneySchema,
  txnDate: calendarDateSchema,
  paymentMode: mode,
  reference: optionalText(100, 'Reference'),
  notes: optionalText(1000, 'Notes'),
});
export type SettleAllInput = z.infer<typeof settleAllSchema>;

export interface CustomerTxnInput {
  type: CustomerTxnType;
  amount: string;
  txnDate: string;
  paymentMode: (typeof PAYMENT_MODES)[number] | null;
  dueId: string | null;
  /** due only (required for new dues): an expense category. */
  categoryId: string | null;
  description: string | null;
  reference: string | null;
  notes: string | null;
}

export const reverseSchema = z.strictObject({
  reason: z.string().trim().min(1, 'A reason is required').max(500, 'Reason must be at most 500 characters'),
  version: z.number().int().positive(),
});

export const customerLedgerQuerySchema = z.object({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  type: z.enum(CUSTOMER_TXN_TYPES).optional(),
  /** Dues of this category, and the payments made against them. */
  categoryId: z.uuid().optional(),
  status: z.enum(['active', 'reversed', 'all']).default('all'),
});
export type CustomerLedgerQuery = z.infer<typeof customerLedgerQuerySchema>;
