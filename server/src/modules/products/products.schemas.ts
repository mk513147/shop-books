import { z } from 'zod';
import { moneySchema, normaliseMoney, toPaise } from '../../utils/money.js';

/**
 * Product validation. Mirrors the database CHECK constraints (migration 0015) so a bad value is a
 * 400 with a field path, never a database error. Money is a decimal STRING (never a JS number).
 */

const collapse = (v: string) => v.trim().replace(/\s+/g, ' ');

const nullableText = (max: number, label: string) =>
  z
    .string()
    .transform(collapse)
    .pipe(z.string().max(max, `${label} must be at most ${max} characters`))
    .nullish()
    .transform((v) => (v ? v : null));

export const productNameSchema = z
  .string()
  .transform(collapse)
  .pipe(z.string().min(1, 'Name is required').max(160, 'Name must be at most 160 characters'));

const skuSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(v), 'SKU: 1–40 letters, digits, ".", "_", "/" or "-"')
  .nullish()
  .transform((v) => (v ? v : null));

const barcodeSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[A-Za-z0-9-]{4,64}$/.test(v), 'Barcode: 4–64 letters, digits or "-"')
  .nullish()
  .transform((v) => (v ? v : null));

const descriptionSchema = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters')
  .nullish()
  .transform((v) => (v ? v : null));

/** Sizes are stored as written, in upper case ("A4", "SL", "MD"); never interpreted. */
const sizeSchema = z
  .string()
  .transform((v) => collapse(v).toUpperCase())
  .pipe(z.string().max(20, 'Size must be at most 20 characters'))
  .nullish()
  .transform((v) => (v ? v : null));

const bindingSchema = z
  .string()
  .transform((v) => collapse(v).toLowerCase())
  .pipe(z.string().max(40, 'Binding must be at most 40 characters'))
  .nullish()
  .transform((v) => (v ? v : null));

const intOrNull = (min: number, max: number, label: string) =>
  z
    .number({ error: `${label} must be a whole number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`)
    .nullish()
    .transform((v) => v ?? null);

export const SELLING_UNITS = ['piece', 'pack', 'box', 'set', 'ream'] as const;
export type SellingUnit = (typeof SELLING_UNITS)[number];

const attributesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'Attribute names: lower-case letters, digits and "_" (start with a letter)'),
    z.union([
      z
        .string()
        .transform(collapse)
        .pipe(z.string().min(1, 'Attribute values cannot be empty').max(80, 'Attribute values: at most 80 characters')),
      z.number().finite(),
    ]),
  )
  .refine((v) => Object.keys(v).length <= 20, 'At most 20 attributes');

const aliasesSchema = z
  .array(
    z
      .string()
      .transform((v) => collapse(v).toLowerCase())
      .pipe(z.string().min(1, 'Aliases cannot be empty').max(60, 'Aliases: at most 60 characters each')),
  )
  .max(20, 'At most 20 search aliases')
  .transform((v) => [...new Set(v)]);

/** A positive amount ("0" is not a price), normalised to two decimals. */
export const positiveMoneySchema = moneySchema
  .refine((v) => toPaise(v) > 0n, 'Must be more than 0')
  .transform(normaliseMoney);

/** A purchase price may be 0 (free samples), never negative. */
export const purchaseMoneySchema = moneySchema.transform(normaliseMoney);

export const PRICE_CONFIRMATIONS = ['sp_above_mrp'] as const;

const productFields = {
  name: productNameSchema,
  brandId: z.uuid('Choose a valid brand').nullish().transform((v) => v ?? null),
  categoryId: z.uuid('Choose a category'),
  sku: skuSchema,
  barcode: barcodeSchema,
  description: descriptionSchema,
  size: sizeSchema,
  pageCount: intOrNull(1, 10_000, 'Page count'),
  gsm: intOrNull(1, 2000, 'GSM'),
  binding: bindingSchema,
  sellingUnit: z.enum(SELLING_UNITS, 'Choose piece, pack, box, set or ream'),
  packQty: z.number().int('Pack quantity must be a whole number').min(1, 'Pack quantity must be at least 1').max(100_000),
  attributes: attributesSchema,
  searchAliases: aliasesSchema,
  mrp: positiveMoneySchema.nullish().transform((v) => v ?? null),
  sellingPrice: positiveMoneySchema,
};

const packRule = (v: { sellingUnit?: SellingUnit | undefined; packQty?: number | undefined }) =>
  v.sellingUnit === undefined || v.packQty === undefined || v.sellingUnit !== 'piece' || v.packQty === 1;
const PACK_RULE_MESSAGE = { message: 'A product sold by the piece has a pack quantity of 1', path: ['packQty'] };

export const productCreateSchema = z
  .strictObject({
    ...productFields,
    sellingUnit: productFields.sellingUnit.default('piece'),
    packQty: productFields.packQty.default(1),
    attributes: productFields.attributes.default({}),
    searchAliases: productFields.searchAliases.default([]),
    /** Explicit confirmations (e.g. selling above the MRP). */
    confirmations: z.array(z.enum(PRICE_CONFIRMATIONS)).max(5).default([]),
    /** Only users allowed to see purchase prices may send this (403 otherwise). */
    defaultPurchasePrice: purchaseMoneySchema.nullish(),
  })
  .refine(packRule, PACK_RULE_MESSAGE);
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = z
  .strictObject({
    name: productFields.name.optional(),
    brandId: productFields.brandId.optional(),
    categoryId: productFields.categoryId.optional(),
    sku: productFields.sku.optional(),
    barcode: productFields.barcode.optional(),
    description: productFields.description.optional(),
    size: productFields.size.optional(),
    pageCount: productFields.pageCount.optional(),
    gsm: productFields.gsm.optional(),
    binding: productFields.binding.optional(),
    sellingUnit: productFields.sellingUnit.optional(),
    packQty: productFields.packQty.optional(),
    attributes: productFields.attributes.optional(),
    searchAliases: productFields.searchAliases.optional(),
    mrp: productFields.mrp.optional(),
    sellingPrice: productFields.sellingPrice.optional(),
    isActive: z.boolean().optional(),
    confirmations: z.array(z.enum(PRICE_CONFIRMATIONS)).max(5).optional(),
    version: z.number().int().positive(),
  })
  .refine(packRule, PACK_RULE_MESSAGE)
  .refine((v) => Object.keys(v).filter((k) => k !== 'version' && k !== 'confirmations').length > 0, 'Nothing to update');
export type ProductUpdateInput = Omit<z.infer<typeof productUpdateSchema>, 'version' | 'confirmations'>;

export const PRODUCT_SORTS = ['relevance', 'name', 'brand', 'selling_price', 'mrp', 'updated'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const productListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  /** A brand id, or "none" for products without a brand. */
  brandId: z.union([z.uuid(), z.literal('none')]).optional(),
  categoryId: z.uuid().optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  sort: z.enum(PRODUCT_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const quickSearchQuerySchema = z.object({
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export const lookupQuerySchema = z.object({ code: z.string().trim().min(1, 'Enter a code').max(64) });

export const similarQuerySchema = z.object({
  name: productNameSchema,
  brandId: z.uuid().optional(),
  size: z.string().trim().max(20).optional(),
  pageCount: z.coerce.number().int().min(1).max(10_000).optional(),
  gsm: z.coerce.number().int().min(1).max(2000).optional(),
  binding: z.string().trim().max(40).optional(),
  excludeId: z.uuid().optional(),
});
export type SimilarQuery = z.infer<typeof similarQuerySchema>;

export const purchasePricesQuerySchema = z.object({
  ids: z
    .string()
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.uuid()).min(1, 'No products').max(100, 'At most 100 products at a time')),
  /** Where the reveal happened (access trail only). */
  scope: z.enum(['page', 'product', 'form']).default('page'),
});

export const costUpdateSchema = z.strictObject({
  defaultPurchasePrice: purchaseMoneySchema.nullable(),
  /** The cost version last seen (0 when no cost has ever been saved). */
  version: z.number().int().min(0),
});

const supplierCodeSchema = nullableText(60, 'Supplier product code');
const linkNotesSchema = z
  .string()
  .trim()
  .max(500, 'Notes must be at most 500 characters')
  .nullish()
  .transform((v) => (v ? v : null));

export const supplierLinkCreateSchema = z.strictObject({
  supplierId: z.uuid('Choose a supplier'),
  supplierProductCode: supplierCodeSchema,
  notes: linkNotesSchema,
  isPreferred: z.boolean().default(false),
  /** Only users allowed to see purchase prices may send this (403 otherwise). */
  purchasePrice: purchaseMoneySchema.nullish(),
});
export type SupplierLinkCreateInput = z.infer<typeof supplierLinkCreateSchema>;

export const supplierLinkUpdateSchema = z
  .strictObject({
    supplierProductCode: supplierCodeSchema.optional(),
    notes: linkNotesSchema.optional(),
    isPreferred: z.boolean().optional(),
    purchasePrice: purchaseMoneySchema.nullable().optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => Object.keys(v).length > 1, 'Nothing to update');
export type SupplierLinkUpdateInput = Omit<z.infer<typeof supplierLinkUpdateSchema>, 'version'>;

/** GET /:id/costs: which screen read the prices (access trail only). */
export const costsQuerySchema = z.object({
  scope: z.enum(['product', 'form']).default('product'),
});

/** DELETE /:id/suppliers/:sid?version=N: the link version the user saw (optimistic locking). */
export const unlinkQuerySchema = z.object({
  version: z.coerce
    .number({ error: 'The link version is required: reload and try again' })
    .int()
    .positive('The link version is required: reload and try again'),
});
