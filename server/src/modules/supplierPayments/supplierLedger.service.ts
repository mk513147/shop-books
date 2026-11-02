import type { Queryable } from '../../database/connection.js';
import { NotFoundError } from '../../utils/errors.js';
import { expenseLabelSql } from '../../utils/sql.js';
import type { PaymentLine, PaymentMode } from '../expenses/expenses.schemas.js';
import { loadPayments } from '../expenses/expenses.service.js';
import type { LedgerQuery } from './supplierPayments.schemas.js';

/**
 * Supplier balances and ledger, always derived from the source rows (view `supplier_balances`).
 *
 *   payable     = active bills - paid at purchase - active allocations     (what is still owed on bills)
 *   unallocated = active payments - active allocations                     (paid but not yet matched to bills)
 *   net balance = payable - unallocated = bills - paid at purchase - all active payments
 *
 * Ledger convention (the shop's books, supplier account): CREDIT = increases what we owe
 * (a bill); DEBIT = reduces it (paid at purchase, a payment). The running balance is the NET
 * balance owed to the supplier after every counted entry, so its final value equals
 * `netBalance`. Voided bills and reversed payments are listed but not counted.
 */
export interface SupplierBalance {
  supplierId: string;
  totalBills: string;
  paidAtPurchase: string;
  totalPayments: string;
  allocated: string;
  payable: string;
  unallocated: string;
  netBalance: string;
  billCount: number;
  paymentCount: number;
}

interface BalanceRow {
  supplier_id: string;
  total_bills: string;
  paid_at_purchase: string;
  total_payments: string;
  allocated: string;
  payable: string;
  unallocated: string;
  net_balance: string;
  bill_count: number;
  payment_count: number;
}

const BALANCE_COLUMNS = `b.supplier_id, b.total_bills, b.paid_at_purchase, b.total_payments, b.allocated, b.payable, b.unallocated,
  (b.payable - b.unallocated)::numeric(20,2) AS net_balance, b.bill_count, b.payment_count`;

function toBalance(row: BalanceRow): SupplierBalance {
  return {
    supplierId: row.supplier_id,
    totalBills: row.total_bills,
    paidAtPurchase: row.paid_at_purchase,
    totalPayments: row.total_payments,
    allocated: row.allocated,
    payable: row.payable,
    unallocated: row.unallocated,
    netBalance: row.net_balance,
    billCount: row.bill_count,
    paymentCount: row.payment_count,
  };
}

async function assertSupplier(db: Queryable, id: string): Promise<{ id: string; name: string; is_active: boolean }> {
  const row = (await db.query<{ id: string; name: string; is_active: boolean }>(`SELECT id, name, is_active FROM suppliers WHERE id = $1`, [id]))
    .rows[0];
  if (!row) throw new NotFoundError('Supplier not found');
  return row;
}

export async function getSupplierBalance(db: Queryable, supplierId: string): Promise<SupplierBalance> {
  await assertSupplier(db, supplierId);
  const row = (await db.query<BalanceRow>(`SELECT ${BALANCE_COLUMNS} FROM supplier_balances b WHERE b.supplier_id = $1`, [supplierId]))
    .rows[0]!;
  return toBalance(row);
}

export type LedgerEntryType = 'bill' | 'paid_at_purchase' | 'payment';

export interface LedgerEntry {
  /** Stable row id: `<type>:<source id>`. */
  key: string;
  type: LedgerEntryType;
  /** The expense (bill / paid at purchase) or the supplier payment. */
  sourceId: string;
  date: string;
  reference: string | null;
  description: string;
  paymentMode: PaymentMode | null;
  /**
   * "Paid at purchase" entries: how the paid amount was made up, one item per payment method
   * (e.g. UPI 1000 + Cash 1500). Display detail only: the entry's `debit` is the total, counted once.
   * Null for bills and supplier payments.
   */
  payments: PaymentLine[] | null;
  /** Increases what is owed (bills). Decimal string, "0.00" when not applicable. */
  credit: string;
  /** Reduces what is owed (paid at purchase, payments). */
  debit: string;
  /** Net balance owed after this entry (counted entries only change it). */
  runningBalance: string;
  status: 'active' | 'voided' | 'reversed';
  counted: boolean;
  /** Payments: how much of it is allocated to bills. Bills: how much of it payments settle. */
  allocated: string | null;
  createdAt: string;
}

interface LedgerRow {
  type: LedgerEntryType;
  source_id: string;
  entry_date: string;
  reference: string | null;
  description: string;
  payment_mode: PaymentMode | null;
  credit: string;
  debit: string;
  status: 'active' | 'voided' | 'reversed';
  allocated: string | null;
  created_at: Date;
  running_balance: string;
}

export interface SupplierLedger {
  supplier: { id: string; name: string; isActive: boolean };
  balance: SupplierBalance;
  /** With a `from` date: net balance of all counted entries BEFORE that date (not an opening balance). */
  broughtForward: string | null;
  entries: LedgerEntry[];
  /** True when more than LEDGER_LIMIT rows matched (narrow the date range). */
  truncated: boolean;
}

const LEDGER_LIMIT = 2000;

export async function getSupplierLedger(db: Queryable, supplierId: string, query: LedgerQuery): Promise<SupplierLedger> {
  const supplier = await assertSupplier(db, supplierId);
  const params: unknown[] = [supplierId];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.from) where.push(`entry_date >= ${bind(query.from)}::date`);
  if (query.to) where.push(`entry_date <= ${bind(query.to)}::date`);
  if (query.type) where.push(`type = ${bind(query.type)}`);
  if (query.status === 'active') where.push(`status = 'active'`);
  if (query.status === 'cancelled') where.push(`status <> 'active'`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Running balance over ALL entries in a fixed order, THEN filtered, so filters never change it.
  const entriesCte = `
    WITH entries AS (
      SELECT 'bill'::text AS type, e.id AS source_id, e.expense_date AS entry_date, e.created_at, 1 AS seq,
             e.invoice_reference AS reference, ${expenseLabelSql('e')} AS description, NULL::text AS payment_mode,
             e.amount AS credit, 0::numeric(14,2) AS debit,
             CASE WHEN e.voided_at IS NULL THEN 'active' ELSE 'voided' END AS status,
             (SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) FROM supplier_payment_allocations a
               WHERE a.expense_id = e.id AND a.released_at IS NULL) AS allocated
        FROM expenses e WHERE e.supplier_id = $1
      UNION ALL
      SELECT 'paid_at_purchase', e.id, e.expense_date, e.created_at, 2,
             e.invoice_reference, ${expenseLabelSql('e')}, e.payment_mode,
             0::numeric(14,2), e.amount_paid,
             CASE WHEN e.voided_at IS NULL THEN 'active' ELSE 'voided' END, NULL
        FROM expenses e WHERE e.supplier_id = $1 AND e.amount_paid > 0
      UNION ALL
      SELECT 'payment', p.id, p.payment_date, p.created_at, 3,
             p.reference, COALESCE(p.notes, ''), p.payment_mode,
             0::numeric(14,2), p.amount,
             CASE WHEN p.reversed_at IS NULL THEN 'active' ELSE 'reversed' END,
             (SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) FROM supplier_payment_allocations a
               WHERE a.payment_id = p.id AND a.released_at IS NULL)
        FROM supplier_payments p WHERE p.supplier_id = $1
    ),
    ordered AS (
      SELECT *, sum(CASE WHEN status = 'active' THEN credit - debit ELSE 0 END)
                  OVER (ORDER BY entry_date, created_at, seq, source_id ROWS UNBOUNDED PRECEDING)::numeric(20,2) AS running_balance
        FROM entries
    )`;

  const rows = await db.query<LedgerRow>(
    `${entriesCte}
     SELECT type, source_id, entry_date, reference, description, payment_mode, credit, debit, status, allocated, created_at, running_balance
       FROM ordered ${whereSql}
      ORDER BY entry_date, created_at, seq, source_id
      LIMIT ${LEDGER_LIMIT + 1}`,
    params,
  );

  let broughtForward: string | null = null;
  if (query.from) {
    broughtForward = (
      await db.query<{ total: string }>(
        `${entriesCte}
         SELECT COALESCE(sum(credit - debit) FILTER (WHERE status = 'active'), 0)::numeric(20,2) AS total
           FROM entries WHERE entry_date < $2::date`,
        [supplierId, query.from],
      )
    ).rows[0]!.total;
  }

  const truncated = rows.rows.length > LEDGER_LIMIT;
  const kept = rows.rows.slice(0, LEDGER_LIMIT);
  const breakdown = await loadPayments(db, kept.filter((r) => r.type === 'paid_at_purchase').map((r) => r.source_id));
  return {
    supplier: { id: supplier.id, name: supplier.name, isActive: supplier.is_active },
    balance: await getSupplierBalance(db, supplierId),
    broughtForward,
    truncated,
    entries: kept.map((r) => ({
      key: `${r.type}:${r.source_id}`,
      type: r.type,
      sourceId: r.source_id,
      date: r.entry_date,
      reference: r.reference,
      description: r.type === 'paid_at_purchase' ? `Paid at purchase: ${r.description}` : r.description,
      paymentMode: r.payment_mode,
      payments: r.type === 'paid_at_purchase' ? (breakdown.get(r.source_id) ?? []) : null,
      credit: r.credit,
      debit: r.debit,
      runningBalance: r.running_balance,
      status: r.status,
      counted: r.status === 'active',
      allocated: r.allocated,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

export interface OpenBill {
  id: string;
  expenseDate: string;
  description: string;
  invoiceReference: string | null;
  amount: string;
  amountPaid: string;
  allocated: string;
  /** amount - amountPaid - allocated, > 0. */
  payable: string;
}

/** Active bills of the supplier with something still payable, oldest first (for allocating payments). */
export async function listOpenBills(db: Queryable, supplierId: string): Promise<OpenBill[]> {
  await assertSupplier(db, supplierId);
  const rows = await db.query<{
    id: string;
    expense_date: string;
    description: string;
    invoice_reference: string | null;
    amount: string;
    amount_paid: string;
    allocated: string;
    payable: string;
  }>(
    `SELECT e.id, e.expense_date, ${expenseLabelSql('e')} AS description, e.invoice_reference, e.amount, e.amount_paid, al.allocated,
            (e.amount - e.amount_paid - al.allocated)::numeric(14,2) AS payable
       FROM expenses e
       CROSS JOIN LATERAL (SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) AS allocated
                             FROM supplier_payment_allocations a WHERE a.expense_id = e.id AND a.released_at IS NULL) al
      WHERE e.supplier_id = $1 AND e.voided_at IS NULL AND e.amount - e.amount_paid - al.allocated > 0
      ORDER BY e.expense_date, e.created_at, e.id`,
    [supplierId],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    expenseDate: r.expense_date,
    description: r.description,
    invoiceReference: r.invoice_reference,
    amount: r.amount,
    amountPaid: r.amount_paid,
    allocated: r.allocated,
    payable: r.payable,
  }));
}

export interface SuppliersSummary {
  totalPayable: string;
  totalPayments: string;
  totalUnallocated: string;
  suppliersWithPayable: number;
  /** Largest payable first (up to 10). */
  topPayable: { id: string; name: string; isActive: boolean; payable: string; unallocated: string }[];
}

/** Totals across all suppliers (archived included: an archived supplier may still be owed money). */
export async function getSuppliersSummary(db: Queryable): Promise<SuppliersSummary> {
  const totals = (
    await db.query<{ payable: string; payments: string; unallocated: string; with_payable: number }>(
      `SELECT COALESCE(sum(payable), 0)::numeric(20,2) AS payable,
              COALESCE(sum(total_payments), 0)::numeric(20,2) AS payments,
              COALESCE(sum(unallocated), 0)::numeric(20,2) AS unallocated,
              count(*) FILTER (WHERE payable > 0)::int AS with_payable
         FROM supplier_balances`,
    )
  ).rows[0]!;
  const top = await db.query<{ id: string; name: string; is_active: boolean; payable: string; unallocated: string }>(
    `SELECT s.id, s.name, s.is_active, b.payable, b.unallocated
       FROM supplier_balances b JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.payable > 0 ORDER BY b.payable DESC, lower(s.name) LIMIT 10`,
  );
  return {
    totalPayable: totals.payable,
    totalPayments: totals.payments,
    totalUnallocated: totals.unallocated,
    suppliersWithPayable: totals.with_payable,
    topPayable: top.rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active, payable: r.payable, unallocated: r.unallocated })),
  };
}
