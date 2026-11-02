import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { ExportButton } from '@/features/exports/ExportButton';
import { BarList } from '@/features/reports/charts';
import { ChangeNote, FigureRow, GeneratedNote, SectionHeading } from '@/features/reports/ReportBits';
import { ReportTabs } from '@/features/reports/ReportTabs';
import type { CategoryRow, CustomerActivity, ExpenseTotals } from '@/features/reports/reports-api';
import { apiRequest } from '@/lib/api-client';
import { todayInKolkata } from '@/lib/dates';
import type { PaymentMode } from '@/types/api';

export interface MonthlySummary {
  year: number;
  month: number;
  label: string;
  from: string;
  to: string;
  generatedAt: string;
  expenses: ExpenseTotals & { previous: ExpenseTotals; changePercent: string | null };
  categories: CategoryRow[];
  paymentModes: { paymentMode: PaymentMode | null; count: number; amount: string; paidAtPurchase: string }[];
  supplierActivity: { supplierExpenses: string; supplierExpenseCount: number; payments: string; paymentCount: number };
  suppliers: { totalPayable: string; suppliersWithPayable: number; totalUnallocated: string; topPayable: { name: string; payable: string }[] };
  customerActivity: CustomerActivity;
  customers: { totalDue: string; customersWithDue: number; totalAdvance: string; customersWithAdvance: number };
  notes: string[];
}

function previousMonth(): string {
  const [y, m] = todayInKolkata().split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** One month at a glance: the same summary the monthly e-mail sends. */
export function MonthlySummaryPage() {
  const [params, setParams] = useSearchParams();
  const ym = params.get('month') ?? previousMonth();
  const [year, month] = ym.split('-').map(Number) as [number, number];
  const summary = useQuery({
    queryKey: ['reports', 'monthly', ym],
    queryFn: ({ signal }) => apiRequest<{ summary: MonthlySummary }>(`/reports/monthly?year=${year}&month=${month}`, { signal }).then((r) => r.summary),
    staleTime: 30_000,
  });
  const s = summary.data;

  return (
    <Page>
      <PageHeader title="Monthly summary" actions={<ExportButton report="monthly" params={{ year, month }} />} />
      <ReportTabs />
      <div className="flex items-center gap-2">
        <label htmlFor="summary-month" className="text-sm font-medium">
          Month
        </label>
        <Input
          id="summary-month"
          type="month"
          className="w-48"
          max={todayInKolkata().slice(0, 7)}
          value={ym}
          onChange={(e) => e.target.value && setParams({ month: e.target.value }, { replace: true })}
        />
      </div>
      {summary.isPending && <LoadingState label="Calculating…" />}
      {summary.isError && <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />}
      {s && (
        <div className="space-y-6">
          <section className="space-y-3">
            <SectionHeading title={`Expenses: ${s.label}`} kind="period" />
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatTile label="Total expenses" amount={s.expenses.amount} hint={`${s.expenses.count} expense(s)`} />
              <StatTile label="Paid at purchase" amount={s.expenses.paidAtPurchase} />
              <StatTile label="Settled by later payments" amount={s.expenses.settledByPayments} />
              <StatTile label="Still payable on them" amount={s.expenses.outstanding} tone="warning" />
            </div>
            <ChangeNote change={s.expenses.changePercent} previous={s.expenses.previous.amount} />
            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>By category</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    items={s.categories
                      .filter((c) => c.count > 0)
                      .map((c) => ({ key: c.categoryId, label: c.name, detail: `${c.count} expense(s)`, amount: c.amount, note: c.percent ? `${c.percent}%` : undefined }))}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>By payment mode at purchase</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    items={s.paymentModes.map((m) => ({
                      key: m.paymentMode ?? 'none',
                      label: m.paymentMode ? PAYMENT_MODE_LABELS[m.paymentMode] : 'Not paid at purchase',
                      detail: `${m.count} expense(s)`,
                      amount: m.amount,
                    }))}
                  />
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Suppliers</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                <FigureRow label={`Supplier expenses in ${s.label}`} amount={s.supplierActivity.supplierExpenses} />
                <FigureRow label={`Supplier payments in ${s.label}`} amount={s.supplierActivity.payments} hint="Settle expenses; not extra expenses" />
                <FigureRow label="Payable now (current balance)" amount={s.suppliers.totalPayable} tone="warning" hint={`${s.suppliers.suppliersWithPayable} supplier(s) owed`} />
                <FigureRow label="Unallocated payments now" amount={s.suppliers.totalUnallocated} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Customers</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="divide-y">
                  <p className="pb-1 text-xs font-medium text-warning">Dues</p>
                  <FigureRow label={`Recorded in ${s.label}`} amount={s.customerActivity.duesRecorded} />
                  <FigureRow label="Payments received" amount={s.customerActivity.duePaymentsReceived} />
                  <FigureRow label="Outstanding now" amount={s.customers.totalDue} tone="warning" />
                </div>
                <div className="divide-y">
                  <p className="pb-1 text-xs font-medium text-primary">Advances</p>
                  <FigureRow label={`Received in ${s.label}`} amount={s.customerActivity.advancesReceived} />
                  <FigureRow label="Refunds issued" amount={s.customerActivity.refundsIssued} />
                  <FigureRow label="Available now" amount={s.customers.totalAdvance} tone="accent" />
                </div>
              </CardContent>
            </Card>
          </section>

          {s.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {s.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <GeneratedNote at={s.generatedAt} />
        </div>
      )}
    </Page>
  );
}
