import { Badge } from '@/components/ui/badge';
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
      {report.isPending && <LoadingState label="Calculating…" />}
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
              <CardContent className="overflow-x-auto px-0 md:px-0">
                <table className="w-full min-w-[30rem] text-sm">
                  <thead className="border-b text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Category</th>
                      <th className="px-2 py-2 text-right font-medium">Amount</th>
                      <th className="px-2 py-2 text-right font-medium">Count</th>
                      <th className="px-2 py-2 text-right font-medium">Share</th>
                      <th className="px-2 py-2 text-right font-medium" title="Expenses carrying this category in any position">
                        Tagged
                      </th>
                      <th className="px-4 py-2 text-right font-medium">vs previous</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {shown.map((c) => (
                      <tr key={c.categoryId}>
                        <td className="px-4 py-2">
                          {c.name} {!c.isActive && <Badge className="ml-1">Archived</Badge>}
                        </td>
                        <td className="figure px-2 py-2 text-right">{formatInr(c.amount)}</td>
                        <td className="figure px-2 py-2 text-right">{c.count}</td>
                        <td className="figure px-2 py-2 text-right">{c.percent ?? '—'}%</td>
                        <td className="figure px-2 py-2 text-right">{c.taggedCount}</td>
                        <td className="px-4 py-2 text-right">
                          <Change value={c.changePercent} />
                          <span className="block text-xs text-muted-foreground">{formatInr(c.previousAmount)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.length === 0 && <p className="px-4 text-sm text-muted-foreground">No expenses in this or the previous period.</p>}
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
