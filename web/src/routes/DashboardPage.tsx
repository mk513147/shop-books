import { ArrowRight, BarChart3, ChevronRight, HandCoins, Plus, Truck, Users, Wallet, WalletCards, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { CompositionBar, TrendChart } from '@/features/reports/charts';
import { PeriodSelector, usePeriodParams } from '@/features/reports/PeriodSelector';
import { ChangeNote, FigureRow, GeneratedNote, SectionHeading, TransactionItem } from '@/features/reports/ReportBits';
import { useDashboard } from '@/features/reports/reports-api';
import { useApiHealth } from '@/features/system/useApiHealth';
import { TIME_ZONE } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

function QuickAction({ to, icon: Icon, title, text, primary }: { to: string; icon: LucideIcon; title: string; text: string; primary?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'surface-interactive group flex min-h-16 items-center gap-3 rounded-xl border p-3 shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:p-3.5',
        primary ? 'border-primary bg-primary text-primary-foreground hover:bg-primary-hover' : 'bg-card',
      )}
    >
      <span
        className={cn(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-lg',
          primary ? 'bg-white/15 text-primary-foreground' : 'bg-primary-soft text-primary',
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className={cn('block truncate text-xs', primary ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{text}</span>
      </span>
      <ChevronRight className="hidden size-4 shrink-0 opacity-60 transition-transform duration-150 group-hover:translate-x-0.5 sm:block" aria-hidden="true" />
    </Link>
  );
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-IN', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' });
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
      <PageHeader
        title="Dashboard"
        description={
          <>
            {user ? `Welcome, ${user.name}.` : null} <span className="text-muted-foreground/80">{todayLabel()}</span>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4">
        <QuickAction to="/expenses/new" icon={Plus} title="Add expense" text="Record a bill" primary />
        <QuickAction to="/supplier-payments/new" icon={Wallet} title="Pay a supplier" text="Record a supplier payment" />
        <QuickAction to="/customers" icon={Users} title="Customers" text="Dues and advances" />
        <QuickAction to="/reports" icon={BarChart3} title="Reports" text="Analysis and Excel export" />
      </div>

      <PeriodSelector state={period} resolved={d?.period} exclude={['all_time']} />

      {dashboard.isPending && <LoadingState label="Calculating…" skeleton="dashboard" />}
      {dashboard.isError && <ErrorState title="Could not load the dashboard" error={dashboard.error} onRetry={() => void dashboard.refetch()} />}

      {d && (
        <div className={cn('space-y-7 transition-opacity duration-200 md:space-y-8', dashboard.isPlaceholderData && 'opacity-60')}>
          <section className="space-y-3">
            <SectionHeading title={`Activity: ${d.period.label}`} kind="period" />
            <div className="grid gap-3 md:gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3">
                <CardHeader className="pb-1">
                  <CardTitle>Expenses</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <p className="figure text-[2rem] font-semibold leading-none tracking-[-0.025em] md:text-[2.5rem]">{formatInr(d.expenses.amount)}</p>
                    <p className="text-sm text-muted-foreground">
                      {d.expenses.count} expense{d.expenses.count === 1 ? '' : 's'}
                      {d.expenses.voidedCount > 0 && ` · ${d.expenses.voidedCount} voided (not counted)`}
                    </p>
                    <ChangeNote change={d.expenses.changePercent} previous={d.expenses.previous?.amount ?? null} />
                  </div>
                  <CompositionBar
                    total={d.expenses.amount}
                    parts={[
                      { key: 'paid', label: 'Paid at purchase', amount: d.expenses.paidAtPurchase, tone: 'accent' },
                      { key: 'settled', label: 'Settled by later supplier payments', amount: d.expenses.settledByPayments, tone: 'accentSoft' },
                      { key: 'due', label: 'Still payable on these expenses', amount: d.expenses.outstanding, tone: 'warning' },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">Supplier payments settle expenses; they are never counted as extra expenses.</p>
                </CardContent>
              </Card>

              <div className="grid gap-3 sm:grid-cols-2 md:gap-4 lg:col-span-2 lg:grid-cols-1">
                <Card>
                  <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
                    <CardTitle>Supplier payments</CardTitle>
                    <span className="inline-flex size-8 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground">
                      <Wallet className="size-4" aria-hidden="true" />
                    </span>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    <p className="figure text-2xl font-semibold tracking-tight">{formatInr(d.supplierPaymentsInPeriod.amount)}</p>
                    <p className="text-sm text-muted-foreground">
                      {d.supplierPaymentsInPeriod.count} payment{d.supplierPaymentsInPeriod.count === 1 ? '' : 's'} to suppliers
                    </p>
                    <Link to="/supplier-payments" className="group inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary hover:underline">
                      All supplier payments
                      <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
                    </Link>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
                    <CardTitle>Customer entries</CardTitle>
                    <span className="inline-flex size-8 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground">
                      <HandCoins className="size-4" aria-hidden="true" />
                    </span>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-warning-strong" />
                        Dues
                      </p>
                      <FigureRow label="Added" amount={d.customerActivity.duesRecorded} />
                      <FigureRow label="Paid" amount={d.customerActivity.duePaymentsReceived} />
                    </div>
                    <div>
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-info">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
                        Advances
                      </p>
                      <FigureRow label="Received" amount={d.customerActivity.advancesReceived} />
                      <FigureRow label="Refunded" amount={d.customerActivity.refundsIssued} />
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <SectionHeading title="Current balances" kind="current" />
            <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4">
              <StatTile
                label="Supplier payable"
                icon={Truck}
                amount={d.suppliers.totalPayable}
                tone={d.suppliers.totalPayable !== '0.00' ? 'warning' : 'muted'}
                hint={`${d.suppliers.suppliersWithPayable} supplier(s) owed`}
              />
              <StatTile
                label="Unallocated supplier payments"
                icon={WalletCards}
                amount={d.suppliers.totalUnallocated}
                tone={d.suppliers.totalUnallocated !== '0.00' ? 'info' : 'muted'}
                hint="Paid, not yet matched to bills"
              />
              <StatTile
                label="Customer dues"
                icon={Users}
                amount={d.customers.totalDue}
                tone={d.customers.totalDue !== '0.00' ? 'warning' : 'muted'}
                hint={`${d.customers.customersWithDue} customer(s) owe the shop`}
              />
              <StatTile
                label="Customer advances"
                icon={HandCoins}
                amount={d.customers.totalAdvance}
                tone={d.customers.totalAdvance !== '0.00' ? 'info' : 'muted'}
                hint={`${d.customers.customersWithAdvance} customer(s); refundable`}
              />
            </div>
            <p className="text-xs text-muted-foreground">Customer dues and advances are separate balances and are never netted.</p>
          </section>

          <div className="grid gap-3 md:gap-4 lg:grid-cols-2 lg:items-start">
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
              <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
                <CardTitle>Recently recorded</CardTitle>
                <Link to="/reports/transactions" className="group inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary hover:underline">
                  All transactions
                  <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </CardHeader>
              <CardContent>
                {d.recentActivity.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
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
