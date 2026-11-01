import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { todayInReportingZone } from '../../utils/dates.js';
import { AppError, NotFoundError, ValidationError, type ErrorDetail } from '../../utils/errors.js';
import { normaliseMoney, toPaise } from '../../utils/money.js';
import { containsPattern } from '../../utils/sql.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { hashRequest, runIdempotent, type IdempotentResult } from '../idempotency/idempotency.js';
import type { ExpenseInput, ExpenseListQuery, PaymentMode } from './expenses.schemas.js';

interface PersonRef {
  id: string;
  name: string;
}

export interface Expense {
  id: string;
  expenseDate: string;
  supplier: { id: string; name: string; isActive: boolean } | null;
  /** Supplier text as typed before suppliers existed (migrated expenses only); read-only history. */
  legacySupplierName: string | null;
  category: { id: string; name: string; isActive: boolean };
  description: string;
  /** Money: decimal strings, e.g. "1250.00". */
  amount: string;
  amountPaid: string;
  /** Derived: active supplier-payment allocations settling this bill (Stage 3C). */
  allocatedPayments: string;
  /** Derived: amount - amountPaid - allocatedPayments (never stored). */
  outstanding: string;
  paymentMode: PaymentMode | null;
  invoiceReference: string | null;
  status: 'active' | 'voided';
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: PersonRef;
  updatedBy: PersonRef;
  voidedAt: string | null;
  voidedBy: PersonRef | null;
  voidReason: string | null;
  /** Active bill documents attached (Stage 3B). */
  documentCount: number;
}

interface ExpenseRow {
  id: string;
  expense_date: string;
  legacy_supplier_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_active: boolean | null;
  description: string;
  amount: string;
  amount_paid: string;
  allocated: string;
  outstanding: string;
  payment_mode: PaymentMode | null;
  invoice_reference: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
  category_id: string;
  category_name: string;
  category_active: boolean;
  created_by_id: string;
  created_by_name: string;
  updated_by_id: string;
  updated_by_name: string;
  voided_by_id: string | null;
  voided_by_name: string | null;
  document_count: number;
}

/** Active supplier-payment allocations of expense `e` (correlated subquery). */
const ALLOCATED_SQL = `SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) AS allocated
    FROM supplier_payment_allocations a WHERE a.expense_id = e.id AND a.released_at IS NULL`;

const SELECT_EXPENSE = `
  SELECT e.id, e.expense_date, e.legacy_supplier_name, e.description, e.amount, e.amount_paid,
         al.allocated, (e.amount - e.amount_paid - al.allocated)::numeric(14,2) AS outstanding, e.payment_mode, e.invoice_reference, e.version,
         e.created_at, e.updated_at, e.voided_at, e.void_reason,
         c.id AS category_id, c.name AS category_name, c.is_active AS category_active,
         s.id AS supplier_id, s.name AS supplier_name, s.is_active AS supplier_active,
         cu.id AS created_by_id, cu.name AS created_by_name,
         uu.id AS updated_by_id, uu.name AS updated_by_name,
         vu.id AS voided_by_id, vu.name AS voided_by_name,
         (SELECT count(*)::int FROM expense_documents d WHERE d.expense_id = e.id AND d.status = 'active') AS document_count
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    JOIN users cu ON cu.id = e.created_by
    JOIN users uu ON uu.id = e.updated_by
    LEFT JOIN users vu ON vu.id = e.voided_by
    CROSS JOIN LATERAL (${ALLOCATED_SQL}) al`;

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    expenseDate: row.expense_date,
    supplier: row.supplier_id
      ? { id: row.supplier_id, name: row.supplier_name ?? '', isActive: row.supplier_active ?? false }
      : null,
    legacySupplierName: row.legacy_supplier_name,
    category: { id: row.category_id, name: row.category_name, isActive: row.category_active },
    description: row.description,
    amount: row.amount,
    amountPaid: row.amount_paid,
    allocatedPayments: row.allocated,
    outstanding: row.outstanding,
    paymentMode: row.payment_mode,
    invoiceReference: row.invoice_reference,
    status: row.voided_at ? 'voided' : 'active',
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidedBy: row.voided_by_id ? { id: row.voided_by_id, name: row.voided_by_name ?? '' } : null,
    voidReason: row.void_reason,
    documentCount: row.document_count,
  };
}

/** Business fields recorded in the financial audit log (as of the change, incl. supplier/category names). */
function snapshot(row: ExpenseRow): AuditSnapshot {
  return {
    expenseDate: row.expense_date,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    description: row.description,
    amount: row.amount,
    amountPaid: row.amount_paid,
    paymentMode: row.payment_mode,
    invoiceReference: row.invoice_reference,
    status: row.voided_at ? 'voided' : 'active',
    voidReason: row.void_reason,
  };
}

async function selectExpense(client: Queryable, id: string, lock = false): Promise<ExpenseRow> {
  if (lock) await client.query(`SELECT 1 FROM expenses WHERE id = $1 FOR UPDATE`, [id]);
  const result = await client.query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Expense not found');
  return row;
}

/** Cross-field financial rules, checked on every create and update (the DB re-checks them too). */
function validateFinancials(input: ExpenseInput, current?: ExpenseRow): void {
  const issues: ErrorDetail[] = [];
  const amount = toPaise(input.amount);
  const paid = toPaise(input.amountPaid);

  if (amount <= 0n) issues.push({ path: 'amount', message: 'The amount must be greater than zero' });
  if (paid > amount) {
    const reducingBelowPaid = current !== undefined && toPaise(current.amount_paid) === paid && toPaise(current.amount) !== amount;
    issues.push({
      path: reducingBelowPaid ? 'amount' : 'amountPaid',
      message: reducingBelowPaid
        ? `The amount cannot be less than the amount already paid (₹${current.amount_paid}). Correct the amount paid first if it was wrong.`
        : 'The amount paid cannot be more than the total amount',
    });
  }
  if (paid > 0n && input.paymentMode === null) {
    issues.push({ path: 'paymentMode', message: 'Choose how the payment was made' });
  }
  if (input.expenseDate > todayInReportingZone()) {
    issues.push({ path: 'expenseDate', message: 'The expense date cannot be in the future' });
  }
  if (input.expenseDate < '2000-01-01') {
    issues.push({ path: 'expenseDate', message: 'The expense date is too far in the past' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Supplier payments allocated to this bill must stay valid (the database re-checks this too):
 * the supplier cannot change, and amount - amount paid at purchase must still cover the allocations.
 */
function assertAllocationsKept(input: ExpenseInput, current: ExpenseRow): void {
  const allocated = toPaise(current.allocated);
  if (allocated === 0n) return;
  if (input.supplierId !== current.supplier_id) {
    throw new AppError(
      409,
      'EXPENSE_HAS_ALLOCATIONS',
      `Supplier payments (₹${current.allocated}) are allocated to this bill, so its supplier cannot change. Release those allocations first.`,
    );
  }
  if (toPaise(input.amount) - toPaise(input.amountPaid) < allocated) {
    throw new ValidationError([
      {
        path: toPaise(input.amount) !== toPaise(current.amount) ? 'amount' : 'amountPaid',
        message: `Supplier payments of ₹${current.allocated} are allocated to this bill: the amount minus the amount paid at purchase cannot be less than that.`,
      },
    ]);
  }
}

/** New expenses (and category changes) may only use an ACTIVE category. Share-locks it meanwhile. */
async function assertCategoryUsable(client: Queryable, categoryId: string): Promise<void> {
  const result = await client.query<{ is_active: boolean }>(
    `SELECT is_active FROM expense_categories WHERE id = $1 FOR SHARE`,
    [categoryId],
  );
  const row = result.rows[0];
  if (!row || !row.is_active) {
    throw new ValidationError([
      { path: 'categoryId', message: row ? 'This category is archived; choose an active one' : 'Category not found' },
    ]);
  }
}

/** New expenses (and supplier changes) may only use an ACTIVE supplier. Share-locks it meanwhile. */
async function assertSupplierUsable(client: Queryable, supplierId: string): Promise<void> {
  const result = await client.query<{ is_active: boolean }>(`SELECT is_active FROM suppliers WHERE id = $1 FOR SHARE`, [
    supplierId,
  ]);
  const row = result.rows[0];
  if (!row || !row.is_active) {
    throw new ValidationError([
      { path: 'supplierId', message: row ? 'This supplier is archived; choose an active one' : 'Supplier not found' },
    ]);
  }
}

function normalised(input: ExpenseInput): ExpenseInput {
  return { ...input, amount: normaliseMoney(input.amount), amountPaid: normaliseMoney(input.amountPaid) };
}

async function insertExpense(client: Queryable, input: ExpenseInput, actor: Actor): Promise<Expense> {
  await assertCategoryUsable(client, input.categoryId);
  if (input.supplierId) await assertSupplierUsable(client, input.supplierId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO expenses (expense_date, supplier_id, category_id, description, amount, amount_paid,
                           payment_mode, invoice_reference, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9, $9)
     RETURNING id`,
    [
      input.expenseDate,
      input.supplierId,
      input.categoryId,
      input.description,
      input.amount,
      input.amountPaid,
      input.paymentMode,
      input.invoiceReference,
      actor.userId,
    ],
  );
  const row = await selectExpense(client, inserted.rows[0]!.id);
  await recordFinancialAudit(client, {
    entityType: 'expense',
    entityId: row.id,
    action: 'create',
    actorUserId: actor.userId,
    before: null,
    after: snapshot(row),
  });
  return toExpense(row);
}

/**
 * Creates an expense. With an idempotency key, a retried request (same key, same normalised
 * input) returns the originally created expense instead of creating a second one.
 */
export async function createExpense(
  db: Database,
  rawInput: ExpenseInput,
  actor: Actor,
  idempotencyKey: string | null = null,
): Promise<IdempotentResult<{ expense: Expense }>> {
  const input = normalised(rawInput);
  validateFinancials(input);
  if (idempotencyKey === null) {
    const expense = await withSessionTransaction(db, actor.sessionId, (client) => insertExpense(client, input, actor));
    return { status: 201, body: { expense }, replayed: false };
  }
  return runIdempotent(db, actor, 'expense.create', idempotencyKey, hashRequest(input), async (client) => {
    const expense = await insertExpense(client, input, actor);
    return { status: 201, body: { expense }, resourceId: expense.id };
  });
}

/** Locks the row and enforces "exists, expected version, (not) voided". */
async function lockForChange(
  client: Queryable,
  id: string,
  expectedVersion: number,
  mustBeVoided: boolean,
): Promise<ExpenseRow> {
  const current = await selectExpense(client, id, true);
  if (current.version !== expectedVersion) {
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This expense was changed by someone else after you opened it. Reload to see the latest version.',
    );
  }
  const voided = current.voided_at !== null;
  if (voided && !mustBeVoided) {
    throw new AppError(409, 'EXPENSE_VOIDED', 'This expense is voided. Restore it before making changes.');
  }
  if (!voided && mustBeVoided) {
    throw new AppError(409, 'EXPENSE_NOT_VOIDED', 'This expense is not voided.');
  }
  return current;
}

export async function updateExpense(
  db: Database,
  id: string,
  rawInput: ExpenseInput,
  expectedVersion: number,
  actor: Actor,
): Promise<Expense> {
  const input = normalised(rawInput);
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockForChange(client, id, expectedVersion, false);
    validateFinancials(input, current);
    assertAllocationsKept(input, current);
    if (input.categoryId !== current.category_id) await assertCategoryUsable(client, input.categoryId);
    // An archived supplier may stay on an existing expense, but cannot be newly chosen.
    if (input.supplierId && input.supplierId !== current.supplier_id) await assertSupplierUsable(client, input.supplierId);

    const unchanged =
      input.expenseDate === current.expense_date &&
      input.supplierId === current.supplier_id &&
      input.categoryId === current.category_id &&
      input.description === current.description &&
      input.amount === current.amount &&
      input.amountPaid === current.amount_paid &&
      input.paymentMode === current.payment_mode &&
      input.invoiceReference === current.invoice_reference;
    if (unchanged) return toExpense(current);

    await client.query(
      `UPDATE expenses
          SET expense_date = $2, supplier_id = $3, category_id = $4, description = $5,
              amount = $6::numeric, amount_paid = $7::numeric, payment_mode = $8, invoice_reference = $9,
              updated_by = $10, version = version + 1
        WHERE id = $1`,
      [
        id,
        input.expenseDate,
        input.supplierId,
        input.categoryId,
        input.description,
        input.amount,
        input.amountPaid,
        input.paymentMode,
        input.invoiceReference,
        actor.userId,
      ],
    );
    const after = await selectExpense(client, id);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: id,
      action: 'update',
      actorUserId: actor.userId,
      before: snapshot(current),
      after: snapshot(after),
    });
    return toExpense(after);
  });
}

/** Soft void: values are preserved; the row stays visible via filters and detail view. */
export async function voidExpense(db: Database, id: string, reason: string, expectedVersion: number, actor: Actor): Promise<Expense> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockForChange(client, id, expectedVersion, false);
    if (toPaise(current.allocated) > 0n) {
      throw new AppError(
        409,
        'EXPENSE_HAS_ALLOCATIONS',
        `Supplier payments (₹${current.allocated}) are allocated to this bill. Release those allocations on the payment before voiding it.`,
      );
    }
    await client.query(
      `UPDATE expenses
          SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2, version = version + 1
        WHERE id = $1`,
      [id, actor.userId, reason],
    );
    const after = await selectExpense(client, id);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: id,
      action: 'void',
      actorUserId: actor.userId,
      reason,
      before: snapshot(current),
      after: snapshot(after),
    });
    return toExpense(after);
  });
}

/** Explicit recovery of a voided expense, with its own reason; the void stays in the history. */
export async function restoreExpense(db: Database, id: string, reason: string, expectedVersion: number, actor: Actor): Promise<Expense> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockForChange(client, id, expectedVersion, true);
    await client.query(
      `UPDATE expenses
          SET voided_at = NULL, voided_by = NULL, void_reason = NULL, updated_by = $2, version = version + 1
        WHERE id = $1`,
      [id, actor.userId],
    );
    const after = await selectExpense(client, id);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: id,
      action: 'restore',
      actorUserId: actor.userId,
      reason,
      before: snapshot(current),
      after: snapshot(after),
    });
    return toExpense(after);
  });
}

export async function getExpense(db: Queryable, id: string): Promise<Expense> {
  return toExpense(await selectExpense(db, id));
}

export async function getExpenseHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectExpense(db, id); // 404 for unknown ids
  return listAuditHistory(db, 'expense', id);
}

export interface ExpenseListResult {
  items: Expense[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /** Over ALL rows matching the filters, excluding voided expenses. */
  totals: { count: number; amount: string; amountPaid: string; outstanding: string };
}

const SORT_SQL: Record<ExpenseListQuery['sort'], (dir: string) => string> = {
  date: (dir) => `e.expense_date ${dir}, e.created_at ${dir}`,
  amount: (dir) => `e.amount ${dir}, e.expense_date DESC`,
  created: (dir) => `e.created_at ${dir}`,
};

/** Server-side filtering, sorting and pagination. Every value is a bound parameter. */
export async function listExpenses(db: Queryable, query: ExpenseListQuery): Promise<ExpenseListResult> {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];

  if (query.status === 'active') where.push('e.voided_at IS NULL');
  if (query.status === 'voided') where.push('e.voided_at IS NOT NULL');
  if (query.q) {
    const pattern = bind(containsPattern(query.q));
    where.push(
      `(s.name ILIKE ${pattern} ESCAPE '\\' OR e.legacy_supplier_name ILIKE ${pattern} ESCAPE '\\'` +
        ` OR e.description ILIKE ${pattern} ESCAPE '\\' OR e.invoice_reference ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (query.from) where.push(`e.expense_date >= ${bind(query.from)}::date`);
  if (query.to) where.push(`e.expense_date <= ${bind(query.to)}::date`);
  if (query.categoryId) where.push(`e.category_id = ${bind(query.categoryId)}`);
  if (query.supplierId) where.push(`e.supplier_id = ${bind(query.supplierId)}`);
  if (query.paymentMode === 'none') where.push('e.payment_mode IS NULL');
  else if (query.paymentMode) where.push(`e.payment_mode = ${bind(query.paymentMode)}`);
  if (query.recordedBy) where.push(`e.created_by = ${bind(query.recordedBy)}`);
  if (query.minAmount) where.push(`e.amount >= ${bind(query.minAmount)}::numeric`);
  if (query.maxAmount) where.push(`e.amount <= ${bind(query.maxAmount)}::numeric`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filterParams = [...params];

  const summary = await db.query<{ total: number; active_count: number; amount: string; paid: string; outstanding: string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE e.voided_at IS NULL)::int AS active_count,
            COALESCE(sum(e.amount) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS amount,
            COALESCE(sum(e.amount_paid) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS paid,
            COALESCE(sum(e.amount - e.amount_paid - al.allocated) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS outstanding
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id CROSS JOIN LATERAL (${ALLOCATED_SQL}) al ${whereSql}`,
    filterParams,
  );

  const dir = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = bind(query.pageSize);
  const offset = bind((query.page - 1) * query.pageSize);
  const rows = await db.query<ExpenseRow>(
    `${SELECT_EXPENSE} ${whereSql} ORDER BY ${SORT_SQL[query.sort](dir)}, e.id ${dir} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const s = summary.rows[0]!;
  return {
    items: rows.rows.map(toExpense),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: s.total,
      totalPages: Math.max(1, Math.ceil(s.total / query.pageSize)),
    },
    totals: { count: s.active_count, amount: s.amount, amountPaid: s.paid, outstanding: s.outstanding },
  };
}

/** Users who have recorded expenses (for the "recorded by" filter; available to all roles). */
export async function listRecorders(db: Queryable): Promise<PersonRef[]> {
  const result = await db.query<PersonRef>(
    `SELECT DISTINCT u.id, u.name FROM expenses e JOIN users u ON u.id = e.created_by ORDER BY u.name`,
  );
  return result.rows;
}
