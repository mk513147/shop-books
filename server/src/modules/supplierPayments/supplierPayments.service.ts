import type pg from 'pg';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { todayInReportingZone } from '../../utils/dates.js';
import { AppError, NotFoundError, ValidationError, type ErrorDetail } from '../../utils/errors.js';
import { fromPaise, normaliseMoney, rupees, toPaise } from '../../utils/money.js';
import { containsPattern } from '../../utils/sql.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import type { PaymentMode } from '../expenses/expenses.schemas.js';
import { hashRequest, runIdempotent, type IdempotentResult } from '../idempotency/idempotency.js';
import type { PaymentCreateInput, PaymentListQuery, PaymentMetadataInput } from './supplierPayments.schemas.js';

interface PersonRef {
  id: string;
  name: string;
}

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  expense: {
    id: string;
    expenseDate: string;
    description: string;
    invoiceReference: string | null;
    amount: string;
    status: 'active' | 'voided';
  };
  amount: string;
  status: 'active' | 'released';
  createdAt: string;
  createdBy: PersonRef;
  releasedAt: string | null;
  releasedBy: PersonRef | null;
  releaseReason: string | null;
}

export interface SupplierPayment {
  id: string;
  supplier: { id: string; name: string; isActive: boolean };
  paymentDate: string;
  amount: string;
  /** Sum of ACTIVE allocations; derived. */
  allocatedAmount: string;
  /** amount - allocatedAmount (0.00 for reversed payments' original amount is still shown in `amount`). */
  unallocatedAmount: string;
  paymentMode: PaymentMode;
  reference: string | null;
  notes: string | null;
  status: 'active' | 'reversed';
  version: number;
  createdAt: string;
  createdBy: PersonRef;
  updatedAt: string;
  updatedBy: PersonRef;
  reversedAt: string | null;
  reversedBy: PersonRef | null;
  reversalReason: string | null;
}

export interface SupplierPaymentDetail extends SupplierPayment {
  /** Every allocation ever made, including released ones (history). */
  allocations: PaymentAllocation[];
}

interface PaymentRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_active: boolean;
  payment_date: string;
  amount: string;
  allocated: string;
  unallocated: string;
  payment_mode: PaymentMode;
  reference: string | null;
  notes: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  reversed_at: Date | null;
  reversal_reason: string | null;
  created_by_id: string;
  created_by_name: string;
  updated_by_id: string;
  updated_by_name: string;
  reversed_by_id: string | null;
  reversed_by_name: string | null;
}

const SELECT_PAYMENT = `
  SELECT p.id, p.supplier_id, s.name AS supplier_name, s.is_active AS supplier_active, p.payment_date, p.amount,
         al.allocated, (p.amount - al.allocated)::numeric(14,2) AS unallocated,
         p.payment_mode, p.reference, p.notes, p.version, p.created_at, p.updated_at, p.reversed_at, p.reversal_reason,
         cu.id AS created_by_id, cu.name AS created_by_name, uu.id AS updated_by_id, uu.name AS updated_by_name,
         ru.id AS reversed_by_id, ru.name AS reversed_by_name
    FROM supplier_payments p
    JOIN suppliers s ON s.id = p.supplier_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) AS allocated
        FROM supplier_payment_allocations a WHERE a.payment_id = p.id AND a.released_at IS NULL) al
    JOIN users cu ON cu.id = p.created_by
    JOIN users uu ON uu.id = p.updated_by
    LEFT JOIN users ru ON ru.id = p.reversed_by`;

function toPayment(row: PaymentRow): SupplierPayment {
  return {
    id: row.id,
    supplier: { id: row.supplier_id, name: row.supplier_name, isActive: row.supplier_active },
    paymentDate: row.payment_date,
    amount: row.amount,
    allocatedAmount: row.allocated,
    unallocatedAmount: row.reversed_at ? '0.00' : row.unallocated,
    paymentMode: row.payment_mode,
    reference: row.reference,
    notes: row.notes,
    status: row.reversed_at ? 'reversed' : 'active',
    version: row.version,
    createdAt: row.created_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    updatedAt: row.updated_at.toISOString(),
    updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
    reversedAt: row.reversed_at?.toISOString() ?? null,
    reversedBy: row.reversed_by_id ? { id: row.reversed_by_id, name: row.reversed_by_name ?? '' } : null,
    reversalReason: row.reversal_reason,
  };
}

function snapshot(row: PaymentRow): AuditSnapshot {
  return {
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    paymentDate: row.payment_date,
    amount: row.amount,
    paymentMode: row.payment_mode,
    reference: row.reference,
    notes: row.notes,
    allocatedAmount: row.allocated,
    status: row.reversed_at ? 'reversed' : 'active',
    reversalReason: row.reversal_reason,
  };
}

async function selectPayment(client: Queryable, id: string): Promise<PaymentRow> {
  const row = (await client.query<PaymentRow>(`${SELECT_PAYMENT} WHERE p.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError('Payment not found');
  return row;
}

/** Row lock on the payment (taken first in every payment write: payment -> bills -> allocations). */
async function lockPayment(client: Queryable, id: string): Promise<PaymentRow> {
  const locked = await client.query(`SELECT 1 FROM supplier_payments WHERE id = $1 FOR UPDATE`, [id]);
  if (locked.rowCount === 0) throw new NotFoundError('Payment not found');
  return selectPayment(client, id);
}

interface AllocationRow {
  id: string;
  payment_id: string;
  amount: string;
  created_at: Date;
  released_at: Date | null;
  release_reason: string | null;
  expense_id: string;
  expense_date: string;
  description: string;
  invoice_reference: string | null;
  expense_amount: string;
  expense_voided: boolean;
  created_by_id: string;
  created_by_name: string;
  released_by_id: string | null;
  released_by_name: string | null;
}

const SELECT_ALLOCATION = `
  SELECT a.id, a.payment_id, a.amount, a.created_at, a.released_at, a.release_reason,
         e.id AS expense_id, e.expense_date, e.description, e.invoice_reference, e.amount AS expense_amount,
         e.voided_at IS NOT NULL AS expense_voided,
         cu.id AS created_by_id, cu.name AS created_by_name, ru.id AS released_by_id, ru.name AS released_by_name
    FROM supplier_payment_allocations a
    JOIN expenses e ON e.id = a.expense_id
    JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users ru ON ru.id = a.released_by`;

function toAllocation(row: AllocationRow): PaymentAllocation {
  return {
    id: row.id,
    paymentId: row.payment_id,
    expense: {
      id: row.expense_id,
      expenseDate: row.expense_date,
      description: row.description,
      invoiceReference: row.invoice_reference,
      amount: row.expense_amount,
      status: row.expense_voided ? 'voided' : 'active',
    },
    amount: row.amount,
    status: row.released_at ? 'released' : 'active',
    createdAt: row.created_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    releasedAt: row.released_at?.toISOString() ?? null,
    releasedBy: row.released_by_id ? { id: row.released_by_id, name: row.released_by_name ?? '' } : null,
    releaseReason: row.release_reason,
  };
}

async function detail(client: Queryable, id: string): Promise<SupplierPaymentDetail> {
  const payment = toPayment(await selectPayment(client, id));
  const allocations = await client.query<AllocationRow>(`${SELECT_ALLOCATION} WHERE a.payment_id = $1 ORDER BY a.created_at, a.id`, [id]);
  return { ...payment, allocations: allocations.rows.map(toAllocation) };
}

function validateDate(paymentDate: string): void {
  if (paymentDate > todayInReportingZone()) {
    throw new ValidationError([{ path: 'paymentDate', message: 'The payment date cannot be in the future' }]);
  }
  if (paymentDate < '2000-01-01') {
    throw new ValidationError([{ path: 'paymentDate', message: 'The payment date is too far in the past' }]);
  }
}

const versionConflict = () =>
  new AppError(409, 'VERSION_CONFLICT', 'This payment was changed by someone else after you opened it. Reload to see the latest version.');
const reversedError = () => new AppError(409, 'PAYMENT_REVERSED', 'This payment has been reversed and can no longer be changed.');

/** Sum of active allocations per expense (bill). */
async function allocatedByExpense(client: Queryable, expenseIds: string[]): Promise<Map<string, bigint>> {
  const result = await client.query<{ expense_id: string; allocated: string }>(
    `SELECT expense_id, sum(amount)::numeric(14,2) AS allocated
       FROM supplier_payment_allocations WHERE expense_id = ANY($1::uuid[]) AND released_at IS NULL GROUP BY expense_id`,
    [expenseIds],
  );
  return new Map(result.rows.map((r) => [r.expense_id, toPaise(r.allocated)]));
}

/**
 * Allocates part of a (locked) payment to bills of the same supplier. All amounts are checked here,
 * on the server, under locks: payment row (already locked by the caller) then the bills FOR UPDATE
 * in id order. Never trusts client-side remaining amounts.
 */
async function applyAllocations(
  client: pg.PoolClient,
  payment: PaymentRow,
  items: { expenseId: string; amount: string }[],
  actor: Actor,
  /** false while the payment is being created (a new payment starts at version 1). */
  bumpVersion = true,
): Promise<void> {
  if (items.length === 0) return;
  if (payment.reversed_at) throw reversedError();

  const issues: ErrorDetail[] = [];
  items.forEach((item, i) => {
    if (toPaise(item.amount) <= 0n) issues.push({ path: `allocations.${i}.amount`, message: 'Enter an amount greater than zero' });
  });
  if (issues.length) throw new ValidationError(issues);

  const requested = items.reduce((sum, i) => sum + toPaise(i.amount), 0n);
  const available = toPaise(payment.amount) - toPaise(payment.allocated);
  if (requested > available) {
    throw new ValidationError([
      {
        path: 'allocations',
        message: `The allocations total ${rupees(requested)} but only ${rupees(available)} of this payment is unallocated.`,
      },
    ]);
  }

  const ids = items.map((i) => i.expenseId);
  const bills = await client.query<{
    id: string;
    supplier_id: string | null;
    voided: boolean;
    payable_before_allocations: string;
    description: string;
  }>(
    `SELECT id, supplier_id, voided_at IS NOT NULL AS voided, (amount - amount_paid)::numeric(14,2) AS payable_before_allocations, description
       FROM expenses WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
  const byId = new Map(bills.rows.map((b) => [b.id, b]));
  const allocated = await allocatedByExpense(client, ids);

  items.forEach((item, i) => {
    const bill = byId.get(item.expenseId);
    const path = `allocations.${i}.expenseId`;
    if (!bill) issues.push({ path, message: 'Bill not found' });
    else if (bill.supplier_id !== payment.supplier_id) issues.push({ path, message: 'This bill belongs to a different supplier' });
    else if (bill.voided) issues.push({ path, message: 'This bill is voided and cannot receive payments' });
    else {
      const remaining = toPaise(bill.payable_before_allocations) - (allocated.get(bill.id) ?? 0n);
      if (toPaise(item.amount) > remaining) {
        issues.push({
          path: `allocations.${i}.amount`,
          message: remaining > 0n ? `Only ${rupees(remaining)} is still payable on this bill` : 'This bill is already fully paid',
        });
      }
    }
  });
  if (issues.length) throw new ValidationError(issues);

  let paymentAllocated = toPaise(payment.allocated);
  for (const item of items) {
    const amount = normaliseMoney(item.amount);
    const bill = byId.get(item.expenseId)!;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO supplier_payment_allocations (payment_id, expense_id, amount, created_by)
       VALUES ($1, $2, $3::numeric, $4) RETURNING id`,
      [payment.id, item.expenseId, amount, actor.userId],
    );
    const allocationId = inserted.rows[0]!.id;
    const billBefore = allocated.get(item.expenseId) ?? 0n;
    const paymentBefore = paymentAllocated;
    paymentAllocated += toPaise(amount);
    allocated.set(item.expenseId, billBefore + toPaise(amount));
    const base = { allocationId, paymentId: payment.id, expenseId: item.expenseId, expenseDescription: bill.description, amount };
    await recordFinancialAudit(client, {
      entityType: 'supplier_payment',
      entityId: payment.id,
      action: 'allocate',
      actorUserId: actor.userId,
      before: { ...base, active: false, paymentAllocated: fromPaise(paymentBefore) },
      after: { ...base, active: true, paymentAllocated: fromPaise(paymentAllocated) },
    });
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: item.expenseId,
      action: 'allocate',
      actorUserId: actor.userId,
      before: { ...base, active: false, billAllocated: fromPaise(billBefore) },
      after: { ...base, active: true, billAllocated: fromPaise(billBefore + toPaise(amount)) },
    });
  }
  if (bumpVersion) {
    await client.query(`UPDATE supplier_payments SET version = version + 1, updated_by = $2 WHERE id = $1`, [payment.id, actor.userId]);
  }
}

function normalisedCreate(input: PaymentCreateInput): PaymentCreateInput {
  return {
    ...input,
    amount: normaliseMoney(input.amount),
    allocations: input.allocations.map((a) => ({ expenseId: a.expenseId, amount: normaliseMoney(a.amount) })),
  };
}

/**
 * Records a supplier payment (NOT an expense), optionally allocating it to bills in the same
 * transaction. With an idempotency key, a retried submit returns the original payment.
 */
export async function createPayment(
  db: Database,
  rawInput: PaymentCreateInput,
  actor: Actor,
  idempotencyKey: string | null,
): Promise<IdempotentResult<{ payment: SupplierPaymentDetail }>> {
  const input = normalisedCreate(rawInput);
  if (toPaise(input.amount) <= 0n) throw new ValidationError([{ path: 'amount', message: 'The amount must be greater than zero' }]);
  validateDate(input.paymentDate);

  const work = async (client: pg.PoolClient) => {
    const supplier = await client.query(`SELECT 1 FROM suppliers WHERE id = $1 FOR SHARE`, [input.supplierId]);
    if (supplier.rowCount === 0) throw new ValidationError([{ path: 'supplierId', message: 'Supplier not found' }]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO supplier_payments (supplier_id, payment_date, amount, payment_mode, reference, notes, created_by, updated_by)
       VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $7) RETURNING id`,
      [input.supplierId, input.paymentDate, input.amount, input.paymentMode, input.reference, input.notes, actor.userId],
    );
    const id = inserted.rows[0]!.id;
    const row = await lockPayment(client, id);
    await recordFinancialAudit(client, {
      entityType: 'supplier_payment',
      entityId: id,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: snapshot(row),
    });
    await applyAllocations(client, row, input.allocations, actor, false);
    return detail(client, id);
  };

  if (idempotencyKey === null) {
    const payment = await withSessionTransaction(db, actor.sessionId, work);
    return { status: 201, body: { payment }, replayed: false };
  }
  return runIdempotent(db, actor, 'supplier_payment.create', idempotencyKey, hashRequest(input), async (client) => {
    const payment = await work(client);
    return { status: 201, body: { payment }, resourceId: payment.id };
  });
}

/** Allocates (more of) an existing payment. Optional idempotency key guards double submits. */
export async function allocatePayment(
  db: Database,
  id: string,
  rawItems: { expenseId: string; amount: string }[],
  actor: Actor,
  idempotencyKey: string | null,
): Promise<IdempotentResult<{ payment: SupplierPaymentDetail }>> {
  const items = rawItems.map((a) => ({ expenseId: a.expenseId, amount: normaliseMoney(a.amount) }));
  const work = async (client: pg.PoolClient) => {
    const payment = await lockPayment(client, id);
    await applyAllocations(client, payment, items, actor);
    return detail(client, id);
  };
  if (idempotencyKey === null) {
    return { status: 200, body: { payment: await withSessionTransaction(db, actor.sessionId, work) }, replayed: false };
  }
  return runIdempotent(db, actor, 'supplier_payment.allocate', idempotencyKey, hashRequest({ id, items }), async (client) => {
    const payment = await work(client);
    return { status: 200, body: { payment }, resourceId: id };
  });
}

async function releaseOne(
  client: pg.PoolClient,
  allocation: AllocationRow,
  reason: string,
  actor: Actor,
  recordOnPayment: boolean,
): Promise<void> {
  await client.query(
    `UPDATE supplier_payment_allocations SET released_at = now(), released_by = $2, release_reason = $3 WHERE id = $1`,
    [allocation.id, actor.userId, reason],
  );
  const base = {
    allocationId: allocation.id,
    paymentId: allocation.payment_id,
    expenseId: allocation.expense_id,
    expenseDescription: allocation.description,
    amount: allocation.amount,
  };
  const targets: ['expense' | 'supplier_payment', string][] = [['expense', allocation.expense_id]];
  if (recordOnPayment) targets.push(['supplier_payment', allocation.payment_id]);
  for (const [entityType, entityId] of targets) {
    await recordFinancialAudit(client, {
      entityType,
      entityId,
      action: 'release_allocation',
      actorUserId: actor.userId,
      reason,
      before: { ...base, active: true },
      after: { ...base, active: false },
    });
  }
}

/** Releases one allocation (wrong bill/amount): the bill becomes payable again, the payment unallocated. */
export async function releaseAllocation(
  db: Database,
  paymentId: string,
  allocationId: string,
  reason: string,
  actor: Actor,
): Promise<SupplierPaymentDetail> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const payment = await lockPayment(client, paymentId);
    if (payment.reversed_at) throw reversedError();
    const row = (
      await client.query<AllocationRow>(`${SELECT_ALLOCATION} WHERE a.id = $1 AND a.payment_id = $2 FOR UPDATE OF a`, [
        allocationId,
        paymentId,
      ])
    ).rows[0];
    if (!row) throw new NotFoundError('Allocation not found');
    if (row.released_at) throw new AppError(409, 'ALLOCATION_RELEASED', 'This allocation was already released.');
    await releaseOne(client, row, reason, actor, true);
    await client.query(`UPDATE supplier_payments SET version = version + 1, updated_by = $2 WHERE id = $1`, [paymentId, actor.userId]);
    return detail(client, paymentId);
  });
}

/**
 * Reverses a payment: it stops counting, every active allocation is released (bills become payable
 * again), and the original values stay visible. Exactly once (409 on a second attempt).
 */
export async function reversePayment(
  db: Database,
  id: string,
  reason: string,
  expectedVersion: number,
  actor: Actor,
): Promise<SupplierPaymentDetail> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const before = await lockPayment(client, id);
    if (before.reversed_at) throw new AppError(409, 'PAYMENT_ALREADY_REVERSED', 'This payment has already been reversed.');
    if (before.version !== expectedVersion) throw versionConflict();

    const active = await client.query<AllocationRow>(
      `${SELECT_ALLOCATION} WHERE a.payment_id = $1 AND a.released_at IS NULL ORDER BY a.id FOR UPDATE OF a`,
      [id],
    );
    const releaseReason = `Payment reversed: ${reason}`.slice(0, 500).trim();
    for (const allocation of active.rows) await releaseOne(client, allocation, releaseReason, actor, false);

    await client.query(
      `UPDATE supplier_payments SET reversed_at = now(), reversed_by = $2, reversal_reason = $3, updated_by = $2, version = version + 1
        WHERE id = $1`,
      [id, actor.userId, reason],
    );
    const after = await selectPayment(client, id);
    await recordFinancialAudit(client, {
      entityType: 'supplier_payment',
      entityId: id,
      action: 'reverse',
      actorUserId: actor.userId,
      reason,
      before: snapshot(before),
      after: snapshot(after),
    });
    return detail(client, id);
  });
}

/** Corrects date, mode, reference or notes. Amount and supplier are fixed (reverse + re-record instead). */
export async function updatePayment(
  db: Database,
  id: string,
  input: PaymentMetadataInput,
  expectedVersion: number,
  actor: Actor,
): Promise<SupplierPaymentDetail> {
  validateDate(input.paymentDate);
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const before = await lockPayment(client, id);
    if (before.reversed_at) throw reversedError();
    if (before.version !== expectedVersion) throw versionConflict();
    const unchanged =
      before.payment_date === input.paymentDate &&
      before.payment_mode === input.paymentMode &&
      before.reference === input.reference &&
      before.notes === input.notes;
    if (unchanged) return detail(client, id);
    await client.query(
      `UPDATE supplier_payments SET payment_date = $2, payment_mode = $3, reference = $4, notes = $5, updated_by = $6, version = version + 1
        WHERE id = $1`,
      [id, input.paymentDate, input.paymentMode, input.reference, input.notes, actor.userId],
    );
    const after = await selectPayment(client, id);
    await recordFinancialAudit(client, {
      entityType: 'supplier_payment',
      entityId: id,
      action: 'update',
      actorUserId: actor.userId,
      before: snapshot(before),
      after: snapshot(after),
    });
    return detail(client, id);
  });
}

export async function getPayment(db: Queryable, id: string): Promise<SupplierPaymentDetail> {
  return detail(db, id);
}

export async function getPaymentHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectPayment(db, id);
  return listAuditHistory(db, 'supplier_payment', id);
}

export interface PaymentListResult {
  items: SupplierPayment[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /** Over all matching ACTIVE (not reversed) payments. */
  totals: { count: number; amount: string; allocated: string; unallocated: string };
}

export async function listPayments(db: Queryable, query: PaymentListQuery): Promise<PaymentListResult> {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.status === 'active') where.push('p.reversed_at IS NULL');
  if (query.status === 'reversed') where.push('p.reversed_at IS NOT NULL');
  if (query.supplierId) where.push(`p.supplier_id = ${bind(query.supplierId)}`);
  if (query.from) where.push(`p.payment_date >= ${bind(query.from)}::date`);
  if (query.to) where.push(`p.payment_date <= ${bind(query.to)}::date`);
  if (query.q) {
    const pattern = bind(containsPattern(query.q));
    where.push(`(p.reference ILIKE ${pattern} ESCAPE '\\' OR p.notes ILIKE ${pattern} ESCAPE '\\' OR s.name ILIKE ${pattern} ESCAPE '\\')`);
  }
  if (query.allocation === 'unallocated') where.push('al.allocated = 0');
  if (query.allocation === 'partial') where.push('al.allocated > 0 AND al.allocated < p.amount');
  if (query.allocation === 'full') where.push('al.allocated = p.amount');
  if (query.allocation === 'open') where.push('al.allocated < p.amount AND p.reversed_at IS NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filterParams = [...params];

  const summary = (
    await db.query<{ total: number; active_count: number; amount: string; allocated: string; unallocated: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE p.reversed_at IS NULL)::int AS active_count,
              COALESCE(sum(p.amount) FILTER (WHERE p.reversed_at IS NULL), 0)::numeric(20,2) AS amount,
              COALESCE(sum(al.allocated) FILTER (WHERE p.reversed_at IS NULL), 0)::numeric(20,2) AS allocated,
              COALESCE(sum(p.amount - al.allocated) FILTER (WHERE p.reversed_at IS NULL), 0)::numeric(20,2) AS unallocated
         FROM supplier_payments p
         JOIN suppliers s ON s.id = p.supplier_id
         CROSS JOIN LATERAL (
           SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) AS allocated
             FROM supplier_payment_allocations a WHERE a.payment_id = p.id AND a.released_at IS NULL) al
         ${whereSql}`,
      filterParams,
    )
  ).rows[0]!;

  const limit = bind(query.pageSize);
  const offset = bind((query.page - 1) * query.pageSize);
  const rows = await db.query<PaymentRow>(
    `${SELECT_PAYMENT} ${whereSql} ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.rows.map(toPayment),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: summary.total,
      totalPages: Math.max(1, Math.ceil(summary.total / query.pageSize)),
    },
    totals: { count: summary.active_count, amount: summary.amount, allocated: summary.allocated, unallocated: summary.unallocated },
  };
}
