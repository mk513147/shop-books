import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExportButton } from '@/features/exports/ExportButton';
import { BarList } from '@/features/reports/charts';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { GeneratedNote, SectionHeading } from '@/features/reports/ReportBits';
import { ReportTabs } from '@/features/reports/ReportTabs';
import { useCategoryReport } from '@/features/reports/reports-api';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

function Change({ value }: { value: string | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return <span className="figure">{value.startsWith('-') ? `−${value.slice(1)}` : `+${value}`}%</span>;
}

/** Category analysis: amount, count, share and change vs the previous equivalent period. */
export function CategoryReportPage() {
  const period = usePeriodParams('this_month');
  const report = useCategoryReport(period.query ?? { period: 'this_month' });
  const r = report.data;
  const shown = r?.rows.filter((c) => c.count > 0 || c.previousCount > 0 || c.taggedCount > 0) ?? [];

  return (
    <Page>
      <PageHeader title="Category analysis" actions={<ExportButton report="categories" params={period.query ?? {}} disabled={!period.query} />} />
      <ReportTabs />
      <PeriodSelector state={period} resolved={r?.period} />
      {report.isPending && <LoadingState label="Calculating…" skeleton="cards" />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {r && (
        <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
          <SectionHeading title={`Total ${formatInr(r.total)}`} kind="period">
            {r.period.previous && <span className="text-sm text-muted-foreground">Previous period: {formatInr(r.previousTotal)}</span>}
          </SectionHeading>
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Share of expenses</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={shown
                    .filter((c) => c.count > 0)
                    .map((c) => ({
                      key: c.categoryId,
                      label: c.name,
                      detail: `${c.count} expense(s)${c.isActive ? '' : ' · archived'}`,
                      amount: c.amount,
                      note: c.percent !== null ? `${c.percent}%` : undefined,
                    }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Table</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-1 md:px-0 md:pb-1">
                {shown.length > 0 && (
                  <>
                    <ul className="divide-y border-t md:hidden">
                      {shown.map((c) => (
                        <li key={c.categoryId} className="px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <p className="flex min-w-0 items-center gap-2 font-semibold">
                              <span className="truncate">{c.name}</span>
                              {!c.isActive && <StatusBadge status="archived" />}
                            </p>
                            <p className="figure shrink-0 font-semibold">{formatInr(c.amount)}</p>
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span className="figure">
                              {c.count} expense(s) · {c.percent === null ? '—' : `${c.percent}%`} · tagged {c.taggedCount}
                            </span>
                            <span className="figure shrink-0 text-right">
                              <Change value={c.changePercent} /> vs {formatInr(c.previousAmount)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="hidden overflow-x-auto border-t md:block">
                      <table className="data-table min-w-[30rem]">
                        <thead>
                          <tr>
                            <th className="px-4 py-3">Category</th>
                            <th className="px-3 py-3 text-right">Amount</th>
                            <th className="px-3 py-3 text-right">Count</th>
                            <th className="px-3 py-3 text-right">Share</th>
                            <th className="px-3 py-3 text-right" title="Expenses carrying this category in any position">
                              Tagged
                            </th>
                            <th className="px-4 py-3 text-right">vs previous</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((c) => (
                            <tr key={c.categoryId}>
                              <td className="px-4 py-3">
                                <span className="inline-flex flex-wrap items-center gap-2">
                                  <span className={cn('font-medium', !c.isActive && 'text-muted-foreground')}>{c.name}</span>
                                  {!c.isActive && <StatusBadge status="archived" />}
                                </span>
                              </td>
                              <td className="figure whitespace-nowrap px-3 py-3 text-right font-semibold">{formatInr(c.amount)}</td>
                              <td className="figure px-3 py-3 text-right">{c.count}</td>
                              <td className="figure px-3 py-3 text-right">{c.percent === null ? '—' : `${c.percent}%`}</td>
                              <td className="figure px-3 py-3 text-right text-muted-foreground">{c.taggedCount}</td>
                              <td className="whitespace-nowrap px-4 py-3 text-right">
                                <Change value={c.changePercent} />
                                <span className="figure block text-xs text-muted-foreground">{formatInr(c.previousAmount)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {shown.length === 0 && <p className="px-4 pb-4 text-sm text-muted-foreground md:px-5">No expenses in this or the previous period.</p>}
              </CardContent>
            </Card>
          </div>
          <p className="text-xs text-muted-foreground">
            Shares are of active (not voided) expenses in the period, truncated to one decimal. Archived categories stay listed when they have expenses.
            An expense with several categories is counted once, under its primary (first) category, so the amounts add up to the expense total;
            “Tagged” is how many expenses carry the category at all.
          </p>
          <GeneratedNote />
        </div>
      )}
    </Page>
  );
}
