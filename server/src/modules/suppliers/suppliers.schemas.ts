import { z } from 'zod';

/** Trimmed, runs of whitespace collapsed (the database requires this form, see suppliers_name_valid). */
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

const categoryIdsSchema = z
  .array(z.uuid('Invalid category'))
  .max(100, 'Too many categories')
  .transform((ids) => [...new Set(ids)]);

const detailFields = {
  name: nameSchema,
  phone: phoneSchema,
  address: optionalText(300, 'Address'),
  notes: optionalText(1000, 'Notes'),
};

export const supplierCreateSchema = z.strictObject({ ...detailFields, categoryIds: categoryIdsSchema.default([]) });
export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;

/**
 * PATCH: any subset of the fields, plus the version the client last saw. `categoryIds`, when sent,
 * is the complete desired set of linked categories.
 */
export const supplierUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    phone: phoneSchema.optional(),
    address: optionalText(300, 'Address').optional(),
    notes: optionalText(1000, 'Notes').optional(),
    isActive: z.boolean().optional(),
    categoryIds: categoryIdsSchema.optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => Object.keys(v).length > 1, 'Nothing to update');
export type SupplierUpdateInput = Omit<z.infer<typeof supplierUpdateSchema>, 'version'>;

export const linkCategorySchema = z.strictObject({ categoryId: z.uuid('Choose a category') });

export const supplierListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  /** payable = only suppliers that are still owed something. */
  balance: z.enum(['all', 'payable']).default('all'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;
