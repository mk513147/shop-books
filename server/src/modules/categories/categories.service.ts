import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { recordFinancialAudit, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';

export type CategoryStatus = 'active' | 'archived' | 'all';

export interface Category {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  expenseCount: number;
  createdAt: string;
  updatedAt: string;
}

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  expense_count: number;
  created_at: Date;
  updated_at: Date;
}

const CATEGORY_COLUMNS = `c.id, c.name, c.description, c.is_active, c.created_at, c.updated_at,
  (SELECT count(*)::int FROM expense_category_links l WHERE l.category_id = c.id) AS expense_count`;

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    expenseCount: row.expense_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function snapshot(row: Pick<CategoryRow, 'name' | 'description' | 'is_active'>): AuditSnapshot {
  return { name: row.name, description: row.description, isActive: row.is_active };
}

function nameTaken(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'expense_categories_active_name_unique';
}

const NAME_TAKEN = () => new AppError(409, 'CATEGORY_NAME_TAKEN', 'An active category with this name already exists');

export async function listCategories(db: Queryable, status: CategoryStatus): Promise<Category[]> {
  const filter = status === 'active' ? 'WHERE c.is_active' : status === 'archived' ? 'WHERE NOT c.is_active' : '';
  const result = await db.query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM expense_categories c ${filter} ORDER BY c.is_active DESC, lower(c.name)`,
  );
  return result.rows.map(toCategory);
}

async function selectCategory(client: Queryable, id: string, lock = false): Promise<CategoryRow> {
  const result = await client.query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM expense_categories c WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Category not found');
  return row;
}

export async function createCategory(
  db: Database,
  input: { name: string; description: string | null },
  actor: Actor,
): Promise<Category> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO expense_categories (name, description, created_by, updated_by)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [input.name, input.description, actor.userId],
      );
      const row = await selectCategory(client, inserted.rows[0]!.id);
      await recordFinancialAudit(client, {
        entityType: 'expense_category',
        entityId: row.id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: snapshot(row),
      });
      return toCategory(row);
    });
  } catch (err) {
    if (nameTaken(err)) throw NAME_TAKEN();
    throw err;
  }
}

/**
 * Rename / describe / archive / reactivate. Archiving never touches existing expenses: they keep
 * their category; archived categories just cannot be chosen for new expenses or re-assignments.
 */
export async function updateCategory(
  db: Database,
  id: string,
  changes: { name?: string | undefined; description?: string | null | undefined; isActive?: boolean | undefined },
  actor: Actor,
): Promise<Category> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const before = await selectCategory(client, id, true);
      const next = {
        name: changes.name ?? before.name,
        description: changes.description === undefined ? before.description : changes.description,
        is_active: changes.isActive ?? before.is_active,
      };
      const beforeSnap = snapshot(before);
      const afterSnap = snapshot(next);
      if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return toCategory(before);

      await client.query(
        `UPDATE expense_categories SET name = $2, description = $3, is_active = $4, updated_by = $5 WHERE id = $1`,
        [id, next.name, next.description, next.is_active, actor.userId],
      );
      const action =
        before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive';
      await recordFinancialAudit(client, {
        entityType: 'expense_category',
        entityId: id,
        action,
        actorUserId: actor.userId,
        before: beforeSnap,
        after: afterSnap,
      });
      return toCategory(await selectCategory(client, id));
    });
  } catch (err) {
    if (nameTaken(err)) throw NAME_TAKEN();
    throw err;
  }
}
