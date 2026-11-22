import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { toPaise } from '../../utils/money.js';
import { recordFinancialAudit, type AuditSnapshot } from '../audit/financialAudit.js';
import { recordAuthEvent, type RequestContext } from '../auth/auth.events.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { PURCHASE_PRICE_CHANGE_FORBIDDEN } from './permissions.js';
import type { SupplierLinkCreateInput, SupplierLinkUpdateInput } from './products.schemas.js';
import { assertProductExists } from './products.service.js';

/**
 * Purchase prices and product <-> supplier links.
 *
 * Every function that RETURNS a purchase price must only be reached through routes guarded by
 * requirePurchasePriceAccess, and every such read is recorded (recordPurchasePriceAccess: who,
 * what, when; never the amount). Supplier-link responses never contain prices. Supplier link
 * events are audited on the 'product' entity WITHOUT prices; every price change is a separate
 * 'product_cost' event, readable only through the protected cost-history endpoint.
 *
 * Writes that alter a stored purchase price or the effective price need the CHANGE permission
 * (`canEditPrices`), checked here inside the transaction after the rows are locked.
 */

export type PriceAccessScope = 'page' | 'product' | 'form' | 'history' | 'after_change';

/**
 * Access trail for purchase-price reads (auth_events 'purchase_prices_viewed'), for every user
 * including the owner. Records the user, the screen and the product ids: never a price. Called
 * AFTER the read succeeded and BEFORE the response is sent, so a failed log fails the request
 * (no prices leave without a record) and refused or failed reads leave no "viewed" record.
 */
export async function recordPurchasePriceAccess(
  db: Queryable,
  ctx: RequestContext,
  userId: string,
  scope: PriceAccessScope,
  productIds: string[],
): Promise<void> {
  await recordAuthEvent(db, ctx, {
    type: 'purchase_prices_viewed',
    userId,
    details: { scope, productCount: productIds.length, productIds: productIds.slice(0, 100) },
  });
}

const LINK_HOLDS_PRICE = () =>
  PURCHASE_PRICE_CHANGE_FORBIDDEN(
    'This change would alter purchase-price information (the supplier link holds a purchase price). Ask the owner or someone allowed to change purchase prices.',
  );

export type CostSource = 'preferred_supplier' | 'default' | null;

export interface EffectiveCost {
  productId: string;
  defaultPurchasePrice: string | null;
  preferredSupplier: { id: string; name: string; isActive: boolean; purchasePrice: string | null } | null;
  /** Preferred supplier's price (when that supplier is active and has a price), else the default. */
  effectivePurchasePrice: string | null;
  source: CostSource;
}

interface CostRow {
  id: string;
  default_purchase_price: string | null;
  pref_supplier_id: string | null;
  pref_supplier_name: string | null;
  pref_supplier_active: boolean | null;
  pref_price: string | null;
}

function toEffective(row: CostRow): EffectiveCost {
  const preferred = row.pref_supplier_id
    ? { id: row.pref_supplier_id, name: row.pref_supplier_name ?? '', isActive: row.pref_supplier_active ?? false, purchasePrice: row.pref_price }
    : null;
  if (preferred && preferred.isActive && preferred.purchasePrice !== null) {
    return { productId: row.id, defaultPurchasePrice: row.default_purchase_price, preferredSupplier: preferred, effectivePurchasePrice: preferred.purchasePrice, source: 'preferred_supplier' };
  }
  if (row.default_purchase_price !== null) {
    return { productId: row.id, defaultPurchasePrice: row.default_purchase_price, preferredSupplier: preferred, effectivePurchasePrice: row.default_purchase_price, source: 'default' };
  }
  return { productId: row.id, defaultPurchasePrice: null, preferredSupplier: preferred, effectivePurchasePrice: null, source: null };
}

async function effectiveCosts(db: Queryable, ids: string[]): Promise<EffectiveCost[]> {
  const result = await db.query<CostRow>(
    `SELECT p.id, pc.default_purchase_price,
            pref.supplier_id AS pref_supplier_id, s.name AS pref_supplier_name, s.is_active AS pref_supplier_active,
            pref.purchase_price AS pref_price
       FROM products p
       LEFT JOIN product_costs pc ON pc.product_id = p.id
       LEFT JOIN product_suppliers pref ON pref.product_id = p.id AND pref.is_preferred
       LEFT JOIN suppliers s ON s.id = pref.supplier_id
      WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(result.rows.map((r) => [r.id, toEffective(r)]));
  return ids.map((id) => byId.get(id)).filter((c): c is EffectiveCost => c !== undefined);
}

/** Reveal for one screen (the visible page of the catalogue, one product, or the edit form). Logged. */
export async function revealPurchasePrices(
  db: Database,
  ids: string[],
  scope: 'page' | 'product' | 'form',
  userId: string,
  ctx: RequestContext,
): Promise<EffectiveCost[]> {
  const costs = await effectiveCosts(db, ids);
  await recordPurchasePriceAccess(db, ctx, userId, scope, costs.map((c) => c.productId));
  return costs;
}

export interface CostWarning {
  code: 'PURCHASE_ABOVE_SELLING_PRICE' | 'PURCHASE_ABOVE_MRP';
  message: string;
}

export interface ProductCosts extends EffectiveCost {
  /** Version of the default cost record; 0 when none has ever been saved. */
  version: number;
  suppliers: { supplierId: string; supplierName: string; supplierActive: boolean; purchasePrice: string | null; isPreferred: boolean }[];
  /** Shown only to users who may see purchase prices (they are the only ones reaching this). */
  warnings: CostWarning[];
}

function costWarnings(price: string | null, sellingPrice: string, mrp: string | null): CostWarning[] {
  if (price === null) return [];
  const warnings: CostWarning[] = [];
  if (toPaise(price) > toPaise(sellingPrice)) {
    warnings.push({ code: 'PURCHASE_ABOVE_SELLING_PRICE', message: 'The purchase price is above the selling price: this product is sold at a loss.' });
  }
  if (mrp !== null && toPaise(price) > toPaise(mrp)) {
    warnings.push({ code: 'PURCHASE_ABOVE_MRP', message: 'The purchase price is above the MRP.' });
  }
  return warnings;
}

export async function getProductCosts(db: Queryable, productId: string): Promise<ProductCosts> {
  await assertProductExists(db, productId);
  const [effective] = await effectiveCosts(db, [productId]);
  const meta = (
    await db.query<{ version: number | null; selling_price: string; mrp: string | null }>(
      `SELECT pc.version, p.selling_price, p.mrp FROM products p LEFT JOIN product_costs pc ON pc.product_id = p.id WHERE p.id = $1`,
      [productId],
    )
  ).rows[0]!;
  const suppliers = await db.query<{ supplier_id: string; name: string; is_active: boolean; purchase_price: string | null; is_preferred: boolean }>(
    `SELECT ps.supplier_id, s.name, s.is_active, ps.purchase_price, ps.is_preferred
       FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ps.product_id = $1
      ORDER BY ps.is_preferred DESC, lower(s.name), s.id`,
    [productId],
  );
  return {
    ...effective!,
    version: meta.version ?? 0,
    suppliers: suppliers.rows.map((r) => ({
      supplierId: r.supplier_id,
      supplierName: r.name,
      supplierActive: r.is_active,
      purchasePrice: r.purchase_price,
      isPreferred: r.is_preferred,
    })),
    warnings: costWarnings(effective!.effectivePurchasePrice, meta.selling_price, meta.mrp),
  };
}

/** Sets or clears the default purchase price (optimistic: `version` 0 = no cost saved yet). */
export async function setDefaultCost(
  db: Database,
  productId: string,
  price: string | null,
  expectedVersion: number,
  actor: Actor,
): Promise<ProductCosts> {
  await withSessionTransaction(db, actor.sessionId, async (client) => {
    const locked = await client.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [productId]);
    if (locked.rowCount === 0) throw new NotFoundError('Product not found');
    const current = (
      await client.query<{ default_purchase_price: string | null; version: number }>(
        `SELECT default_purchase_price, version FROM product_costs WHERE product_id = $1 FOR UPDATE`,
        [productId],
      )
    ).rows[0];
    if ((current?.version ?? 0) !== expectedVersion) {
      throw new AppError(409, 'VERSION_CONFLICT', 'The purchase price was changed by someone else after you opened it. Reload to see the latest version.');
    }
    if (!current) {
      if (price === null) return;
      await client.query(`INSERT INTO product_costs (product_id, default_purchase_price, created_by, updated_by) VALUES ($1, $2, $3, $3)`, [
        productId,
        price,
        actor.userId,
      ]);
      await recordFinancialAudit(client, {
        entityType: 'product_cost',
        entityId: productId,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: { supplier: null, purchasePrice: price },
      });
      return;
    }
    if (current.default_purchase_price === price) return;
    await client.query(
      `UPDATE product_costs SET default_purchase_price = $2, updated_by = $3, version = version + 1 WHERE product_id = $1`,
      [productId, price, actor.userId],
    );
    await recordFinancialAudit(client, {
      entityType: 'product_cost',
      entityId: productId,
      action: 'update',
      actorUserId: actor.userId,
      before: { supplier: null, purchasePrice: current.default_purchase_price },
      after: { supplier: null, purchasePrice: price },
    });
  });
  return getProductCosts(db, productId);
}

// --- Supplier links --------------------------------------------------------------------------------

export interface SupplierLink {
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierActive: boolean;
  supplierProductCode: string | null;
  notes: string | null;
  isPreferred: boolean;
  version: number;
  updatedAt: string;
  // Never a purchase price here, for anyone: supplier prices are read only through GET /:id/costs.
}

interface LinkRow {
  supplier_id: string;
  supplier_name: string;
  supplier_phone: string | null;
  supplier_active: boolean;
  supplier_product_code: string | null;
  notes: string | null;
  is_preferred: boolean;
  version: number;
  updated_at: Date;
  purchase_price: string | null;
}

function toLink(row: LinkRow): SupplierLink {
  return {
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierPhone: row.supplier_phone,
    supplierActive: row.supplier_active,
    supplierProductCode: row.supplier_product_code,
    notes: row.notes,
    isPreferred: row.is_preferred,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const LINK_SELECT = `
  SELECT ps.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone, s.is_active AS supplier_active,
         ps.supplier_product_code, ps.notes, ps.is_preferred, ps.version, ps.updated_at, ps.purchase_price
    FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id`;

export async function listSupplierLinks(db: Queryable, productId: string): Promise<SupplierLink[]> {
  await assertProductExists(db, productId);
  const rows = await db.query<LinkRow>(`${LINK_SELECT} WHERE ps.product_id = $1 ORDER BY ps.is_preferred DESC, lower(s.name), s.id`, [productId]);
  return rows.rows.map(toLink);
}

function linkSnapshot(row: Pick<LinkRow, 'supplier_name' | 'supplier_product_code' | 'notes' | 'is_preferred'>): AuditSnapshot {
  return { supplier: row.supplier_name, supplierProductCode: row.supplier_product_code, notes: row.notes, isPreferred: row.is_preferred };
}

/**
 * Locks one link. A request carrying the version the user saw (`missingIsConflict`) treats a link
 * that no longer exists as a concurrent change (409): someone else removed it after the screen loaded.
 */
async function lockLink(client: Queryable, productId: string, supplierId: string, missingIsConflict = false): Promise<LinkRow> {
  const row = (await client.query<LinkRow>(`${LINK_SELECT} WHERE ps.product_id = $1 AND ps.supplier_id = $2 FOR UPDATE OF ps`, [productId, supplierId])).rows[0];
  if (!row && missingIsConflict) {
    throw new AppError(409, 'VERSION_CONFLICT', 'This supplier is no longer linked to the product: someone else changed it after you opened it. Reload to see the latest version.');
  }
  if (!row) throw new NotFoundError('This supplier is not linked to the product');
  return row;
}

/** The current preferred link of another supplier (locked), if any. */
async function otherPreferred(client: Queryable, productId: string, except: string): Promise<LinkRow | undefined> {
  return (await client.query<LinkRow>(`${LINK_SELECT} WHERE ps.product_id = $1 AND ps.is_preferred AND ps.supplier_id <> $2 FOR UPDATE OF ps`, [productId, except])).rows[0];
}

/**
 * Moving the preferred flag changes the effective purchase price whenever the link losing or
 * gaining it holds a price. Without the CHANGE permission that is refused (the refusal reveals
 * only that a price exists, never its amount).
 */
function assertPreferredMoveAllowed(canEditPrices: boolean, ...links: (Pick<LinkRow, 'purchase_price'> | undefined)[]): void {
  if (canEditPrices) return;
  if (links.some((l) => l !== undefined && l.purchase_price !== null)) throw LINK_HOLDS_PRICE();
}

/** Clears the current preferred flag (if another supplier has it), audited on that link. */
async function clearPreferred(client: Queryable, productId: string, current: LinkRow | undefined, actor: Actor): Promise<void> {
  if (!current) return;
  // Only the flag moves: stored prices are never changed by choosing another preferred supplier.
  await client.query(`UPDATE product_suppliers SET is_preferred = false, updated_by = $3, version = version + 1 WHERE product_id = $1 AND supplier_id = $2`, [
    productId,
    current.supplier_id,
    actor.userId,
  ]);
  await recordFinancialAudit(client, {
    entityType: 'product',
    entityId: productId,
    action: 'update_supplier_link',
    actorUserId: actor.userId,
    before: linkSnapshot(current),
    after: linkSnapshot({ ...current, is_preferred: false }),
  });
}

export async function linkSupplier(db: Database, productId: string, input: SupplierLinkCreateInput, actor: Actor, canEditPrices: boolean): Promise<SupplierLink> {
  if (input.purchasePrice !== undefined && !canEditPrices) throw PURCHASE_PRICE_CHANGE_FORBIDDEN();
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const locked = await client.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [productId]);
    if (locked.rowCount === 0) throw new NotFoundError('Product not found');
    const supplier = (await client.query<{ name: string; is_active: boolean }>(`SELECT name, is_active FROM suppliers WHERE id = $1 FOR SHARE`, [input.supplierId])).rows[0];
    if (!supplier) throw new ValidationError([{ path: 'supplierId', message: 'Choose a supplier' }]);
    if (!supplier.is_active) throw new ValidationError([{ path: 'supplierId', message: `“${supplier.name}” is archived. Choose another supplier.` }]);
    if (input.isPreferred) {
      const previous = await otherPreferred(client, productId, input.supplierId);
      assertPreferredMoveAllowed(canEditPrices, previous);
      await clearPreferred(client, productId, previous, actor);
    }
    const price = input.purchasePrice ?? null;
    const inserted = await client.query(
      `INSERT INTO product_suppliers (product_id, supplier_id, purchase_price, supplier_product_code, notes, is_preferred, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT DO NOTHING`,
      [productId, input.supplierId, price, input.supplierProductCode, input.notes, input.isPreferred, actor.userId],
    );
    if (inserted.rowCount === 0) throw new AppError(409, 'SUPPLIER_ALREADY_LINKED', `“${supplier.name}” is already linked to this product.`);
    await recordFinancialAudit(client, {
      entityType: 'product',
      entityId: productId,
      action: 'link_supplier',
      actorUserId: actor.userId,
      // Only 'create' may have no "before" (financial_audit_before_valid).
      before: { supplier: supplier.name, linked: false },
      after: linkSnapshot({ supplier_name: supplier.name, supplier_product_code: input.supplierProductCode, notes: input.notes, is_preferred: input.isPreferred }),
    });
    if (price !== null) {
      await recordFinancialAudit(client, {
        entityType: 'product_cost',
        entityId: productId,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: { supplier: supplier.name, purchasePrice: price },
      });
    }
    return toLink(await lockLink(client, productId, input.supplierId));
  });
}

export async function updateSupplierLink(
  db: Database,
  productId: string,
  supplierId: string,
  changes: SupplierLinkUpdateInput,
  expectedVersion: number,
  actor: Actor,
  canEditPrices: boolean,
): Promise<SupplierLink> {
  if (changes.purchasePrice !== undefined && !canEditPrices) throw PURCHASE_PRICE_CHANGE_FORBIDDEN();
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const locked = await client.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [productId]);
    if (locked.rowCount === 0) throw new NotFoundError('Product not found');
    const before = await lockLink(client, productId, supplierId, true);
    if (before.version !== expectedVersion) {
      throw new AppError(409, 'VERSION_CONFLICT', 'This supplier link was changed by someone else after you opened it. Reload to see the latest version.');
    }
    const next = {
      supplier_name: before.supplier_name,
      supplier_product_code: changes.supplierProductCode === undefined ? before.supplier_product_code : changes.supplierProductCode,
      notes: changes.notes === undefined ? before.notes : changes.notes,
      is_preferred: changes.isPreferred ?? before.is_preferred,
      purchase_price: changes.purchasePrice === undefined ? before.purchase_price : changes.purchasePrice,
    };
    const detailsChanged = JSON.stringify(linkSnapshot(before)) !== JSON.stringify(linkSnapshot(next));
    const priceChanged = next.purchase_price !== before.purchase_price;
    if (!detailsChanged && !priceChanged) return toLink(before);
    if (next.is_preferred && !before.is_preferred) {
      // An archived supplier cannot become the preferred (effective-price) supplier. The supplier
      // row is locked FOR SHARE so a concurrent archive either waits for this commit (and then
      // refuses: the supplier is preferred) or commits first (and this re-read sees it archived).
      const supplier = (await client.query<{ is_active: boolean }>(`SELECT is_active FROM suppliers WHERE id = $1 FOR SHARE`, [supplierId])).rows[0];
      if (!supplier?.is_active) {
        throw new ValidationError([{ path: 'isPreferred', message: `“${before.supplier_name}” is archived and cannot be the preferred supplier.` }]);
      }
      const previous = await otherPreferred(client, productId, supplierId);
      assertPreferredMoveAllowed(canEditPrices, previous, before);
      await clearPreferred(client, productId, previous, actor);
    } else if (!next.is_preferred && before.is_preferred) {
      assertPreferredMoveAllowed(canEditPrices, before);
    }
    await client.query(
      `UPDATE product_suppliers
          SET supplier_product_code = $3, notes = $4, is_preferred = $5, purchase_price = $6, updated_by = $7, version = version + 1
        WHERE product_id = $1 AND supplier_id = $2`,
      [productId, supplierId, next.supplier_product_code, next.notes, next.is_preferred, next.purchase_price, actor.userId],
    );
    if (detailsChanged) {
      await recordFinancialAudit(client, {
        entityType: 'product',
        entityId: productId,
        action: 'update_supplier_link',
        actorUserId: actor.userId,
        before: linkSnapshot(before),
        after: linkSnapshot(next),
      });
    }
    if (priceChanged) {
      await recordFinancialAudit(client, {
        entityType: 'product_cost',
        entityId: productId,
        action: 'update',
        actorUserId: actor.userId,
        before: { supplier: before.supplier_name, purchasePrice: before.purchase_price },
        after: { supplier: before.supplier_name, purchasePrice: next.purchase_price },
      });
    }
    return toLink(await lockLink(client, productId, supplierId));
  });
}

/**
 * Unlinks a supplier. Optimistic: `expectedVersion` must be the link's current version (a stale
 * screen gets 409 VERSION_CONFLICT instead of removing a link someone just changed). Unlinking
 * deletes the link's stored purchase price, so a link holding a price needs the CHANGE permission.
 */
export async function unlinkSupplier(
  db: Database,
  productId: string,
  supplierId: string,
  expectedVersion: number,
  actor: Actor,
  canEditPrices: boolean,
): Promise<void> {
  await withSessionTransaction(db, actor.sessionId, async (client) => {
    const locked = await client.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [productId]);
    if (locked.rowCount === 0) throw new NotFoundError('Product not found');
    const before = await lockLink(client, productId, supplierId, true);
    if (before.version !== expectedVersion) {
      throw new AppError(409, 'VERSION_CONFLICT', 'This supplier link was changed by someone else after you opened it. Reload to see the latest version.');
    }
    if (before.purchase_price !== null && !canEditPrices) throw LINK_HOLDS_PRICE();
    await client.query(`DELETE FROM product_suppliers WHERE product_id = $1 AND supplier_id = $2`, [productId, supplierId]);
    await recordFinancialAudit(client, {
      entityType: 'product',
      entityId: productId,
      action: 'unlink_supplier',
      actorUserId: actor.userId,
      before: linkSnapshot(before),
      after: { supplier: before.supplier_name, linked: false },
    });
    if (before.purchase_price !== null) {
      await recordFinancialAudit(client, {
        entityType: 'product_cost',
        entityId: productId,
        action: 'update',
        actorUserId: actor.userId,
        before: { supplier: before.supplier_name, purchasePrice: before.purchase_price },
        after: { supplier: before.supplier_name, purchasePrice: null },
      });
    }
  });
}
