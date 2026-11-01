import { BarChart3, ChevronRight, Plus, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { TrendChart } from '@/features/reports/charts';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { ChangeNote, FigureRow, GeneratedNote, SectionHeading, TransactionItem } from '@/features/reports/ReportBits';
import { useDashboard } from '@/features/reports/reports-api';
import { useApiHealth } from '@/features/system/useApiHealth';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

function QuickAction({ to, icon: Icon, title, text, primary }: { to: string; icon: LucideIcon; title: string; text: string; primary?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 rounded-xl border p-3 shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:p-4',
        primary ? 'border-primary bg-primary text-primary-foreground hover:bg-primary-hover' : 'bg-card hover:bg-accent',
      )}
    >
      <span className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-lg', primary ? 'bg-white/15' : 'bg-primary-soft text-primary')}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className={cn('block text-sm', primary ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{text}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 opacity-60" aria-hidden="true" />
    </Link>
  );
}

/**
 * Overview of recorded activity. Two clearly separated groups: PERIOD activity (follows the period
 * selector) and CURRENT balances (as of now). Every figure comes from GET /reports/dashboard.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const health = useApiHealth();
  const period = usePeriodParams('this_month');
  const dashboard = useDashboard(period.query ?? { period: 'this_month' });
  const d = dashboard.data;

  return (
    <Page>
      <PageHeader title="Dashboard" description={user ? `Welcome, ${user.name}.` : undefined} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickAction to="/expenses/new" icon={Plus} title="Add expense" text="Record a bill" primary />
        <QuickAction to="/supplier-payments/new" icon={Wallet} title="Pay a supplier" text="Record a supplier payment" />
        <QuickAction to="/customers" icon={Users} title="Customers" text="Dues and advances" />
        <QuickAction to="/reports" icon={BarChart3} title="Reports" text="Analysis and Excel export" />
      </div>

      <PeriodSelector state={period} resolved={d?.period} exclude={['all_time']} />

      {dashboard.isPending && <LoadingState label="Calculating…" />}
      {dashboard.isError && <ErrorState title="Could not load the dashboard" error={dashboard.error} onRetry={() => void dashboard.refetch()} />}

      {d && (
        <div className={cn('space-y-6 transition-opacity', dashboard.isPlaceholderData && 'opacity-60')}>
          <section className="space-y-3">
            <SectionHeading title={`Activity: ${d.period.label}`} kind="period" />
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-1">
                <CardHeader className="pb-2">
                  <CardTitle>Expenses</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="figure text-3xl font-semibold tracking-tight">{formatInr(d.expenses.amount)}</p>
                  <p className="text-sm text-muted-foreground">
                    {d.expenses.count} expense{d.expenses.count === 1 ? '' : 's'}
                    {d.expenses.voidedCount > 0 && ` · ${d.expenses.voidedCount} voided (not counted)`}
                  </p>
                  <ChangeNote change={d.expenses.changePercent} previous={d.expenses.previous?.amount ?? null} />
                  <div className="divide-y border-t pt-1">
                    <FigureRow label="Paid at purchase" amount={d.expenses.paidAtPurchase} />
                    <FigureRow label="Settled by later supplier payments" amount={d.expenses.settledByPayments} />
                    <FigureRow label="Still payable on these expenses" amount={d.expenses.outstanding} tone={d.expenses.outstanding !== '0.00' ? 'warning' : undefined} />
                  </div>
                  <p className="text-xs text-muted-foreground">Supplier payments settle expenses; they are never counted as extra expenses.</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Supplier payments</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="figure text-3xl font-semibold tracking-tight">{formatInr(d.supplierPaymentsInPeriod.amount)}</p>
                  <p className="text-sm text-muted-foreground">
                    {d.supplierPaymentsInPeriod.count} payment{d.supplierPaymentsInPeriod.count === 1 ? '' : 's'} to suppliers
                  </p>
                  <Link to="/supplier-payments" className="text-sm text-primary hover:underline">
                    All supplier payments
                  </Link>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Customer entries</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs font-medium text-warning">Dues</p>
                    <FigureRow label="Added" amount={d.customerActivity.duesRecorded} />
                    <FigureRow label="Paid" amount={d.customerActivity.duePaymentsReceived} />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-primary">Advances</p>
                    <FigureRow label="Received" amount={d.customerActivity.advancesReceived} />
                    <FigureRow label="Refunded" amount={d.customerActivity.refundsIssued} />
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="space-y-3">
            <SectionHeading title="Current balances" kind="current" />
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <StatTile
                label="Supplier payable"
                amount={d.suppliers.totalPayable}
                tone={d.suppliers.totalPayable !== '0.00' ? 'warning' : 'muted'}
                hint={`${d.suppliers.suppliersWithPayable} supplier(s) owed`}
              />
              <StatTile label="Unallocated supplier payments" amount={d.suppliers.totalUnallocated} hint="Paid, not yet matched to bills" />
              <StatTile
                label="Customer dues"
                amount={d.customers.totalDue}
                tone={d.customers.totalDue !== '0.00' ? 'warning' : 'muted'}
                hint={`${d.customers.customersWithDue} customer(s) owe the shop`}
              />
              <StatTile
                label="Customer advances"
                amount={d.customers.totalAdvance}
                tone={d.customers.totalAdvance !== '0.00' ? 'accent' : 'muted'}
                hint={`${d.customers.customersWithAdvance} customer(s); refundable`}
              />
            </div>
            <p className="text-xs text-muted-foreground">Customer dues and advances are separate balances and are never netted.</p>
          </section>

          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Expenses by month</CardTitle>
                <p className="text-xs text-muted-foreground">Last 6 months up to the end of the selected period</p>
              </CardHeader>
              <CardContent>
                <TrendChart points={d.trend} highlightFrom={d.period.from} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
                <CardTitle>Recently recorded</CardTitle>
                <Link to="/reports/transactions" className="text-sm text-primary hover:underline">
                  All transactions
                </Link>
              </CardHeader>
              <CardContent>
                {d.recentActivity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <ul className="divide-y">
                    {d.recentActivity.map((t) => (
                      <li key={`${t.type}:${t.id}`}>
                        <TransactionItem t={t} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
          <GeneratedNote at={d.generatedAt} />
        </div>
      )}

      {health.isError && <ErrorState title="Cannot reach the server" error={health.error} onRetry={() => void health.refetch()} />}
    </Page>
  );
}
