import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { PaymentMode } from '@/types/api';

/** Period resolved by the server: explicit inclusive dates in Asia/Kolkata. */
export interface ReportPeriod {
  preset: string;
  from: string;
  to: string;
  previous: { from: string; to: string } | null;
  label: string;
}

export interface ExpenseTotals {
  count: number;
  amount: string;
  paidAtPurchase: string;
  settledByPayments: string;
  outstanding: string;
  average: string;
  voidedCount: number;
  voidedAmount: string;
}

export type TransactionType =
  | 'expense'
  | 'supplier_payment'
  | 'customer_due'
  | 'customer_due_payment'
  | 'customer_advance'
  | 'customer_refund';

export interface TransactionRow {
  type: TransactionType;
  id: string;
  date: string;
  createdAt: string;
  reference: string | null;
  entity: string | null;
  entityId: string | null;
  description: string | null;
  amount: string;
  status: 'active' | 'voided' | 'reversed';
  recordedBy: string;
}

export interface TrendPoint {
  month: string;
  amount: string;
  count: number;
}

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

export interface Dashboard {
  period: ReportPeriod;
  generatedAt: string;
  expenses: ExpenseTotals & { previous: { count: number; amount: string } | null; changePercent: string | null };
  supplierPaymentsInPeriod: { count: number; amount: string };
  customerActivity: CustomerActivity;
  suppliers: { totalPayable: string; suppliersWithPayable: number; totalUnallocated: string };
  customers: { totalDue: string; customersWithDue: number; totalAdvance: string; customersWithAdvance: number };
  trend: TrendPoint[];
  recentActivity: TransactionRow[];
}

export interface CategoryRow {
  categoryId: string;
  name: string;
  isActive: boolean;
  amount: string;
  count: number;
  percent: string | null;
  previousAmount: string;
  previousCount: number;
  changePercent: string | null;
  /** Expenses carrying the category in any position (amount stays with the primary category). */
  taggedCount: number;
}

export interface ExpenseReport {
  period: ReportPeriod;
  totals: ExpenseTotals;
  previous: ExpenseTotals | null;
  changePercent: string | null;
  paidStatus: { status: 'paid' | 'partly_paid' | 'unpaid'; count: number; amount: string; outstanding: string }[];
  paymentModes: { paymentMode: PaymentMode | null; count: number; amount: string; paidAtPurchase: string }[];
  topSuppliers: { supplierId: string | null; name: string; isActive: boolean; amount: string; count: number; outstanding: string }[];
  trend: TrendPoint[];
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SupplierReportRow {
  supplierId: string;
  name: string;
  isActive: boolean;
  periodExpenses: string;
  periodExpenseCount: number;
  periodPaidAtPurchase: string;
  periodPayments: string;
  totalExpenses: string;
  directPayments: string;
  allocatedPayments: string;
  totalSettled: string;
  totalPayments: string;
  unallocated: string;
  payable: string;
  outstandingBills: number;
}

export interface SupplierReport {
  period: ReportPeriod;
  items: SupplierReportRow[];
  totals: Omit<SupplierReportRow, 'supplierId' | 'name' | 'isActive' | 'periodExpenseCount'> & { suppliers: number };
  pagination: Pagination;
}

export interface CustomerReport {
  period: ReportPeriod;
  kind: 'due' | 'advance';
  items: { customerId: string; name: string; phone: string | null; isActive: boolean; added: string; reduced: string; balance: string }[];
  totals: { customers: number; added: string; reduced: string; balance: string };
  pagination: Pagination;
}

export interface TransactionsReport {
  period: ReportPeriod;
  items: TransactionRow[];
  pagination: Pagination;
  totals: { type: TransactionType; count: number; amount: string }[];
}

export type QueryParams = Record<string, string | number | undefined>;

export const toQuery = (params: QueryParams) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

/**
 * Report data is read-only and recomputed by the server on every request; a short stale time
 * avoids refetch storms while switching tabs, and mutations elsewhere invalidate ['reports'].
 */
function useReport<T>(path: string, params: QueryParams, pick: (r: never) => T = (r) => r as T) {
  const search = toQuery(params);
  return useQuery({
    queryKey: ['reports', path, search],
    queryFn: async ({ signal }) => {
      const data = pick(await apiRequest<never>(`/reports/${path}?${search}`, { signal }));
      if (data === undefined || data === null) throw new Error('Unexpected response from the server');
      return data;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export const useDashboard = (params: QueryParams) =>
  useReport<Dashboard>('dashboard', params, (r: { dashboard: Dashboard }) => r.dashboard);
export const useExpenseReport = (params: QueryParams) => useReport<ExpenseReport>('expenses', params);
export const useCategoryReport = (params: QueryParams) =>
  useReport<{ period: ReportPeriod; rows: CategoryRow[]; total: string; previousTotal: string }>('categories', params);
export const useSupplierReport = (params: QueryParams) => useReport<SupplierReport>('suppliers', params);
export const useCustomerReport = (kind: 'due' | 'advance', params: QueryParams) =>
  useReport<CustomerReport>(kind === 'due' ? 'customers/dues' : 'customers/advances', params);
export const useTransactionsReport = (params: QueryParams) => useReport<TransactionsReport>('transactions', params);

export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  expense: 'Expense',
  supplier_payment: 'Supplier payment',
  customer_due: 'Customer due added',
  customer_due_payment: 'Customer due payment',
  customer_advance: 'Customer advance received',
  customer_refund: 'Customer advance refunded',
};

/** Where a transaction row leads. */
export function transactionLink(t: TransactionRow): string {
  if (t.type === 'expense') return `/expenses/${t.id}`;
  if (t.type === 'supplier_payment') return `/supplier-payments/${t.id}`;
  return `/customers/${t.entityId}/transactions/${t.id}`;
}
