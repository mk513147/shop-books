import { createHash } from 'node:crypto';
import type ExcelJS from 'exceljs';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { recordFinancialAudit } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { newWorkbook, safeText, workbookBuffer } from '../exports/excel.js';
import type { ProductCreateInput } from '../products/products.schemas.js';
import { applyProductUpdate, insertProduct } from '../products/products.service.js';
import { normaliseSearchText } from '../products/search.js';
import {
  analyseRows,
  brandCandidates,
  commitBlockers,
  identityKey,
  IMPORT_FIELDS,
  sectionLabel,
  type AnalyseContext,
  type AnalysedRow,
  type BrandCandidate,
  type BrandDecision,
  type Decision,
  type Group,
  type ImportField,
  type Issue,
  type Mapping,
  type Proposal,
  type RowOverrides,
  type StoredRow,
  type ValueRules,
} from './analyse.js';
import { cellText, columnLetter, extractBlock, formatRange, type RawRow } from './workbook.js';

/**
 * Product import batches (migration 0015). Flow:
 *   inspect (stateless) -> create batch (stores ONLY the selected block) -> mapping / rules /
 *   brand decisions / section categories / row edits (each re-analyses every row) -> commit
 *   (one transaction, re-validated against the current database) or discard.
 *
 * Only users allowed to see purchase prices reach this module (the router requires it), because a
 * workbook may carry purchase prices.
 */

export type BatchStatus = 'review' | 'committed' | 'discarded';

export interface SkippedRow {
  rowNumber: number;
  reason: 'header' | 'section' | 'above_header';
  text: string;
}

interface BatchRow {
  id: string;
  file_name: string;
  sheet_name: string;
  block_range: string;
  header_row: number;
  mapping: Mapping;
  value_rules: ValueRules;
  brand_decisions: Record<string, BrandDecision>;
  section_categories: Record<string, string>;
  status: BatchStatus;
  summary: BatchSummary | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by_name: string;
  committed_at: Date | null;
  committed_by_name: string | null;
}

interface BatchSummary {
  header: Record<string, string>;
  skipped: SkippedRow[];
  sections: string[];
  result?: { created: number; updated: number; skipped: number; brandsCreated: number };
}

export interface ImportBatch {
  id: string;
  fileName: string;
  sheetName: string;
  blockRange: string;
  headerRow: number;
  /** Header cell text by column letter. */
  header: Record<string, string>;
  mapping: Mapping;
  valueRules: ValueRules;
  brandDecisions: Record<string, BrandDecision>;
  sectionCategories: Record<string, string>;
  status: BatchStatus;
  version: number;
  createdAt: string;
  createdBy: string;
  committedAt: string | null;
  committedBy: string | null;
  skippedRows: SkippedRow[];
  sections: { name: string; rows: number; categoryId: string | null }[];
  counts: Record<Group, number> & { total: number; toCreate: number; toUpdate: number; toSkip: number; pending: number };
  brandCandidates: BrandCandidate[];
  /** Non-size values found in the size column, with their rule (if any). */
  sizeValues: { value: string; rows: number; rule: ValueRules['sizes'][string] | null }[];
  gsmInNames: number;
  blockers: string[];
  result: BatchSummary['result'] | null;
  fields: readonly ImportField[];
}

export interface ImportRowView {
  rowNumber: number;
  splitIndex: number;
  section: string | null;
  raw: Record<string, string>;
  rawTypes: Record<string, string>;
  proposal: Proposal;
  overrides: RowOverrides;
  issues: Issue[];
  group: Group;
  decision: Decision;
  effectiveDecision: Decision;
  duplicateOf: number | null;
  matchedProduct: { id: string; name: string; brand: string | null; sellingPrice: string; mrp: string | null } | null;
  resultProductId: string | null;
}

const BATCH_SELECT = `
  SELECT b.id, b.file_name, b.sheet_name, b.block_range, b.header_row, b.mapping, b.value_rules, b.brand_decisions,
         b.section_categories, b.status, b.summary, b.version, b.created_at, b.updated_at,
         cu.name AS created_by_name, b.committed_at, mu.name AS committed_by_name
    FROM product_import_batches b
    JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users mu ON mu.id = b.committed_by`;

async function selectBatch(db: Queryable, id: string, lock = false): Promise<BatchRow> {
  if (lock) {
    const locked = await db.query(`SELECT 1 FROM product_import_batches WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) throw new NotFoundError('Import not found');
  }
  const row = (await db.query<BatchRow>(`${BATCH_SELECT} WHERE b.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError('Import not found');
  return row;
}

interface StoredRowRecord {
  row_number: number;
  split_index: number;
  section: string | null;
  raw: RawRow;
  overrides: RowOverrides;
  decision: Decision;
  proposal: Proposal;
  issues: Issue[];
  grp: Group;
  duplicate_of: number | null;
  matched_product_id: string | null;
  result_product_id: string | null;
}

async function loadRows(db: Queryable, batchId: string): Promise<StoredRowRecord[]> {
  const result = await db.query<StoredRowRecord>(
    `SELECT row_number, split_index, section, raw, overrides, decision, proposal, issues, grp, duplicate_of, matched_product_id, result_product_id
       FROM product_import_rows WHERE batch_id = $1 ORDER BY row_number, split_index`,
    [batchId],
  );
  return result.rows;
}

const toStored = (r: StoredRowRecord): StoredRow => ({
  rowNumber: r.row_number,
  splitIndex: r.split_index,
  section: r.section,
  raw: r.raw,
  overrides: r.overrides,
  decision: r.decision,
});

async function loadContext(db: Queryable, batch: Pick<BatchRow, 'mapping' | 'value_rules' | 'brand_decisions' | 'section_categories'>): Promise<AnalyseContext> {
  const [brands, categories, products] = await Promise.all([
    db.query<{ id: string; name: string; is_active: boolean }>(`SELECT id, name, is_active FROM brands`),
    db.query<{ id: string; name: string; is_active: boolean; is_product_usable: boolean }>(
      `SELECT id, name, is_active, is_product_usable FROM expense_categories`,
    ),
    db.query<{
      id: string;
      name: string;
      brand_id: string | null;
      size: string | null;
      page_count: number | null;
      gsm: number | null;
      binding: string | null;
      selling_unit: Proposal['sellingUnit'];
      pack_qty: number;
      attributes: Record<string, string | number>;
      sku: string | null;
      barcode: string | null;
    }>(`SELECT id, name, brand_id, size, page_count, gsm, binding, selling_unit, pack_qty, attributes, sku, barcode FROM products WHERE is_active`),
  ]);
  return {
    mapping: batch.mapping,
    rules: batch.value_rules,
    brandDecisions: batch.brand_decisions,
    sectionCategories: batch.section_categories,
    brands: brands.rows.map((b) => ({ id: b.id, name: b.name, isActive: b.is_active })),
    categories: categories.rows.map((c) => ({ id: c.id, name: c.name, isActive: c.is_active, isProductUsable: c.is_product_usable })),
    products: products.rows.map((p) => ({
      id: p.id,
      name: p.name,
      brandId: p.brand_id,
      sku: p.sku,
      barcode: p.barcode,
      identity: identityKey({
        brandKey: p.brand_id ? `id:${p.brand_id}` : 'none',
        name: p.name,
        size: p.size,
        pageCount: p.page_count,
        gsm: p.gsm,
        binding: p.binding,
        sellingUnit: p.selling_unit,
        packQty: p.pack_qty,
        attributes: p.attributes,
      }),
    })),
  };
}

/** Re-analyses every row of the batch and stores the results (inside the caller's transaction). */
async function reanalyse(client: Queryable, batch: BatchRow): Promise<AnalysedRow[]> {
  const rows = await loadRows(client, batch.id);
  const analysed = analyseRows(rows.map(toStored), await loadContext(client, batch));
  if (analysed.length) {
    await client.query(
      `UPDATE product_import_rows r
          SET proposal = x.proposal, issues = x.issues, grp = x.grp, duplicate_of = x.duplicate_of, matched_product_id = x.matched
         FROM (SELECT * FROM unnest($2::int[], $3::smallint[], $4::jsonb[], $5::jsonb[], $6::text[], $7::int[], $8::uuid[])
                 AS t(row_number, split_index, proposal, issues, grp, duplicate_of, matched)) x
        WHERE r.batch_id = $1 AND r.row_number = x.row_number AND r.split_index = x.split_index`,
      [
        batch.id,
        analysed.map((a) => a.rowNumber),
        analysed.map((a) => a.splitIndex),
        analysed.map((a) => JSON.stringify(a.proposal)),
        analysed.map((a) => JSON.stringify(a.issues)),
        analysed.map((a) => a.group),
        analysed.map((a) => a.duplicateOf),
        analysed.map((a) => a.matchedProductId),
      ],
    );
  }
  return analysed;
}

// --- Create ------------------------------------------------------------------------------------------

const HEADER_GUESSES: [RegExp, ImportField][] = [
  [/^(name|product|product name|item|item name|description)$/, 'name'],
  [/^(brand|company|make)$/, 'brand'],
  [/^(category)$/, 'category'],
  [/^(size)$/, 'size'],
  [/^(page|pages|page count|no of pages)$/, 'pages'],
  [/^(gsm|paper weight|weight)$/, 'gsm'],
  [/^(binding)$/, 'binding'],
  [/^(unit|selling unit)$/, 'unit'],
  [/^(pack qty|pack quantity|pack size)$/, 'packQty'],
  [/^(mrp|m r p)$/, 'mrp'],
  // Deliberately NOT "SP": the abbreviation must be mapped by the user.
  [/^(selling price|sale price)$/, 'sellingPrice'],
  [/^(purchase price|cost price|cost)$/, 'purchasePrice'],
  [/^(sku|item code|product code)$/, 'sku'],
  [/^(barcode|ean|upc)$/, 'barcode'],
  [/^(aliases|search aliases|other names)$/, 'aliases'],
  [/^(notes|remarks)$/, 'notes'],
];

function guessMapping(header: RawRow): Mapping {
  const columns: Mapping['columns'] = {};
  const used = new Set<ImportField>();
  for (const [letter, cell] of Object.entries(header)) {
    const text = normaliseSearchText(cellText(cell));
    const guess = HEADER_GUESSES.find(([re, field]) => re.test(text) && !used.has(field));
    if (guess) {
      columns[letter] = guess[1];
      used.add(guess[1]);
    }
  }
  return { columns, confirmed: false };
}

const rowSignature = (cells: RawRow) =>
  Object.entries(cells)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, c]) => `${k}=${normaliseSearchText(cellText(c))}`)
    .join('|');

/**
 * A section label row: every non-empty cell holds the same text and none is a number (e.g. a
 * merged "CLASSMATE" title across the block). Detected only when the user asks for it.
 */
function sectionText(cells: RawRow): string | null {
  const values = Object.values(cells);
  if (values.length === 0 || values.some((c) => c.t === 'n' || (c.t === 'f' && typeof c.v === 'number'))) return null;
  const texts = [...new Set(values.map((c) => sectionLabel(cellText(c))))];
  return texts.length === 1 && texts[0] ? texts[0] : null;
}

export async function createBatch(
  db: Database,
  input: { file: Buffer; fileName: string; sheetName: string; range: string; headerRow: number; sectionRows: boolean },
  actor: Actor,
): Promise<ImportBatch> {
  const block = await extractBlock(input.file, input.sheetName, input.range, input.headerRow);
  const headerSig = rowSignature(block.header);
  const skipped: SkippedRow[] = [];
  const dataRows: { rowNumber: number; section: string | null; cells: RawRow }[] = [];
  let section: string | null = null;
  for (const row of block.rows) {
    const text = Object.values(row.cells).map((c) => cellText(c)).join(' | ');
    if (rowSignature(row.cells) === headerSig) {
      skipped.push({ rowNumber: row.rowNumber, reason: 'header', text });
      continue;
    }
    const label = input.sectionRows ? sectionText(row.cells) : null;
    if (label) {
      section = label;
      skipped.push({ rowNumber: row.rowNumber, reason: 'section', text: label });
      continue;
    }
    if (row.rowNumber < block.headerRow) {
      skipped.push({ rowNumber: row.rowNumber, reason: 'above_header', text });
      continue;
    }
    dataRows.push({ rowNumber: row.rowNumber, section, cells: row.cells });
  }
  if (dataRows.length === 0) throw new AppError(400, 'EMPTY_BLOCK', 'No product rows were found below the header row');

  const header = Object.fromEntries(Object.entries(block.header).map(([k, c]) => [k, cellText(c)]));
  const sections = [...new Set(dataRows.map((r) => r.section).filter((s): s is string => s !== null))];
  const summary: BatchSummary = { header, skipped, sections };
  const mapping = guessMapping(block.header);
  const rules: ValueRules = { gsmSuffix: false, sizes: {} };

  const id = await withSessionTransaction(db, actor.sessionId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO product_import_batches (file_name, file_sha256, sheet_name, block_range, header_row, mapping, value_rules, summary, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $9) RETURNING id`,
      [
        input.fileName,
        createHash('sha256').update(input.file).digest(),
        block.sheetName,
        formatRange(block.range),
        block.headerRow,
        JSON.stringify(mapping),
        JSON.stringify(rules),
        JSON.stringify(summary),
        actor.userId,
      ],
    );
    const batchId = inserted.rows[0]!.id;
    await client.query(
      `INSERT INTO product_import_rows (batch_id, row_number, section, raw)
       SELECT $1, t.row_number, t.section, t.raw FROM unnest($2::int[], $3::text[], $4::jsonb[]) AS t(row_number, section, raw)`,
      [batchId, dataRows.map((r) => r.rowNumber), dataRows.map((r) => r.section), dataRows.map((r) => JSON.stringify(r.cells))],
    );
    await reanalyse(client, await selectBatch(client, batchId));
    await recordFinancialAudit(client, {
      entityType: 'product_import',
      entityId: batchId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: { fileName: input.fileName, sheet: block.sheetName, range: formatRange(block.range), rows: dataRows.length },
    });
    return batchId;
  });
  return getBatch(db, id);
}

// --- Read --------------------------------------------------------------------------------------------

function effectiveOf(r: StoredRowRecord): Decision {
  const defaults: Record<Group, Decision> = { new: 'create', update: 'pending', duplicate: 'skip', error: 'pending' };
  const effective = r.decision === 'pending' ? defaults[r.grp] : r.decision;
  return effective === 'update' && !r.matched_product_id ? 'pending' : effective;
}

function asAnalysed(rows: StoredRowRecord[]): AnalysedRow[] {
  return rows.map((r) => ({
    rowNumber: r.row_number,
    splitIndex: r.split_index,
    proposal: r.proposal,
    issues: r.issues,
    group: r.grp,
    effectiveDecision: effectiveOf(r),
    duplicateOf: r.duplicate_of,
    matchedProductId: r.matched_product_id,
  }));
}

function toBatch(b: BatchRow, rows: StoredRowRecord[], ctx: AnalyseContext): ImportBatch {
  const analysed = asAnalysed(rows);
  const counts = { new: 0, update: 0, duplicate: 0, error: 0, total: rows.length, toCreate: 0, toUpdate: 0, toSkip: 0, pending: 0 };
  for (const a of analysed) {
    counts[a.group]++;
    if (a.effectiveDecision === 'create') counts.toCreate++;
    else if (a.effectiveDecision === 'update') counts.toUpdate++;
    else if (a.effectiveDecision === 'skip') counts.toSkip++;
    else counts.pending++;
  }
  const sizeCol = Object.entries(b.mapping.columns).find(([, f]) => f === 'size')?.[0];
  const sizes = new Map<string, number>();
  let gsmInNames = 0;
  for (const r of rows) {
    const v = sizeCol ? sectionLabel(cellText(r.raw[sizeCol])).toUpperCase() : '';
    if (v && !/^A(10|[0-9])$/.test(v)) sizes.set(v, (sizes.get(v) ?? 0) + 1);
    if (r.issues.some((i) => i.code === 'GSM_IN_NAME')) gsmInNames++;
  }
  const summary = b.summary ?? { header: {}, skipped: [], sections: [] };
  return {
    id: b.id,
    fileName: b.file_name,
    sheetName: b.sheet_name,
    blockRange: b.block_range,
    headerRow: b.header_row,
    header: summary.header,
    mapping: b.mapping,
    valueRules: b.value_rules,
    brandDecisions: b.brand_decisions,
    sectionCategories: b.section_categories,
    status: b.status,
    version: b.version,
    createdAt: b.created_at.toISOString(),
    createdBy: b.created_by_name,
    committedAt: b.committed_at?.toISOString() ?? null,
    committedBy: b.committed_by_name,
    skippedRows: summary.skipped,
    sections: summary.sections.map((name) => ({
      name,
      rows: rows.filter((r) => r.section === name && r.split_index === 0).length,
      categoryId: b.section_categories[name] ?? null,
    })),
    counts,
    brandCandidates: brandCandidates(rows.map(toStored), analysed, ctx),
    sizeValues: [...sizes.entries()].sort().map(([value, n]) => ({ value, rows: n, rule: b.value_rules.sizes[value] ?? null })),
    gsmInNames,
    blockers: b.status === 'review' ? commitBlockers(analysed, b.mapping) : [],
    result: summary.result ?? null,
    fields: IMPORT_FIELDS,
  };
}

export async function getBatch(db: Queryable, id: string): Promise<ImportBatch> {
  const batch = await selectBatch(db, id);
  const rows = await loadRows(db, id);
  return toBatch(batch, rows, await loadContext(db, batch));
}

export async function listBatches(db: Queryable): Promise<
  { id: string; fileName: string; sheetName: string; status: BatchStatus; rows: number; createdAt: string; createdBy: string; committedAt: string | null }[]
> {
  const result = await db.query<{
    id: string;
    file_name: string;
    sheet_name: string;
    status: BatchStatus;
    rows: number;
    created_at: Date;
    created_by: string;
    committed_at: Date | null;
  }>(
    `SELECT b.id, b.file_name, b.sheet_name, b.status, b.created_at, u.name AS created_by, b.committed_at,
            (SELECT count(*)::int FROM product_import_rows r WHERE r.batch_id = b.id AND r.split_index = 0) AS rows
       FROM product_import_batches b JOIN users u ON u.id = b.created_by
      ORDER BY b.created_at DESC LIMIT 50`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    sheetName: r.sheet_name,
    status: r.status,
    rows: r.rows,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
    committedAt: r.committed_at?.toISOString() ?? null,
  }));
}

export async function listRows(
  db: Queryable,
  id: string,
  query: { group?: Group | undefined; page: number; pageSize: number },
): Promise<{ items: ImportRowView[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  await selectBatch(db, id);
  const all = await loadRows(db, id);
  const filtered = query.group ? all.filter((r) => r.grp === query.group) : all;
  const pageRows = filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  const matchedIds = [...new Set(pageRows.map((r) => r.matched_product_id).filter((x): x is string => x !== null))];
  const matched = new Map<string, ImportRowView['matchedProduct']>();
  if (matchedIds.length) {
    const result = await db.query<{ id: string; name: string; brand: string | null; selling_price: string; mrp: string | null }>(
      `SELECT p.id, p.name, b.name AS brand, p.selling_price, p.mrp FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ANY($1::uuid[])`,
      [matchedIds],
    );
    for (const m of result.rows) matched.set(m.id, { id: m.id, name: m.name, brand: m.brand, sellingPrice: m.selling_price, mrp: m.mrp });
  }
  return {
    items: pageRows.map((r) => ({
      rowNumber: r.row_number,
      splitIndex: r.split_index,
      section: r.section,
      raw: Object.fromEntries(Object.entries(r.raw).map(([k, c]) => [k, cellText(c)])),
      rawTypes: Object.fromEntries(Object.entries(r.raw).map(([k, c]) => [k, c.t])),
      proposal: r.proposal,
      overrides: r.overrides,
      issues: r.issues,
      group: r.grp,
      decision: r.decision,
      effectiveDecision: effectiveOf(r),
      duplicateOf: r.duplicate_of,
      matchedProduct: r.matched_product_id ? (matched.get(r.matched_product_id) ?? null) : null,
      resultProductId: r.result_product_id,
    })),
    pagination: { page: query.page, pageSize: query.pageSize, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)) },
  };
}

// --- Changes during review -----------------------------------------------------------------------------

async function inReview(db: Database, id: string, expectedVersion: number, actor: Actor, change: (client: Queryable, batch: BatchRow) => Promise<Partial<BatchRow> | void>): Promise<ImportBatch> {
  await withSessionTransaction(db, actor.sessionId, async (client) => {
    const batch = await selectBatch(client, id, true);
    if (batch.status !== 'review') throw new AppError(409, batch.status === 'committed' ? 'ALREADY_COMMITTED' : 'IMPORT_DISCARDED', `This import was already ${batch.status}.`);
    if (batch.version !== expectedVersion) {
      throw new AppError(409, 'VERSION_CONFLICT', 'This import was changed in another window after you opened it. Reload to see the latest version.');
    }
    const patch = (await change(client, batch)) ?? {};
    const next = { ...batch, ...patch };
    await client.query(
      `UPDATE product_import_batches
          SET mapping = $2::jsonb, value_rules = $3::jsonb, brand_decisions = $4::jsonb, section_categories = $5::jsonb,
              version = version + 1, updated_by = $6
        WHERE id = $1`,
      [id, JSON.stringify(next.mapping), JSON.stringify(next.value_rules), JSON.stringify(next.brand_decisions), JSON.stringify(next.section_categories), actor.userId],
    );
    await reanalyse(client, next);
  });
  return getBatch(db, id);
}

export interface SettingsInput {
  mapping?: Mapping | undefined;
  valueRules?: ValueRules | undefined;
  brandDecisions?: Record<string, BrandDecision | null> | undefined;
  sectionCategories?: Record<string, string | null> | undefined;
}

export async function updateSettings(db: Database, id: string, input: SettingsInput, expectedVersion: number, actor: Actor): Promise<ImportBatch> {
  return inReview(db, id, expectedVersion, actor, async (client, batch) => {
    const patch: Partial<BatchRow> = {};
    if (input.mapping) {
      const header: Record<string, string> = batch.summary?.header ?? {};
      for (const letter of Object.keys(input.mapping.columns)) {
        if (!(letter in header) && !(await blockHasColumn(client, batch.id, letter))) {
          throw new AppError(400, 'UNKNOWN_COLUMN', `Column ${letter} is not part of the imported block`);
        }
      }
      const fields = Object.values(input.mapping.columns).filter((f) => f !== 'ignore');
      if (new Set(fields).size !== fields.length) throw new AppError(400, 'DUPLICATE_MAPPING', 'Each field can be mapped from one column only');
      patch.mapping = input.mapping;
    }
    if (input.valueRules) patch.value_rules = input.valueRules;
    if (input.brandDecisions) {
      const next = { ...batch.brand_decisions };
      for (const [key, decision] of Object.entries(input.brandDecisions)) {
        if (decision === null) delete next[key];
        else {
          if (decision.action === 'existing') {
            const b = (await client.query<{ is_active: boolean }>(`SELECT is_active FROM brands WHERE id = $1`, [decision.brandId])).rows[0];
            if (!b?.is_active) throw new AppError(400, 'BRAND_UNAVAILABLE', 'Choose an active brand');
          }
          if (decision.action !== 'not_brand' && !normaliseSearchText(decision.prefix).toUpperCase().startsWith(key)) {
            throw new AppError(400, 'INVALID_PREFIX', `The brand words must start with “${key}”`);
          }
          next[key] = decision;
        }
      }
      patch.brand_decisions = next;
    }
    if (input.sectionCategories) {
      const next = { ...batch.section_categories };
      for (const [section, categoryId] of Object.entries(input.sectionCategories)) {
        if (categoryId === null) delete next[section];
        else {
          const c = (await client.query<{ ok: boolean }>(`SELECT (is_active AND is_product_usable) AS ok FROM expense_categories WHERE id = $1`, [categoryId])).rows[0];
          if (!c?.ok) throw new AppError(400, 'CATEGORY_UNAVAILABLE', 'Choose an active category marked for products');
          next[section] = categoryId;
        }
      }
      patch.section_categories = next;
    }
    return patch;
  });
}

async function blockHasColumn(client: Queryable, batchId: string, letter: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM product_import_rows WHERE batch_id = $1 AND raw ? $2 LIMIT 1`, [batchId, letter]);
  return (r.rowCount ?? 0) > 0;
}

export interface RowChange {
  rowNumber: number;
  splitIndex: number;
  decision?: Decision | undefined;
  /** Complete replacement of the row's overrides (null clears them). */
  overrides?: RowOverrides | null | undefined;
}

export async function updateRows(db: Database, id: string, changes: RowChange[], expectedVersion: number, actor: Actor): Promise<ImportBatch> {
  return inReview(db, id, expectedVersion, actor, async (client) => {
    for (const c of changes) {
      const result = await client.query(
        `UPDATE product_import_rows
            SET decision = COALESCE($4, decision),
                overrides = CASE WHEN $5::boolean THEN COALESCE($6::jsonb, '{}'::jsonb) ELSE overrides END
          WHERE batch_id = $1 AND row_number = $2 AND split_index = $3`,
        [id, c.rowNumber, c.splitIndex, c.decision ?? null, c.overrides !== undefined, c.overrides ? JSON.stringify(c.overrides) : null],
      );
      if (result.rowCount === 0) throw new AppError(400, 'UNKNOWN_ROW', `Row ${c.rowNumber} is not part of this import`);
    }
  });
}

/**
 * Splits one source row into several products (e.g. a pack and a loose piece, or one product per
 * page count). The original row is kept and marked "skip"; each part gets its own overrides and is
 * analysed like any other row. Nothing is calculated: every price comes from the user.
 */
export async function splitRow(db: Database, id: string, rowNumber: number, parts: RowOverrides[], expectedVersion: number, actor: Actor): Promise<ImportBatch> {
  return inReview(db, id, expectedVersion, actor, async (client) => {
    const original = (
      await client.query<{ section: string | null; raw: RawRow }>(
        `SELECT section, raw FROM product_import_rows WHERE batch_id = $1 AND row_number = $2 AND split_index = 0 FOR UPDATE`,
        [id, rowNumber],
      )
    ).rows[0];
    if (!original) throw new AppError(400, 'UNKNOWN_ROW', `Row ${rowNumber} is not part of this import`);
    await client.query(`DELETE FROM product_import_rows WHERE batch_id = $1 AND row_number = $2 AND split_index > 0`, [id, rowNumber]);
    await client.query(`UPDATE product_import_rows SET decision = 'skip' WHERE batch_id = $1 AND row_number = $2 AND split_index = 0`, [id, rowNumber]);
    for (const [i, overrides] of parts.entries()) {
      await client.query(
        `INSERT INTO product_import_rows (batch_id, row_number, split_index, section, raw, overrides) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [id, rowNumber, i + 1, original.section, JSON.stringify(original.raw), JSON.stringify(overrides)],
      );
    }
  });
}

export async function unsplitRow(db: Database, id: string, rowNumber: number, expectedVersion: number, actor: Actor): Promise<ImportBatch> {
  return inReview(db, id, expectedVersion, actor, async (client) => {
    await client.query(`DELETE FROM product_import_rows WHERE batch_id = $1 AND row_number = $2 AND split_index > 0`, [id, rowNumber]);
    await client.query(`UPDATE product_import_rows SET decision = 'pending' WHERE batch_id = $1 AND row_number = $2 AND split_index = 0`, [id, rowNumber]);
  });
}

export async function discardBatch(db: Database, id: string, expectedVersion: number, actor: Actor): Promise<ImportBatch> {
  await withSessionTransaction(db, actor.sessionId, async (client) => {
    const batch = await selectBatch(client, id, true);
    if (batch.status !== 'review') throw new AppError(409, batch.status === 'committed' ? 'ALREADY_COMMITTED' : 'IMPORT_DISCARDED', `This import was already ${batch.status}.`);
    if (batch.version !== expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', 'This import was changed in another window. Reload it first.');
    await client.query(`UPDATE product_import_batches SET status = 'discarded', version = version + 1, updated_by = $2 WHERE id = $1`, [id, actor.userId]);
    await recordFinancialAudit(client, {
      entityType: 'product_import',
      entityId: id,
      action: 'discard',
      actorUserId: actor.userId,
      before: { status: 'review' },
      after: { status: 'discarded' },
    });
  });
  return getBatch(db, id);
}

// --- Commit --------------------------------------------------------------------------------------------

class StalePreview extends Error {}

/** What must not have changed between the reviewed preview and the commit. */
const reviewSignature = (rows: AnalysedRow[]) =>
  JSON.stringify(
    rows.map((r) => [
      r.rowNumber,
      r.splitIndex,
      r.group,
      r.effectiveDecision,
      r.matchedProductId,
      r.duplicateOf,
      r.issues.filter((i) => i.severity === 'error').map((i) => i.code),
      // Explicit fields: stored proposals come back from JSONB with their keys reordered.
      r.proposal.brand ? [r.proposal.brand.kind, r.proposal.brand.kind === 'existing' ? r.proposal.brand.id : '', r.proposal.brand.name] : null,
      r.proposal.categoryId,
    ]),
  );

/**
 * Commits the whole batch in ONE transaction: approved new brands first, then every row marked
 * create/update. The analysis is re-run against the CURRENT database inside the transaction; if
 * anything differs from what was reviewed (a product, brand or category changed meanwhile) the
 * transaction rolls back, the refreshed preview is saved, and 409 IMPORT_STALE asks for a review.
 * Any failure rolls everything back: a batch is never partly committed.
 */
export async function commitBatch(db: Database, id: string, expectedVersion: number, actor: Actor): Promise<ImportBatch> {
  try {
    await withSessionTransaction(db, actor.sessionId, async (client) => {
      const batch = await selectBatch(client, id, true);
      if (batch.status === 'committed') throw new AppError(409, 'ALREADY_COMMITTED', 'This import was already committed.');
      if (batch.status !== 'review') throw new AppError(409, 'IMPORT_DISCARDED', 'This import was discarded.');
      if (batch.version !== expectedVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'This import was changed in another window after you opened it. Reload it before committing.');
      }
      const stored = asAnalysed(await loadRows(client, id));
      const ctx = await loadContext(client, batch);
      const rows = await loadRows(client, id);
      const fresh = analyseRows(rows.map(toStored), ctx);
      if (reviewSignature(fresh) !== reviewSignature(stored)) {
        throw new StalePreview();
      }
      const blockers = commitBlockers(fresh, batch.mapping);
      if (blockers.length) throw new AppError(422, 'IMPORT_NOT_READY', blockers.join(' '));

      const toImport = fresh.filter((r) => r.effectiveDecision === 'create' || r.effectiveDecision === 'update');
      const audit = (r: AnalysedRow) => ({ importBatchId: id, sourceRow: r.splitIndex ? `${r.rowNumber}.${r.splitIndex}` : String(r.rowNumber) });

      // New brands, only those actually used by imported rows. Approval is in brand_decisions.
      const newBrands = new Map<string, string>();
      for (const r of toImport) {
        if (r.proposal.brand?.kind !== 'new') continue;
        const key = normaliseSearchText(r.proposal.brand.name);
        if (newBrands.has(key)) continue;
        const existing = (await client.query<{ id: string }>(`SELECT id FROM brands WHERE is_active AND lower(name) = lower($1)`, [r.proposal.brand.name])).rows[0];
        if (existing) throw new StalePreview();
        const created = await client.query<{ id: string }>(`INSERT INTO brands (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [
          r.proposal.brand.name,
          actor.userId,
        ]);
        newBrands.set(key, created.rows[0]!.id);
        await recordFinancialAudit(client, {
          entityType: 'brand',
          entityId: created.rows[0]!.id,
          action: 'create',
          actorUserId: actor.userId,
          before: null,
          after: { name: r.proposal.brand.name, isActive: true, importBatchId: id },
        });
      }

      let created = 0;
      let updated = 0;
      for (const r of toImport) {
        const p = r.proposal;
        const brandId = p.brand === null ? null : p.brand.kind === 'existing' ? p.brand.id : newBrands.get(normaliseSearchText(p.brand.name))!;
        let productId: string;
        if (r.effectiveDecision === 'create') {
          const input: ProductCreateInput = {
            name: p.name!,
            brandId,
            categoryId: p.categoryId!,
            sku: p.sku,
            barcode: p.barcode,
            description: p.description,
            size: p.size,
            pageCount: p.pageCount,
            gsm: p.gsm,
            binding: p.binding,
            sellingUnit: p.sellingUnit,
            packQty: p.packQty,
            attributes: p.attributes,
            searchAliases: p.searchAliases,
            mrp: p.mrp,
            sellingPrice: p.sellingPrice!,
            confirmations: p.confirmSpAboveMrp ? ['sp_above_mrp'] : [],
            defaultPurchasePrice: p.purchasePrice,
          };
          productId = (await insertProduct(client, input, actor, audit(r))).id;
          created++;
        } else {
          // "Update prices": only the prices present in the row change; nothing is renamed.
          productId = r.matchedProductId!;
          const changes: { sellingPrice?: string; mrp?: string } = { sellingPrice: p.sellingPrice! };
          if (p.mrp !== null) changes.mrp = p.mrp;
          await applyProductUpdate(client, productId, changes, p.confirmSpAboveMrp ? ['sp_above_mrp'] : [], null, actor, audit(r));
          if (p.purchasePrice !== null) await setImportedDefaultCost(client, productId, p.purchasePrice, actor, audit(r));
          updated++;
        }
        await client.query(`UPDATE product_import_rows SET result_product_id = $4 WHERE batch_id = $1 AND row_number = $2 AND split_index = $3`, [
          id,
          r.rowNumber,
          r.splitIndex,
          productId,
        ]);
      }

      const summary: BatchSummary = {
        ...(batch.summary ?? { header: {}, skipped: [], sections: [] }),
        result: { created, updated, skipped: fresh.length - toImport.length, brandsCreated: newBrands.size },
      };
      await client.query(
        `UPDATE product_import_batches
            SET status = 'committed', committed_at = now(), committed_by = $2, updated_by = $2, version = version + 1, summary = $3::jsonb
          WHERE id = $1`,
        [id, actor.userId, JSON.stringify(summary)],
      );
      await recordFinancialAudit(client, {
        entityType: 'product_import',
        entityId: id,
        action: 'commit',
        actorUserId: actor.userId,
        before: { status: 'review' },
        after: { status: 'committed', created, updated, skipped: summary.result!.skipped, brandsCreated: newBrands.size },
      });
    });
  } catch (err) {
    if (!(err instanceof StalePreview)) throw err;
    // Save the refreshed analysis (outside the rolled-back transaction) so the user sees what changed.
    await withSessionTransaction(db, actor.sessionId, async (client) => {
      const batch = await selectBatch(client, id, true);
      await reanalyse(client, batch);
      await client.query(`UPDATE product_import_batches SET version = version + 1 WHERE id = $1`, [id]);
    });
    throw new AppError(409, 'IMPORT_STALE', 'Products, brands or categories changed since this preview was made. Review the refreshed preview, then commit again.');
  }
  return getBatch(db, id);
}

async function setImportedDefaultCost(client: Queryable, productId: string, price: string, actor: Actor, audit: Record<string, string>): Promise<void> {
  const current = (await client.query<{ default_purchase_price: string | null }>(`SELECT default_purchase_price FROM product_costs WHERE product_id = $1 FOR UPDATE`, [productId])).rows[0];
  if (!current) {
    await client.query(`INSERT INTO product_costs (product_id, default_purchase_price, created_by, updated_by) VALUES ($1, $2, $3, $3)`, [productId, price, actor.userId]);
    await recordFinancialAudit(client, { entityType: 'product_cost', entityId: productId, action: 'create', actorUserId: actor.userId, before: null, after: { supplier: null, purchasePrice: price, ...audit } });
    return;
  }
  if (current.default_purchase_price === price) return;
  await client.query(`UPDATE product_costs SET default_purchase_price = $2, updated_by = $3, version = version + 1 WHERE product_id = $1`, [productId, price, actor.userId]);
  await recordFinancialAudit(client, {
    entityType: 'product_cost',
    entityId: productId,
    action: 'update',
    actorUserId: actor.userId,
    before: { supplier: null, purchasePrice: current.default_purchase_price },
    after: { supplier: null, purchasePrice: price, ...audit },
  });
}

// --- Error report ----------------------------------------------------------------------------------------

/** Every row with its original row number, raw cells, group, decision and issues (formula-safe). */
export async function errorReport(db: Queryable, id: string, shopName: string): Promise<{ buffer: Buffer; fileName: string }> {
  const batch = await selectBatch(db, id);
  const rows = await loadRows(db, id);
  const header: Record<string, string> = batch.summary?.header ?? {};
  const letters = [...new Set([...Object.keys(header), ...rows.flatMap((r) => Object.keys(r.raw))])].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  const wb: ExcelJS.Workbook = newWorkbook(shopName);
  const ws = wb.addWorksheet('Import review');
  ws.addRow(['Row', 'Part', 'Section', ...letters.map((l) => `${l}: ${header[l] ?? ''}`), 'Group', 'Decision', 'Errors', 'Warnings']).font = { bold: true };
  for (const r of rows) {
    const effective = effectiveOf(r);
    const line = ws.addRow([
      r.row_number,
      r.split_index || '',
      safeText(r.section),
      ...letters.map((l) => safeText(cellText(r.raw[l]))),
      r.grp,
      effective,
      safeText(r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('\n')),
      safeText(r.issues.filter((i) => i.severity === 'warning').map((i) => i.message).join('\n')),
    ]);
    line.eachCell((cell) => {
      if (typeof cell.value === 'string') cell.numFmt = '@';
    });
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns.forEach((c) => (c.width = 18));
  const skipped = wb.addWorksheet('Skipped rows');
  skipped.addRow(['Row', 'Reason', 'Text']).font = { bold: true };
  for (const s of (batch.summary ?? { skipped: [] as SkippedRow[] }).skipped) skipped.addRow([s.rowNumber, s.reason, safeText(s.text)]);
  const safeName = batch.file_name.replace(/\.xlsx$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'import';
  return { buffer: await workbookBuffer(wb), fileName: `${safeName}_import-review.xlsx` };
}

export { columnLetter };
