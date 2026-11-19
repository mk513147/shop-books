import { Search, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ExportButton } from '@/features/exports/ExportButton';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { GeneratedNote } from '@/features/reports/ReportBits';
import { FilterBar, Pager, ReportTabs } from '@/features/reports/ReportTabs';
import { useCustomerReport } from '@/features/reports/reports-api';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

const COPY = {
  due: {
    title: 'Customer dues',
    added: 'Dues recorded',
    reduced: 'Payments received',
    balance: 'Outstanding due',
    balanceHint: 'What customers owe the shop now',
    outstanding: 'Only customers who still owe',
  },
  advance: {
    title: 'Customer advances',
    added: 'Advances received',
    reduced: 'Refunds issued',
    balance: 'Available advance',
    balanceHint: 'Held for customers now; refundable',
    outstanding: 'Only customers with an advance',
  },
} as const;

/** Two separate reports (due / advance) — there is no combined or net customer balance. */
export function CustomerReportPage() {
  const period = usePeriodParams('all_time');
  const p = period.params;
  const kind = p.get('kind') === 'advance' ? 'advance' : 'due';
  const copy = COPY[kind];
  const status = p.get('status') ?? 'all';
  const outstandingOnly = p.get('outstandingOnly') === 'true';
  const page = Math.max(1, Number(p.get('page')) || 1);
  const [search, setSearch] = useState(p.get('q') ?? '');
  const params = {
    ...(period.query ?? { period: 'all_time' }),
    status,
    q: p.get('q') ?? undefined,
    outstandingOnly: outstandingOnly ? 'true' : undefined,
  };
  const report = useCustomerReport(kind, { ...params, page, pageSize: 25 });
  const r = report.data;
  const periodWord = r?.period.preset === 'all_time' ? 'all time' : 'in period';

  return (
    <Page>
      <PageHeader
        title="Customer reports"
        description="Dues and advances are separate balances. Neither is a sale or income."
        actions={<ExportButton report={kind === 'due' ? 'customer-dues' : 'customer-advances'} params={params} disabled={!period.query} />}
      />
      <ReportTabs />
      <div role="tablist" aria-label="Report" className="grid grid-cols-2 gap-1 rounded-xl bg-surface-muted p-1 sm:w-96">
        {(['due', 'advance'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => period.set({ kind: k === 'due' ? '' : k })}
            className={cn(
              'min-h-10 rounded-lg px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              kind === k ? 'bg-card font-semibold text-foreground shadow-card' : 'font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {COPY[k].title}
          </button>
        ))}
      </div>
      <PeriodSelector state={period} resolved={r?.period} />
      <FilterBar>
        <form
          role="search"
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            period.set({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" className="pl-9" aria-label="Search customers" placeholder="Search name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <Select aria-label="Customer status" value={status} onChange={(e) => period.set({ status: e.target.value === 'all' ? '' : e.target.value })}>
          <option value="all">Active and archived</option>
          <option value="active">Active customers</option>
          <option value="archived">Archived customers</option>
        </Select>
        <label className="flex h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-input bg-card px-3 text-sm shadow-card transition-colors hover:border-[oklch(0.8_0.01_245)] md:h-10">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={outstandingOnly} onChange={(e) => period.set({ outstandingOnly: e.target.checked ? 'true' : '' })} />
          {copy.outstanding}
        </label>
      </FilterBar>

      {report.isPending && <LoadingState label="Calculating…" skeleton="table" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-3">
            <StatTile label={`${copy.added} (${periodWord})`} amount={r.totals.added} />
            <StatTile label={`${copy.reduced} (${periodWord})`} amount={r.totals.reduced} />
            <StatTile label={`${copy.balance} (now)`} amount={r.totals.balance} tone={kind === 'due' ? 'warning' : 'info'} hint={copy.balanceHint} className="col-span-2 lg:col-span-1" />
          </div>

          {r.items.length === 0 ? (
            <EmptyState icon={Users} title="No customers match." />
          ) : (
            <>
              <ul className="space-y-2 md:hidden">
                {r.items.map((c) => (
                  <li key={c.customerId}>
                    <Link to={`/customers/${c.customerId}/ledger`} className="list-card">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 font-semibold">
                            <span className="truncate">{c.name}</span>
                            {!c.isActive && <StatusBadge status="archived" />}
                          </p>
                          {c.phone && <p className="figure truncate text-sm text-muted-foreground">{c.phone}</p>}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={cn('figure font-semibold', c.balance !== '0.00' && (kind === 'due' ? 'text-warning' : 'text-info'))}>{formatInr(c.balance)}</p>
                          <p className="text-xs text-muted-foreground">{copy.balance} now</p>
                        </div>
                      </div>
                      <p className="figure mt-2 text-xs text-muted-foreground">
                        {copy.added} {formatInr(c.added)} · {copy.reduced} {formatInr(c.reduced)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="table-shell hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-3 py-3 text-right">{copy.added}</th>
                      <th className="px-3 py-3 text-right">{copy.reduced}</th>
                      <th className="px-4 py-3 text-right">{copy.balance} now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((c) => (
                      <tr key={c.customerId}>
                        <td className="px-4 py-3">
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <Link to={`/customers/${c.customerId}/ledger`} className="font-medium hover:underline">
                              {c.name}
                            </Link>
                            {!c.isActive && <StatusBadge status="archived" />}
                          </span>
                          {c.phone && <span className="figure block text-xs text-muted-foreground">{c.phone}</span>}
                        </td>
                        <td className="figure whitespace-nowrap px-3 py-3 text-right">{formatInr(c.added)}</td>
                        <td className="figure whitespace-nowrap px-3 py-3 text-right">{formatInr(c.reduced)}</td>
                        <td className={cn('figure whitespace-nowrap px-4 py-3 text-right font-semibold', c.balance !== '0.00' && (kind === 'due' ? 'text-warning' : 'text-info'))}>
                          {formatInr(c.balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <Pager page={page} totalPages={r.pagination.totalPages} onPage={(n) => period.set({ page: String(n) })} />
          <GeneratedNote />
        </div>
      )}
    </Page>
  );
}
