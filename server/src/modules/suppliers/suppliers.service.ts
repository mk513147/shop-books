import type pg from 'pg';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { containsPattern } from '../../utils/sql.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import type { SupplierCreateInput, SupplierListQuery, SupplierUpdateInput } from './suppliers.schemas.js';

export interface CategoryRef {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  /** Linked categories (suggestions only), including archived ones, sorted by name. */
  categories: CategoryRef[];
  expenseCount: number;
  /** Derived (Stage 3C): still owed on active bills, and payments not yet allocated to bills. */
  payable: string;
  unallocated: string;
  createdAt: string;
  updatedAt: string;
}

interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  version: number;
  categories: CategoryRef[];
  expense_count: number;
  payable: string;
  unallocated: string;
  created_at: Date;
  updated_at: Date;
}

const SUPPLIER_COLUMNS = `s.id, s.name, s.phone, s.address, s.notes, s.is_active, s.version, s.created_at, s.updated_at,
  COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'isActive', c.is_active) ORDER BY lower(c.name))
              FROM supplier_categories sc JOIN expense_categories c ON c.id = sc.category_id
             WHERE sc.supplier_id = s.id), '[]'::json) AS categories,
  (SELECT count(*)::int FROM expenses e WHERE e.supplier_id = s.id) AS expense_count,
  (SELECT b.payable FROM supplier_balances b WHERE b.supplier_id = s.id) AS payable,
  (SELECT b.unallocated FROM supplier_balances b WHERE b.supplier_id = s.id) AS unallocated`;

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    isActive: row.is_active,
    version: row.version,
    categories: row.categories,
    expenseCount: row.expense_count,
    payable: row.payable,
    unallocated: row.unallocated,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type Details = Pick<SupplierRow, 'name' | 'phone' | 'address' | 'notes' | 'is_active'>;

function snapshot(row: Details): AuditSnapshot {
  return { name: row.name, phone: row.phone, address: row.address, notes: row.notes, isActive: row.is_active };
}

function nameTaken(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'suppliers_active_name_unique';
}

const NAME_TAKEN = () => new AppError(409, 'SUPPLIER_NAME_TAKEN', 'An active supplier with this name already exists');

async function selectSupplier(client: Queryable, id: string, lock = false): Promise<SupplierRow> {
  const result = await client.query<SupplierRow>(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers s WHERE s.id = $1 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Supplier not found');
  return row;
}

export interface SupplierListResult {
  items: Supplier[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export async function listSuppliers(db: Queryable, query: SupplierListQuery): Promise<SupplierListResult> {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.status === 'active') where.push('s.is_active');
  if (query.status === 'archived') where.push('NOT s.is_active');
  if (query.balance === 'payable') {
    where.push('EXISTS (SELECT 1 FROM supplier_balances b WHERE b.supplier_id = s.id AND b.payable > 0)');
  }
  let prefixOrder = '';
  if (query.q) {
    const pattern = bind(containsPattern(query.q));
    where.push(`(s.name ILIKE ${pattern} ESCAPE '\\' OR s.phone ILIKE ${pattern} ESCAPE '\\')`);
    // Names that start with the search text come first.
    prefixOrder = `(lower(s.name) LIKE ${bind(`${query.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} ESCAPE '\\') DESC,`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM suppliers s ${whereSql}`, params.slice(0, query.q ? 1 : 0))
  ).rows[0]!.n;

  const limit = bind(query.pageSize);
  const offset = bind((query.page - 1) * query.pageSize);
  const rows = await db.query<SupplierRow>(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers s ${whereSql}
      ORDER BY s.is_active DESC, ${prefixOrder} lower(s.name), s.id
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.rows.map(toSupplier),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

export async function getSupplier(db: Queryable, id: string): Promise<Supplier> {
  return toSupplier(await selectSupplier(db, id));
}

export async function getSupplierHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectSupplier(db, id);
  return listAuditHistory(db, 'supplier', id);
}

/** Share-locks the categories and checks they exist; `allowArchived` ids may be archived. */
async function loadCategories(
  client: Queryable,
  ids: string[],
  allowArchived: Set<string> = new Set(),
): Promise<Map<string, CategoryRef>> {
  if (ids.length === 0) return new Map();
  const result = await client.query<{ id: string; name: string; is_active: boolean }>(
    `SELECT id, name, is_active FROM expense_categories WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
    [ids],
  );
  const found = new Map(result.rows.map((r) => [r.id, { id: r.id, name: r.name, isActive: r.is_active }]));
  const problems = ids.flatMap((id) => {
    const c = found.get(id);
    if (!c) return ['A selected category no longer exists'];
    if (!c.isActive && !allowArchived.has(id)) return [`“${c.name}” is archived and cannot be linked`];
    return [];
  });
  if (problems.length > 0) throw new ValidationError(problems.map((message) => ({ path: 'categoryIds', message })));
  return found;
}

async function link(client: pg.PoolClient, supplierId: string, category: CategoryRef, actor: Actor): Promise<void> {
  await client.query(
    `INSERT INTO supplier_categories (supplier_id, category_id, created_by) VALUES ($1, $2, $3)`,
    [supplierId, category.id, actor.userId],
  );
  await recordFinancialAudit(client, {
    entityType: 'supplier',
    entityId: supplierId,
    action: 'link_category',
    actorUserId: actor.userId,
    before: { categoryId: category.id, categoryName: category.name, linked: false },
    after: { categoryId: category.id, categoryName: category.name, linked: true },
  });
}

async function unlink(client: pg.PoolClient, supplierId: string, category: CategoryRef, actor: Actor): Promise<void> {
  await client.query(`DELETE FROM supplier_categories WHERE supplier_id = $1 AND category_id = $2`, [
    supplierId,
    category.id,
  ]);
  await recordFinancialAudit(client, {
    entityType: 'supplier',
    entityId: supplierId,
    action: 'unlink_category',
    actorUserId: actor.userId,
    before: { categoryId: category.id, categoryName: category.name, linked: true },
    after: { categoryId: category.id, categoryName: category.name, linked: false },
  });
}

async function withNameCheck<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (nameTaken(err)) throw NAME_TAKEN();
    throw err;
  }
}

export async function createSupplier(db: Database, input: SupplierCreateInput, actor: Actor): Promise<Supplier> {
  return withNameCheck(() =>
    withSessionTransaction(db, actor.sessionId, async (client) => {
      const categories = await loadCategories(client, input.categoryIds);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO suppliers (name, phone, address, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [input.name, input.phone, input.address, input.notes, actor.userId],
      );
      const id = inserted.rows[0]!.id;
      await recordFinancialAudit(client, {
        entityType: 'supplier',
        entityId: id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: snapshot({ ...input, is_active: true }),
      });
      for (const category of categories.values()) await link(client, id, category, actor);
      return toSupplier(await selectSupplier(client, id));
    }),
  );
}

function assertVersion(row: SupplierRow, expected: number): void {
  if (row.version !== expected) {
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This supplier was changed by someone else after you opened it. Reload to see the latest version.',
    );
  }
}

/** Details, archive/reactivate and (optionally) the full set of linked categories, in one change. */
export async function updateSupplier(
  db: Database,
  id: string,
  changes: SupplierUpdateInput,
  expectedVersion: number,
  actor: Actor,
): Promise<Supplier> {
  return withNameCheck(() =>
    withSessionTransaction(db, actor.sessionId, async (client) => {
      const before = await selectSupplier(client, id, true);
      assertVersion(before, expectedVersion);

      const next: Details = {
        name: changes.name ?? before.name,
        phone: changes.phone === undefined ? before.phone : changes.phone,
        address: changes.address === undefined ? before.address : changes.address,
        notes: changes.notes === undefined ? before.notes : changes.notes,
        is_active: changes.isActive ?? before.is_active,
      };
      const beforeSnap = snapshot(before);
      const afterSnap = snapshot(next);
      const detailsChanged = JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap);

      const current = new Set(before.categories.map((c) => c.id));
      const wanted = new Set(changes.categoryIds ?? current);
      const toAdd = [...wanted].filter((cid) => !current.has(cid));
      const toRemove = before.categories.filter((c) => !wanted.has(c.id));
      if (toAdd.length > 0 && !next.is_active) {
        throw new AppError(409, 'SUPPLIER_ARCHIVED', 'Reactivate this supplier before linking categories to it.');
      }
      const added = await loadCategories(client, toAdd);

      if (!detailsChanged && toAdd.length === 0 && toRemove.length === 0) return toSupplier(before);

      await client.query(
        `UPDATE suppliers SET name = $2, phone = $3, address = $4, notes = $5, is_active = $6,
                updated_by = $7, version = version + 1
          WHERE id = $1`,
        [id, next.name, next.phone, next.address, next.notes, next.is_active, actor.userId],
      );
      if (detailsChanged) {
        await recordFinancialAudit(client, {
          entityType: 'supplier',
          entityId: id,
          action: before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive',
          actorUserId: actor.userId,
          before: beforeSnap,
          after: afterSnap,
        });
      }
      for (const category of toRemove) await unlink(client, id, category, actor);
      for (const category of added.values()) await link(client, id, category, actor);
      return toSupplier(await selectSupplier(client, id));
    }),
  );
}

/**
 * Adds one category link without a version check (used from the expense form's "remember this
 * category" offer). Still bumps the version, so an edit form opened earlier cannot silently drop it.
 * Linking an already-linked category is a no-op.
 */
export async function linkSupplierCategory(db: Database, id: string, categoryId: string, actor: Actor): Promise<Supplier> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const supplier = await selectSupplier(client, id, true);
    if (supplier.categories.some((c) => c.id === categoryId)) return toSupplier(supplier);
    if (!supplier.is_active) {
      throw new AppError(409, 'SUPPLIER_ARCHIVED', 'Reactivate this supplier before linking categories to it.');
    }
    const category = (await loadCategories(client, [categoryId])).get(categoryId)!;
    await link(client, id, category, actor);
    await client.query(`UPDATE suppliers SET updated_by = $2, version = version + 1 WHERE id = $1`, [id, actor.userId]);
    return toSupplier(await selectSupplier(client, id));
  });
}

/** Removes one link. Existing expenses are never affected. Removing a missing link is a no-op. */
export async function unlinkSupplierCategory(db: Database, id: string, categoryId: string, actor: Actor): Promise<Supplier> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const supplier = await selectSupplier(client, id, true);
    const category = supplier.categories.find((c) => c.id === categoryId);
    if (!category) return toSupplier(supplier);
    await unlink(client, id, category, actor);
    await client.query(`UPDATE suppliers SET updated_by = $2, version = version + 1 WHERE id = $1`, [id, actor.userId]);
    return toSupplier(await selectSupplier(client, id));
  });
}
