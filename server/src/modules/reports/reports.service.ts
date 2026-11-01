import type { Queryable } from '../../database/connection.js';
import { toPaise } from '../../utils/money.js';
import { containsPattern } from '../../utils/sql.js';
import { getCustomersSummary } from '../customers/customers.service.js';
import type { PaymentMode } from '../expenses/expenses.schemas.js';
import { getSuppliersSummary } from '../supplierPayments/supplierLedger.service.js';
import { monthRange, type Period } from './period.js';

/**
 * Reporting calculations. THE single implementation used by the dashboard, the report pages,
 * the Excel exports and the monthly e-mail, so all of them agree.
 *
 * Definitions (see docs/architecture.md → Reports):
 *  - Expense totals = ACTIVE (not voided) expenses whose expense_date is in the period.
 *    Supplier payments are never added to expense totals.
 *  - "Paid at purchase" = expenses.amount_paid. "Settled by later supplier payments" = ACTIVE
 *    allocations to those expenses as of now. "Outstanding" = what is still payable on them now.
 *  - Supplier payable / unallocated and customer due / advance are CURRENT balances from the
 *    views supplier_balances / customer_balances (the same as the ledgers), never period figures.
 *  - Customer due and advance are always reported separately; there is no net figure.
 *  - Customer ledger entries are not revenue: dues, payments, advances and refunds are reported
 *    as what they are.
 */

type Bind = (value: unknown) => string;
function binder(params: unknown[]): Bind {
  return (value) => {
    params.push(value);
    return `$${params.length}`;
  };
}

/** Change in percent with one decimal, from decimal strings (BigInt paise; no floats). null if no base. */
export function percentChange(current: string, previous: string): string | null {
  const cur = toPaise(current.replace('-', ''));
  const prev = toPaise(previous.replace('-', ''));
  if (prev === 0n) return null;
  const tenths = ((cur - prev) * 1000n) / prev; // truncated toward zero
  const sign = tenths < 0n ? '-' : '';
  const abs = tenths < 0n ? -tenths : tenths;
  return `${sign}${abs / 10n}.${abs % 10n}`;
}

const ALLOCATED_LATERAL = `CROSS JOIN LATERAL (
    SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) AS allocated
      FROM supplier_payment_allocations a WHERE a.expense_id = e.id AND a.released_at IS NULL) al`;

// --- Expenses ----------------------------------------------------------------------------------

export interface ExpenseFilters {
  from: string;
  to: string;
  categoryId?: string | undefined;
  supplierId?: string | undefined;
  /** 'none' = nothing paid at purchase (no mode). */
  paymentMode?: PaymentMode | 'none' | undefined;
  recordedBy?: string | undefined;
}

/** WHERE conditions on alias `e` for every filter EXCEPT the date range and status. */
function expenseConditions(f: Omit<ExpenseFilters, 'from' | 'to'>, bind: Bind): string[] {
  const where: string[] = [];
  if (f.categoryId) where.push(`e.category_id = ${bind(f.categoryId)}`);
  if (f.supplierId) where.push(`e.supplier_id = ${bind(f.supplierId)}`);
  if (f.paymentMode === 'none') where.push('e.payment_mode IS NULL');
  else if (f.paymentMode) where.push(`e.payment_mode = ${bind(f.paymentMode)}`);
  if (f.recordedBy) where.push(`e.created_by = ${bind(f.recordedBy)}`);
  return where;
}

export interface ExpenseTotals {
  count: number;
  amount: string;
  paidAtPurchase: string;
  /** Later supplier payments allocated to these expenses (as of now). Not additional expenditure. */
  settledByPayments: string;
  /** Still payable on these expenses now. */
  outstanding: string;
  average: string;
  /** Voided expenses in the period (excluded from every total above). */
  voidedCount: number;
  voidedAmount: string;
}

export async function expenseTotals(db: Queryable, f: ExpenseFilters): Promise<ExpenseTotals> {
  const params: unknown[] = [];
  const bind = binder(params);
  const where = [`e.expense_date BETWEEN ${bind(f.from)}::date AND ${bind(f.to)}::date`, ...expenseConditions(f, bind)];
  const row = (
    await db.query<{
      count: number;
      amount: string;
      paid: string;
      settled: string;
      outstanding: string;
      average: string;
      voided_count: number;
      voided_amount: string;
    }>(
      `SELECT count(*) FILTER (WHERE e.voided_at IS NULL)::int AS count,
              COALESCE(sum(e.amount) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS amount,
              COALESCE(sum(e.amount_paid) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS paid,
              COALESCE(sum(al.allocated) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS settled,
              COALESCE(sum(e.amount - e.amount_paid - al.allocated) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS outstanding,
              COALESCE(round(avg(e.amount) FILTER (WHERE e.voided_at IS NULL), 2), 0)::numeric(20,2) AS average,
              count(*) FILTER (WHERE e.voided_at IS NOT NULL)::int AS voided_count,
              COALESCE(sum(e.amount) FILTER (WHERE e.voided_at IS NOT NULL), 0)::numeric(20,2) AS voided_amount
         FROM expenses e ${ALLOCATED_LATERAL}
        WHERE ${where.join(' AND ')}`,
      params,
    )
  ).rows[0]!;
  return {
    count: row.count,
    amount: row.amount,
    paidAtPurchase: row.paid,
    settledByPayments: row.settled,
    outstanding: row.outstanding,
    average: row.average,
    voidedCount: row.voided_count,
    voidedAmount: row.voided_amount,
  };
}

export interface CategoryRow {
  categoryId: string;
  name: string;
  isActive: boolean;
  amount: string;
  count: number;
  /** Share of the period total, one decimal ("12.5"); null when the total is zero. */
  percent: string | null;
  previousAmount: string;
  previousCount: number;
  changePercent: string | null;
}

/**
 * Category breakdown for the period plus the previous equivalent period, in ONE query.
 * Archived categories with expenses are kept (historical reporting); nothing is merged.
 */
export async function categoryBreakdown(
  db: Queryable,
  f: ExpenseFilters,
  previous: { from: string; to: string } | null,
): Promise<{ rows: CategoryRow[]; total: string; previousTotal: string }> {
  const params: unknown[] = [];
  const bind = binder(params);
  const cur = `e.expense_date BETWEEN ${bind(f.from)}::date AND ${bind(f.to)}::date`;
  const prev = previous ? `e.expense_date BETWEEN ${bind(previous.from)}::date AND ${bind(previous.to)}::date` : 'false';
  const where = ['e.voided_at IS NULL', `(${cur} OR ${prev})`, ...expenseConditions({ ...f, categoryId: undefined }, bind)];
  if (f.categoryId) where.push(`e.category_id = ${bind(f.categoryId)}`);
  const rows = (
    await db.query<{ id: string; name: string; is_active: boolean; amount: string; count: number; prev_amount: string; prev_count: number }>(
      `SELECT c.id, c.name, c.is_active,
              COALESCE(sum(e.amount) FILTER (WHERE ${cur}), 0)::numeric(20,2) AS amount,
              count(*) FILTER (WHERE ${cur})::int AS count,
              COALESCE(sum(e.amount) FILTER (WHERE ${prev}), 0)::numeric(20,2) AS prev_amount,
              count(*) FILTER (WHERE ${prev})::int AS prev_count
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE ${where.join(' AND ')}
        GROUP BY c.id, c.name, c.is_active
        ORDER BY sum(e.amount) FILTER (WHERE ${cur}) DESC NULLS LAST, lower(c.name)`,
      params,
    )
  ).rows;
  const total = rows.reduce((s, r) => s + toPaise(r.amount), 0n);
  const previousTotal = rows.reduce((s, r) => s + toPaise(r.prev_amount), 0n);
  return {
    total: fromPaiseString(total),
    previousTotal: fromPaiseString(previousTotal),
    rows: rows.map((r) => ({
      categoryId: r.id,
      name: r.name,
      isActive: r.is_active,
      amount: r.amount,
      count: r.count,
      percent: total === 0n ? null : tenthsString((toPaise(r.amount) * 1000n) / total),
      previousAmount: r.prev_amount,
      previousCount: r.prev_count,
      changePercent: previous ? percentChange(r.amount, r.prev_amount) : null,
    })),
  };
}

function fromPaiseString(p: bigint): string {
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
function tenthsString(t: bigint): string {
  return `${t / 10n}.${t % 10n}`;
}

export interface SupplierBreakdownRow {
  supplierId: string | null;
  name: string;
  isActive: boolean;
  amount: string;
  count: number;
  outstanding: string;
}

/** Expenses in the period grouped by supplier ("No supplier" is its own row). */
export async function supplierBreakdown(db: Queryable, f: ExpenseFilters, limit = 50): Promise<SupplierBreakdownRow[]> {
  const params: unknown[] = [];
  const bind = binder(params);
  const where = ['e.voided_at IS NULL', `e.expense_date BETWEEN ${bind(f.from)}::date AND ${bind(f.to)}::date`, ...expenseConditions(f, bind)];
  const rows = await db.query<{ id: string | null; name: string | null; is_active: boolean | null; amount: string; count: number; outstanding: string }>(
    `SELECT s.id, s.name, s.is_active, sum(e.amount)::numeric(20,2) AS amount, count(*)::int AS count,
            sum(e.amount - e.amount_paid - al.allocated)::numeric(20,2) AS outstanding
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id ${ALLOCATED_LATERAL}
      WHERE ${where.join(' AND ')}
      GROUP BY s.id, s.name, s.is_active
      ORDER BY sum(e.amount) DESC, lower(s.name) NULLS LAST
      LIMIT ${bind(limit)}`,
    params,
  );
  return rows.rows.map((r) => ({
    supplierId: r.id,
    name: r.name ?? 'No supplier',
    isActive: r.is_active ?? true,
    amount: r.amount,
    count: r.count,
    outstanding: r.outstanding,
  }));
}

export interface ModeRow {
  /** null = nothing was paid at purchase (credit purchase). */
  paymentMode: PaymentMode | null;
  count: number;
  /** Expense amounts of these expenses. */
  amount: string;
  /** Paid at purchase with this mode. */
  paidAtPurchase: string;
}

/** Expenses grouped by how the at-purchase payment was made. */
export async function paymentModeBreakdown(db: Queryable, f: ExpenseFilters): Promise<ModeRow[]> {
  const params: unknown[] = [];
  const bind = binder(params);
  const where = ['e.voided_at IS NULL', `e.expense_date BETWEEN ${bind(f.from)}::date AND ${bind(f.to)}::date`, ...expenseConditions(f, bind)];
  const rows = await db.query<{ payment_mode: PaymentMode | null; count: number; amount: string; paid: string }>(
    `SELECT e.payment_mode, count(*)::int AS count, sum(e.amount)::numeric(20,2) AS amount, sum(e.amount_paid)::numeric(20,2) AS paid
       FROM expenses e WHERE ${where.join(' AND ')}
      GROUP BY e.payment_mode ORDER BY sum(e.amount) DESC`,
    params,
  );
  return rows.rows.map((r) => ({ paymentMode: r.payment_mode, count: r.count, amount: r.amount, paidAtPurchase: r.paid }));
}

export interface PaidStatusRow {
  status: 'paid' | 'partly_paid' | 'unpaid';
  count: number;
  amount: string;
  outstanding: string;
}

/**
 * Paid vs unpaid, by what is outstanding on each expense NOW (paid at purchase + later supplier
 * payments): paid = nothing outstanding, unpaid = nothing paid at all, partly_paid = in between.
 */
export async function paidStatusBreakdown(db: Queryable, f: ExpenseFilters): Promise<PaidStatusRow[]> {
  const params: unknown[] = [];
  const bind = binder(params);
  const where = ['e.voided_at IS NULL', `e.expense_date BETWEEN ${bind(f.from)}::date AND ${bind(f.to)}::date`, ...expenseConditions(f, bind)];
  const rows = await db.query<{ status: PaidStatusRow['status']; count: number; amount: string; outstanding: string }>(
    `SELECT x.status, count(*)::int AS count, sum(x.amount)::numeric(20,2) AS amount, sum(x.outstanding)::numeric(20,2) AS outstanding
       FROM (SELECT e.amount, (e.amount - e.amount_paid - al.allocated) AS outstanding,
                    CASE WHEN e.amount - e.amount_paid - al.allocated = 0 THEN 'paid'
                         WHEN e.amount_paid + al.allocated = 0 THEN 'unpaid'
                         ELSE 'partly_paid' END AS status
               FROM expenses e ${ALLOCATED_LATERAL} WHERE ${where.join(' AND ')}) x
      GROUP BY x.status`,
    params,
  );
  const order: PaidStatusRow['status'][] = ['paid', 'partly_paid', 'unpaid'];
  return order.map(
    (status) => rows.rows.find((r) => r.status === status) ?? { status, count: 0, amount: '0.00', outstanding: '0.00' },
  );
}

export interface TrendPoint {
  /** 'YYYY-MM' */
  month: string;
  amount: string;
  count: number;
}

/** Monthly expense totals for every calendar month touching [from, to] (empty months included). */
export async function monthlyExpenseTrend(db: Queryable, f: ExpenseFilters): Promise<TrendPoint[]> {
  const params: unknown[] = [];
  const bind = binder(params);
  const from = bind(f.from);
  const to = bind(f.to);
  const cond = expenseConditions(f, bind);
  const rows = await db.query<{ month: string; amount: string; count: number }>(
    `SELECT to_char(m.month, 'YYYY-MM') AS month,
            COALESCE(sum(e.amount), 0)::numeric(20,2) AS amount, count(e.id)::int AS count
       FROM generate_series(date_trunc('month', ${from}::date), date_trunc('month', ${to}::date), interval '1 month') AS m(month)
       LEFT JOIN expenses e
              ON e.voided_at IS NULL AND date_trunc('month', e.expense_date) = m.month
             AND e.expense_date BETWEEN ${from}::date AND ${to}::date ${cond.length ? `AND ${cond.join(' AND ')}` : ''}
      GROUP BY m.month ORDER BY m.month`,
    params,
  );
  return rows.rows;
}

// --- Suppliers ---------------------------------------------------------------------------------

export interface SupplierReportQuery {
  from: string | null;
  to: string | null;
  supplierId?: string | undefined;
  status: 'active' | 'archived' | 'all';
  outstandingOnly: boolean;
  page: number;
  pageSize: number;
}

export interface SupplierReportRow {
  supplierId: string;
  name: string;
  isActive: boolean;
  /** PERIOD ACTIVITY (or all time without a period): */
  periodExpenses: string;
  periodExpenseCount: number;
  periodPaidAtPurchase: string;
  periodPayments: string;
  /** CURRENT BALANCES (never filtered by the period): */
  totalExpenses: string;
  directPayments: string;
  allocatedPayments: string;
  /** direct + allocated: everything paid against bills. */
  totalSettled: string;
  totalPayments: string;
  unallocated: string;
  payable: string;
  outstandingBills: number;
}

const SUPPLIER_REPORT_TOTAL_KEYS = [
  'periodExpenses',
  'periodPaidAtPurchase',
  'periodPayments',
  'totalExpenses',
  'directPayments',
  'allocatedPayments',
  'totalSettled',
  'totalPayments',
  'unallocated',
  'payable',
] as const;

export async function supplierReport(
  db: Queryable,
  q: SupplierReportQuery,
): Promise<{
  items: SupplierReportRow[];
  totals: Record<(typeof SUPPLIER_REPORT_TOTAL_KEYS)[number], string> & { suppliers: number; outstandingBills: number };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const params: unknown[] = [];
  const bind = binder(params);
  const from = bind(q.from ?? '2000-01-01');
  const to = bind(q.to ?? '2100-12-31');
  const where: string[] = [];
  if (q.supplierId) where.push(`s.id = ${bind(q.supplierId)}`);
  if (q.status === 'active') where.push('s.is_active');
  if (q.status === 'archived') where.push('NOT s.is_active');
  if (q.outstandingOnly) where.push('b.payable > 0');
  // Only suppliers with any financial activity (archived ones included when they have history).
  where.push('(b.bill_count > 0 OR b.payment_count > 0 OR pe.count > 0 OR pp.amount > 0)');
  const base = `
    FROM suppliers s
    JOIN supplier_balances b ON b.supplier_id = s.id
    LEFT JOIN (SELECT supplier_id, sum(amount) AS amount, sum(amount_paid) AS paid, count(*) AS count
                 FROM expenses WHERE voided_at IS NULL AND supplier_id IS NOT NULL
                  AND expense_date BETWEEN ${from}::date AND ${to}::date GROUP BY supplier_id) pe ON pe.supplier_id = s.id
    LEFT JOIN (SELECT supplier_id, sum(amount) AS amount
                 FROM supplier_payments WHERE reversed_at IS NULL
                  AND payment_date BETWEEN ${from}::date AND ${to}::date GROUP BY supplier_id) pp ON pp.supplier_id = s.id
    LEFT JOIN (SELECT e.supplier_id, count(*) AS n FROM expenses e ${ALLOCATED_LATERAL}
                WHERE e.voided_at IS NULL AND e.supplier_id IS NOT NULL AND e.amount - e.amount_paid - al.allocated > 0
                GROUP BY e.supplier_id) ob ON ob.supplier_id = s.id
    WHERE ${where.join(' AND ')}`;
  const columns = `s.id, s.name, s.is_active,
    COALESCE(pe.amount, 0)::numeric(20,2) AS period_expenses, COALESCE(pe.count, 0)::int AS period_count,
    COALESCE(pe.paid, 0)::numeric(20,2) AS period_paid, COALESCE(pp.amount, 0)::numeric(20,2) AS period_payments,
    b.total_bills, b.paid_at_purchase, b.allocated, (b.paid_at_purchase + b.allocated)::numeric(20,2) AS total_settled,
    b.total_payments, b.unallocated, b.payable, COALESCE(ob.n, 0)::int AS outstanding_bills`;
  const filterParams = [...params];
  const totalsRow = (
    await db.query<Record<string, string>>(
      `SELECT count(*)::int AS suppliers,
              COALESCE(sum(period_expenses), 0)::numeric(20,2) AS "periodExpenses",
              COALESCE(sum(period_paid), 0)::numeric(20,2) AS "periodPaidAtPurchase",
              COALESCE(sum(period_payments), 0)::numeric(20,2) AS "periodPayments",
              COALESCE(sum(total_bills), 0)::numeric(20,2) AS "totalExpenses",
              COALESCE(sum(paid_at_purchase), 0)::numeric(20,2) AS "directPayments",
              COALESCE(sum(allocated), 0)::numeric(20,2) AS "allocatedPayments",
              COALESCE(sum(total_settled), 0)::numeric(20,2) AS "totalSettled",
              COALESCE(sum(total_payments), 0)::numeric(20,2) AS "totalPayments",
              COALESCE(sum(unallocated), 0)::numeric(20,2) AS unallocated,
              COALESCE(sum(payable), 0)::numeric(20,2) AS payable,
              COALESCE(sum(outstanding_bills), 0)::int AS "outstandingBills"
         FROM (SELECT ${columns} ${base}) t`,
      filterParams,
    )
  ).rows[0]!;
  const limit = bind(q.pageSize);
  const offset = bind((q.page - 1) * q.pageSize);
  const rows = await db.query<{
    id: string;
    name: string;
    is_active: boolean;
    period_expenses: string;
    period_count: number;
    period_paid: string;
    period_payments: string;
    total_bills: string;
    paid_at_purchase: string;
    allocated: string;
    total_settled: string;
    total_payments: string;
    unallocated: string;
    payable: string;
    outstanding_bills: number;
  }>(`SELECT ${columns} ${base} ORDER BY b.payable DESC, lower(s.name), s.id LIMIT ${limit} OFFSET ${offset}`, params);
  const total = Number(totalsRow.suppliers);
  return {
    items: rows.rows.map((r) => ({
      supplierId: r.id,
      name: r.name,
      isActive: r.is_active,
      periodExpenses: r.period_expenses,
      periodExpenseCount: r.period_count,
      periodPaidAtPurchase: r.period_paid,
      periodPayments: r.period_payments,
      totalExpenses: r.total_bills,
      directPayments: r.paid_at_purchase,
      allocatedPayments: r.allocated,
      totalSettled: r.total_settled,
      totalPayments: r.total_payments,
      unallocated: r.unallocated,
      payable: r.payable,
      outstandingBills: r.outstanding_bills,
    })),
    totals: {
      ...(Object.fromEntries(SUPPLIER_REPORT_TOTAL_KEYS.map((k) => [k, totalsRow[k]!])) as Record<
        (typeof SUPPLIER_REPORT_TOTAL_KEYS)[number],
        string
      >),
      suppliers: total,
      outstandingBills: Number(totalsRow.outstandingBills),
    },
    pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
  };
}

/** Active supplier payments made in the period. */
export async function supplierPaymentsInPeriod(db: Queryable, from: string, to: string): Promise<{ count: number; amount: string }> {
  return (
    await db.query<{ count: number; amount: string }>(
      `SELECT count(*)::int AS count, COALESCE(sum(amount), 0)::numeric(20,2) AS amount
         FROM supplier_payments WHERE reversed_at IS NULL AND payment_date BETWEEN $1::date AND $2::date`,
      [from, to],
    )
  ).rows[0]!;
}

// --- Customers ---------------------------------------------------------------------------------

export interface CustomerActivity {
  duesRecorded: string;
  dueCount: number;
  duePaymentsReceived: string;
  duePaymentCount: number;
  advancesReceived: string;
  advanceCount: number;
  refundsIssued: string;
  refundCount: number;
}

/** Active customer ledger entries in the period, by type (never netted). */
export async function customerActivityInPeriod(db: Queryable, from: string, to: string): Promise<CustomerActivity> {
  const row = (
    await db.query<Record<string, string | number>>(
      `SELECT ${(['due', 'due_payment', 'advance', 'advance_refund'] as const)
        .map(
          (t) => `COALESCE(sum(amount) FILTER (WHERE txn_type = '${t}'), 0)::numeric(20,2) AS "${t}_amount",
                  count(*) FILTER (WHERE txn_type = '${t}')::int AS "${t}_count"`,
        )
        .join(', ')}
         FROM customer_transactions
        WHERE reversed_at IS NULL AND txn_date BETWEEN $1::date AND $2::date`,
      [from, to],
    )
  ).rows[0]!;
  return {
    duesRecorded: String(row.due_amount),
    dueCount: Number(row.due_count),
    duePaymentsReceived: String(row.due_payment_amount),
    duePaymentCount: Number(row.due_payment_count),
    advancesReceived: String(row.advance_amount),
    advanceCount: Number(row.advance_count),
    refundsIssued: String(row.advance_refund_amount),
    refundCount: Number(row.advance_refund_count),
  };
}

export interface CustomerReportQuery {
  kind: 'due' | 'advance';
  from: string | null;
  to: string | null;
  q?: string | undefined;
  status: 'active' | 'archived' | 'all';
  outstandingOnly: boolean;
  page: number;
  pageSize: number;
}

export interface CustomerReportRow {
  customerId: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  /** due: dues recorded; advance: advances received (PERIOD, or all time without a period). */
  added: string;
  /** due: payments received against dues; advance: refunds issued (PERIOD). */
  reduced: string;
  /** due: current outstanding due; advance: current available advance (CURRENT balance). */
  balance: string;
}

/**
 * The customer DUE report or the customer ADVANCE report. Two separate reports by design; each
 * only ever touches its own entry types and its own balance.
 */
export async function customerReport(
  db: Queryable,
  q: CustomerReportQuery,
): Promise<{
  kind: 'due' | 'advance';
  items: CustomerReportRow[];
  totals: { customers: number; added: string; reduced: string; balance: string };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const params: unknown[] = [];
  const bind = binder(params);
  const [addType, reduceType, balanceCol] =
    q.kind === 'due' ? (['due', 'due_payment', 'due_balance'] as const) : (['advance', 'advance_refund', 'advance_balance'] as const);
  const from = bind(q.from ?? '2000-01-01');
  const to = bind(q.to ?? '2100-12-31');
  const where: string[] = [];
  if (q.status === 'active') where.push('c.is_active');
  if (q.status === 'archived') where.push('NOT c.is_active');
  if (q.outstandingOnly) where.push(`b.${balanceCol} > 0`);
  if (q.q) {
    const p = bind(containsPattern(q.q));
    where.push(`(c.name ILIKE ${p} ESCAPE '\\' OR c.phone ILIKE ${p} ESCAPE '\\')`);
  }
  // Only customers with entries of this kind (archived customers included when they have history).
  where.push(`(b.${balanceCol} <> 0 OR t.added > 0 OR t.reduced > 0 OR t.ever > 0)`);
  const base = `
    FROM customers c
    JOIN customer_balances b ON b.customer_id = c.id
    LEFT JOIN (SELECT customer_id,
                      sum(amount) FILTER (WHERE txn_type = '${addType}' AND reversed_at IS NULL AND txn_date BETWEEN ${from}::date AND ${to}::date) AS added,
                      sum(amount) FILTER (WHERE txn_type = '${reduceType}' AND reversed_at IS NULL AND txn_date BETWEEN ${from}::date AND ${to}::date) AS reduced,
                      count(*) FILTER (WHERE txn_type IN ('${addType}', '${reduceType}')) AS ever
                 FROM customer_transactions GROUP BY customer_id) t ON t.customer_id = c.id
    WHERE ${where.join(' AND ')}`;
  const columns = `c.id, c.name, c.phone, c.is_active, COALESCE(t.added, 0)::numeric(20,2) AS added,
    COALESCE(t.reduced, 0)::numeric(20,2) AS reduced, b.${balanceCol} AS balance`;
  const totals = (
    await db.query<{ customers: number; added: string; reduced: string; balance: string }>(
      `SELECT count(*)::int AS customers, COALESCE(sum(added), 0)::numeric(20,2) AS added,
              COALESCE(sum(reduced), 0)::numeric(20,2) AS reduced, COALESCE(sum(balance), 0)::numeric(20,2) AS balance
         FROM (SELECT ${columns} ${base}) x`,
      [...params],
    )
  ).rows[0]!;
  const limit = bind(q.pageSize);
  const offset = bind((q.page - 1) * q.pageSize);
  const rows = await db.query<{ id: string; name: string; phone: string | null; is_active: boolean; added: string; reduced: string; balance: string }>(
    `SELECT ${columns} ${base} ORDER BY b.${balanceCol} DESC, lower(c.name), c.id LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    kind: q.kind,
    items: rows.rows.map((r) => ({
      customerId: r.id,
      name: r.name,
      phone: r.phone,
      isActive: r.is_active,
      added: r.added,
      reduced: r.reduced,
      balance: r.balance,
    })),
    totals,
    pagination: {
      page: q.page,
      pageSize: q.pageSize,
      total: totals.customers,
      totalPages: Math.max(1, Math.ceil(totals.customers / q.pageSize)),
    },
  };
}

// --- Transactions (activity feed and history) --------------------------------------------------

export const TRANSACTION_TYPES = [
  'expense',
  'supplier_payment',
  'customer_due',
  'customer_due_payment',
  'customer_advance',
  'customer_refund',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface TransactionRow {
  type: TransactionType;
  id: string;
  date: string;
  createdAt: string;
  reference: string | null;
  /** Supplier or customer name (null for an expense without supplier). */
  entity: string | null;
  entityId: string | null;
  description: string | null;
  amount: string;
  status: 'active' | 'voided' | 'reversed';
  recordedBy: string;
}

export interface TransactionQuery {
  from?: string | undefined;
  to?: string | undefined;
  types?: TransactionType[] | undefined;
  status: 'active' | 'cancelled' | 'all';
  q?: string | undefined;
}

const CUSTOMER_TYPE_SQL: Record<string, string> = {
  due: 'customer_due',
  due_payment: 'customer_due_payment',
  advance: 'customer_advance',
  advance_refund: 'customer_refund',
};

/** UNION of every financial transaction type with identical columns. Never includes document data. */
function transactionsSql(q: TransactionQuery, bind: Bind): string {
  const types = new Set(q.types?.length ? q.types : TRANSACTION_TYPES);
  const date = (col: string) => [
    ...(q.from ? [`${col} >= ${bind(q.from)}::date`] : []),
    ...(q.to ? [`${col} <= ${bind(q.to)}::date`] : []),
  ];
  const search = (cols: string[]) => {
    if (!q.q) return [];
    const p = bind(containsPattern(q.q));
    return [`(${cols.map((c) => `${c} ILIKE ${p} ESCAPE '\\'`).join(' OR ')})`];
  };
  const parts: string[] = [];
  const and = (conds: string[]) => (conds.length ? `WHERE ${conds.join(' AND ')}` : '');
  if (types.has('expense')) {
    parts.push(`SELECT 'expense'::text AS type, e.id, e.expense_date AS date, e.created_at, e.invoice_reference AS reference,
                       s.name AS entity, s.id AS entity_id, e.description, e.amount,
                       CASE WHEN e.voided_at IS NULL THEN 'active' ELSE 'voided' END AS status, u.name AS recorded_by
                  FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id JOIN users u ON u.id = e.created_by
                  ${and([...date('e.expense_date'), ...search(['e.description', 'e.invoice_reference', 's.name'])])}`);
  }
  if (types.has('supplier_payment')) {
    parts.push(`SELECT 'supplier_payment'::text AS type, p.id, p.payment_date AS date, p.created_at, p.reference, s.name AS entity,
                       s.id AS entity_id, p.notes AS description, p.amount,
                       CASE WHEN p.reversed_at IS NULL THEN 'active' ELSE 'reversed' END AS status, u.name AS recorded_by
                  FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id JOIN users u ON u.id = p.created_by
                  ${and([...date('p.payment_date'), ...search(['p.reference', 'p.notes', 's.name'])])}`);
  }
  const customerTypes = Object.entries(CUSTOMER_TYPE_SQL)
    .filter(([, t]) => types.has(t as TransactionType))
    .map(([raw]) => raw);
  if (customerTypes.length) {
    parts.push(`SELECT CASE t.txn_type ${Object.entries(CUSTOMER_TYPE_SQL)
      .map(([raw, t]) => `WHEN '${raw}' THEN '${t}'`)
      .join(' ')} END AS type, t.id, t.txn_date AS date, t.created_at, t.reference, c.name AS entity, c.id AS entity_id,
                       t.description, t.amount, CASE WHEN t.reversed_at IS NULL THEN 'active' ELSE 'reversed' END AS status,
                       u.name AS recorded_by
                  FROM customer_transactions t JOIN customers c ON c.id = t.customer_id JOIN users u ON u.id = t.created_by
                  ${and([
                    `t.txn_type = ANY(${bind(customerTypes)}::text[])`,
                    ...date('t.txn_date'),
                    ...search(['t.description', 't.reference', 'c.name']),
                  ])}`);
  }
  const statusFilter = q.status === 'active' ? `WHERE x.status = 'active'` : q.status === 'cancelled' ? `WHERE x.status <> 'active'` : '';
  if (parts.length === 0) return `SELECT * FROM (SELECT NULL::text AS type) x WHERE false`;
  return `SELECT * FROM (${parts.join(' UNION ALL ')}) x ${statusFilter}`;
}

type TxnDbRow = {
  type: TransactionType;
  id: string;
  date: string;
  created_at: Date;
  reference: string | null;
  entity: string | null;
  entity_id: string | null;
  description: string | null;
  amount: string;
  status: TransactionRow['status'];
  recorded_by: string;
};
const toTxn = (r: TxnDbRow): TransactionRow => ({
  type: r.type,
  id: r.id,
  date: r.date,
  createdAt: r.created_at.toISOString(),
  reference: r.reference,
  entity: r.entity,
  entityId: r.entity_id,
  description: r.description || null,
  amount: r.amount,
  status: r.status,
  recordedBy: r.recorded_by,
});

/** Paginated transaction history (newest business date first). */
export async function listTransactions(
  db: Queryable,
  q: TransactionQuery & { page: number; pageSize: number },
): Promise<{
  items: TransactionRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  totals: { type: TransactionType; count: number; amount: string }[];
}> {
  const params: unknown[] = [];
  const bind = binder(params);
  const sql = transactionsSql(q, bind);
  const summary = await db.query<{ type: TransactionType; count: number; amount: string }>(
    `SELECT type, count(*)::int AS count, COALESCE(sum(amount) FILTER (WHERE status = 'active'), 0)::numeric(20,2) AS amount
       FROM (${sql}) y GROUP BY type ORDER BY type`,
    [...params],
  );
  const total = summary.rows.reduce((s, r) => s + r.count, 0);
  const limit = bind(q.pageSize);
  const offset = bind((q.page - 1) * q.pageSize);
  const rows = await db.query<TxnDbRow>(`${sql} ORDER BY date DESC, created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  return {
    items: rows.rows.map(toTxn),
    pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
    // Amounts per type over ACTIVE rows only (counts include cancelled rows that matched).
    totals: summary.rows,
  };
}

/** Most recently RECORDED transactions across all types (for the dashboard feed). */
export async function recentActivity(db: Queryable, limit = 12): Promise<TransactionRow[]> {
  const params: unknown[] = [];
  const bind = binder(params);
  const l = bind(limit);
  // Each branch is limited first (uses the created_at indexes), then merged.
  const rows = await db.query<TxnDbRow>(
    `SELECT * FROM (
       (SELECT 'expense'::text AS type, e.id, e.expense_date AS date, e.created_at, e.invoice_reference AS reference, s.name AS entity,
               s.id AS entity_id, e.description, e.amount, CASE WHEN e.voided_at IS NULL THEN 'active' ELSE 'voided' END AS status,
               u.name AS recorded_by
          FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id JOIN users u ON u.id = e.created_by
         ORDER BY e.created_at DESC LIMIT ${l})
       UNION ALL
       (SELECT 'supplier_payment', p.id, p.payment_date, p.created_at, p.reference, s.name, s.id, p.notes, p.amount,
               CASE WHEN p.reversed_at IS NULL THEN 'active' ELSE 'reversed' END, u.name
          FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id JOIN users u ON u.id = p.created_by
         ORDER BY p.created_at DESC LIMIT ${l})
       UNION ALL
       (SELECT CASE t.txn_type WHEN 'due' THEN 'customer_due' WHEN 'due_payment' THEN 'customer_due_payment'
                               WHEN 'advance' THEN 'customer_advance' ELSE 'customer_refund' END,
               t.id, t.txn_date, t.created_at, t.reference, c.name, c.id, t.description, t.amount,
               CASE WHEN t.reversed_at IS NULL THEN 'active' ELSE 'reversed' END, u.name
          FROM customer_transactions t JOIN customers c ON c.id = t.customer_id JOIN users u ON u.id = t.created_by
         ORDER BY t.created_at DESC LIMIT ${l})
     ) x ORDER BY created_at DESC, id DESC LIMIT ${l}`,
    params,
  );
  return rows.rows.map(toTxn);
}

/** Streams nothing: returns up to `max` rows (exports). Caller checks `truncated`. */
export async function allTransactions(db: Queryable, q: TransactionQuery, max: number): Promise<{ rows: TransactionRow[]; truncated: boolean }> {
  const params: unknown[] = [];
  const bind = binder(params);
  const rows = await db.query<TxnDbRow>(
    `${transactionsSql(q, bind)} ORDER BY date DESC, created_at DESC, id DESC LIMIT ${bind(max + 1)}`,
    params,
  );
  return { rows: rows.rows.slice(0, max).map(toTxn), truncated: rows.rows.length > max };
}

// --- Dashboard and monthly summary --------------------------------------------------------------

export interface Dashboard {
  period: Period;
  generatedAt: string;
  /** PERIOD ACTIVITY */
  expenses: ExpenseTotals & { previous: { count: number; amount: string } | null; changePercent: string | null };
  supplierPaymentsInPeriod: { count: number; amount: string };
  customerActivity: CustomerActivity;
  /** CURRENT BALANCES (as of now, independent of the period) */
  suppliers: { totalPayable: string; suppliersWithPayable: number; totalUnallocated: string };
  customers: { totalDue: string; customersWithDue: number; totalAdvance: string; customersWithAdvance: number };
  /** Monthly expense totals for the 6 months ending with the period's last month. */
  trend: TrendPoint[];
  recentActivity: TransactionRow[];
}

export async function dashboard(db: Queryable, period: Period): Promise<Dashboard> {
  const f: ExpenseFilters = { from: period.from, to: period.to };
  const [endY, endM] = period.to.split('-').map(Number) as [number, number];
  const trendFrom = monthRange(endY, endM - 5).from;
  const [current, previous, payments, activity, suppliers, customers, trend, recent] = await Promise.all([
    expenseTotals(db, f),
    period.previous ? expenseTotals(db, period.previous) : null,
    supplierPaymentsInPeriod(db, period.from, period.to),
    customerActivityInPeriod(db, period.from, period.to),
    getSuppliersSummary(db),
    getCustomersSummary(db),
    monthlyExpenseTrend(db, { from: trendFrom, to: period.to }),
    recentActivity(db, 10),
  ]);
  return {
    period,
    generatedAt: new Date().toISOString(),
    expenses: {
      ...current,
      previous: previous ? { count: previous.count, amount: previous.amount } : null,
      changePercent: previous ? percentChange(current.amount, previous.amount) : null,
    },
    supplierPaymentsInPeriod: payments,
    customerActivity: activity,
    suppliers: {
      totalPayable: suppliers.totalPayable,
      suppliersWithPayable: suppliers.suppliersWithPayable,
      totalUnallocated: suppliers.totalUnallocated,
    },
    customers,
    trend,
    recentActivity: recent,
  };
}

export interface MonthlySummary {
  year: number;
  month: number;
  label: string;
  from: string;
  to: string;
  previous: { from: string; to: string };
  generatedAt: string;
  expenses: ExpenseTotals & { previous: ExpenseTotals; changePercent: string | null };
  categories: CategoryRow[];
  paymentModes: ModeRow[];
  /** PERIOD: expenses with a supplier, and supplier payments, in the month. */
  supplierActivity: { supplierExpenses: string; supplierExpenseCount: number; payments: string; paymentCount: number };
  /** CURRENT balances at generation time. */
  suppliers: { totalPayable: string; suppliersWithPayable: number; totalUnallocated: string; topPayable: { name: string; payable: string }[] };
  customerActivity: CustomerActivity;
  customers: { totalDue: string; customersWithDue: number; totalAdvance: string; customersWithAdvance: number };
  /** Factual notes derived from the figures above (no interpretation). */
  notes: string[];
}

/** The monthly financial summary (dashboard, Excel "Monthly summary" and the monthly e-mail). */
export async function monthlySummary(db: Queryable, year: number, month: number, label: string): Promise<MonthlySummary> {
  const range = monthRange(year, month);
  const previous = monthRange(year, month - 1);
  const f: ExpenseFilters = { from: range.from, to: range.to };
  const [current, prev, categories, modes, supplierExp, payments, activity, suppliers, customers] = await Promise.all([
    expenseTotals(db, f),
    expenseTotals(db, previous),
    categoryBreakdown(db, f, previous),
    paymentModeBreakdown(db, f),
    db.query<{ amount: string; count: number }>(
      `SELECT COALESCE(sum(amount), 0)::numeric(20,2) AS amount, count(*)::int AS count
         FROM expenses WHERE voided_at IS NULL AND supplier_id IS NOT NULL AND expense_date BETWEEN $1::date AND $2::date`,
      [range.from, range.to],
    ),
    supplierPaymentsInPeriod(db, range.from, range.to),
    customerActivityInPeriod(db, range.from, range.to),
    getSuppliersSummary(db),
    getCustomersSummary(db),
  ]);
  const changePercent = percentChange(current.amount, prev.amount);
  const notes: string[] = [];
  if (current.count === 0) notes.push('No expenses were recorded for this month.');
  if (changePercent !== null) {
    notes.push(
      `Expenses were ${changePercent.startsWith('-') ? `${changePercent.slice(1)}% lower` : `${changePercent}% higher`} than the previous month.`,
    );
  }
  const top = categories.rows[0];
  if (top && top.amount !== '0.00') notes.push(`Largest category: ${top.name} (${top.percent ?? '0.0'}% of expenses).`);
  if (current.voidedCount > 0) notes.push(`${current.voidedCount} voided expense(s) are excluded from the totals.`);
  return {
    year,
    month,
    label,
    from: range.from,
    to: range.to,
    previous,
    generatedAt: new Date().toISOString(),
    expenses: { ...current, previous: prev, changePercent },
    categories: categories.rows.filter((r) => r.count > 0 || r.previousCount > 0),
    paymentModes: modes,
    supplierActivity: {
      supplierExpenses: supplierExp.rows[0]!.amount,
      supplierExpenseCount: supplierExp.rows[0]!.count,
      payments: payments.amount,
      paymentCount: payments.count,
    },
    suppliers: {
      totalPayable: suppliers.totalPayable,
      suppliersWithPayable: suppliers.suppliersWithPayable,
      totalUnallocated: suppliers.totalUnallocated,
      topPayable: suppliers.topPayable.slice(0, 5).map((s) => ({ name: s.name, payable: s.payable })),
    },
    customerActivity: activity,
    customers,
    notes,
  };
}

