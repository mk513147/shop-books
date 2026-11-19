import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { PaymentStatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader, PageSection } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { useBrands } from '@/features/brands/brands-api';
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
    brandId: p.get('brandId') ?? undefined,
    supplierId: p.get('supplierId') ?? undefined,
    paymentMode: p.get('paymentMode') ?? undefined,
    recordedBy: p.get('recordedBy') ?? undefined,
  };
  const report = useExpenseReport({ ...(period.query ?? { period: 'this_month' }), ...filters });
  const categories = useCategories('all');
  const brands = useBrands('all');
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
        <Select aria-label="Brand" value={filters.brandId ?? ''} onChange={(e) => period.set({ brandId: e.target.value })}>
          <option value="">All brands</option>
          {brands.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.isActive ? '' : ' (archived)'}
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

      {report.isPending && <LoadingState label="Calculating…" skeleton="cards" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-3">
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

          <PageSection title="Expenses in this period" actions={<span className="figure text-xs text-muted-foreground">{detail.data?.pagination.total ?? 0} including voided</span>}>
            {detail.isPending && <LoadingState skeleton="table" />}
            {detail.data && detail.data.items.length === 0 && <p className="text-sm text-muted-foreground">No expenses in this period.</p>}
            {detail.data && detail.data.items.length > 0 && (
              <>
                <ul className="space-y-2 md:hidden">
                  {detail.data.items.map((e) => (
                    <li key={e.id}>
                      <Link to={`/expenses/${e.id}`} className="list-card">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className={cn('truncate font-semibold', e.status === 'voided' && 'text-muted-foreground')}>{expenseLabel(e)}</p>
                            <p className="truncate text-sm text-muted-foreground">
                              {e.category.name}
                              {e.supplier && ` · ${e.supplier.name}`}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={cn('figure font-semibold', e.status === 'voided' && 'text-muted-foreground line-through')}>{formatInr(e.amount)}</p>
                            {e.status !== 'voided' && e.outstanding !== '0.00' && (
                              <p className="figure text-xs font-medium text-warning">{formatInr(e.outstanding)} payable</p>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="truncate">
                            {formatDate(e.expenseDate)} · {e.createdBy.name}
                          </span>
                          <PaymentStatusBadge amount={e.amount} outstanding={e.outstanding} voided={e.status === 'voided'} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="table-shell hidden md:block">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="px-4 py-3">Date</th>
                        <th className="px-3 py-3">Expense</th>
                        <th className="px-3 py-3">Category</th>
                        <th className="px-3 py-3">Supplier</th>
                        <th className="px-3 py-3">Recorded by</th>
                        <th className="px-3 py-3 text-right">Amount</th>
                        <th className="px-3 py-3 text-right">Payable</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.items.map((e) => (
                        <tr key={e.id} className={cn(e.status === 'voided' && 'text-muted-foreground')}>
                          <td className="figure whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(e.expenseDate)}</td>
                          <td className="max-w-64 px-3 py-3">
                            <Link to={`/expenses/${e.id}`} className="line-clamp-2 font-medium hover:underline">
                              {expenseLabel(e)}
                            </Link>
                          </td>
                          <td className="px-3 py-3">{e.category.name}</td>
                          <td className="px-3 py-3">{e.supplier?.name ?? '—'}</td>
                          <td className="px-3 py-3 text-muted-foreground">{e.createdBy.name}</td>
                          <td className={cn('figure whitespace-nowrap px-3 py-3 text-right font-semibold', e.status === 'voided' && 'font-medium line-through')}>
                            {formatInr(e.amount)}
                          </td>
                          <td className={cn('figure whitespace-nowrap px-3 py-3 text-right', e.status !== 'voided' && e.outstanding !== '0.00' ? 'font-medium text-warning' : 'text-muted-foreground')}>
                            {e.status === 'voided' || e.outstanding === '0.00' ? '—' : formatInr(e.outstanding)}
                          </td>
                          <td className="px-4 py-3">
                            <PaymentStatusBadge amount={e.amount} outstanding={e.outstanding} voided={e.status === 'voided'} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {detail.data && <Pager page={page} totalPages={detail.data.pagination.totalPages} onPage={(n) => period.set({ page: String(n) })} />}
          </PageSection>
          <GeneratedNote />
        </div>
      )}
    </Page>
  );
}

