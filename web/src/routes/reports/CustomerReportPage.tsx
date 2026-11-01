import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
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
            className={cn('h-10 rounded-lg text-sm font-medium', kind === k ? 'bg-card shadow-card' : 'text-muted-foreground hover:text-foreground')}
          >
            {COPY[k].title}
          </button>
        ))}
      </div>
      <PeriodSelector state={period} resolved={r?.period} />
      <FilterBar>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            period.set({ q: search.trim() });
          }}
        >
          <Input type="search" aria-label="Search customers" placeholder="Search name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <Select aria-label="Customer status" value={status} onChange={(e) => period.set({ status: e.target.value === 'all' ? '' : e.target.value })}>
          <option value="all">Active and archived</option>
          <option value="active">Active customers</option>
          <option value="archived">Archived customers</option>
        </Select>
        <label className="flex h-11 items-center gap-2 rounded-lg border bg-card px-3 text-sm md:h-10">
          <input type="checkbox" className="size-4" checked={outstandingOnly} onChange={(e) => period.set({ outstandingOnly: e.target.checked ? 'true' : '' })} />
          {copy.outstanding}
        </label>
      </FilterBar>

      {report.isPending && <LoadingState label="Calculating…" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <StatTile label={`${copy.added} (${periodWord})`} amount={r.totals.added} />
            <StatTile label={`${copy.reduced} (${periodWord})`} amount={r.totals.reduced} />
            <StatTile label={`${copy.balance} (now)`} amount={r.totals.balance} tone={kind === 'due' ? 'warning' : 'accent'} hint={copy.balanceHint} />
          </div>

          {r.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No customers match.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-3 py-2.5 text-right font-medium">{copy.added}</th>
                    <th className="px-3 py-2.5 text-right font-medium">{copy.reduced}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{copy.balance} now</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {r.items.map((c) => (
                    <tr key={c.customerId}>
                      <td className="px-4 py-2.5">
                        <Link to={`/customers/${c.customerId}/ledger`} className="font-medium hover:underline">
                          {c.name}
                        </Link>
                        {!c.isActive && <Badge className="ml-2">Archived</Badge>}
                        {c.phone && <span className="block text-xs text-muted-foreground">{c.phone}</span>}
                      </td>
                      <td className="figure px-3 py-2.5 text-right">{formatInr(c.added)}</td>
                      <td className="figure px-3 py-2.5 text-right">{formatInr(c.reduced)}</td>
                      <td className={cn('figure px-4 py-2.5 text-right font-medium', c.balance !== '0.00' && (kind === 'due' ? 'text-warning' : 'text-primary'))}>
                        {formatInr(c.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={page} totalPages={r.pagination.totalPages} onPage={(n) => period.set({ page: String(n) })} />
          <GeneratedNote />
        </div>
      )}
    </Page>
  );
}
