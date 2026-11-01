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
import type { CustomerLedgerQuery, CustomerTxnInput, CustomerTxnType } from './customers.schemas.js';
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
  /** due_payment: the due it settles. */
  due: { id: string; txnDate: string; description: string | null; amount: string } | null;
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
         t.description, t.reference, t.notes, t.version, t.created_at, t.reversed_at, t.reversal_reason,
         CASE WHEN t.txn_type = 'due' THEN
           (SELECT COALESCE(sum(p.amount), 0)::numeric(14,2) FROM customer_transactions p
             WHERE p.due_id = t.id AND p.reversed_at IS NULL) END AS paid,
         cu.id AS created_by_id, cu.name AS created_by_name, ru.id AS reversed_by_id, ru.name AS reversed_by_name
    FROM customer_transactions t
    LEFT JOIN customer_transactions d ON d.id = t.due_id
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
    due: row.due_id ? { id: row.due_id, txnDate: row.due_date!, description: row.due_description, amount: row.due_amount! } : null,
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
       (customer_id, txn_type, txn_date, amount, payment_mode, due_id, description, reference, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
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
