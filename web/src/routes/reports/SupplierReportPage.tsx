import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { ExportButton } from '@/features/exports/ExportButton';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { GeneratedNote, SectionHeading } from '@/features/reports/ReportBits';
import { FilterBar, Pager, ReportTabs } from '@/features/reports/ReportTabs';
import { useSupplierReport } from '@/features/reports/reports-api';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Supplier report. Columns are split into PERIOD activity (expenses and payments dated in the
 * period) and CURRENT balances (payable, unallocated) — the period never filters a balance.
 */
export function SupplierReportPage() {
  const period = usePeriodParams('all_time');
  const p = period.params;
  const status = p.get('status') ?? 'all';
  const outstandingOnly = p.get('outstandingOnly') === 'true';
  const page = Math.max(1, Number(p.get('page')) || 1);
  const params = { ...(period.query ?? { period: 'all_time' }), status, outstandingOnly: outstandingOnly ? 'true' : undefined };
  const report = useSupplierReport({ ...params, page, pageSize: 25 });
  const r = report.data;
  const periodLabel = r?.period.preset === 'all_time' ? 'All time' : 'In period';

  return (
    <Page>
      <PageHeader title="Supplier report" actions={<ExportButton report="suppliers" params={params} disabled={!period.query} />} />
      <ReportTabs />
      <PeriodSelector state={period} resolved={r?.period} />
      <FilterBar>
        <Select aria-label="Supplier status" value={status} onChange={(e) => period.set({ status: e.target.value === 'all' ? '' : e.target.value })}>
          <option value="all">Active and archived</option>
          <option value="active">Active suppliers</option>
          <option value="archived">Archived suppliers</option>
        </Select>
        <label className="flex h-11 items-center gap-2 rounded-lg border bg-card px-3 text-sm md:h-10">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={outstandingOnly} onChange={(e) => period.set({ outstandingOnly: e.target.checked ? 'true' : '' })} />
          Only suppliers still owed money
        </label>
      </FilterBar>

      {report.isPending && <LoadingState label="Calculating…" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
          <div className="space-y-3">
            <SectionHeading title="Current balances" kind="current" />
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatTile label="Payable now" amount={r.totals.payable} tone={r.totals.payable !== '0.00' ? 'warning' : 'muted'} hint={`${r.totals.suppliers} supplier(s) listed`} />
              <StatTile label="Unallocated payments" amount={r.totals.unallocated} />
              <StatTile label="Paid at purchase" amount={r.totals.directPayments} hint="All active bills" />
              <StatTile label="Later payments allocated" amount={r.totals.allocatedPayments} hint="All active bills" />
            </div>
          </div>
          <div className="space-y-3">
            <SectionHeading title={r.period.preset === 'all_time' ? 'All recorded activity' : `Activity: ${r.period.label}`} kind="period" />
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatTile label="Supplier expenses" amount={r.totals.periodExpenses} />
              <StatTile label="Supplier payments" amount={r.totals.periodPayments} hint="Not counted as expenses" />
            </div>
          </div>

          {r.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No suppliers match.</p>
          ) : (
            <>
              <ul className="space-y-2 md:hidden">
                {r.items.map((s) => (
                  <li key={s.supplierId} className="space-y-2 rounded-xl border bg-card p-4 shadow-card">
                    <div className="flex items-start justify-between gap-2">
                      <Link to={`/suppliers/${s.supplierId}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      {!s.isActive && <Badge>Archived</Badge>}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Payable now</dt>
                      <dd className={cn('figure text-right font-semibold', s.payable !== '0.00' && 'text-warning')}>{formatInr(s.payable)}</dd>
                      <dt className="text-muted-foreground">Unallocated</dt>
                      <dd className="figure text-right">{formatInr(s.unallocated)}</dd>
                      <dt className="text-muted-foreground">Unpaid bills</dt>
                      <dd className="figure text-right">{s.outstandingBills}</dd>
                      <dt className="text-muted-foreground">{periodLabel}: expenses</dt>
                      <dd className="figure text-right">{formatInr(s.periodExpenses)}</dd>
                      <dt className="text-muted-foreground">{periodLabel}: payments</dt>
                      <dd className="figure text-right">{formatInr(s.periodPayments)}</dd>
                    </dl>
                    <Link to={`/suppliers/${s.supplierId}/ledger`} className="text-sm text-primary hover:underline">
                      Open ledger
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
                <table className="w-full text-sm">
                  <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 font-medium" rowSpan={2}>
                        Supplier
                      </th>
                      <th className="border-l px-3 pt-2 text-center font-medium" colSpan={2}>
                        {periodLabel}
                      </th>
                      <th className="border-l px-3 pt-2 text-center font-medium" colSpan={6}>
                        Current (all active bills and payments)
                      </th>
                    </tr>
                    <tr>
                      <th className="border-l px-3 py-2 text-right font-medium">Expenses</th>
                      <th className="px-3 py-2 text-right font-medium">Payments</th>
                      <th className="border-l px-3 py-2 text-right font-medium">Expenses</th>
                      <th className="px-3 py-2 text-right font-medium">Paid at purchase</th>
                      <th className="px-3 py-2 text-right font-medium">Allocated payments</th>
                      <th className="px-3 py-2 text-right font-medium">Unallocated</th>
                      <th className="px-3 py-2 text-right font-medium">Payable</th>
                      <th className="px-3 py-2 text-right font-medium">Unpaid bills</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {r.items.map((s) => (
                      <tr key={s.supplierId}>
                        <td className="px-3 py-2.5">
                          <Link to={`/suppliers/${s.supplierId}/ledger`} className="font-medium hover:underline">
                            {s.name}
                          </Link>
                          {!s.isActive && <Badge className="ml-2">Archived</Badge>}
                        </td>
                        <td className="figure border-l px-3 py-2.5 text-right">{formatInr(s.periodExpenses)}</td>
                        <td className="figure px-3 py-2.5 text-right">{formatInr(s.periodPayments)}</td>
                        <td className="figure border-l px-3 py-2.5 text-right">{formatInr(s.totalExpenses)}</td>
                        <td className="figure px-3 py-2.5 text-right">{formatInr(s.directPayments)}</td>
                        <td className="figure px-3 py-2.5 text-right">{formatInr(s.allocatedPayments)}</td>
                        <td className="figure px-3 py-2.5 text-right">{formatInr(s.unallocated)}</td>
                        <td className={cn('figure px-3 py-2.5 text-right font-medium', s.payable !== '0.00' && 'text-warning')}>{formatInr(s.payable)}</td>
                        <td className="figure px-3 py-2.5 text-right">{s.outstandingBills}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page} totalPages={r.pagination.totalPages} onPage={(n) => period.set({ page: String(n) })} />
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Payable = active expenses − paid at purchase − allocated payments. Unallocated = payments not yet matched to bills. Supplier payments are never counted as
            expenses.
          </p>
          <GeneratedNote />
        </div>
      )}
    </Page>
  );
}
