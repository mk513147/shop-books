import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';

export type BrandStatus = 'active' | 'archived' | 'all';

/** Brands (manufacturers): master data, independent of suppliers and categories (migration 0012). */
export interface Brand {
  id: string;
  name: string;
  isActive: boolean;
  /** Expenses tagged with this brand (any status). */
  expenseCount: number;
  /** Suppliers that list this brand as a default. */
  supplierCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandRef {
  id: string;
  name: string;
  isActive: boolean;
}

interface BrandRow {
  id: string;
  name: string;
  is_active: boolean;
  expense_count: number;
  supplier_count: number;
  created_at: Date;
  updated_at: Date;
}

const BRAND_COLUMNS = `b.id, b.name, b.is_active, b.created_at, b.updated_at,
  (SELECT count(*)::int FROM expense_brands eb WHERE eb.brand_id = b.id) AS expense_count,
  (SELECT count(*)::int FROM supplier_brands sb WHERE sb.brand_id = b.id) AS supplier_count`;

function toBrand(row: BrandRow): Brand {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    expenseCount: row.expense_count,
    supplierCount: row.supplier_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function snapshot(row: Pick<BrandRow, 'name' | 'is_active'>): AuditSnapshot {
  return { name: row.name, isActive: row.is_active };
}

function nameTaken(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'brands_active_name_unique';
}

const NAME_TAKEN = () => new AppError(409, 'BRAND_NAME_TAKEN', 'An active brand with this name already exists');

export async function listBrands(db: Queryable, status: BrandStatus): Promise<Brand[]> {
  const filter = status === 'active' ? 'WHERE b.is_active' : status === 'archived' ? 'WHERE NOT b.is_active' : '';
  const result = await db.query<BrandRow>(`SELECT ${BRAND_COLUMNS} FROM brands b ${filter} ORDER BY b.is_active DESC, lower(b.name)`);
  return result.rows.map(toBrand);
}

async function selectBrand(client: Queryable, id: string, lock = false): Promise<BrandRow> {
  const result = await client.query<BrandRow>(`SELECT ${BRAND_COLUMNS} FROM brands b WHERE b.id = $1 ${lock ? 'FOR UPDATE OF b' : ''}`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Brand not found');
  return row;
}

export async function getBrandHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectBrand(db, id);
  return listAuditHistory(db, 'brand', id);
}

export async function createBrand(db: Database, input: { name: string }, actor: Actor): Promise<Brand> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO brands (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
        [input.name, actor.userId],
      );
      const row = await selectBrand(client, inserted.rows[0]!.id);
      await recordFinancialAudit(client, {
        entityType: 'brand',
        entityId: row.id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: snapshot(row),
      });
      return toBrand(row);
    });
  } catch (err) {
    if (nameTaken(err)) throw NAME_TAKEN();
    throw err;
  }
}

/**
 * Rename / archive / reactivate. Archiving never touches expenses or supplier defaults: existing
 * links stay (history); an archived brand just cannot be newly chosen or auto-selected.
 */
export async function updateBrand(
  db: Database,
  id: string,
  changes: { name?: string | undefined; isActive?: boolean | undefined },
  actor: Actor,
): Promise<Brand> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const before = await selectBrand(client, id, true);
      const next = { name: changes.name ?? before.name, is_active: changes.isActive ?? before.is_active };
      const beforeSnap = snapshot(before);
      const afterSnap = snapshot(next);
      if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return toBrand(before);
      await client.query(`UPDATE brands SET name = $2, is_active = $3, updated_by = $4 WHERE id = $1`, [
        id,
        next.name,
        next.is_active,
        actor.userId,
      ]);
      await recordFinancialAudit(client, {
        entityType: 'brand',
        entityId: id,
        action: before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive',
        actorUserId: actor.userId,
        before: beforeSnap,
        after: afterSnap,
      });
      return toBrand(await selectBrand(client, id));
    });
  } catch (err) {
    if (nameTaken(err)) throw NAME_TAKEN();
    throw err;
  }
}
