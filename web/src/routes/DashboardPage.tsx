import { NAV_ITEMS } from '@/app/navigation';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useApiHealth } from '@/features/system/useApiHealth';

/** Stage 1 placeholder: shows system connectivity only. Deliberately contains no financial figures. */
export function DashboardPage() {
  const health = useApiHealth();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <Card>
        <CardHeader>
          <CardTitle>System status</CardTitle>
          <CardDescription>Connection to the Shop-Books server.</CardDescription>
        </CardHeader>
        <CardContent>
          {health.isPending && <LoadingState label="Checking server…" />}
          {health.isError && (
            <ErrorState title="Cannot reach the server" error={health.error} onRetry={() => void health.refetch()} />
          )}
          {health.isSuccess && (
            <p>
              Server: <strong>{health.data.status === 'ok' ? 'online' : 'degraded'}</strong> · Database:{' '}
              <strong>{health.data.database === 'up' ? 'connected' : 'unavailable'}</strong>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            No financial data has been recorded yet. Dashboard figures appear here once expense entry is built.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc text-sm text-muted-foreground">
            {NAV_ITEMS.filter((item) => item.stage).map((item) => (
              <li key={item.to}>{item.stage}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
