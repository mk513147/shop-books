import type ExcelJS from 'exceljs';
import type { Queryable } from '../../database/connection.js';
import { AppError } from '../../utils/errors.js';
import { getCustomerLedger } from '../customers/customerLedger.service.js';
import { listExpenses } from '../expenses/expenses.service.js';
import type { PaymentMode } from '../expenses/expenses.schemas.js';
import { type Period } from '../reports/period.js';
import {
  allTransactions,
  categoryBreakdown,
  customerReport,
  expenseTotals,
  monthlySummary,
  supplierReport,
  type ExpenseFilters,
  type MonthlySummary,
  type TransactionQuery,
  type TransactionRow,
} from '../reports/reports.service.js';
import { getSupplierLedger } from '../supplierPayments/supplierLedger.service.js';
import { listPayments } from '../supplierPayments/supplierPayments.service.js';
import { addKeyValueSheet, addTableSheet, newWorkbook, type Column, type ReportMeta } from './excel.js';

/**
 * Excel exports. Every workbook is filled from the SAME service functions as the report pages and
 * ledgers (no separate calculation engine), with the same filters. Exports are bounded: more than
 * MAX_EXPORT_ROWS matching rows is refused with a request to narrow the filters.
 */
export const MAX_EXPORT_ROWS = 20_000;

const MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};
const mode = (m: PaymentMode | null | undefined) => (m ? MODE_LABELS[m] : '');
/** "UPI 1000.00, Cash 1500.00" for several methods; just the method name for one; empty when unpaid. */
const paymentMethods = (payments: { paymentMode: PaymentMode; amount: string }[]) =>
  payments.map((p) => (payments.length > 1 ? `${MODE_LABELS[p.paymentMode]} ${p.amount}` : MODE_LABELS[p.paymentMode])).join(', ');

const TXN_LABELS: Record<TransactionRow['type'], string> = {
  expense: 'Expense',
  supplier_payment: 'Supplier payment',
  customer_due: 'Customer due added',
  customer_due_payment: 'Customer due payment received',
  customer_advance: 'Customer advance received',
  customer_refund: 'Customer advance refunded',
};

export interface ExportResult {
  workbook: ExcelJS.Workbook;
  /** File name without extension (ASCII). */
  name: string;
}

function tooLarge(count: number): AppError {
  return new AppError(
    422,
    'EXPORT_TOO_LARGE',
    `This export has more than ${MAX_EXPORT_ROWS.toLocaleString('en-IN')} rows${count ? ` (${count.toLocaleString('en-IN')})` : ''}. Narrow the period or filters and try again.`,
  );
}

const periodText = (p: Period | { from: string; to: string; label?: string; preset?: string }) =>
  'preset' in p && p.preset === 'all_time' ? 'All recorded transactions' : `${p.from} to ${p.to}`;
const fileDates = (p: { from: string; to: string; preset?: string }) => (p.preset === 'all_time' ? 'all-time' : `${p.from}_${p.to}`);

const EXPENSE_NOTES = [
  'Totals include active expenses only; voided expenses are listed with status "voided" and are not counted.',
  'Supplier payments settle expenses and are never counted as additional expenses.',
  'An expense may have several categories and brands. They are labels only: each expense is listed and counted once, with its full amount.',
];

// --- 1. Expenses --------------------------------------------------------------------------------

export async function exportExpenses(
  db: Queryable,
  shopName: string,
  period: Period,
  f: Omit<ExpenseFilters, 'from' | 'to'> & { status: 'active' | 'voided' | 'all' },
  filterLabels: [string, string][],
): Promise<ExportResult> {
  const list = await listExpenses(db, {
    from: period.from,
    to: period.to,
    categoryId: f.categoryId,
    brandId: f.brandId,
    supplierId: f.supplierId,
    paymentMode: f.paymentMode,
    recordedBy: f.recordedBy,
    status: f.status,
    sort: 'date',
    order: 'asc',
    page: 1,
    pageSize: MAX_EXPORT_ROWS + 1,
  });
  if (list.items.length > MAX_EXPORT_ROWS) throw tooLarge(list.pagination.total);
  const totals = await expenseTotals(db, { ...f, from: period.from, to: period.to });
  const meta: ReportMeta = { shopName, title: 'Expense report', period: periodText(period), filters: filterLabels, notes: EXPENSE_NOTES };
  const wb = newWorkbook(shopName);
  addKeyValueSheet(wb, 'Summary', meta, [
    {
      heading: 'Expenses in the period (active)',
      rows: [
        ['Number of expenses', totals.count, 'int'],
        ['Total expenses', totals.amount],
        ['Average expense', totals.average],
        ['Paid at purchase', totals.paidAtPurchase],
        ['Settled by later supplier payments (to date)', totals.settledByPayments],
        ['Still payable on these expenses (now)', totals.outstanding],
        ['Voided expenses (not counted)', totals.voidedCount, 'int'],
        ['Voided amount (not counted)', totals.voidedAmount],
      ],
    },
  ]);
  type Row = (typeof list.items)[number];
  const columns: Column<Row>[] = [
    { header: 'Date', width: 13, type: 'date', value: (e) => e.expenseDate },
    { header: 'Description', width: 34, type: 'text', value: (e) => e.description },
    { header: 'Supplier', width: 24, type: 'text', value: (e) => e.supplier?.name },
    { header: 'Category', width: 18, type: 'text', value: (e) => e.category.name },
    { header: 'Invoice ref.', width: 14, type: 'text', value: (e) => e.invoiceReference },
    { header: 'Amount', width: 14, type: 'money', value: (e) => e.amount },
    { header: 'Paid at purchase', width: 15, type: 'money', value: (e) => e.amountPaid },
    { header: 'Payment methods', width: 26, type: 'text', value: (e) => paymentMethods(e.payments) },
    { header: 'Settled by payments', width: 16, type: 'money', value: (e) => e.allocatedPayments },
    { header: 'Outstanding', width: 14, type: 'money', value: (e) => e.outstanding },
    { header: 'Status', width: 10, type: 'text', value: (e) => e.status },
    { header: 'Documents', width: 11, type: 'int', value: (e) => e.documentCount },
    { header: 'Recorded by', width: 16, type: 'text', value: (e) => e.createdBy.name },
    // Added at the end so the existing column positions stay unchanged.
    { header: 'All categories', width: 26, type: 'text', value: (e) => e.categories.map((c) => c.name).join(', ') },
    { header: 'Brands', width: 22, type: 'text', value: (e) => e.brands.map((b) => b.name).join(', ') },
  ];
  addTableSheet(wb, 'Expenses', meta, columns, list.items, {
    label: 'Total (active)',
    5: totals.amount,
    6: totals.paidAtPurchase,
    8: totals.settledByPayments,
    9: totals.outstanding,
  });
  return { workbook: wb, name: `expenses_${fileDates(period)}` };
}

// --- 2. Categories ------------------------------------------------------------------------------

export async function exportCategories(
  db: Queryable,
  shopName: string,
  period: Period,
  f: Omit<ExpenseFilters, 'from' | 'to'>,
  filterLabels: [string, string][],
): Promise<ExportResult> {
  const r = await categoryBreakdown(db, { ...f, from: period.from, to: period.to }, period.previous);
  const wb = newWorkbook(shopName);
  const rows = r.rows.filter((c) => c.count > 0 || c.previousCount > 0 || c.taggedCount > 0);
  addTableSheet(
    wb,
    'Categories',
    {
      shopName,
      title: 'Category-wise expenses',
      period: periodText(period),
      filters: [...filterLabels, ...(period.previous ? [['Compared with', `${period.previous.from} to ${period.previous.to}`] as [string, string]] : [])],
      notes: [
        'Active expenses only. Share = category ÷ period total (truncated to one decimal). Archived categories are kept.',
        'An expense with several categories is counted once, under its primary (first) category, so the amounts add up to the expense total. "Tagged" counts every expense that carries the category in any position.',
        ...(f.categoryId
          ? ['A category is selected, so only that category is listed: Amount = expenses where it is the primary category (0 if it is only ever a secondary one); Tagged = expenses carrying it in any position; Share = of all expenses matching the other filters.']
          : []),
      ],
    },
    [
      { header: 'Category', width: 26, type: 'text', value: (c) => c.name },
      { header: 'Archived', width: 10, type: 'text', value: (c) => (c.isActive ? '' : 'Yes') },
      { header: 'Expenses', width: 10, type: 'int', value: (c) => c.count },
      { header: 'Amount', width: 15, type: 'money', value: (c) => c.amount },
      { header: 'Share', width: 9, type: 'percent', value: (c) => c.percent },
      { header: 'Previous period', width: 16, type: 'money', value: (c) => c.previousAmount },
      { header: 'Change', width: 9, type: 'percent', value: (c) => c.changePercent },
      { header: 'Tagged (any position)', width: 12, type: 'int', value: (c) => c.taggedCount },
    ],
    rows,
    { 3: r.total, 5: r.previousTotal },
  );
  return { workbook: wb, name: `categories_${fileDates(period)}` };
}

// --- 3. Supplier outstanding report ----------------------------------------------------------

export async function exportSuppliers(
  db: Queryable,
  shopName: string,
  period: Period,
  q: { supplierId?: string; status: 'active' | 'archived' | 'all'; outstandingOnly: boolean },
  filterLabels: [string, string][],
): Promise<ExportResult> {
  const all = period.preset === 'all_time';
  const r = await supplierReport(db, { ...q, from: all ? null : period.from, to: all ? null : period.to, page: 1, pageSize: MAX_EXPORT_ROWS + 1 });
  if (r.items.length > MAX_EXPORT_ROWS) throw tooLarge(r.pagination.total);
  const wb = newWorkbook(shopName);
  const p = all ? 'All time' : 'Period';
  addTableSheet(
    wb,
    'Suppliers',
    {
      shopName,
      title: 'Supplier outstanding report',
      period: periodText(period),
      filters: filterLabels,
      notes: [
        `"${p}" columns are activity dated in the period. Every other column is a CURRENT balance (as of generation) and is not limited by the period.`,
        'Payable = active expenses − paid at purchase − allocated payments. Supplier payments are not expenses.',
      ],
    },
    [
      { header: 'Supplier', width: 26, type: 'text', value: (s) => s.name },
      { header: 'Archived', width: 9, type: 'text', value: (s) => (s.isActive ? '' : 'Yes') },
      { header: `${p}: expenses`, width: 15, type: 'money', value: (s) => s.periodExpenses },
      { header: `${p}: payments`, width: 15, type: 'money', value: (s) => s.periodPayments },
      { header: 'Total expenses', width: 15, type: 'money', value: (s) => s.totalExpenses },
      { header: 'Paid at purchase', width: 15, type: 'money', value: (s) => s.directPayments },
      { header: 'Allocated payments', width: 15, type: 'money', value: (s) => s.allocatedPayments },
      { header: 'Total settled', width: 15, type: 'money', value: (s) => s.totalSettled },
      { header: 'Total payments', width: 15, type: 'money', value: (s) => s.totalPayments },
      { header: 'Unallocated', width: 14, type: 'money', value: (s) => s.unallocated },
      { header: 'Payable now', width: 15, type: 'money', value: (s) => s.payable },
      { header: 'Unpaid bills', width: 11, type: 'int', value: (s) => s.outstandingBills },
    ],
    r.items,
    {
      2: r.totals.periodExpenses,
      3: r.totals.periodPayments,
      4: r.totals.totalExpenses,
      5: r.totals.directPayments,
      6: r.totals.allocatedPayments,
      7: r.totals.totalSettled,
      8: r.totals.totalPayments,
      9: r.totals.unallocated,
      10: r.totals.payable,
      11: r.totals.outstandingBills,
    },
  );
  return { workbook: wb, name: `suppliers_${fileDates(period)}` };
}

// --- 4. Supplier payments --------------------------------------------------------------------

export async function exportSupplierPayments(
  db: Queryable,
  shopName: string,
  period: Period,
  q: { supplierId?: string; status: 'active' | 'reversed' | 'all'; allocation?: 'unallocated' | 'partial' | 'full' | 'open'; q?: string },
  filterLabels: [string, string][],
): Promise<ExportResult> {
  const all = period.preset === 'all_time';
  const r = await listPayments(db, { ...q, from: all ? undefined : period.from, to: all ? undefined : period.to, page: 1, pageSize: MAX_EXPORT_ROWS + 1 });
  if (r.items.length > MAX_EXPORT_ROWS) throw tooLarge(r.pagination.total);
  const wb = newWorkbook(shopName);
  addTableSheet(
    wb,
    'Supplier payments',
    {
      shopName,
      title: 'Supplier payment report',
      period: periodText(period),
      filters: filterLabels,
      notes: ['Supplier payments settle bills; they are not expenses. Totals count active (not reversed) payments.'],
    },
    [
      { header: 'Date', width: 13, type: 'date', value: (p) => p.paymentDate },
      { header: 'Supplier', width: 26, type: 'text', value: (p) => p.supplier.name },
      { header: 'Mode', width: 13, type: 'text', value: (p) => mode(p.paymentMode) },
      { header: 'Reference', width: 18, type: 'text', value: (p) => p.reference },
      { header: 'Amount', width: 14, type: 'money', value: (p) => p.amount },
      { header: 'Allocated', width: 14, type: 'money', value: (p) => p.allocatedAmount },
      { header: 'Unallocated', width: 14, type: 'money', value: (p) => p.unallocatedAmount },
      { header: 'Status', width: 10, type: 'text', value: (p) => p.status },
      { header: 'Reversal reason', width: 24, type: 'text', value: (p) => p.reversalReason },
      { header: 'Notes', width: 26, type: 'text', value: (p) => p.notes },
      { header: 'Recorded by', width: 16, type: 'text', value: (p) => p.createdBy.name },
    ],
    r.items,
    { label: 'Total (active)', 4: r.totals.amount, 5: r.totals.allocated, 6: r.totals.unallocated },
  );
  return { workbook: wb, name: `supplier-payments_${fileDates(period)}` };
}

// --- 5. Supplier ledger ----------------------------------------------------------------------

export async function exportSupplierLedger(
  db: Queryable,
  shopName: string,
  supplierId: string,
  q: { from?: string; to?: string; type?: 'bill' | 'paid_at_purchase' | 'payment'; status: 'active' | 'cancelled' | 'all' },
): Promise<ExportResult> {
  const l = await getSupplierLedger(db, supplierId, q);
  const wb = newWorkbook(shopName);
  const notes = [
    'Credit (+) = a bill (increases what is owed). Debit (−) = money paid (at purchase or a payment). Balance = net amount owed after each counted entry.',
    'Voided bills and reversed payments are listed but never change a balance. There is no opening balance.',
    ...(l.broughtForward !== null ? [`Balance of entries before ${q.from}: ₹${l.broughtForward}`] : []),
    ...(l.truncated ? ['Only the first 2,000 entries are included; narrow the date range for the rest.'] : []),
  ];
  const meta: ReportMeta = {
    shopName,
    title: `Supplier ledger: ${l.supplier.name}${l.supplier.isActive ? '' : ' (archived)'}`,
    period: q.from || q.to ? `${q.from ?? 'start'} to ${q.to ?? 'today'}` : 'All entries',
    notes,
  };
  addKeyValueSheet(wb, 'Balance', meta, [
    {
      heading: 'Current balance (as of generation)',
      rows: [
        ['Active bills', l.balance.totalBills],
        ['Paid at purchase', l.balance.paidAtPurchase],
        ['Payments', l.balance.totalPayments],
        ['Allocated to bills', l.balance.allocated],
        ['Payable on bills', l.balance.payable],
        ['Unallocated payments', l.balance.unallocated],
        ['Net balance owed (payable − unallocated)', l.balance.netBalance],
      ],
    },
  ]);
  const TYPES = { bill: 'Bill', paid_at_purchase: 'Paid at purchase', payment: 'Payment' } as const;
  addTableSheet(wb, 'Ledger', meta, [
    { header: 'Date', width: 13, type: 'date', value: (e) => e.date },
    { header: 'Type', width: 16, type: 'text', value: (e) => TYPES[e.type] },
    { header: 'Reference', width: 16, type: 'text', value: (e) => e.reference },
    { header: 'Description', width: 32, type: 'text', value: (e) => e.description },
    { header: 'Mode', width: 26, type: 'text', value: (e) => (e.payments && e.payments.length > 1 ? paymentMethods(e.payments) : mode(e.paymentMode)) },
    { header: 'Credit (bill)', width: 14, type: 'money', value: (e) => (e.credit === '0.00' ? null : e.credit) },
    { header: 'Debit (paid)', width: 14, type: 'money', value: (e) => (e.debit === '0.00' ? null : e.debit) },
    { header: 'Balance', width: 14, type: 'money', value: (e) => (e.counted ? e.runningBalance : null) },
    { header: 'Status', width: 10, type: 'text', value: (e) => e.status },
  ], l.entries);
  return { workbook: wb, name: `supplier-ledger_${l.supplier.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}` };
}

// --- 6/7. Customer due and advance reports -------------------------------------------------------

export async function exportCustomerReport(
  db: Queryable,
  shopName: string,
  kind: 'due' | 'advance',
  period: Period,
  q: { q?: string; status: 'active' | 'archived' | 'all'; outstandingOnly: boolean },
  filterLabels: [string, string][],
): Promise<ExportResult> {
  const all = period.preset === 'all_time';
  const r = await customerReport(db, { ...q, kind, from: all ? null : period.from, to: all ? null : period.to, page: 1, pageSize: MAX_EXPORT_ROWS + 1 });
  if (r.items.length > MAX_EXPORT_ROWS) throw tooLarge(r.pagination.total);
  const copy =
    kind === 'due'
      ? { title: 'Customer due report', added: 'Dues recorded', reduced: 'Payments received', balance: 'Outstanding due (now)' }
      : { title: 'Customer advance report', added: 'Advances received', reduced: 'Refunds issued', balance: 'Available advance (now)' };
  const p = all ? 'all time' : 'period';
  const wb = newWorkbook(shopName);
  addTableSheet(
    wb,
    kind === 'due' ? 'Customer dues' : 'Customer advances',
    {
      shopName,
      title: copy.title,
      period: periodText(period),
      filters: filterLabels,
      notes: [
        'Customer dues and customer advances are separate balances and are never netted. They are not sales or income.',
        `"${copy.added}" and "${copy.reduced}" are ${p} activity; the last column is the current balance.`,
      ],
    },
    [
      { header: 'Customer', width: 26, type: 'text', value: (c) => c.name },
      { header: 'Phone', width: 16, type: 'text', value: (c) => c.phone },
      { header: 'Archived', width: 9, type: 'text', value: (c) => (c.isActive ? '' : 'Yes') },
      { header: copy.added, width: 17, type: 'money', value: (c) => c.added },
      { header: copy.reduced, width: 17, type: 'money', value: (c) => c.reduced },
      { header: copy.balance, width: 20, type: 'money', value: (c) => c.balance },
    ],
    r.items,
    { 3: r.totals.added, 4: r.totals.reduced, 5: r.totals.balance },
  );
  return { workbook: wb, name: `customer-${kind === 'due' ? 'dues' : 'advances'}_${fileDates(period)}` };
}

// --- 8. Customer ledger ----------------------------------------------------------------------

export async function exportCustomerLedger(
  db: Queryable,
  shopName: string,
  customerId: string,
  q: { from?: string; to?: string; type?: 'due' | 'due_payment' | 'advance' | 'advance_refund'; status: 'active' | 'reversed' | 'all' },
): Promise<ExportResult> {
  const l = await getCustomerLedger(db, customerId, q);
  const TYPES = { due: 'Due added', due_payment: 'Due payment received', advance: 'Advance received', advance_refund: 'Advance refunded' } as const;
  const meta: ReportMeta = {
    shopName,
    title: `Customer ledger: ${l.customer.name}${l.customer.isActive ? '' : ' (archived)'}`,
    period: q.from || q.to ? `${q.from ?? 'start'} to ${q.to ?? 'today'}` : 'All entries',
    notes: [
      'Due and advance are independent balances; an advance is never subtracted from a due.',
      '+ increases that balance, − reduces it. Reversed entries are listed but do not change any balance.',
      ...(l.broughtForward ? [`Before ${q.from}: due ₹${l.broughtForward.due}, advance ₹${l.broughtForward.advance}`] : []),
      ...(l.truncated ? ['Only the first 2,000 entries are included; narrow the date range for the rest.'] : []),
    ],
  };
  const wb = newWorkbook(shopName);
  addKeyValueSheet(wb, 'Balances', meta, [
    { heading: 'Current balances (separate, never netted)', rows: [['Customer due', l.balances.due], ['Customer advance', l.balances.advance]] },
  ]);
  const signed = (v: string | null) => (v === null ? null : v.startsWith('-') ? `-${v.slice(1)}` : v.slice(1));
  addTableSheet(wb, 'Ledger', meta, [
    { header: 'Date', width: 13, type: 'date', value: (e) => e.txnDate },
    { header: 'Entry', width: 22, type: 'text', value: (e) => TYPES[e.type] },
    { header: 'Reference', width: 16, type: 'text', value: (e) => e.reference },
    // Dues: their own category; due payments: the category of the due they settle.
    { header: 'Category', width: 18, type: 'text', value: (e) => e.category?.name ?? e.due?.categoryName ?? null },
    { header: 'Description', width: 30, type: 'text', value: (e) => e.description ?? (e.settlementId ? 'Full outstanding payment' : null) },
    { header: 'Mode', width: 13, type: 'text', value: (e) => mode(e.paymentMode) },
    { header: 'Due ±', width: 13, type: 'money', value: (e) => signed(e.dueEffect) },
    { header: 'Advance ±', width: 13, type: 'money', value: (e) => signed(e.advanceEffect) },
    { header: 'Due balance', width: 14, type: 'money', value: (e) => e.runningDue },
    { header: 'Advance balance', width: 15, type: 'money', value: (e) => e.runningAdvance },
    { header: 'Status', width: 10, type: 'text', value: (e) => e.status },
    { header: 'Recorded by', width: 16, type: 'text', value: (e) => e.createdBy.name },
  ], l.entries);
  return { workbook: wb, name: `customer-ledger_${l.customer.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}` };
}

// --- 9. Transaction history --------------------------------------------------------------------

const TRANSACTION_COLUMNS: Column<TransactionRow>[] = [
  { header: 'Date', width: 13, type: 'date', value: (t) => t.date },
  { header: 'Type', width: 28, type: 'text', value: (t) => TXN_LABELS[t.type] },
  { header: 'Supplier / customer', width: 24, type: 'text', value: (t) => t.entity },
  { header: 'Description', width: 30, type: 'text', value: (t) => t.description },
  { header: 'Reference', width: 16, type: 'text', value: (t) => t.reference },
  { header: 'Amount', width: 14, type: 'money', value: (t) => t.amount },
  { header: 'Status', width: 10, type: 'text', value: (t) => t.status },
  { header: 'Recorded by', width: 16, type: 'text', value: (t) => t.recordedBy },
];

export async function exportTransactions(
  db: Queryable,
  shopName: string,
  period: Period,
  q: TransactionQuery,
  filterLabels: [string, string][],
): Promise<ExportResult> {
  const r = await allTransactions(db, { ...q, from: period.from, to: period.to }, MAX_EXPORT_ROWS);
  if (r.truncated) throw tooLarge(0);
  const wb = newWorkbook(shopName);
  addTableSheet(
    wb,
    'Transactions',
    {
      shopName,
      title: 'Financial transaction history',
      period: periodText(period),
      filters: filterLabels,
      notes: ['Each row is shown as what it is: supplier payments are not expenses, and customer entries are not income.'],
    },
    TRANSACTION_COLUMNS,
    r.rows,
  );
  return { workbook: wb, name: `transactions_${fileDates(period)}` };
}

// --- 10. Monthly financial summary -------------------------------------------------------------

/** Builds the monthly workbook from an already computed summary (shared with the e-mail). */
export async function buildMonthlyWorkbook(db: Queryable, shopName: string, s: MonthlySummary): Promise<ExcelJS.Workbook> {
  const period = { from: s.from, to: s.to };
  const meta: ReportMeta = {
    shopName,
    title: `Monthly financial summary: ${s.label}`,
    period: `${s.from} to ${s.to}`,
    notes: [
      'Figures are recorded transactions. "Now" figures are current balances at generation time.',
      'Supplier payments are not expenses. Customer dues and advances are separate and never netted.',
    ],
  };
  const [suppliers, dues, advances, txns] = await Promise.all([
    supplierReport(db, { from: s.from, to: s.to, status: 'all', outstandingOnly: false, page: 1, pageSize: MAX_EXPORT_ROWS }),
    customerReport(db, { kind: 'due', from: s.from, to: s.to, status: 'all', outstandingOnly: false, page: 1, pageSize: MAX_EXPORT_ROWS }),
    customerReport(db, { kind: 'advance', from: s.from, to: s.to, status: 'all', outstandingOnly: false, page: 1, pageSize: MAX_EXPORT_ROWS }),
    allTransactions(db, { ...period, status: 'all' }, MAX_EXPORT_ROWS),
  ]);
  const wb = newWorkbook(shopName);
  addKeyValueSheet(wb, 'Expense Summary', meta, [
    {
      heading: `Expenses in ${s.label}`,
      rows: [
        ['Number of expenses', s.expenses.count, 'int'],
        ['Total expenses', s.expenses.amount],
        ['Paid at purchase', s.expenses.paidAtPurchase],
        ['Settled by later supplier payments', s.expenses.settledByPayments],
        ['Still payable on these expenses (now)', s.expenses.outstanding],
        ['Previous month total', s.expenses.previous.amount],
        ['Change vs previous month', s.expenses.changePercent === null ? 'n/a' : `${s.expenses.changePercent}%`, 'text'],
      ],
    },
    {
      heading: 'Suppliers',
      rows: [
        [`Supplier expenses in ${s.label}`, s.supplierActivity.supplierExpenses],
        [`Supplier payments in ${s.label} (not expenses)`, s.supplierActivity.payments],
        ['Supplier payable (now)', s.suppliers.totalPayable],
        ['Suppliers with payable (now)', s.suppliers.suppliersWithPayable, 'int'],
        ['Unallocated supplier payments (now)', s.suppliers.totalUnallocated],
      ],
    },
    {
      heading: 'Customer dues',
      rows: [
        [`Dues recorded in ${s.label}`, s.customerActivity.duesRecorded],
        [`Payments received against dues in ${s.label}`, s.customerActivity.duePaymentsReceived],
        ['Outstanding customer dues (now)', s.customers.totalDue],
      ],
    },
    {
      heading: 'Customer advances',
      rows: [
        [`Advances received in ${s.label}`, s.customerActivity.advancesReceived],
        [`Refunds issued in ${s.label}`, s.customerActivity.refundsIssued],
        ['Available customer advances (now)', s.customers.totalAdvance],
      ],
    },
    ...(s.notes.length ? [{ heading: 'Notes', rows: s.notes.map((n) => [n, '', 'text'] as [string, string, 'text']) }] : []),
  ]);
  addTableSheet(wb, 'Category Breakdown', meta, [
    { header: 'Category', width: 26, type: 'text', value: (c) => c.name },
    { header: 'Expenses', width: 10, type: 'int', value: (c) => c.count },
    { header: 'Amount', width: 15, type: 'money', value: (c) => c.amount },
    { header: 'Share', width: 9, type: 'percent', value: (c) => c.percent },
    { header: 'Previous month', width: 16, type: 'money', value: (c) => c.previousAmount },
    { header: 'Change', width: 9, type: 'percent', value: (c) => c.changePercent },
  ], s.categories, { 2: s.expenses.amount, 4: s.expenses.previous.amount });
  addTableSheet(wb, 'Payment Modes', meta, [
    { header: 'Mode at purchase', width: 26, type: 'text', value: (m) => (m.paymentMode ? MODE_LABELS[m.paymentMode] : 'Not paid at purchase') },
    { header: 'Expenses', width: 10, type: 'int', value: (m) => m.count },
    { header: 'Amount', width: 15, type: 'money', value: (m) => m.amount },
    { header: 'Paid at purchase', width: 16, type: 'money', value: (m) => m.paidAtPurchase },
  ], s.paymentModes);
  addTableSheet(wb, 'Supplier Summary', meta, [
    { header: 'Supplier', width: 26, type: 'text', value: (r) => r.name },
    { header: 'Expenses in month', width: 16, type: 'money', value: (r) => r.periodExpenses },
    { header: 'Payments in month', width: 16, type: 'money', value: (r) => r.periodPayments },
    { header: 'Unallocated (now)', width: 16, type: 'money', value: (r) => r.unallocated },
    { header: 'Payable (now)', width: 15, type: 'money', value: (r) => r.payable },
  ], suppliers.items, { 1: suppliers.totals.periodExpenses, 2: suppliers.totals.periodPayments, 3: suppliers.totals.unallocated, 4: suppliers.totals.payable });
  addTableSheet(wb, 'Customer Due Summary', meta, [
    { header: 'Customer', width: 26, type: 'text', value: (r) => r.name },
    { header: 'Dues recorded in month', width: 20, type: 'money', value: (r) => r.added },
    { header: 'Payments received in month', width: 22, type: 'money', value: (r) => r.reduced },
    { header: 'Outstanding due (now)', width: 20, type: 'money', value: (r) => r.balance },
  ], dues.items, { 1: dues.totals.added, 2: dues.totals.reduced, 3: dues.totals.balance });
  addTableSheet(wb, 'Customer Advance Summary', meta, [
    { header: 'Customer', width: 26, type: 'text', value: (r) => r.name },
    { header: 'Advances received in month', width: 22, type: 'money', value: (r) => r.added },
    { header: 'Refunds issued in month', width: 20, type: 'money', value: (r) => r.reduced },
    { header: 'Available advance (now)', width: 20, type: 'money', value: (r) => r.balance },
  ], advances.items, { 1: advances.totals.added, 2: advances.totals.reduced, 3: advances.totals.balance });
  addTableSheet(wb, 'Transaction Activity', meta, TRANSACTION_COLUMNS, txns.rows);
  return wb;
}

export async function exportMonthly(db: Queryable, shopName: string, year: number, month: number, label: string): Promise<ExportResult> {
  const summary = await monthlySummary(db, year, month, label);
  return {
    workbook: await buildMonthlyWorkbook(db, shopName, summary),
    name: `monthly-summary_${year}-${String(month).padStart(2, '0')}`,
  };
}
