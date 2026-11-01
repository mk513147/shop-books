import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { containsPattern } from '../../utils/sql.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import type { CustomerCreateInput, CustomerListQuery, CustomerUpdateInput } from './customers.schemas.js';

/**
 * Customer profiles. Balances are derived from the ledger (view `customer_balances`) and are two
 * INDEPENDENT numbers: what the customer owes (due) and what the shop holds for them (advance).
 * They are never netted.
 */
export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  dueBalance: string;
  advanceBalance: string;
  transactionCount: number;
  createdAt: string;
  updatedAt: string;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  version: number;
  due_balance: string;
  advance_balance: string;
  transaction_count: number;
  created_at: Date;
  updated_at: Date;
}

const SELECT_CUSTOMER = `
  SELECT c.id, c.name, c.phone, c.address, c.notes, c.is_active, c.version, c.created_at, c.updated_at,
         b.due_balance, b.advance_balance, b.transaction_count
    FROM customers c JOIN customer_balances b ON b.customer_id = c.id`;

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    isActive: row.is_active,
    version: row.version,
    dueBalance: row.due_balance,
    advanceBalance: row.advance_balance,
    transactionCount: row.transaction_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type Details = Pick<CustomerRow, 'name' | 'phone' | 'address' | 'notes' | 'is_active'>;

function snapshot(row: Details): AuditSnapshot {
  return { name: row.name, phone: row.phone, address: row.address, notes: row.notes, isActive: row.is_active };
}

export async function selectCustomer(client: Queryable, id: string): Promise<CustomerRow> {
  const row = (await client.query<CustomerRow>(`${SELECT_CUSTOMER} WHERE c.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError('Customer not found');
  return row;
}

/** Locks the customer row: every write to a customer's profile OR ledger takes this lock first. */
export async function lockCustomer(client: Queryable, id: string): Promise<CustomerRow> {
  const locked = await client.query(`SELECT 1 FROM customers WHERE id = $1 FOR UPDATE`, [id]);
  if (locked.rowCount === 0) throw new NotFoundError('Customer not found');
  return selectCustomer(client, id);
}

async function phoneOwner(client: Queryable, phone: string | null, exceptId: string | null): Promise<string | null> {
  if (!phone) return null;
  const row = (
    await client.query<{ name: string }>(
      `SELECT name FROM customers
        WHERE is_active AND phone IS NOT NULL AND phone_key = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
          AND ($2::uuid IS NULL OR id <> $2)`,
      [phone, exceptId],
    )
  ).rows[0];
  return row?.name ?? null;
}

const phoneTaken = (name: string) =>
  new AppError(409, 'CUSTOMER_PHONE_TAKEN', `This phone number already belongs to the active customer “${name}”.`);

async function withPhoneCheck<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'customers_active_phone_unique') {
      throw new AppError(409, 'CUSTOMER_PHONE_TAKEN', 'This phone number already belongs to another active customer.');
    }
    throw err;
  }
}

export async function createCustomer(db: Database, input: CustomerCreateInput, actor: Actor): Promise<Customer> {
  return withPhoneCheck(() =>
    withSessionTransaction(db, actor.sessionId, async (client) => {
      const owner = await phoneOwner(client, input.phone, null);
      if (owner) throw phoneTaken(owner);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO customers (name, phone, address, notes, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [input.name, input.phone, input.address, input.notes, actor.userId],
      );
      const id = inserted.rows[0]!.id;
      await recordFinancialAudit(client, {
        entityType: 'customer',
        entityId: id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: snapshot({ ...input, is_active: true }),
      });
      return toCustomer(await selectCustomer(client, id));
    }),
  );
}

/** Profile edits and archive/reactivate. Archived customers keep their full ledger. */
export async function updateCustomer(
  db: Database,
  id: string,
  changes: CustomerUpdateInput,
  expectedVersion: number,
  actor: Actor,
): Promise<Customer> {
  return withPhoneCheck(() =>
    withSessionTransaction(db, actor.sessionId, async (client) => {
      const before = await lockCustomer(client, id);
      if (before.version !== expectedVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'This customer was changed by someone else after you opened it. Reload to see the latest version.');
      }
      const next: Details = {
        name: changes.name ?? before.name,
        phone: changes.phone === undefined ? before.phone : changes.phone,
        address: changes.address === undefined ? before.address : changes.address,
        notes: changes.notes === undefined ? before.notes : changes.notes,
        is_active: changes.isActive ?? before.is_active,
      };
      const beforeSnap = snapshot(before);
      const afterSnap = snapshot(next);
      if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return toCustomer(before);
      if (next.is_active && next.phone) {
        const owner = await phoneOwner(client, next.phone, id);
        if (owner) throw phoneTaken(owner);
      }
      await client.query(
        `UPDATE customers SET name = $2, phone = $3, address = $4, notes = $5, is_active = $6, updated_by = $7, version = version + 1
          WHERE id = $1`,
        [id, next.name, next.phone, next.address, next.notes, next.is_active, actor.userId],
      );
      await recordFinancialAudit(client, {
        entityType: 'customer',
        entityId: id,
        action: before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive',
        actorUserId: actor.userId,
        before: beforeSnap,
        after: afterSnap,
      });
      return toCustomer(await selectCustomer(client, id));
    }),
  );
}

export async function getCustomer(db: Queryable, id: string): Promise<Customer> {
  return toCustomer(await selectCustomer(db, id));
}

export async function getCustomerHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectCustomer(db, id);
  return listAuditHistory(db, 'customer', id);
}

export interface CustomerListResult {
  items: Customer[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export async function listCustomers(db: Queryable, query: CustomerListQuery): Promise<CustomerListResult> {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.status === 'active') where.push('c.is_active');
  if (query.status === 'archived') where.push('NOT c.is_active');
  if (query.balance === 'due') where.push('b.due_balance > 0');
  if (query.balance === 'advance') where.push('b.advance_balance > 0');
  if (query.balance === 'any') where.push('(b.due_balance > 0 OR b.advance_balance > 0)');
  if (query.q) {
    const pattern = bind(containsPattern(query.q));
    const digits = query.q.replace(/\D/g, '');
    const phoneMatch = digits.length >= 3 ? ` OR regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE ${bind(`%${digits}%`)}` : '';
    where.push(`(c.name ILIKE ${pattern} ESCAPE '\\' OR c.phone ILIKE ${pattern} ESCAPE '\\'${phoneMatch})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM customers c JOIN customer_balances b ON b.customer_id = c.id ${whereSql}`,
      [...params],
    )
  ).rows[0]!.n;
  const limit = bind(query.pageSize);
  const offset = bind((query.page - 1) * query.pageSize);
  const rows = await db.query<CustomerRow>(
    `${SELECT_CUSTOMER} ${whereSql} ORDER BY c.is_active DESC, lower(c.name), c.id LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.rows.map(toCustomer),
    pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
  };
}

export interface CustomersSummary {
  /** Owed BY customers, across all customers (archived included). */
  totalDue: string;
  /** Held FOR customers as advances. Never netted with totalDue. */
  totalAdvance: string;
  customersWithDue: number;
  customersWithAdvance: number;
}

export async function getCustomersSummary(db: Queryable): Promise<CustomersSummary> {
  const row = (
    await db.query<{ due: string; advance: string; with_due: number; with_advance: number }>(
      `SELECT COALESCE(sum(due_balance), 0)::numeric(20,2) AS due,
              COALESCE(sum(advance_balance), 0)::numeric(20,2) AS advance,
              count(*) FILTER (WHERE due_balance > 0)::int AS with_due,
              count(*) FILTER (WHERE advance_balance > 0)::int AS with_advance
         FROM customer_balances`,
    )
  ).rows[0]!;
  return { totalDue: row.due, totalAdvance: row.advance, customersWithDue: row.with_due, customersWithAdvance: row.with_advance };
}
