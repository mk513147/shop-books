import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { todayInReportingZone } from '../../utils/dates.js';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { normaliseMoney, rupees, toPaise } from '../../utils/money.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import type { PaymentMode } from '../expenses/expenses.schemas.js';
import { hashRequest, runIdempotent, type IdempotentResult } from '../idempotency/idempotency.js';
import type { CustomerLedgerQuery, CustomerTxnInput, CustomerTxnType, SettleAllInput } from './customers.schemas.js';
import { lockCustomer, selectCustomer } from './customers.service.js';

interface PersonRef {
  id: string;
  name: string;
}

/**
 * One customer ledger entry. Effects on the two INDEPENDENT balances:
 *   due            due +amount
 *   due_payment    due −amount       (settles one due)
 *   advance        advance +amount
 *   advance_refund advance −amount   (never more than the advance balance)
 */
export interface CustomerTransaction {
  id: string;
  customerId: string;
  type: CustomerTxnType;
  txnDate: string;
  amount: string;
  paymentMode: PaymentMode | null;
  /** due_payment: the due it settles (`categoryName`: that due's category, if it has one). */
  due: { id: string; txnDate: string; description: string | null; categoryName: string | null; amount: string } | null;
  /** due only: what it is for (expense category). Null for dues recorded before migration 0014. */
  category: { id: string; name: string; isActive: boolean } | null;
  /** due_payment only: set on the payments created together by one "Pay full outstanding". */
  settlementId: string | null;
  description: string | null;
  reference: string | null;
  notes: string | null;
  /** due only: active payments against it, and what is still owed on it. */
  paidAmount: string | null;
  remainingAmount: string | null;
  status: 'active' | 'reversed';
  version: number;
  createdAt: string;
  createdBy: PersonRef;
  reversedAt: string | null;
  reversedBy: PersonRef | null;
  reversalReason: string | null;
}

interface TxnRow {
  id: string;
  customer_id: string;
  txn_type: CustomerTxnType;
  txn_date: string;
  amount: string;
  payment_mode: PaymentMode | null;
  due_id: string | null;
  due_date: string | null;
  due_description: string | null;
  due_amount: string | null;
  due_category_id: string | null;
  due_category_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_active: boolean | null;
  settlement_id: string | null;
  description: string | null;
  reference: string | null;
  notes: string | null;
  paid: string | null;
  version: number;
  created_at: Date;
  reversed_at: Date | null;
  reversal_reason: string | null;
  created_by_id: string;
  created_by_name: string;
  reversed_by_id: string | null;
  reversed_by_name: string | null;
}

const SELECT_TXN = `
  SELECT t.id, t.customer_id, t.txn_type, t.txn_date, t.amount, t.payment_mode, t.due_id,
         d.txn_date AS due_date, d.description AS due_description, d.amount AS due_amount,
         d.category_id AS due_category_id, dc.name AS due_category_name,
         t.category_id, tc.name AS category_name, tc.is_active AS category_active, t.settlement_id,
         t.description, t.reference, t.notes, t.version, t.created_at, t.reversed_at, t.reversal_reason,
         CASE WHEN t.txn_type = 'due' THEN
           (SELECT COALESCE(sum(p.amount), 0)::numeric(14,2) FROM customer_transactions p
             WHERE p.due_id = t.id AND p.reversed_at IS NULL) END AS paid,
         cu.id AS created_by_id, cu.name AS created_by_name, ru.id AS reversed_by_id, ru.name AS reversed_by_name
    FROM customer_transactions t
    LEFT JOIN customer_transactions d ON d.id = t.due_id
    LEFT JOIN expense_categories tc ON tc.id = t.category_id
    LEFT JOIN expense_categories dc ON dc.id = d.category_id
    JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users ru ON ru.id = t.reversed_by`;

function toTxn(row: TxnRow): CustomerTransaction {
  const remaining = row.paid !== null ? fromDb(toPaise(row.amount) - toPaise(row.paid)) : null;
  return {
    id: row.id,
    customerId: row.customer_id,
    type: row.txn_type,
    txnDate: row.txn_date,
    amount: row.amount,
    paymentMode: row.payment_mode,
    due: row.due_id
      ? { id: row.due_id, txnDate: row.due_date!, description: row.due_description, categoryName: row.due_category_name, amount: row.due_amount! }
      : null,
    category: row.category_id ? { id: row.category_id, name: row.category_name ?? '', isActive: row.category_active ?? false } : null,
    settlementId: row.settlement_id,
    description: row.description,
    reference: row.reference,
    notes: row.notes,
    paidAmount: row.paid,
    remainingAmount: row.reversed_at ? (row.paid !== null ? '0.00' : null) : remaining,
    status: row.reversed_at ? 'reversed' : 'active',
    version: row.version,
    createdAt: row.created_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    reversedAt: row.reversed_at?.toISOString() ?? null,
    reversedBy: row.reversed_by_id ? { id: row.reversed_by_id, name: row.reversed_by_name ?? '' } : null,
    reversalReason: row.reversal_reason,
  };
}

function fromDb(paise: bigint): string {
  return `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;
}

function snapshot(row: TxnRow): AuditSnapshot {
  return {
    customerId: row.customer_id,
    type: row.txn_type,
    txnDate: row.txn_date,
    amount: row.amount,
    paymentMode: row.payment_mode,
    dueId: row.due_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    settlementId: row.settlement_id,
    description: row.description,
    reference: row.reference,
    notes: row.notes,
    status: row.reversed_at ? 'reversed' : 'active',
    reversalReason: row.reversal_reason,
  };
}

/** Always scoped by customer: an entry id of another customer is "not found" (no IDOR). */
async function selectTxn(client: Queryable, customerId: string, id: string): Promise<TxnRow> {
  const row = (await client.query<TxnRow>(`${SELECT_TXN} WHERE t.id = $1 AND t.customer_id = $2`, [id, customerId])).rows[0];
  if (!row) throw new NotFoundError('Entry not found');
  return row;
}

async function advanceBalance(client: Queryable, customerId: string): Promise<bigint> {
  const row = (
    await client.query<{ balance: string }>(
      `SELECT COALESCE(sum(CASE txn_type WHEN 'advance' THEN amount ELSE -amount END), 0)::numeric(20,2) AS balance
         FROM customer_transactions
        WHERE customer_id = $1 AND reversed_at IS NULL AND txn_type IN ('advance', 'advance_refund')`,
      [customerId],
    )
  ).rows[0]!;
  return toPaise(row.balance);
}

async function duePaid(client: Queryable, dueId: string): Promise<bigint> {
  const row = (
    await client.query<{ paid: string }>(
      `SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS paid FROM customer_transactions WHERE due_id = $1 AND reversed_at IS NULL`,
      [dueId],
    )
  ).rows[0]!;
  return toPaise(row.paid);
}

function validateDate(txnDate: string): void {
  if (txnDate > todayInReportingZone()) throw new ValidationError([{ path: 'txnDate', message: 'The date cannot be in the future' }]);
  if (txnDate < '2000-01-01') throw new ValidationError([{ path: 'txnDate', message: 'The date is too far in the past' }]);
}

/**
 * A new due must name an ACTIVE expense category (the same master list as expenses; there is no
 * separate customer category list). Share-locked so it cannot be archived mid-transaction.
 */
async function assertDueCategoryUsable(client: Queryable, categoryId: string | null): Promise<void> {
  if (!categoryId) throw new ValidationError([{ path: 'categoryId', message: 'Choose a category' }]);
  const row = (
    await client.query<{ is_active: boolean }>(`SELECT is_active FROM expense_categories WHERE id = $1 FOR SHARE`, [categoryId])
  ).rows[0];
  if (!row) throw new ValidationError([{ path: 'categoryId', message: 'Category not found' }]);
  if (!row.is_active) throw new ValidationError([{ path: 'categoryId', message: 'This category is archived; choose an active one' }]);
}

const ARCHIVED = () =>
  new AppError(409, 'CUSTOMER_ARCHIVED', 'This customer is archived. Reactivate them to record new dues or advances.');

/**
 * Records one ledger entry. Every write locks the customer row FIRST, so concurrent payments,
 * refunds and reversals for a customer are serialised and always see the latest balances.
 * Amount limits are computed here, on the server.
 */
async function insertTxn(client: pg.PoolClient, customerId: string, input: CustomerTxnInput, actor: Actor): Promise<CustomerTransaction> {
  const customer = await lockCustomer(client, customerId);
  // Settling old dues and refunding advances stays possible for archived customers.
  if (!customer.is_active && (input.type === 'due' || input.type === 'advance')) throw ARCHIVED();

  if (input.type === 'due') await assertDueCategoryUsable(client, input.categoryId);

  if (input.type === 'due_payment') {
    const due = (
      await client.query<{ customer_id: string; txn_type: string; amount: string; reversed: boolean }>(
        `SELECT customer_id, txn_type, amount, reversed_at IS NOT NULL AS reversed FROM customer_transactions WHERE id = $1 FOR UPDATE`,
        [input.dueId],
      )
    ).rows[0];
    if (!due || due.customer_id !== customerId || due.txn_type !== 'due') {
      throw new ValidationError([{ path: 'dueId', message: 'Choose a due of this customer' }]);
    }
    if (due.reversed) throw new ValidationError([{ path: 'dueId', message: 'This due was reversed and cannot be paid' }]);
    const remaining = toPaise(due.amount) - (await duePaid(client, input.dueId!));
    if (toPaise(input.amount) > remaining) {
      throw new ValidationError([
        {
          path: 'amount',
          message: remaining > 0n ? `Only ${rupees(remaining)} is still due on this entry` : 'This due is already fully paid',
        },
      ]);
    }
  }

  if (input.type === 'advance_refund') {
    const available = await advanceBalance(client, customerId);
    if (toPaise(input.amount) > available) {
      throw new ValidationError([
        {
          path: 'amount',
          message:
            available > 0n
              ? `A refund cannot exceed the available advance of ${rupees(available)}`
              : 'This customer has no advance to refund',
        },
      ]);
    }
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO customer_transactions
       (customer_id, txn_type, txn_date, amount, payment_mode, due_id, description, reference, notes, created_by, updated_by, category_id)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $10, $11) RETURNING id`,
    [
      customerId,
      input.type,
      input.txnDate,
      input.amount,
      input.paymentMode,
      input.dueId,
      input.description,
      input.reference,
      input.notes,
      actor.userId,
      input.type === 'due' ? input.categoryId : null,
    ],
  );
  const row = await selectTxn(client, customerId, inserted.rows[0]!.id);
  await recordFinancialAudit(client, {
    entityType: 'customer_transaction',
    entityId: row.id,
    action: 'create',
    actorUserId: actor.userId,
    before: null,
    after: snapshot(row),
  });
  return toTxn(row);
}

export async function recordCustomerTransaction(
  db: Database,
  customerId: string,
  rawInput: CustomerTxnInput,
  actor: Actor,
  idempotencyKey: string | null,
): Promise<IdempotentResult<{ transaction: CustomerTransaction }>> {
  const input = { ...rawInput, amount: normaliseMoney(rawInput.amount) };
  if (toPaise(input.amount) <= 0n) throw new ValidationError([{ path: 'amount', message: 'The amount must be greater than zero' }]);
  validateDate(input.txnDate);
  if (idempotencyKey === null) {
    const transaction = await withSessionTransaction(db, actor.sessionId, (client) => insertTxn(client, customerId, input, actor));
    return { status: 201, body: { transaction }, replayed: false };
  }
  return runIdempotent(
    db,
    actor,
    'customer_transaction.create',
    idempotencyKey,
    hashRequest({ customerId, ...input }),
    async (client) => {
      const transaction = await insertTxn(client, customerId, input, actor);
      return { status: 201, body: { transaction }, resourceId: transaction.id };
    },
  );
}

/**
 * Reverses an entry (with a reason): it stays visible but no longer counts. Refused when that would
 * leave the ledger inconsistent: a due that still has active payments, or an advance whose money
 * has already been refunded (reverse those first). Exactly once.
 */
export async function reverseCustomerTransaction(
  db: Database,
  customerId: string,
  id: string,
  reason: string,
  expectedVersion: number,
  actor: Actor,
): Promise<CustomerTransaction> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    await lockCustomer(client, customerId);
    const before = await selectTxn(client, customerId, id);
    if (before.reversed_at) throw new AppError(409, 'ALREADY_REVERSED', 'This entry has already been reversed.');
    if (before.version !== expectedVersion) {
      throw new AppError(409, 'VERSION_CONFLICT', 'This entry was changed by someone else. Reload to see the latest version.');
    }
    if (before.txn_type === 'due' && toPaise(before.paid ?? '0') > 0n) {
      throw new AppError(
        409,
        'DUE_HAS_PAYMENTS',
        `Payments of ${rupees(before.paid!)} were received against this due. Reverse those payments first.`,
      );
    }
    if (before.txn_type === 'advance') {
      const available = await advanceBalance(client, customerId);
      if (available < toPaise(before.amount)) {
        throw new AppError(
          409,
          'ADVANCE_ALREADY_REFUNDED',
          `Only ${rupees(available)} of advance is left, so this ${rupees(before.amount)} advance cannot be reversed. Reverse the refund(s) first.`,
        );
      }
    }
    await client.query(
      `UPDATE customer_transactions SET reversed_at = now(), reversed_by = $2, reversal_reason = $3, updated_by = $2, version = version + 1
        WHERE id = $1`,
      [id, actor.userId, reason],
    );
    const after = await selectTxn(client, customerId, id);
    await recordFinancialAudit(client, {
      entityType: 'customer_transaction',
      entityId: id,
      action: 'reverse',
      actorUserId: actor.userId,
      reason,
      before: snapshot(before),
      after: snapshot(after),
    });
    return toTxn(after);
  });
}

export async function getCustomerTransaction(db: Queryable, customerId: string, id: string): Promise<CustomerTransaction> {
  return toTxn(await selectTxn(db, customerId, id));
}

export async function getCustomerTransactionHistory(db: Queryable, customerId: string, id: string): Promise<AuditHistoryEntry[]> {
  await selectTxn(db, customerId, id);
  return listAuditHistory(db, 'customer_transaction', id);
}

export interface FifoDue {
  id: string;
  /** Still owed on this due, in paise. */
  remaining: bigint;
}

/**
 * Splits `amount` (paise) over `dues` in the order given (callers pass them OLDEST FIRST): each due
 * is paid in full before the next one gets anything, and the last one reached may be paid in part.
 * Dues with nothing left are skipped. Throws when the amount is not positive or exceeds the total
 * still owed (a payment is never allocated beyond what is due).
 */
export function allocateFifo(dues: FifoDue[], amount: bigint): { dueId: string; amount: bigint }[] {
  if (amount <= 0n) throw new RangeError('The amount must be greater than zero');
  const total = dues.reduce((sum, d) => sum + (d.remaining > 0n ? d.remaining : 0n), 0n);
  if (amount > total) throw new RangeError('The amount is more than the total outstanding');
  const allocations: { dueId: string; amount: bigint }[] = [];
  let left = amount;
  for (const due of dues) {
    if (left === 0n) break;
    if (due.remaining <= 0n) continue;
    const part = due.remaining < left ? due.remaining : left;
    allocations.push({ dueId: due.id, amount: part });
    left -= part;
  }
  return allocations;
}

export interface Settlement {
  id: string;
  customerId: string;
  amount: string;
  txnDate: string;
  paymentMode: PaymentMode;
  /** One per due paid, oldest due first. */
  allocations: { dueId: string; transactionId: string; amount: string; dueRemainingAfter: string }[];
}

/**
 * "Pay full outstanding amount": records ONE payment of the customer's whole outstanding due, as one
 * due_payment per open due (oldest first, FIFO) sharing a settlement id, in ONE transaction: either
 * every due is settled or nothing is recorded.
 *
 * Concurrency: the customer row is locked first (like every ledger write), so concurrent payments,
 * dues and reversals for the same customer are serialised. `amount` must equal the outstanding total
 * at that moment; if anything changed since the user confirmed it, 409 OUTSTANDING_CHANGED and
 * nothing is recorded. The Idempotency-Key makes retries and double taps return the first result.
 */
export async function settleAllDues(
  db: Database,
  customerId: string,
  rawInput: SettleAllInput,
  actor: Actor,
  idempotencyKey: string,
): Promise<IdempotentResult<{ settlement: Settlement; transactions: CustomerTransaction[] }>> {
  const input = { ...rawInput, amount: normaliseMoney(rawInput.amount) };
  if (toPaise(input.amount) <= 0n) throw new ValidationError([{ path: 'amount', message: 'The amount must be greater than zero' }]);
  validateDate(input.txnDate);
  return runIdempotent(db, actor, 'customer_due.settle_all', idempotencyKey, hashRequest({ customerId, ...input }), async (client) => {
    await lockCustomer(client, customerId);
    const open = (
      await client.query<{ id: string; amount: string; paid: string }>(
        `SELECT t.id, t.amount,
                (SELECT COALESCE(sum(p.amount), 0)::numeric(14,2) FROM customer_transactions p
                  WHERE p.due_id = t.id AND p.reversed_at IS NULL) AS paid
           FROM customer_transactions t
          WHERE t.customer_id = $1 AND t.txn_type = 'due' AND t.reversed_at IS NULL
          ORDER BY t.txn_date, t.created_at, t.id
            FOR UPDATE OF t`,
        [customerId],
      )
    ).rows;
    const dues: FifoDue[] = open.map((d) => ({ id: d.id, remaining: toPaise(d.amount) - toPaise(d.paid) }));
    const outstanding = dues.reduce((sum, d) => sum + (d.remaining > 0n ? d.remaining : 0n), 0n);
    if (outstanding === 0n) throw new AppError(409, 'NOTHING_DUE', 'This customer has no outstanding dues.');
    const amount = toPaise(input.amount);
    if (amount !== outstanding) {
      throw new AppError(
        409,
        'OUTSTANDING_CHANGED',
        `The outstanding amount is now ${rupees(outstanding)} (you confirmed ${rupees(amount)}). Nothing was recorded; check and confirm again.`,
      );
    }

    const settlementId = randomUUID();
    const transactions: CustomerTransaction[] = [];
    const lines: Settlement['allocations'] = [];
    for (const a of allocateFifo(dues, amount)) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO customer_transactions
           (customer_id, txn_type, txn_date, amount, payment_mode, due_id, reference, notes, settlement_id, created_by, updated_by)
         VALUES ($1, 'due_payment', $2, $3::numeric, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [customerId, input.txnDate, fromDb(a.amount), input.paymentMode, a.dueId, input.reference, input.notes, settlementId, actor.userId],
      );
      const row = await selectTxn(client, customerId, inserted.rows[0]!.id);
      await recordFinancialAudit(client, {
        entityType: 'customer_transaction',
        entityId: row.id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: snapshot(row),
      });
      transactions.push(toTxn(row));
      const due = dues.find((d) => d.id === a.dueId)!;
      lines.push({ dueId: a.dueId, transactionId: row.id, amount: fromDb(a.amount), dueRemainingAfter: fromDb(due.remaining - a.amount) });
    }
    const settlement: Settlement = {
      id: settlementId,
      customerId,
      amount: fromDb(amount),
      txnDate: input.txnDate,
      paymentMode: input.paymentMode,
      allocations: lines,
    };
    return { status: 201, body: { settlement, transactions }, resourceId: settlementId };
  });
}

/** Active dues with something still owed, oldest first (for "receive payment"). */
export async function listOpenDues(db: Queryable, customerId: string): Promise<CustomerTransaction[]> {
  await selectCustomer(db, customerId);
  const rows = await db.query<TxnRow>(
    `SELECT * FROM (${SELECT_TXN} WHERE t.customer_id = $1 AND t.txn_type = 'due' AND t.reversed_at IS NULL) x
      WHERE x.amount > x.paid ORDER BY x.txn_date, x.created_at, x.id`,
    [customerId],
  );
  return rows.rows.map(toTxn);
}

export interface CustomerLedgerEntry extends CustomerTransaction {
  /** Effect on the due balance: "+500.00", "-200.00" or null (no effect). */
  dueEffect: string | null;
  advanceEffect: string | null;
  /** Balances after this entry (counted entries only change them). */
  runningDue: string;
  runningAdvance: string;
  counted: boolean;
}

export interface CustomerLedger {
  customer: { id: string; name: string; isActive: boolean };
  balances: { due: string; advance: string };
  /** With `from`: both balances from entries before that date (derived, not an opening balance). */
  broughtForward: { due: string; advance: string } | null;
  entries: CustomerLedgerEntry[];
  truncated: boolean;
}

const LEDGER_LIMIT = 2000;

export async function getCustomerLedger(db: Queryable, customerId: string, query: CustomerLedgerQuery): Promise<CustomerLedger> {
  const customer = await selectCustomer(db, customerId);
  const params: unknown[] = [customerId];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.from) where.push(`x.txn_date >= ${bind(query.from)}::date`);
  if (query.to) where.push(`x.txn_date <= ${bind(query.to)}::date`);
  if (query.type) where.push(`x.txn_type = ${bind(query.type)}`);
  if (query.categoryId) {
    // Dues of this category and the payments made against them.
    const c = bind(query.categoryId);
    where.push(`(x.category_id = ${c}::uuid OR x.due_category_id = ${c}::uuid)`);
  }
  if (query.status === 'active') where.push('x.reversed_at IS NULL');
  if (query.status === 'reversed') where.push('x.reversed_at IS NOT NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Running balances over ALL entries in a fixed order, THEN filtered.
  const rows = await db.query<TxnRow & { running_due: string; running_advance: string }>(
    `SELECT * FROM (
       SELECT t.*,
              sum(CASE WHEN t.reversed_at IS NOT NULL THEN 0
                       WHEN t.txn_type = 'due' THEN t.amount WHEN t.txn_type = 'due_payment' THEN -t.amount ELSE 0 END)
                OVER w::numeric(20,2) AS running_due,
              sum(CASE WHEN t.reversed_at IS NOT NULL THEN 0
                       WHEN t.txn_type = 'advance' THEN t.amount WHEN t.txn_type = 'advance_refund' THEN -t.amount ELSE 0 END)
                OVER w::numeric(20,2) AS running_advance
         FROM (${SELECT_TXN} WHERE t.customer_id = $1) t
       WINDOW w AS (ORDER BY t.txn_date, t.created_at, t.id ROWS UNBOUNDED PRECEDING)
     ) x ${whereSql}
     ORDER BY x.txn_date, x.created_at, x.id
     LIMIT ${LEDGER_LIMIT + 1}`,
    params,
  );

  let broughtForward: CustomerLedger['broughtForward'] = null;
  if (query.from) {
    const b = (
      await db.query<{ due: string; advance: string }>(
        `SELECT COALESCE(sum(CASE txn_type WHEN 'due' THEN amount WHEN 'due_payment' THEN -amount ELSE 0 END), 0)::numeric(20,2) AS due,
                COALESCE(sum(CASE txn_type WHEN 'advance' THEN amount WHEN 'advance_refund' THEN -amount ELSE 0 END), 0)::numeric(20,2) AS advance
           FROM customer_transactions WHERE customer_id = $1 AND reversed_at IS NULL AND txn_date < $2::date`,
        [customerId, query.from],
      )
    ).rows[0]!;
    broughtForward = { due: b.due, advance: b.advance };
  }

  const effect = (type: CustomerTxnType, amount: string, on: 'due' | 'advance'): string | null => {
    if (on === 'due') return type === 'due' ? `+${amount}` : type === 'due_payment' ? `-${amount}` : null;
    return type === 'advance' ? `+${amount}` : type === 'advance_refund' ? `-${amount}` : null;
  };

  return {
    customer: { id: customer.id, name: customer.name, isActive: customer.is_active },
    balances: { due: customer.due_balance, advance: customer.advance_balance },
    broughtForward,
    truncated: rows.rows.length > LEDGER_LIMIT,
    entries: rows.rows.slice(0, LEDGER_LIMIT).map((r) => ({
      ...toTxn(r),
      dueEffect: effect(r.txn_type, r.amount, 'due'),
      advanceEffect: effect(r.txn_type, r.amount, 'advance'),
      runningDue: r.running_due,
      runningAdvance: r.running_advance,
      counted: r.reversed_at === null,
    })),
  };
}
