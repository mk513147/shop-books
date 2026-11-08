import { z } from 'zod';

/** Trimmed, runs of whitespace collapsed (the database requires this form, see salesmen_name_valid). */
const nameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Name is required').max(120, 'Name must be at most 120 characters'));

const notesSchema = z
  .string()
  .trim()
  .max(1000, 'Notes must be at most 1000 characters')
  .nullish()
  .transform((v) => (v ? v : null));

const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ' '))
  .refine((v) => v === '' || /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/.test(v), 'Enter a phone number using digits, spaces, +, - or ( )')
  .nullish()
  .transform((v) => (v ? v : null));

export const salesmanCreateSchema = z.strictObject({ name: nameSchema, phone: phoneSchema, notes: notesSchema });
export type SalesmanCreateInput = z.infer<typeof salesmanCreateSchema>;

/** PATCH: any subset of the fields plus the version the client last saw. */
export const salesmanUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    phone: phoneSchema.optional(),
    notes: notesSchema.optional(),
    isActive: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => Object.keys(v).length > 1, 'Nothing to update');
export type SalesmanUpdateInput = Omit<z.infer<typeof salesmanUpdateSchema>, 'version'>;

export const salesmanListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SalesmanListQuery = z.infer<typeof salesmanListQuerySchema>;
