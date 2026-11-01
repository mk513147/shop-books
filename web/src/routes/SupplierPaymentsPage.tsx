import { ChevronLeft, ChevronRight, Plus, Search, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ExportButton } from '@/features/exports/ExportButton';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { useSupplierPayments } from '@/features/supplierPayments/payments-api';
import { useSupplier } from '@/features/suppliers/suppliers-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

export function SupplierPaymentsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const get = (k: string) => params.get(k) ?? '';
  const supplierId = get('supplierId');
  const page = Math.max(1, Number(get('page')) || 1);
  const [search, setSearch] = useState(get('q'));
  const supplier = useSupplier(supplierId || null);
  const list = useSupplierPayments({
    supplierId: supplierId || undefined,
    status: get('status') || 'active',
    allocation: get('allocation') || undefined,
    from: get('from') || undefined,
    to: get('to') || undefined,
    q: get('q') || undefined,
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
        title="Supplier payments"
        description="Money paid to suppliers against their bills. Payments are not expenses."
        actions={
          <>
            <ExportButton
              report="supplier-payments"
              params={{
                supplierId: supplierId || undefined,
                status: get('status') || 'active',
                allocation: get('allocation') || undefined,
                from: get('from') || undefined,
                to: get('to') || undefined,
                q: get('q') || undefined,
              }}
            />
            <Link to={`/supplier-payments/new${supplierId ? `?supplierId=${supplierId}` : ''}`} className={buttonVariants()}>
              <Plus aria-hidden="true" /> Record payment
            </Link>
          </>
        }
      />

      {supplierId && (
        <p className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-primary-soft px-3 py-1 text-primary-soft-foreground">
            Supplier: {supplier.data?.name ?? '…'}
          </span>
          <button type="button" className="inline-flex size-8 items-center justify-center rounded-full hover:bg-accent" aria-label="Show all suppliers" onClick={() => update({ supplierId: '' })}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto]">
        <form
          role="search"
          className="relative sm:col-span-2 lg:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search payments"
            placeholder="Search reference, notes or supplier"
            enterKeyHint="search"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value === '' && get('q')) update({ q: '' });
            }}
          />
        </form>
        <Select aria-label="Status" value={get('status') || 'active'} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value })}>
          <option value="active">Counted payments</option>
          <option value="reversed">Reversed</option>
          <option value="all">All</option>
        </Select>
        <Select aria-label="Allocation" value={get('allocation')} onChange={(e) => update({ allocation: e.target.value })}>
          <option value="">Any allocation</option>
          <option value="open">With unallocated amount</option>
          <option value="unallocated">Not allocated</option>
          <option value="partial">Partly allocated</option>
          <option value="full">Fully allocated</option>
        </Select>
        <Input type="date" aria-label="From date" value={get('from')} onChange={(e) => update({ from: e.target.value })} />
        <Input type="date" aria-label="To date" value={get('to')} onChange={(e) => update({ to: e.target.value })} />
      </div>

      {list.isPending && <LoadingState label="Loading payments…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatTile label={`Paid (${list.data.totals.count})`} amount={list.data.totals.amount} />
            <StatTile label="Allocated" amount={list.data.totals.allocated} />
            <StatTile label="Unallocated" amount={list.data.totals.unallocated} tone={list.data.totals.unallocated !== '0.00' ? 'warning' : 'muted'} />
          </div>

          {list.data.items.length === 0 ? (
            <EmptyState icon={Wallet} title="No payments found">
              Record a payment when you pay a supplier for bills you have already entered as expenses.
            </EmptyState>
          ) : (
            <>
              <ul className="space-y-2 md:hidden">
                {list.data.items.map((p) => (
                  <li key={p.id}>
                    <Link to={`/supplier-payments/${p.id}`} className="block space-y-1 rounded-xl border bg-card p-4 shadow-card">
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 truncate font-medium">{p.supplier.name}</p>
                        <p className={cn('figure shrink-0 font-semibold', p.status === 'reversed' && 'text-muted-foreground line-through')}>
                          {formatInr(p.amount)}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(p.paymentDate)} · {PAYMENT_MODE_LABELS[p.paymentMode]}
                        {p.reference && ` · ${p.reference}`}
                      </p>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        {p.status === 'reversed' ? (
                          <StatusBadge status="reversed" />
                        ) : (
                          <span className={cn(p.unallocatedAmount !== '0.00' ? 'text-warning' : 'text-muted-foreground')}>
                            {p.unallocatedAmount === '0.00' ? 'Fully allocated' : `${formatInr(p.unallocatedAmount)} unallocated`}
                          </span>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
                <table className="w-full text-sm">
                  <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-4 py-2.5 font-medium">Supplier</th>
                      <th className="px-4 py-2.5 font-medium">Mode / reference</th>
                      <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                      <th className="px-4 py-2.5 text-right font-medium">Allocated</th>
                      <th className="px-4 py-2.5 text-right font-medium">Unallocated</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {list.data.items.map((p) => (
                      <tr key={p.id} className="cursor-pointer hover:bg-accent/50" onClick={() => navigate(`/supplier-payments/${p.id}`)}>
                        <td className="whitespace-nowrap px-4 py-3">{formatDate(p.paymentDate)}</td>
                        <td className="px-4 py-3">
                          <Link to={`/supplier-payments/${p.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                            {p.supplier.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {PAYMENT_MODE_LABELS[p.paymentMode]}
                          {p.reference && <span className="block text-xs">{p.reference}</span>}
                        </td>
                        <td className={cn('figure whitespace-nowrap px-4 py-3 text-right font-medium', p.status === 'reversed' && 'line-through')}>
                          {formatInr(p.amount)}
                        </td>
                        <td className="figure whitespace-nowrap px-4 py-3 text-right">{formatInr(p.allocatedAmount)}</td>
                        <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', p.unallocatedAmount !== '0.00' && 'text-warning')}>
                          {formatInr(p.unallocatedAmount)}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={p.status} />
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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= list.data.pagination.totalPages}
                    onClick={() => update({ page: String(page + 1) })}
                  >
                    Next <ChevronRight aria-hidden="true" />
                  </Button>
                </nav>
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}
