import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { containsPattern } from '../../utils/sql.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import type { SalesmanCreateInput, SalesmanListQuery, SalesmanUpdateInput } from './salesmen.schemas.js';

/**
 * Salesmen: a standalone directory (no links to expenses, suppliers or customers; no sales,
 * commissions or targets). Deactivated, never deleted; every change is audited.
 */
export interface Salesman {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string };
}

interface SalesmanRow {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by_id: string;
  created_by_name: string;
  updated_by_id: string;
  updated_by_name: string;
}

const SELECT_SALESMAN = `
  SELECT s.id, s.name, s.phone, s.notes, s.is_active, s.version, s.created_at, s.updated_at,
         cu.id AS created_by_id, cu.name AS created_by_name, uu.id AS updated_by_id, uu.name AS updated_by_name
    FROM salesmen s
    JOIN users cu ON cu.id = s.created_by
    JOIN users uu ON uu.id = s.updated_by`;

function toSalesman(row: SalesmanRow): Salesman {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    notes: row.notes,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
  };
}

type Details = Pick<SalesmanRow, 'name' | 'phone' | 'notes' | 'is_active'>;

function snapshot(row: Details): AuditSnapshot {
  return { name: row.name, phone: row.phone, notes: row.notes, isActive: row.is_active };
}

async function selectSalesman(client: Queryable, id: string, lock = false): Promise<SalesmanRow> {
  if (lock) {
    const locked = await client.query(`SELECT 1 FROM salesmen WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) throw new NotFoundError('Salesman not found');
  }
  const row = (await client.query<SalesmanRow>(`${SELECT_SALESMAN} WHERE s.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError('Salesman not found');
  return row;
}

export interface SalesmanListResult {
  items: Salesman[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export async function listSalesmen(db: Queryable, query: SalesmanListQuery): Promise<SalesmanListResult> {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.status === 'active') where.push('s.is_active');
  if (query.status === 'archived') where.push('NOT s.is_active');
  if (query.q) {
    const pattern = bind(containsPattern(query.q));
    const digits = query.q.replace(/\D/g, '');
    const phoneDigits = digits.length >= 3 ? ` OR regexp_replace(COALESCE(s.phone, ''), '[^0-9]', '', 'g') LIKE ${bind(`%${digits}%`)}` : '';
    where.push(`(s.name ILIKE ${pattern} ESCAPE '\\' OR s.phone ILIKE ${pattern} ESCAPE '\\'${phoneDigits})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM salesmen s ${whereSql}`, params)).rows[0]!.n;
  const limit = bind(query.pageSize);
  const offset = bind((query.page - 1) * query.pageSize);
  const rows = await db.query<SalesmanRow>(
    `${SELECT_SALESMAN} ${whereSql} ORDER BY s.is_active DESC, lower(s.name), s.id LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.rows.map(toSalesman),
    pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
  };
}

export async function getSalesman(db: Queryable, id: string): Promise<Salesman> {
  return toSalesman(await selectSalesman(db, id));
}

export async function getSalesmanHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectSalesman(db, id);
  return listAuditHistory(db, 'salesman', id);
}

export async function createSalesman(db: Database, input: SalesmanCreateInput, actor: Actor): Promise<Salesman> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO salesmen (name, phone, notes, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [input.name, input.phone, input.notes, actor.userId],
    );
    const id = inserted.rows[0]!.id;
    await recordFinancialAudit(client, {
      entityType: 'salesman',
      entityId: id,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: snapshot({ ...input, is_active: true }),
    });
    return toSalesman(await selectSalesman(client, id));
  });
}

/** Edit details and/or deactivate/reactivate, with optimistic concurrency. */
export async function updateSalesman(
  db: Database,
  id: string,
  changes: SalesmanUpdateInput,
  expectedVersion: number,
  actor: Actor,
): Promise<Salesman> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const before = await selectSalesman(client, id, true);
    if (before.version !== expectedVersion) {
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'This salesman was changed by someone else after you opened it. Reload to see the latest version.',
      );
    }
    const next: Details = {
      name: changes.name ?? before.name,
      phone: changes.phone === undefined ? before.phone : changes.phone,
      notes: changes.notes === undefined ? before.notes : changes.notes,
      is_active: changes.isActive ?? before.is_active,
    };
    const beforeSnap = snapshot(before);
    const afterSnap = snapshot(next);
    if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return toSalesman(before);

    await client.query(
      `UPDATE salesmen SET name = $2, phone = $3, notes = $4, is_active = $5, updated_by = $6, version = version + 1 WHERE id = $1`,
      [id, next.name, next.phone, next.notes, next.is_active, actor.userId],
    );
    await recordFinancialAudit(client, {
      entityType: 'salesman',
      entityId: id,
      action: before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive',
      actorUserId: actor.userId,
      before: beforeSnap,
      after: afterSnap,
    });
    return toSalesman(await selectSalesman(client, id));
  });
}
