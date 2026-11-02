import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { useCategories } from '@/features/categories/categories-api';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES, useExpenseList, useRecorders } from '@/features/expenses/expenses-api';
import { ExportButton } from '@/features/exports/ExportButton';
import { BarList, TrendChart } from '@/features/reports/charts';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { ChangeNote, GeneratedNote } from '@/features/reports/ReportBits';
import { FilterBar, Pager, ReportTabs } from '@/features/reports/ReportTabs';
import { useExpenseReport } from '@/features/reports/reports-api';
import { useSuppliers } from '@/features/suppliers/suppliers-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn, expenseLabel } from '@/lib/utils';
import type { PaymentMode } from '@/types/api';

const PAID_LABELS = { paid: 'Fully paid', partly_paid: 'Partly paid', unpaid: 'Not paid yet' } as const;

export function ExpenseReportPage() {
  const period = usePeriodParams('this_month');
  const p = period.params;
  const filters = {
    categoryId: p.get('categoryId') ?? undefined,
    supplierId: p.get('supplierId') ?? undefined,
    paymentMode: p.get('paymentMode') ?? undefined,
    recordedBy: p.get('recordedBy') ?? undefined,
  };
  const report = useExpenseReport({ ...(period.query ?? { period: 'this_month' }), ...filters });
  const categories = useCategories('all');
  const suppliers = useSuppliers({ status: 'all', pageSize: 100 });
  const recorders = useRecorders();
  const page = Math.max(1, Number(p.get('page')) || 1);
  const r = report.data;
  // Detailed rows: the existing paginated expense list with the SAME resolved dates and filters.
  const detail = useExpenseList(
    Object.fromEntries(
      Object.entries({
        from: r?.period.from ?? '',
        to: r?.period.to ?? '',
        status: 'all',
        page: String(page),
        pageSize: '20',
        ...filters,
      }).filter(([, v]) => v),
    ) as Record<string, string>,
  );

  return (
    <Page>
      <PageHeader
        title="Expense report"
        actions={<ExportButton report="expenses" params={{ ...(period.query ?? {}), ...filters }} disabled={!period.query} />}
      />
      <ReportTabs />
      <PeriodSelector state={period} resolved={r?.period} />
      <FilterBar>
        <Select aria-label="Category" value={filters.categoryId ?? ''} onChange={(e) => period.set({ categoryId: e.target.value })}>
          <option value="">All categories</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isActive ? '' : ' (archived)'}
            </option>
          ))}
        </Select>
        <Select aria-label="Supplier" value={filters.supplierId ?? ''} onChange={(e) => period.set({ supplierId: e.target.value })}>
          <option value="">All suppliers</option>
          {suppliers.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isActive ? '' : ' (archived)'}
            </option>
          ))}
        </Select>
        <Select aria-label="Payment mode" value={filters.paymentMode ?? ''} onChange={(e) => period.set({ paymentMode: e.target.value })}>
          <option value="">Any payment mode</option>
          {PAYMENT_MODES.map((m) => (
            <option key={m} value={m}>
              Paid by {PAYMENT_MODE_LABELS[m]}
            </option>
          ))}
          <option value="none">Nothing paid at purchase</option>
        </Select>
        <Select aria-label="Recorded by" value={filters.recordedBy ?? ''} onChange={(e) => period.set({ recordedBy: e.target.value })}>
          <option value="">Recorded by anyone</option>
          {recorders.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </FilterBar>

      {report.isPending && <LoadingState label="Calculating…" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Total expenses" amount={r.totals.amount} hint={`${r.totals.count} expense(s)`} />
            <StatTile label="Average expense" amount={r.totals.average} />
            <StatTile label="Paid at purchase" amount={r.totals.paidAtPurchase} />
            <StatTile label="Settled by later payments" amount={r.totals.settledByPayments} />
            <StatTile label="Still payable" amount={r.totals.outstanding} tone={r.totals.outstanding !== '0.00' ? 'warning' : 'muted'} hint="On these expenses, now" />
            <StatTile label="Voided (not counted)" amount={r.totals.voidedAmount} tone="muted" hint={`${r.totals.voidedCount} expense(s)`} />
          </div>
          <ChangeNote change={r.changePercent} previous={r.previous?.amount ?? null} />

          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Expenses by month</CardTitle>
              </CardHeader>
              <CardContent>
                <TrendChart points={r.trend} highlightFrom={r.period.from} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Paid vs unpaid</CardTitle>
                <p className="text-xs text-muted-foreground">By what is still payable on each expense now</p>
              </CardHeader>
              <CardContent>
                <BarList
                  items={r.paidStatus.map((s) => ({
                    key: s.status,
                    label: PAID_LABELS[s.status],
                    detail: `${s.count} expense(s)${s.outstanding !== '0.00' ? ` · ${formatInr(s.outstanding)} still payable` : ''}`,
                    amount: s.amount,
                  }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Payment mode at purchase</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={r.paymentModes.map((m) => ({
                    key: m.paymentMode ?? 'none',
                    label: m.paymentMode ? PAYMENT_MODE_LABELS[m.paymentMode as PaymentMode] : 'Not paid at purchase',
                    // The unpaid row holds remainders (paid amount is always zero); an expense paid by several methods counts in each method's row.
                    detail: m.paymentMode ? `${m.count} expense(s) · ${formatInr(m.paidAtPurchase)} paid` : `${m.count} expense(s) with an unpaid part`,
                    amount: m.amount,
                  }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Top suppliers</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={r.topSuppliers.map((s) => ({
                    key: s.supplierId ?? 'none',
                    label: s.name,
                    detail: `${s.count} expense(s)${s.isActive ? '' : ' · archived'}`,
                    amount: s.amount,
                    href: s.supplierId ? `/suppliers/${s.supplierId}` : undefined,
                  }))}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
              <CardTitle>Expenses in this period</CardTitle>
              <span className="text-xs text-muted-foreground">{detail.data?.pagination.total ?? 0} including voided</span>
            </CardHeader>
            <CardContent className="space-y-3">
              {detail.isPending && <LoadingState />}
              <ul className="divide-y">
                {detail.data?.items.map((e) => (
                  <li key={e.id}>
                    <Link to={`/expenses/${e.id}`} className="flex items-start justify-between gap-3 py-2.5 hover:bg-accent/40">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{expenseLabel(e)}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatDate(e.expenseDate)} · {e.category.name}
                          {e.supplier && ` · ${e.supplier.name}`} · {e.createdBy.name}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className={cn('figure text-sm font-semibold', e.status === 'voided' && 'text-muted-foreground line-through')}>
                          {formatInr(e.amount)}
                        </span>
                        {e.status === 'voided' ? (
                          <StatusBadge status="voided" />
                        ) : (
                          e.outstanding !== '0.00' && <span className="figure text-xs text-warning">{formatInr(e.outstanding)} payable</span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {detail.data && <Pager page={page} totalPages={detail.data.pagination.totalPages} onPage={(n) => period.set({ page: String(n) })} />}
            </CardContent>
          </Card>
          <GeneratedNote />
        </div>
      )}
    </Page>
  );
}

