import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ExportButton } from '@/features/exports/ExportButton';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { GeneratedNote, TransactionItem } from '@/features/reports/ReportBits';
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
          onSubmit={(e) => {
            e.preventDefault();
            period.set({ q: search.trim() });
          }}
        >
          <Input type="search" aria-label="Search" placeholder="Search description, reference, name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </FilterBar>

      {report.isPending && <LoadingState label="Loading…" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-4', report.isPlaceholderData && 'opacity-60')}>
          <ul className="flex flex-wrap gap-2 text-xs">
            {r.totals.map((t) => (
              <li key={t.type} className="rounded-full border bg-card px-3 py-1">
                {TRANSACTION_LABELS[t.type]}: {t.count} · <span className="figure">{formatInr(t.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Amounts per type count only active entries. Each type is shown as what it is; payments are not added to expenses.</p>

          {r.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions match.</p>
          ) : (
            <>
              <ul className="divide-y rounded-xl border bg-card px-4 shadow-card md:hidden">
                {r.items.map((t) => (
                  <li key={`${t.type}:${t.id}`}>
                    <TransactionItem t={t} />
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
                <table className="w-full text-sm">
                  <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-3 py-2.5 font-medium">Type</th>
                      <th className="px-3 py-2.5 font-medium">Supplier / customer</th>
                      <th className="px-3 py-2.5 font-medium">Description</th>
                      <th className="px-3 py-2.5 font-medium">Reference</th>
                      <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                      <th className="px-3 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Recorded by</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {r.items.map((t) => (
                      <tr key={`${t.type}:${t.id}`} className="cursor-pointer hover:bg-accent/50" onClick={() => navigate(transactionLink(t))}>
                        <td className="whitespace-nowrap px-4 py-2.5">{formatDate(t.date)}</td>
                        <td className="px-3 py-2.5">
                          <Link to={transactionLink(t)} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                            {TRANSACTION_LABELS[t.type]}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5">{t.entity ?? '—'}</td>
                        <td className="max-w-56 px-3 py-2.5">
                          <span className="line-clamp-2">{t.description ?? '—'}</span>
                        </td>
                        <td className="px-3 py-2.5">{t.reference ?? '—'}</td>
                        <td className={cn('figure whitespace-nowrap px-3 py-2.5 text-right font-medium', t.status !== 'active' && 'text-muted-foreground line-through')}>
                          {formatInr(t.amount)}
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-4 py-2.5">{t.recordedBy}</td>
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
