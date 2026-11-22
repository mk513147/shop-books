import { createHmac } from 'node:crypto';
import type pg from 'pg';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { rupees, toPaise } from '../../utils/money.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { hashRequest, runIdempotent, type IdempotentResult } from '../idempotency/idempotency.js';
import type { ProductCreateInput, ProductListQuery, ProductSort, ProductUpdateInput, SimilarQuery, SellingUnit } from './products.schemas.js';
import { escapeLike, FUZZY_MIN_TOKEN_LENGTH, isNumericToken, normaliseSearchText, searchTokens } from './search.js';

/**
 * Product catalogue (migration 0015). Catalogue ONLY: no stock or sales.
 *
 * PURCHASE PRICES NEVER APPEAR HERE. Nothing in this file reads product_costs or
 * product_suppliers.purchase_price; those live in productCosts.service.ts behind the
 * purchase-price permission. Search never looks at prices either.
 */

export interface Ref {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Product {
  id: string;
  name: string;
  brand: Ref | null;
  category: Ref & { isProductUsable: boolean };
  sku: string | null;
  barcode: string | null;
  description: string | null;
  size: string | null;
  pageCount: number | null;
  gsm: number | null;
  binding: string | null;
  sellingUnit: SellingUnit;
  packQty: number;
  attributes: Record<string, string | number>;
  searchAliases: string[];
  mrp: string | null;
  sellingPrice: string;
  /** Set when the selling price is above the MRP: who confirmed it, and when. */
  spAboveMrpConfirmation: { at: string; by: { id: string; name: string } } | null;
  supplierCount: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string };
}

interface ProductRow {
  id: string;
  name: string;
  brand_id: string | null;
  brand_name: string | null;
  brand_active: boolean | null;
  category_id: string;
  category_name: string;
  category_active: boolean;
  category_usable: boolean;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  size: string | null;
  page_count: number | null;
  gsm: number | null;
  binding: string | null;
  selling_unit: SellingUnit;
  pack_qty: number;
  attributes: Record<string, string | number>;
  search_aliases: string[];
  mrp: string | null;
  selling_price: string;
  sp_above_mrp_confirmed_at: Date | null;
  confirmed_by_id: string | null;
  confirmed_by_name: string | null;
  supplier_count: number;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by_id: string;
  created_by_name: string;
  updated_by_id: string;
  updated_by_name: string;
}

/** Every column a Product needs. Deliberately no cost table in this list. */
const PRODUCT_COLUMNS = `
  p.id, p.name, p.brand_id, b.name AS brand_name, b.is_active AS brand_active,
  p.category_id, c.name AS category_name, c.is_active AS category_active, c.is_product_usable AS category_usable,
  p.sku, p.barcode, p.description, p.size, p.page_count, p.gsm, p.binding, p.selling_unit, p.pack_qty,
  p.attributes, p.search_aliases, p.mrp, p.selling_price, p.sp_above_mrp_confirmed_at,
  cfu.id AS confirmed_by_id, cfu.name AS confirmed_by_name,
  (SELECT count(*)::int FROM product_suppliers ps2 WHERE ps2.product_id = p.id) AS supplier_count,
  p.is_active, p.version, p.created_at, p.updated_at,
  cu.id AS created_by_id, cu.name AS created_by_name, uu.id AS updated_by_id, uu.name AS updated_by_name`;

const PRODUCT_JOINS = `
  LEFT JOIN brands b ON b.id = p.brand_id
  JOIN expense_categories c ON c.id = p.category_id
  LEFT JOIN users cfu ON cfu.id = p.sp_above_mrp_confirmed_by
  JOIN users cu ON cu.id = p.created_by
  JOIN users uu ON uu.id = p.updated_by`;

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name ?? '', isActive: row.brand_active ?? false } : null,
    category: { id: row.category_id, name: row.category_name, isActive: row.category_active, isProductUsable: row.category_usable },
    sku: row.sku,
    barcode: row.barcode,
    description: row.description,
    size: row.size,
    pageCount: row.page_count,
    gsm: row.gsm,
    binding: row.binding,
    sellingUnit: row.selling_unit,
    packQty: row.pack_qty,
    attributes: row.attributes,
    searchAliases: row.search_aliases,
    mrp: row.mrp,
    sellingPrice: row.selling_price,
    spAboveMrpConfirmation:
      row.sp_above_mrp_confirmed_at && row.confirmed_by_id
        ? { at: row.sp_above_mrp_confirmed_at.toISOString(), by: { id: row.confirmed_by_id, name: row.confirmed_by_name ?? '' } }
        : null,
    supplierCount: row.supplier_count,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
  };
}

/** Business fields recorded in the audit log. NO purchase prices (those are 'product_cost'). */
interface Details {
  name: string;
  brand_id: string | null;
  brand_name: string | null;
  category_id: string;
  category_name: string;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  size: string | null;
  page_count: number | null;
  gsm: number | null;
  binding: string | null;
  selling_unit: SellingUnit;
  pack_qty: number;
  attributes: Record<string, string | number>;
  search_aliases: string[];
  mrp: string | null;
  selling_price: string;
  is_active: boolean;
}

function snapshot(d: Details, extra: AuditSnapshot = {}): AuditSnapshot {
  return {
    name: d.name,
    brand: d.brand_name,
    category: d.category_name,
    sku: d.sku,
    barcode: d.barcode,
    description: d.description,
    size: d.size,
    pageCount: d.page_count,
    gsm: d.gsm,
    binding: d.binding,
    sellingUnit: d.selling_unit,
    packQty: d.pack_qty,
    attributes: Object.keys(d.attributes).length ? JSON.stringify(sortedObject(d.attributes)) : null,
    searchAliases: d.search_aliases.length ? d.search_aliases.join(', ') : null,
    mrp: d.mrp,
    sellingPrice: d.selling_price,
    isActive: d.is_active,
    ...extra,
  };
}

function sortedObject<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

async function selectProduct(client: Queryable, id: string, lock = false): Promise<ProductRow> {
  if (lock) {
    const locked = await client.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) throw new NotFoundError('Product not found');
  }
  const row = (await client.query<ProductRow>(`SELECT ${PRODUCT_COLUMNS} FROM products p ${PRODUCT_JOINS} WHERE p.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError('Product not found');
  return row;
}

export async function getProduct(db: Queryable, id: string): Promise<Product> {
  return toProduct(await selectProduct(db, id));
}

/** Throws 404 unless the product exists (used before protected reads). */
export async function assertProductExists(db: Queryable, id: string): Promise<void> {
  const found = await db.query(`SELECT 1 FROM products WHERE id = $1`, [id]);
  if (found.rowCount === 0) throw new NotFoundError('Product not found');
}

// --- Price rules ----------------------------------------------------------------------------------

export const PRICE_CONFIRMATION_REQUIRED = (sellingPrice: string, mrp: string) =>
  new AppError(422, 'PRICE_CONFIRMATION_REQUIRED', `The selling price ${rupees(sellingPrice)} is above the MRP ${rupees(mrp)}. Confirm to save it anyway.`, [
    { path: 'sellingPrice', message: `Selling price ${rupees(sellingPrice)} is above the MRP ${rupees(mrp)}` },
  ]);

export const spAboveMrp = (sellingPrice: string, mrp: string | null): boolean => mrp !== null && toPaise(sellingPrice) > toPaise(mrp);

// --- Master data checks ---------------------------------------------------------------------------

interface CategoryCheckRow {
  id: string;
  name: string;
  is_active: boolean;
  is_product_usable: boolean;
}

/** A newly chosen category must be active and marked "Use for products". */
async function loadCategory(client: Queryable, id: string, mustBeSelectable: boolean): Promise<CategoryCheckRow> {
  const row = (
    await client.query<CategoryCheckRow>(`SELECT id, name, is_active, is_product_usable FROM expense_categories WHERE id = $1 FOR SHARE`, [id])
  ).rows[0];
  if (!row) throw new ValidationError([{ path: 'categoryId', message: 'Choose a category' }]);
  if (mustBeSelectable && (!row.is_active || !row.is_product_usable)) {
    throw new ValidationError([
      {
        path: 'categoryId',
        message: row.is_active
          ? `“${row.name}” is not marked for products. Mark it on the Categories page, or choose another category.`
          : `“${row.name}” is archived. Choose another category.`,
      },
    ]);
  }
  return row;
}

async function loadBrand(client: Queryable, id: string, mustBeActive: boolean): Promise<{ id: string; name: string }> {
  const row = (await client.query<{ id: string; name: string; is_active: boolean }>(`SELECT id, name, is_active FROM brands WHERE id = $1 FOR SHARE`, [id])).rows[0];
  if (!row) throw new ValidationError([{ path: 'brandId', message: 'Choose a valid brand' }]);
  if (mustBeActive && !row.is_active) throw new ValidationError([{ path: 'brandId', message: `“${row.name}” is archived. Choose another brand.` }]);
  return row;
}

/** Unique-index clashes on SKU / barcode (among active products) as a clear 409. */
export function codeConflict(err: unknown, reactivating = false): AppError | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  const which = e.constraint === 'products_active_sku_unique' ? 'SKU' : e.constraint === 'products_active_barcode_unique' ? 'barcode' : null;
  if (!which) return null;
  const path = which === 'SKU' ? 'sku' : 'barcode';
  return new AppError(
    409,
    which === 'SKU' ? 'SKU_TAKEN' : 'BARCODE_TAKEN',
    reactivating
      ? `This product cannot be reactivated: an active product already uses its ${which}. Change one of the ${which}s first.`
      : `An active product already uses this ${which}.`,
    [{ path, message: `Another active product already uses this ${which}` }],
  );
}

// --- Create ----------------------------------------------------------------------------------------

export interface CreatedProduct {
  product: Product;
}

/**
 * Creates a product. A `defaultPurchasePrice` in the input is accepted only from users with the
 * purchase-price CHANGE permission (the route refuses it for everyone else, before this runs). The
 * RESPONSE never contains a purchase price, so the idempotency record (which stores the response)
 * never holds one either.
 */
export async function createProduct(
  db: Database,
  input: ProductCreateInput,
  actor: Actor,
  idempotencyKey: string | null,
  priceKey: Buffer,
): Promise<IdempotentResult<CreatedProduct>> {
  const work = async (client: pg.PoolClient) => {
    const created = await insertProduct(client, input, actor);
    return { status: 201, body: { product: created }, resourceId: created.id };
  };
  if (!idempotencyKey) {
    const result = await withSessionTransaction(db, actor.sessionId, work);
    return { status: result.status, body: result.body, replayed: false };
  }
  // A plain hash of the price could be guessed back (prices are short), so the stored request hash
  // covers the price only through a keyed HMAC (server secret): a key reused with a different
  // purchase price is refused (409 IDEMPOTENCY_KEY_REUSED), and the stored hash reveals nothing.
  const { defaultPurchasePrice, ...hashed } = input;
  const purchasePriceFingerprint = createHmac('sha256', priceKey).update(JSON.stringify(defaultPurchasePrice ?? null)).digest('hex');
  return runIdempotent(db, actor, 'product.create', idempotencyKey, hashRequest({ ...hashed, purchasePriceFingerprint }), work);
}

/** HMAC key for purchase-price fingerprints in idempotency hashes, derived from the server secret. */
export function purchasePriceFingerprintKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('shop-books:idempotency:product.create:purchase-price').digest();
}

/** Inserts one product (+ its default cost) and the audit rows, inside the caller's transaction. */
export async function insertProduct(
  client: Queryable,
  input: ProductCreateInput,
  actor: Actor,
  audit: AuditSnapshot = {},
): Promise<Product> {
  const category = await loadCategory(client, input.categoryId, true);
  const brand = input.brandId ? await loadBrand(client, input.brandId, true) : null;
  const above = spAboveMrp(input.sellingPrice, input.mrp);
  if (above && !input.confirmations.includes('sp_above_mrp')) throw PRICE_CONFIRMATION_REQUIRED(input.sellingPrice, input.mrp!);

  let id: string;
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO products (name, brand_id, category_id, sku, barcode, description, size, page_count, gsm, binding,
                             selling_unit, pack_qty, attributes, search_aliases, mrp, selling_price,
                             sp_above_mrp_confirmed_at, sp_above_mrp_confirmed_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::text[], $15, $16,
               CASE WHEN $17::boolean THEN now() END, CASE WHEN $17::boolean THEN $18::uuid END, $18, $18)
       RETURNING id`,
      [
        input.name,
        input.brandId,
        input.categoryId,
        input.sku,
        input.barcode,
        input.description,
        input.size,
        input.pageCount,
        input.gsm,
        input.binding,
        input.sellingUnit,
        input.packQty,
        JSON.stringify(input.attributes),
        input.searchAliases,
        input.mrp,
        input.sellingPrice,
        above,
        actor.userId,
      ],
    );
    id = inserted.rows[0]!.id;
  } catch (err) {
    throw codeConflict(err) ?? err;
  }

  await recordFinancialAudit(client, {
    entityType: 'product',
    entityId: id,
    action: 'create',
    actorUserId: actor.userId,
    before: null,
    after: snapshot(
      {
        name: input.name,
        brand_id: brand?.id ?? null,
        brand_name: brand?.name ?? null,
        category_id: category.id,
        category_name: category.name,
        sku: input.sku,
        barcode: input.barcode,
        description: input.description,
        size: input.size,
        page_count: input.pageCount,
        gsm: input.gsm,
        binding: input.binding,
        selling_unit: input.sellingUnit,
        pack_qty: input.packQty,
        attributes: input.attributes,
        search_aliases: input.searchAliases,
        mrp: input.mrp,
        selling_price: input.sellingPrice,
        is_active: true,
      },
      { spAboveMrpConfirmed: above, ...audit },
    ),
  });

  if (input.defaultPurchasePrice !== undefined && input.defaultPurchasePrice !== null) {
    await client.query(
      `INSERT INTO product_costs (product_id, default_purchase_price, created_by, updated_by) VALUES ($1, $2, $3, $3)`,
      [id, input.defaultPurchasePrice, actor.userId],
    );
    await recordFinancialAudit(client, {
      entityType: 'product_cost',
      entityId: id,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: { supplier: null, purchasePrice: input.defaultPurchasePrice, ...audit },
    });
  }
  return toProduct(await selectProduct(client, id));
}

// --- Update / deactivate / reactivate ------------------------------------------------------------

export async function updateProduct(
  db: Database,
  id: string,
  changes: ProductUpdateInput,
  confirmations: string[],
  expectedVersion: number,
  actor: Actor,
): Promise<Product> {
  return withSessionTransaction(db, actor.sessionId, (client) => applyProductUpdate(client, id, changes, confirmations, expectedVersion, actor));
}

export async function applyProductUpdate(
  client: Queryable,
  id: string,
  changes: ProductUpdateInput,
  confirmations: string[],
  expectedVersion: number | null,
  actor: Actor,
  audit: AuditSnapshot = {},
): Promise<Product> {
  const before = await selectProduct(client, id, true);
  if (expectedVersion !== null && before.version !== expectedVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', 'This product was changed by someone else after you opened it. Reload to see the latest version.');
  }

  // A newly chosen category / brand must be selectable; unchanged ones stay even if archived since.
  let categoryName = before.category_name;
  if (changes.categoryId !== undefined && changes.categoryId !== before.category_id) {
    categoryName = (await loadCategory(client, changes.categoryId, true)).name;
  }
  let brandName = before.brand_name;
  if (changes.brandId !== undefined && changes.brandId !== before.brand_id) {
    brandName = changes.brandId ? (await loadBrand(client, changes.brandId, true)).name : null;
  }

  const pick = <K extends keyof ProductUpdateInput, V>(key: K, current: V): V =>
    (changes[key] === undefined ? current : changes[key]) as V;
  const next: Details = {
    name: pick('name', before.name),
    brand_id: pick('brandId', before.brand_id),
    brand_name: brandName,
    category_id: pick('categoryId', before.category_id),
    category_name: categoryName,
    sku: pick('sku', before.sku),
    barcode: pick('barcode', before.barcode),
    description: pick('description', before.description),
    size: pick('size', before.size),
    page_count: pick('pageCount', before.page_count),
    gsm: pick('gsm', before.gsm),
    binding: pick('binding', before.binding),
    selling_unit: pick('sellingUnit', before.selling_unit),
    pack_qty: pick('packQty', before.pack_qty),
    attributes: pick('attributes', before.attributes),
    search_aliases: pick('searchAliases', before.search_aliases),
    mrp: pick('mrp', before.mrp),
    selling_price: pick('sellingPrice', before.selling_price),
    is_active: pick('isActive', before.is_active),
  };
  if (next.selling_unit === 'piece' && next.pack_qty !== 1) {
    throw new ValidationError([{ path: 'packQty', message: 'A product sold by the piece has a pack quantity of 1' }]);
  }

  // Selling above the MRP needs a (fresh) confirmation whenever either price changes.
  const above = spAboveMrp(next.selling_price, next.mrp);
  const pricesChanged = next.selling_price !== before.selling_price || next.mrp !== before.mrp;
  const alreadyConfirmed = before.sp_above_mrp_confirmed_at !== null && !pricesChanged;
  if (above && !alreadyConfirmed && !confirmations.includes('sp_above_mrp')) {
    throw PRICE_CONFIRMATION_REQUIRED(next.selling_price, next.mrp!);
  }
  const confirmation: 'keep' | 'set' | 'clear' = !above ? 'clear' : alreadyConfirmed ? 'keep' : 'set';

  const beforeSnap = snapshot(before as unknown as Details, { spAboveMrpConfirmed: before.sp_above_mrp_confirmed_at !== null });
  const afterSnap = snapshot(next, { spAboveMrpConfirmed: above });
  if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return toProduct(before);

  try {
    await client.query(
      `UPDATE products
          SET name = $2, brand_id = $3, category_id = $4, sku = $5, barcode = $6, description = $7, size = $8,
              page_count = $9, gsm = $10, binding = $11, selling_unit = $12, pack_qty = $13, attributes = $14::jsonb,
              search_aliases = $15::text[], mrp = $16, selling_price = $17, is_active = $18,
              sp_above_mrp_confirmed_at = CASE $19 WHEN 'keep' THEN sp_above_mrp_confirmed_at WHEN 'set' THEN now() END,
              sp_above_mrp_confirmed_by = CASE $19 WHEN 'keep' THEN sp_above_mrp_confirmed_by WHEN 'set' THEN $20::uuid END,
              updated_by = $20, version = version + 1
        WHERE id = $1`,
      [
        id,
        next.name,
        next.brand_id,
        next.category_id,
        next.sku,
        next.barcode,
        next.description,
        next.size,
        next.page_count,
        next.gsm,
        next.binding,
        next.selling_unit,
        next.pack_qty,
        JSON.stringify(next.attributes),
        next.search_aliases,
        next.mrp,
        next.selling_price,
        next.is_active,
        confirmation,
        actor.userId,
      ],
    );
  } catch (err) {
    throw codeConflict(err, !before.is_active && next.is_active) ?? err;
  }
  await recordFinancialAudit(client, {
    entityType: 'product',
    entityId: id,
    action: before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive',
    actorUserId: actor.userId,
    before: beforeSnap,
    after: { ...afterSnap, ...audit },
  });
  return toProduct(await selectProduct(client, id));
}

/** Product history for everyone: product and supplier-link events, never purchase prices. */
export async function getProductHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await assertProductExists(db, id);
  return listAuditHistory(db, ['product'], id);
}

/** Purchase-price history ('product_cost' events). Only through the protected, logged route. */
export async function getProductCostHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await assertProductExists(db, id);
  return listAuditHistory(db, ['product_cost'], id);
}

// --- Search ----------------------------------------------------------------------------------------

export interface ProductListResult {
  items: Product[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /** True when nothing matched exactly and these are typo-tolerant ("close") matches. */
  closeMatches: boolean;
}

class Params {
  readonly values: unknown[] = [];
  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface SearchSql {
  where: string[];
  rank: string;
  /** How many leading bound parameters the WHERE clauses use (the rest are for ranking). */
  whereParams: number;
}

/**
 * Strict search: EVERY token must appear (as a substring) in the product's search document or in
 * its supplier names; numeric tokens may also be a barcode / SKU prefix. Each token is its own
 * bound LIKE, so the pg_trgm GIN indexes can serve it. Ranking (highest first):
 *   exact barcode/SKU (1000) > all tokens in the product's own fields (100) > brand starts with the
 *   first token (50) > exact size / pages / GSM (20 each) > word-start matches (10 each) > shorter document.
 * Supplier-name-only matches get none of the product bonuses, so they rank last.
 */
function strictSearch(params: Params, q: string, tokens: string[]): SearchSql {
  // 1. Filter parameters first (the count query uses only these: see SearchSql.whereParams).
  const where: string[] = [];
  const contains = tokens.map((token) => {
    const c = params.bind(`%${escapeLike(token)}%`);
    const alternatives = [`ps.document LIKE ${c} ESCAPE '\\'`, `ps.supplier_document LIKE ${c} ESCAPE '\\'`];
    if (isNumericToken(token)) {
      const prefix = params.bind(`${escapeLike(token)}%`);
      alternatives.push(`lower(p.barcode) LIKE ${prefix} ESCAPE '\\'`, `lower(p.sku) LIKE ${prefix} ESCAPE '\\'`);
    }
    where.push(`(${alternatives.join(' OR ')})`);
    return c;
  });
  const whereParams = params.values.length;

  // 2. Ranking parameters.
  const raw = params.bind(q.trim());
  const bonuses: string[] = [];
  tokens.forEach((token, i) => {
    if (isNumericToken(token)) {
      const n = params.bind(Number(token) <= 2_000_000_000 ? Number(token) : -1);
      bonuses.push(`(CASE WHEN p.page_count = ${n}::int THEN 20 ELSE 0 END)`, `(CASE WHEN p.gsm = ${n}::int THEN 20 ELSE 0 END)`);
    }
    bonuses.push(`(CASE WHEN p.size = upper(${params.bind(token)}::text) THEN 20 ELSE 0 END)`);
    bonuses.push(`(CASE WHEN (' ' || ps.document) LIKE ${params.bind(`% ${escapeLike(token)}%`)} ESCAPE '\\' THEN 10 ELSE 0 END)`);
    if (i === 0) {
      // lower() rather than product_search_norm(): no regular expression per candidate row.
      bonuses.push(`(CASE WHEN lower(b.name) LIKE ${params.bind(`${escapeLike(token)}%`)} ESCAPE '\\' THEN 50 ELSE 0 END)`);
    }
  });
  const rank = [
    `(CASE WHEN lower(p.barcode) = lower(${raw}::text) OR lower(p.sku) = lower(${raw}::text) THEN 1000 ELSE 0 END)`,
    `(CASE WHEN ${contains.map((c) => `ps.document LIKE ${c} ESCAPE '\\'`).join(' AND ')} THEN 100 ELSE 0 END)`,
    ...bonuses,
    // Tie-break: shorter documents are more specific matches (cheap, unlike trigram similarity).
    `(1.0 / (1 + length(ps.document)))`,
  ].join(' + ');
  return { where, rank, whereParams };
}

/** Most corrections tried per misspelt word. */
const MAX_CORRECTIONS = 3;
/** Minimum trigram similarity between a typed word and a catalogue word to count as a correction. */
const CORRECTION_SIMILARITY = 0.4;

/**
 * Typo tolerance, step 1: correct each word of 4+ letters against the catalogue's vocabulary
 * (product_search_words, a small trigram-indexed table: migration 0016), e.g. "clasmate" ->
 * "classmate". Short words and numbers are kept as typed. Returns null when there is nothing to
 * correct or a word has no close match (then there are no close matches either).
 */
async function correctTokens(db: Queryable, tokens: string[]): Promise<string[][] | null> {
  const corrected: string[][] = [];
  let changed = false;
  for (const token of tokens) {
    if (token.length < FUZZY_MIN_TOKEN_LENGTH || isNumericToken(token)) {
      corrected.push([token]);
      continue;
    }
    const words = (
      await db.query<{ word: string }>(
        `SELECT word FROM product_search_words
          WHERE word % $1 AND similarity(word, $1) >= $2
          ORDER BY similarity(word, $1) DESC, word LIMIT $3`,
        [token, CORRECTION_SIMILARITY, MAX_CORRECTIONS],
      )
    ).rows.map((r) => r.word);
    if (words.length === 0) return null;
    if (words.length > 1 || words[0] !== token) changed = true;
    corrected.push(words);
  }
  return changed ? corrected : null;
}

/**
 * Typo tolerance, step 2: the normal indexed substring search with each word replaced by its
 * corrections (any of them may match). Closer corrections rank higher. Used only when the strict
 * search found too little.
 */
async function fuzzySearch(db: Queryable, params: Params, tokens: string[]): Promise<SearchSql | null> {
  const corrected = await correctTokens(db, tokens);
  if (!corrected) return null;
  const where: string[] = [];
  const scores: string[] = [];
  for (const alternatives of corrected) {
    const bound = alternatives.map((word) => params.bind(`%${escapeLike(word)}%`));
    where.push(`(${bound.map((b) => `ps.document LIKE ${b} ESCAPE '\\' OR ps.supplier_document LIKE ${b} ESCAPE '\\'`).join(' OR ')})`);
    scores.push(`(CASE ${bound.map((b, i) => `WHEN ps.document LIKE ${b} ESCAPE '\\' THEN ${(MAX_CORRECTIONS - i) * 10}`).join(' ')} ELSE 0 END)`);
  }
  return { where, rank: scores.join(' + '), whereParams: params.values.length };
}

function orderBy(sort: ProductSort, dir: 'asc' | 'desc' | undefined, hasRank: boolean): string {
  const d = (fallback: 'asc' | 'desc') => ((dir ?? fallback) === 'asc' ? 'ASC' : 'DESC');
  switch (sort) {
    case 'relevance':
      return hasRank ? `rank DESC, lower(p.name), p.id` : `lower(p.name), p.id`;
    case 'brand':
      return `lower(b.name) ${d('asc')} NULLS LAST, lower(p.name), p.id`;
    case 'selling_price':
      return `p.selling_price ${d('asc')}, lower(p.name), p.id`;
    case 'mrp':
      return `p.mrp ${d('asc')} NULLS LAST, lower(p.name), p.id`;
    case 'updated':
      return `p.updated_at ${d('desc')}, p.id`;
    case 'name':
    default:
      return `lower(p.name) ${d('asc')}, lower(b.name) NULLS FIRST, p.id`;
  }
}

function filters(params: Params, query: Pick<ProductListQuery, 'status' | 'brandId' | 'categoryId'>): string[] {
  const where: string[] = [];
  if (query.status === 'active') where.push('p.is_active');
  if (query.status === 'inactive') where.push('NOT p.is_active');
  if (query.brandId === 'none') where.push('p.brand_id IS NULL');
  else if (query.brandId) where.push(`p.brand_id = ${params.bind(query.brandId)}`);
  if (query.categoryId) where.push(`p.category_id = ${params.bind(query.categoryId)}`);
  return where;
}

async function runList(db: Queryable, query: ProductListQuery, mode: 'strict' | 'fuzzy'): Promise<ProductListResult | null> {
  const params = new Params();
  const where = filters(params, query);
  const tokens = query.q ? searchTokens(query.q) : [];
  let rank = '0';
  let whereParams = params.values.length;
  if (tokens.length) {
    const search = mode === 'strict' ? strictSearch(params, query.q!, tokens) : await fuzzySearch(db, params, tokens);
    if (!search) return null;
    where.push(...search.where);
    rank = search.rank;
    whereParams = search.whereParams;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM products p JOIN product_search ps ON ps.product_id = p.id LEFT JOIN brands b ON b.id = p.brand_id`;
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n ${from} ${whereSql}`, params.values.slice(0, whereParams))).rows[0]!.n;
  const sort = query.sort ?? (tokens.length ? 'relevance' : 'name');
  const limit = params.bind(query.pageSize);
  const offset = params.bind((query.page - 1) * query.pageSize);
  const ids = await db.query<{ id: string }>(
    `SELECT p.id, ${rank} AS rank ${from} ${whereSql} ORDER BY ${orderBy(sort, query.dir, tokens.length > 0)} LIMIT ${limit} OFFSET ${offset}`,
    params.values,
  );
  const items = await productsByIds(db, ids.rows.map((r) => r.id));
  return {
    items,
    pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
    closeMatches: mode === 'fuzzy',
  };
}

/** Full products for the given ids, in the given order. */
async function productsByIds(db: Queryable, ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<ProductRow>(`SELECT ${PRODUCT_COLUMNS} FROM products p ${PRODUCT_JOINS} WHERE p.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.rows.map((r) => [r.id, toProduct(r)]));
  return ids.map((id) => byId.get(id)).filter((p): p is Product => p !== undefined);
}

/** Catalogue list with search, filters, sorting and pagination. Never includes purchase prices. */
export async function listProducts(db: Queryable, query: ProductListQuery): Promise<ProductListResult> {
  const strict = (await runList(db, query, 'strict'))!;
  if (strict.pagination.total > 0 || !query.q) return strict;
  return (await runList(db, query, 'fuzzy')) ?? strict;
}

export interface QuickSearchItem {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  size: string | null;
  pageCount: number | null;
  gsm: number | null;
  binding: string | null;
  sellingUnit: SellingUnit;
  packQty: number;
  sku: string | null;
  barcode: string | null;
  mrp: string | null;
  sellingPrice: string;
  /** Matched only through typo tolerance. */
  close: boolean;
}

/**
 * Fast type-ahead for the quick lookup: active products only, slim rows, no total count (one row
 * more than the limit tells whether there are more). Close (typo-tolerant) matches fill up a short
 * strict result.
 */
export async function quickSearch(db: Queryable, q: string, limit: number): Promise<{ items: QuickSearchItem[]; hasMore: boolean }> {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return { items: [], hasMore: false };
  const select = `SELECT p.id, p.name, b.name AS brand, c.name AS category, p.size, p.page_count, p.gsm, p.binding,
                         p.selling_unit, p.pack_qty, p.sku, p.barcode, p.mrp, p.selling_price`;
  const from = `FROM products p JOIN product_search ps ON ps.product_id = p.id LEFT JOIN brands b ON b.id = p.brand_id
                JOIN expense_categories c ON c.id = p.category_id`;
  type Row = {
    id: string;
    name: string;
    brand: string | null;
    category: string;
    size: string | null;
    page_count: number | null;
    gsm: number | null;
    binding: string | null;
    selling_unit: SellingUnit;
    pack_qty: number;
    sku: string | null;
    barcode: string | null;
    mrp: string | null;
    selling_price: string;
  };
  const toItem = (r: Row, close: boolean): QuickSearchItem => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    category: r.category,
    size: r.size,
    pageCount: r.page_count,
    gsm: r.gsm,
    binding: r.binding,
    sellingUnit: r.selling_unit,
    packQty: r.pack_qty,
    sku: r.sku,
    barcode: r.barcode,
    mrp: r.mrp,
    sellingPrice: r.selling_price,
    close,
  });

  const strictParams = new Params();
  const strict = strictSearch(strictParams, q, tokens);
  const strictRows = await db.query<Row>(
    `${select} ${from} WHERE p.is_active AND ${strict.where.join(' AND ')}
      ORDER BY ${strict.rank} DESC, lower(p.name), p.id LIMIT ${strictParams.bind(limit + 1)}`,
    strictParams.values,
  );
  const items = strictRows.rows.slice(0, limit).map((r) => toItem(r, false));
  let hasMore = strictRows.rows.length > limit;
  if (items.length < Math.min(5, limit)) {
    const fuzzyParams = new Params();
    const fuzzy = await fuzzySearch(db, fuzzyParams, tokens);
    if (fuzzy) {
      const room = limit - items.length;
      const seen = fuzzyParams.bind(items.map((i) => i.id));
      const more = await db.query<Row>(
        `${select} ${from} WHERE p.is_active AND NOT (p.id = ANY(${seen}::uuid[])) AND ${fuzzy.where.join(' AND ')}
          ORDER BY ${fuzzy.rank} DESC, lower(p.name), p.id LIMIT ${fuzzyParams.bind(room + 1)}`,
        fuzzyParams.values,
      );
      items.push(...more.rows.slice(0, room).map((r) => toItem(r, true)));
      hasMore = hasMore || more.rows.length > room;
    }
  }
  return { items, hasMore };
}

/** Exact barcode or SKU (letter case ignored for both; migration 0017). Active products first. */
export async function lookupByCode(db: Queryable, code: string): Promise<Product[]> {
  const ids = await db.query<{ id: string }>(
    `SELECT id FROM products WHERE lower(barcode) = lower($1) OR lower(sku) = lower($1) ORDER BY is_active DESC, lower(name), id LIMIT 10`,
    [code.trim()],
  );
  return productsByIds(db, ids.rows.map((r) => r.id));
}

export interface SimilarProduct {
  product: Product;
  /** Same brand, same name (ignoring case and punctuation) and the same size/pages/GSM/binding. */
  sameSpecs: boolean;
}

/**
 * Possible duplicates for the product form's warning: same brand (or both unbranded) and a similar
 * name. Advisory only: two products may legitimately share a description (e.g. different colour).
 */
export async function findSimilar(db: Queryable, q: SimilarQuery): Promise<SimilarProduct[]> {
  const name = normaliseSearchText(q.name);
  if (!name) return [];
  const rows = await db.query<{ id: string; same_specs: boolean }>(
    `SELECT p.id,
            (product_search_norm(p.name) = $2
             AND p.size IS NOT DISTINCT FROM $3 AND p.page_count IS NOT DISTINCT FROM $4
             AND p.gsm IS NOT DISTINCT FROM $5 AND p.binding IS NOT DISTINCT FROM $6) AS same_specs
       FROM products p
      WHERE p.is_active
        AND p.brand_id IS NOT DISTINCT FROM $1
        AND (product_search_norm(p.name) = $2 OR similarity(product_search_norm(p.name), $2) >= 0.5)
        AND ($7::uuid IS NULL OR p.id <> $7)
      ORDER BY 2 DESC, similarity(product_search_norm(p.name), $2) DESC, p.id
      LIMIT 5`,
    [
      q.brandId ?? null,
      name,
      q.size ? q.size.trim().replace(/\s+/g, ' ').toUpperCase() : null,
      q.pageCount ?? null,
      q.gsm ?? null,
      q.binding ? q.binding.trim().replace(/\s+/g, ' ').toLowerCase() : null,
      q.excludeId ?? null,
    ],
  );
  const products = await productsByIds(db, rows.rows.map((r) => r.id));
  const same = new Map(rows.rows.map((r) => [r.id, r.same_specs]));
  return products.map((product) => ({ product, sameSpecs: same.get(product.id) ?? false }));
}

/** Active suppliers that list the product's brand (existing supplier_brands links), not yet linked. */
export async function supplierSuggestions(db: Queryable, productId: string): Promise<{ id: string; name: string; phone: string | null }[]> {
  const product = await selectProduct(db, productId);
  if (!product.brand_id) return [];
  const rows = await db.query<{ id: string; name: string; phone: string | null }>(
    `SELECT s.id, s.name, s.phone
       FROM supplier_brands sb JOIN suppliers s ON s.id = sb.supplier_id
      WHERE sb.brand_id = $1 AND s.is_active
        AND NOT EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = $2 AND ps.supplier_id = s.id)
      ORDER BY lower(s.name), s.id`,
    [product.brand_id, productId],
  );
  return rows.rows;
}
