import express, { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { perUserRateLimit } from '../../middleware/rateLimit.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { contentDisposition } from '../documents/documents.routes.js';
import { purchaseMoneySchema, positiveMoneySchema, SELLING_UNITS } from '../products/products.schemas.js';
import { requirePurchasePriceAccess } from '../products/permissions.js';
import { IMPORT_FIELDS } from './analyse.js';
import {
  commitBatch,
  createBatch,
  discardBatch,
  errorReport,
  getBatch,
  listBatches,
  listRows,
  splitRow,
  unsplitRow,
  updateRows,
  updateSettings,
} from './imports.service.js';
import { inspectWorkbook } from './workbook.js';
import { XLSX_LIMITS } from './zipGuard.js';

function parseId(raw: unknown): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError('Import not found');
  return parsed.data;
}

const fileNameOf = (header: string | undefined): string => {
  let name = 'workbook.xlsx';
  try {
    if (header) name = decodeURIComponent(header);
  } catch {
    // keep the default
  }
  name = name.replace(/[\u0000-\u001f\\/]/g, '_').trim().slice(0, 200) || 'workbook.xlsx';
  if (!/\.xlsx$/i.test(name)) throw new AppError(400, 'INVALID_WORKBOOK', 'Only .xlsx workbooks can be imported (not .xls, .xlsm or .csv).');
  return name;
};

const bodyBuffer = (body: unknown): Buffer => {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new AppError(400, 'INVALID_WORKBOOK', 'Send the workbook as the request body (application/octet-stream).');
  }
  return body;
};

const createQuerySchema = z.object({
  sheet: z.string().trim().min(1, 'Choose a sheet').max(100),
  range: z.string().trim().min(3).max(20),
  headerRow: z.coerce.number().int().min(1).max(100_000),
  sectionRows: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

const mappingSchema = z.strictObject({
  columns: z.record(z.string().regex(/^[A-Z]{1,3}$/), z.enum([...IMPORT_FIELDS, 'ignore'])),
  confirmed: z.boolean(),
});

const sizeRuleSchema = z.union([
  z.strictObject({ action: z.literal('keep') }),
  z.strictObject({
    action: z.literal('attribute'),
    key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'Detail names: lower-case letters, digits and "_"'),
    value: z.string().trim().min(1).max(80),
  }),
]);

const brandDecisionSchema = z.union([
  z.strictObject({ action: z.literal('existing'), brandId: z.uuid(), prefix: z.string().trim().min(1).max(80) }),
  z.strictObject({
    action: z.literal('create'),
    name: z
      .string()
      .transform((v) => v.trim().replace(/\s+/g, ' '))
      .pipe(z.string().min(1, 'Enter the brand name').max(80)),
    prefix: z.string().trim().min(1).max(80),
  }),
  z.strictObject({ action: z.literal('not_brand') }),
]);

const settingsSchema = z
  .strictObject({
    version: z.number().int().positive(),
    mapping: mappingSchema.optional(),
    valueRules: z.strictObject({ gsmSuffix: z.boolean(), sizes: z.record(z.string().max(20), sizeRuleSchema) }).optional(),
    brandDecisions: z.record(z.string().max(80), brandDecisionSchema.nullable()).optional(),
    sectionCategories: z.record(z.string().max(200), z.uuid().nullable()).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, 'Nothing to update');

const overridesSchema = z.strictObject({
  name: z.string().max(160).optional(),
  brandId: z.uuid().nullable().optional(),
  categoryId: z.uuid().optional(),
  size: z.string().max(20).nullable().optional(),
  pageCount: z.number().int().min(1).max(10_000).nullable().optional(),
  gsm: z.number().int().min(1).max(2000).nullable().optional(),
  binding: z.string().max(40).nullable().optional(),
  sellingUnit: z.enum(SELLING_UNITS).optional(),
  packQty: z.number().int().min(1).max(100_000).optional(),
  mrp: positiveMoneySchema.nullable().optional(),
  sellingPrice: positiveMoneySchema.optional(),
  purchasePrice: purchaseMoneySchema.nullable().optional(),
  sku: z.string().trim().max(40).nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  attributes: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), z.string().trim().min(1).max(80)).optional(),
  confirmSpAboveMrp: z.boolean().optional(),
});

const rowsSchema = z.strictObject({
  version: z.number().int().positive(),
  rows: z
    .array(
      z.strictObject({
        rowNumber: z.number().int().min(1),
        splitIndex: z.number().int().min(0).default(0),
        decision: z.enum(['pending', 'create', 'update', 'skip']).optional(),
        overrides: overridesSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(2000),
});

const splitSchema = z.strictObject({ version: z.number().int().positive(), parts: z.array(overridesSchema).min(2).max(5) });
const versionSchema = z.strictObject({ version: z.number().int().positive() });
const rowsQuerySchema = z.object({
  group: z.enum(['new', 'update', 'duplicate', 'error']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Product import from Excel. ONLY the owner and managers allowed to see purchase prices (a
 * workbook may contain purchase prices, and the preview shows raw cells).
 *
 *   POST   /inspect                   (xlsx body) sheets, preview, detected blocks; nothing stored
 *   POST   /?sheet&range&headerRow&sectionRows   (xlsx body) create a batch from the selected block
 *   GET    /                          recent batches
 *   GET    /:id                       batch, counts, brand words, sections, blockers
 *   GET    /:id/rows?group&page       rows with raw cells, proposal, issues, decision
 *   PATCH  /:id                       mapping / value rules / brand decisions / section categories (+ version)
 *   PATCH  /:id/rows                  row decisions and overrides, in bulk (+ version)
 *   POST   /:id/rows/:row/split       split a row into 2–5 products (+ version)
 *   POST   /:id/rows/:row/unsplit     undo a split (+ version)
 *   POST   /:id/commit                commit everything in one transaction (+ version)
 *   POST   /:id/discard               discard (+ version)
 *   GET    /:id/report                review / error report (.xlsx)
 */
export function createProductImportsRouter({ db, shopName }: { db: Database; shopName: string }): Router {
  const router = Router();
  router.use(requirePurchasePriceAccess);

  const upload = [
    perUserRateLimit('product-import-upload', 20, 10 * 60 * 1000),
    express.raw({ type: 'application/octet-stream', limit: XLSX_LIMITS.maxFileBytes }),
  ];

  router.post('/inspect', ...upload, async (req, res) => {
    fileNameOf(req.get('X-File-Name'));
    res.json({ sheets: await inspectWorkbook(bodyBuffer(req.body)) });
  });

  router.post('/', ...upload, async (req, res) => {
    const fileName = fileNameOf(req.get('X-File-Name'));
    const q = createQuerySchema.parse(req.query);
    const batch = await createBatch(
      db,
      { file: bodyBuffer(req.body), fileName, sheetName: q.sheet, range: q.range, headerRow: q.headerRow, sectionRows: q.sectionRows },
      getActor(res),
    );
    res.status(201).json({ batch });
  });

  router.get('/', async (_req, res) => {
    res.json({ batches: await listBatches(db) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ batch: await getBatch(db, parseId(req.params.id)) });
  });

  router.get('/:id/rows', async (req, res) => {
    res.json(await listRows(db, parseId(req.params.id), rowsQuerySchema.parse(req.query)));
  });

  router.patch('/:id', async (req, res) => {
    const { version, ...input } = settingsSchema.parse(req.body);
    res.json({ batch: await updateSettings(db, parseId(req.params.id), input, version, getActor(res)) });
  });

  router.patch('/:id/rows', async (req, res) => {
    const { version, rows } = rowsSchema.parse(req.body);
    res.json({ batch: await updateRows(db, parseId(req.params.id), rows, version, getActor(res)) });
  });

  router.post('/:id/rows/:row/split', async (req, res) => {
    const { version, parts } = splitSchema.parse(req.body);
    const row = z.coerce.number().int().min(1).parse(req.params.row);
    res.json({ batch: await splitRow(db, parseId(req.params.id), row, parts, version, getActor(res)) });
  });

  router.post('/:id/rows/:row/unsplit', async (req, res) => {
    const { version } = versionSchema.parse(req.body);
    const row = z.coerce.number().int().min(1).parse(req.params.row);
    res.json({ batch: await unsplitRow(db, parseId(req.params.id), row, version, getActor(res)) });
  });

  router.post('/:id/commit', async (req, res) => {
    const { version } = versionSchema.parse(req.body);
    res.json({ batch: await commitBatch(db, parseId(req.params.id), version, getActor(res)) });
  });

  router.post('/:id/discard', async (req, res) => {
    const { version } = versionSchema.parse(req.body);
    res.json({ batch: await discardBatch(db, parseId(req.params.id), version, getActor(res)) });
  });

  router.get('/:id/report', async (req, res) => {
    const report = await errorReport(db, parseId(req.params.id), shopName);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', contentDisposition('attachment', report.fileName));
    res.set('Cache-Control', 'private, no-store');
    res.send(report.buffer);
  });

  return router;
}
