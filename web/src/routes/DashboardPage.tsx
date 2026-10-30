import { ChevronRight, Plus, ReceiptText, Truck, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { NAV_ITEMS } from '@/app/navigation';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { useApiHealth } from '@/features/system/useApiHealth';
import { cn } from '@/lib/utils';

function QuickAction({ to, icon: Icon, title, text, primary }: { to: string; icon: LucideIcon; title: string; text: string; primary?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 rounded-xl border p-4 shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        primary ? 'border-primary bg-primary text-primary-foreground hover:bg-primary-hover' : 'bg-card hover:bg-accent',
      )}
    >
      <span
        className={cn(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-lg',
          primary ? 'bg-white/15' : 'bg-primary-soft text-primary',
        )}
      >
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

/** Placeholder: quick links and system status only. Deliberately contains no financial figures. */
export function DashboardPage() {
  const { user } = useAuth();
  const health = useApiHealth();

  return (
    <Page width="medium">
      <PageHeader title="Dashboard" description={user ? `Welcome, ${user.name}.` : undefined} />

      <div className="grid gap-3 md:grid-cols-3">
        <QuickAction to="/expenses/new" icon={Plus} title="Add expense" text="Record a bill or payment" primary />
        <QuickAction to="/expenses" icon={ReceiptText} title="Expenses" text="Search, filter and edit" />
        <QuickAction to="/suppliers" icon={Truck} title="Suppliers" text="Contacts and usual categories" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System status</CardTitle>
            <CardDescription>Connection to the Shop-Books server.</CardDescription>
          </CardHeader>
          <CardContent>
            {health.isPending && <LoadingState label="Checking server…" />}
            {health.isError && <ErrorState title="Cannot reach the server" error={health.error} onRetry={() => void health.refetch()} />}
            {health.isSuccess && (
              <ul className="space-y-2 text-sm">
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">Server</span>
                  <span className="flex items-center gap-2 font-medium">
                    <span className={cn('size-2 rounded-full', health.data.status === 'ok' ? 'bg-primary' : 'bg-warning')} aria-hidden="true" />
                    {health.data.status === 'ok' ? 'online' : 'degraded'}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">Database</span>
                  <span className="flex items-center gap-2 font-medium">
                    <span className={cn('size-2 rounded-full', health.data.database === 'up' ? 'bg-primary' : 'bg-destructive')} aria-hidden="true" />
                    {health.data.database === 'up' ? 'connected' : 'unavailable'}
                  </span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Coming later</CardTitle>
            <CardDescription>Dashboard figures appear here in a later stage.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
              {NAV_ITEMS.filter((item) => item.stage).map((item) => (
                <li key={item.to}>{item.stage}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
