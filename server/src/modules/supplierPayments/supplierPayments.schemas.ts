import { z } from 'zod';
import { calendarDateSchema } from '../../utils/dates.js';
import { moneySchema } from '../../utils/money.js';
import { PAYMENT_MODES } from '../expenses/expenses.schemas.js';

/** Optional free text: trimmed; empty or missing becomes null. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null));

export const allocationItemSchema = z.strictObject({
  expenseId: z.uuid('Choose a bill'),
  amount: moneySchema,
});

const allocationsSchema = z
  .array(allocationItemSchema)
  .max(100, 'At most 100 bills at once')
  .refine((items) => new Set(items.map((i) => i.expenseId)).size === items.length, 'Each bill can appear only once');

/** Fields that may be corrected later without reversing the payment. */
const metadataFields = {
  paymentDate: calendarDateSchema,
  paymentMode: z.enum(PAYMENT_MODES, 'Choose how the payment was made'),
  reference: optionalText(100, 'Reference'),
  notes: optionalText(1000, 'Notes'),
};

export const paymentCreateSchema = z.strictObject({
  supplierId: z.uuid('Choose a supplier'),
  amount: moneySchema,
  ...metadataFields,
  /** Optional allocation to the supplier's bills, applied in the same transaction. */
  allocations: allocationsSchema.default([]),
});
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

export const paymentUpdateSchema = z.strictObject({ ...metadataFields, version: z.number().int().positive() });
export type PaymentMetadataInput = Omit<z.infer<typeof paymentUpdateSchema>, 'version'>;

export const allocateSchema = z.strictObject({
  allocations: allocationsSchema.refine((items) => items.length > 0, 'Choose at least one bill'),
});

export const reasonOnlySchema = z.strictObject({
  reason: z.string().trim().min(1, 'A reason is required').max(500, 'Reason must be at most 500 characters'),
});

export const reverseSchema = reasonOnlySchema.extend({ version: z.number().int().positive() });

export const paymentListQuerySchema = z.object({
  supplierId: z.uuid().optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  status: z.enum(['active', 'reversed', 'all']).default('active'),
  allocation: z.enum(['unallocated', 'partial', 'full', 'open']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

export const LEDGER_TYPES = ['bill', 'paid_at_purchase', 'payment'] as const;

export const ledgerQuerySchema = z.object({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  type: z.enum(LEDGER_TYPES).optional(),
  /** active = counted in balances; cancelled = voided bills and reversed payments. */
  status: z.enum(['active', 'cancelled', 'all']).default('all'),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
