import { ListOrdered, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ExportButton } from '@/features/exports/ExportButton';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { GeneratedNote } from '@/features/reports/ReportBits';
import { FilterBar, Pager, ReportTabs } from '@/features/reports/ReportTabs';
import { TRANSACTION_LABELS, transactionLink, useTransactionsReport, type TransactionType } from '@/features/reports/reports-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

/** Every financial transaction type in one paginated history. */
export function TransactionsReportPage() {
  const navigate = useNavigate();
  const period = usePeriodParams('this_month');
  const p = period.params;
  const type = p.get('type') ?? '';
  const status = p.get('status') ?? 'all';
  const page = Math.max(1, Number(p.get('page')) || 1);
  const [search, setSearch] = useState(p.get('q') ?? '');
  const params = { ...(period.query ?? { period: 'this_month' }), type: type || undefined, status, q: p.get('q') ?? undefined };
  const report = useTransactionsReport({ ...params, page, pageSize: 25 });
  const r = report.data;

  return (
    <Page>
      <PageHeader title="Transaction history" actions={<ExportButton report="transactions" params={params} disabled={!period.query} />} />
      <ReportTabs />
      <PeriodSelector state={period} resolved={r?.period} />
      <FilterBar>
        <Select aria-label="Transaction type" value={type} onChange={(e) => period.set({ type: e.target.value })}>
          <option value="">All transaction types</option>
          {(Object.keys(TRANSACTION_LABELS) as TransactionType[]).map((t) => (
            <option key={t} value={t}>
              {TRANSACTION_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => period.set({ status: e.target.value === 'all' ? '' : e.target.value })}>
          <option value="all">Any status</option>
          <option value="active">Counted only</option>
          <option value="cancelled">Voided / reversed</option>
        </Select>
        <form
          role="search"
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            period.set({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" className="pl-9" aria-label="Search" placeholder="Search description, reference, name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </FilterBar>

      {report.isPending && <LoadingState label="Loading…" skeleton="table" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-4', report.isPlaceholderData && 'opacity-60')}>
          <ul className="flex flex-wrap gap-2 text-xs">
            {r.totals.map((t) => (
              <li key={t.type} className="rounded-full border bg-card px-3 py-1.5 text-muted-foreground shadow-card">
                <span className="font-medium text-foreground">{TRANSACTION_LABELS[t.type]}</span>: {t.count} ·{' '}
                <span className="figure font-semibold text-foreground">{formatInr(t.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Amounts per type count only active entries. Each type is shown as what it is; payments are not added to expenses.</p>

          {r.items.length === 0 ? (
            <EmptyState icon={ListOrdered} title="No transactions match." />
          ) : (
            <>
              <ul className="space-y-2 md:hidden">
                {r.items.map((t) => {
                  const cancelled = t.status !== 'active';
                  return (
                    <li key={`${t.type}:${t.id}`}>
                      <Link to={transactionLink(t)} className="list-card">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className={cn('truncate font-semibold', cancelled && 'text-muted-foreground')}>{TRANSACTION_LABELS[t.type]}</p>
                            {(t.entity ?? t.description) && <p className="truncate text-sm text-muted-foreground">{t.entity ?? t.description}</p>}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <p className={cn('figure font-semibold', cancelled && 'text-muted-foreground line-through')}>{formatInr(t.amount)}</p>
                            {cancelled && <StatusBadge status={t.status} />}
                          </div>
                        </div>
                        <p className="mt-2 truncate text-xs text-muted-foreground">
                          {formatDate(t.date)}
                          {t.entity && t.description && ` · ${t.description}`}
                          {t.reference && ` · ${t.reference}`}
                          {` · ${t.recordedBy}`}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="table-shell hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-3 py-3">Type</th>
                      <th className="px-3 py-3">Supplier / customer</th>
                      <th className="px-3 py-3">Description</th>
                      <th className="px-3 py-3">Reference</th>
                      <th className="px-3 py-3 text-right">Amount</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-4 py-3">Recorded by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((t) => (
                      <tr key={`${t.type}:${t.id}`} className={cn('cursor-pointer', t.status !== 'active' && 'text-muted-foreground')} onClick={() => navigate(transactionLink(t))}>
                        <td className="figure whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(t.date)}</td>
                        <td className="whitespace-nowrap px-3 py-3">
                          <Link to={transactionLink(t)} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                            {TRANSACTION_LABELS[t.type]}
                          </Link>
                        </td>
                        <td className="px-3 py-3">{t.entity ?? '—'}</td>
                        <td className="max-w-56 px-3 py-3 text-muted-foreground">
                          <span className="line-clamp-2">{t.description ?? '—'}</span>
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">{t.reference ?? '—'}</td>
                        <td className={cn('figure whitespace-nowrap px-3 py-3 text-right font-semibold', t.status !== 'active' && 'font-medium text-muted-foreground line-through')}>
                          {formatInr(t.amount)}
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{t.recordedBy}</td>
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
