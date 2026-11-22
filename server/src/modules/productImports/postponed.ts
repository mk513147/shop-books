import type { RequestHandler } from 'express';

/**
 * Product import from Excel is POSTPONED (product decision; docs/products.md → "Excel import:
 * postponed"). Products are added and maintained by hand in the catalogue.
 *
 * Every request to /api/v1/product-imports (any method, any sub-path: upload, inspect, batches,
 * rows, settings, split, commit, discard, report) gets this one answer. It is mounted in
 * routes/index.ts INSTEAD of createProductImportsRouter, before the JSON-only guard and before any
 * body parsing, so no workbook is read, parsed, stored or returned. The import code in this folder
 * is kept for a future release but is not imported by the running application.
 *
 * Do not re-enable by mounting createProductImportsRouter again without completing the
 * reactivation checklist in docs/products.md (ZIP guard bypass, ExcelJS range expansion,
 * workbook resource limits, preview staleness, retention and access to stored workbooks).
 */
export const PRODUCT_IMPORT_UNAVAILABLE = {
  code: 'PRODUCT_IMPORT_UNAVAILABLE',
  message: 'Importing products from Excel is not available yet. Add products one by one from the Products screen.',
} as const;

export const productImportsUnavailable: RequestHandler = (_req, res) => {
  res.status(503).json({ error: PRODUCT_IMPORT_UNAVAILABLE });
};
