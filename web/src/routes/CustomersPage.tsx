import { ChevronLeft, ChevronRight, Plus, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CustomerFormDialog } from '@/features/customers/CustomerFormDialog';
import { useCustomers, useCustomersSummary } from '@/features/customers/customers-api';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const get = (k: string) => params.get(k) ?? '';
  const page = Math.max(1, Number(get('page')) || 1);
  const [search, setSearch] = useState(get('q'));
  const [adding, setAdding] = useState(false);
  const summary = useCustomersSummary();
  const list = useCustomers({
    q: get('q') || undefined,
    status: get('status') || 'active',
    balance: get('balance') || undefined,
    page,
    pageSize: 25,
  });

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (!('page' in next)) merged.delete('page');
    setParams(merged);
  }

  return (
    <Page>
      <PageHeader
        title="Customers"
        description="Customer dues and advances. Not sales or orders: only what a customer owes and what you hold for them."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" /> Add customer
          </Button>
        }
      />

      {summary.data && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Total customer dues" amount={summary.data.totalDue} tone={summary.data.totalDue !== '0.00' ? 'warning' : 'muted'} hint={`${summary.data.customersWithDue} customer(s) owe`} />
          <StatTile label="Total advances held" amount={summary.data.totalAdvance} tone={summary.data.totalAdvance !== '0.00' ? 'accent' : 'muted'} hint={`${summary.data.customersWithAdvance} customer(s)`} />
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <form
          role="search"
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search customers"
            placeholder="Search by name or phone"
            enterKeyHint="search"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value === '' && get('q')) update({ q: '' });
            }}
          />
        </form>
        <Select aria-label="Balance" value={get('balance')} onChange={(e) => update({ balance: e.target.value })}>
          <option value="">Any balance</option>
          <option value="due">Owes money (due)</option>
          <option value="advance">Has advance</option>
          <option value="any">Due or advance</option>
        </Select>
        <Select aria-label="Status" value={get('status') || 'active'} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value })}>
          <option value="active">Active customers</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Select>
      </div>

      {list.isPending && <LoadingState label="Loading customers…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          icon={Users}
          title={get('q') ? 'No customers match' : 'No customers here'}
          action={
            !get('q') && (
              <Button onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" /> Add customer
              </Button>
            )
          }
        >
          {get('q') ? 'Try a different name or phone number.' : 'Add a customer to record what they owe or what they paid in advance.'}
        </EmptyState>
      )}

      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <ul className="space-y-2 md:hidden">
            {list.data.items.map((c) => (
              <li key={c.id}>
                <Link to={`/customers/${c.id}`} className={cn('block space-y-2 rounded-xl border bg-card p-4 shadow-card', !c.isActive && 'opacity-80')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{c.name}</p>
                      {c.phone && <p className="text-xs text-muted-foreground">{c.phone}</p>}
                    </div>
                    {!c.isActive && <Badge>Archived</Badge>}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <p>
                      <span className="block text-xs text-muted-foreground">Due</span>
                      <span className={cn('figure font-semibold', c.dueBalance !== '0.00' ? 'text-warning' : 'text-muted-foreground')}>
                        {formatInr(c.dueBalance)}
                      </span>
                    </p>
                    <p>
                      <span className="block text-xs text-muted-foreground">Advance</span>
                      <span className={cn('figure font-semibold', c.advanceBalance !== '0.00' ? 'text-primary' : 'text-muted-foreground')}>
                        {formatInr(c.advanceBalance)}
                      </span>
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-4 py-2.5 font-medium">Phone</th>
                  <th className="px-4 py-2.5 text-right font-medium">Due (owes shop)</th>
                  <th className="px-4 py-2.5 text-right font-medium">Advance (held)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.items.map((c) => (
                  <tr key={c.id} className={cn('cursor-pointer hover:bg-accent/50', !c.isActive && 'text-muted-foreground')} onClick={() => navigate(`/customers/${c.id}`)}>
                    <td className="px-4 py-3">
                      <Link to={`/customers/${c.id}`} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
                        {c.name}
                      </Link>
                      {!c.isActive && <Badge className="ml-2">Archived</Badge>}
                    </td>
                    <td className="px-4 py-3">{c.phone ?? '—'}</td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', c.dueBalance !== '0.00' && 'font-medium text-warning')}>
                      {formatInr(c.dueBalance)}
                    </td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', c.advanceBalance !== '0.00' && 'font-medium text-primary')}>
                      {formatInr(c.advanceBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {list.data.pagination.totalPages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
                <ChevronLeft aria-hidden="true" /> Previous
              </Button>
              <span className="text-muted-foreground">
                Page {list.data.pagination.page} of {list.data.pagination.totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= list.data.pagination.totalPages} onClick={() => update({ page: String(page + 1) })}>
                Next <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}

      <CustomerFormDialog open={adding} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />
    </Page>
  );
}
