import { Archive, ArchiveRestore, BookOpenText, History, MapPin, Pencil, Phone, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { useOpenBills, useSupplierBalance, useSupplierPayments } from '@/features/supplierPayments/payments-api';
import { SupplierFormDialog } from '@/features/suppliers/SupplierForm';
import { useSupplier } from '@/features/suppliers/suppliers-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import { ArchiveDialog, HistoryDialog } from './SuppliersPage';

/** One supplier: contact details, derived balances, unpaid bills and recent payments. */
export function SupplierDetailPage() {
  const { id = '' } = useParams();
  const supplier = useSupplier(id);
  const balance = useSupplierBalance(id);
  const bills = useOpenBills(id);
  const payments = useSupplierPayments({ supplierId: id, status: 'all', pageSize: 5 });
  const [dialog, setDialog] = useState<'edit' | 'archive' | 'history' | null>(null);

  if (supplier.isPending) return <LoadingState label="Loading supplier…" skeleton="detail" />;
  if (supplier.isError) return <ErrorState title="Could not load this supplier" error={supplier.error} />;
  const s = supplier.data;

  return (
    <Page width="medium">
      <PageHeader
        back={{ to: '/suppliers', label: 'Suppliers' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name}
            {!s.isActive && <StatusBadge status="archived" />}
          </span>
        }
        actions={
          <>
            <Link to={`/supplier-payments/new?supplierId=${s.id}`} className={buttonVariants({ size: 'sm' })}>
              <Plus aria-hidden="true" /> Record payment
            </Link>
            <Link to={`/suppliers/${s.id}/ledger`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <BookOpenText aria-hidden="true" /> Ledger
            </Link>
          </>
        }
      />

      {balance.isError && <ErrorState error={balance.error} onRetry={() => void balance.refetch()} />}
      {balance.data && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
          <StatTile
            label="Payable now"
            amount={balance.data.payable}
            tone={balance.data.payable !== '0.00' ? 'warning' : 'muted'}
            hint={balance.data.payable !== '0.00' ? 'Still owed on bills' : 'Nothing due'}
          />
          <StatTile
            label="Unallocated payments"
            amount={balance.data.unallocated}
            tone={balance.data.unallocated !== '0.00' ? 'info' : 'muted'}
            hint="Paid, not yet matched to bills"
          />
          <StatTile label="Bills (active)" amount={balance.data.totalBills} hint={`${balance.data.billCount} bill(s)`} />
          <StatTile label="Payments made" amount={balance.data.totalPayments} hint={`${balance.data.paymentCount} payment(s)`} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Unpaid bills</CardTitle>
            <Link to={`/expenses?supplierId=${s.id}`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              All expenses
            </Link>
          </CardHeader>
          <CardContent>
            {bills.isPending && <LoadingState skeleton="list" />}
            {bills.isError && <ErrorState error={bills.error} />}
            {bills.data?.length === 0 && <p className="text-sm text-muted-foreground">Nothing is payable to this supplier.</p>}
            <ul className="divide-y">
              {bills.data?.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <Link to={`/expenses/${b.id}`} className="block truncate text-sm font-semibold hover:underline">
                      {b.description}
                    </Link>
                    <p className="figure text-xs text-muted-foreground">
                      {formatDate(b.expenseDate)} · bill {formatInr(b.amount)}
                    </p>
                  </div>
                  <span className="shrink-0 text-right">
                    <span className="figure block text-sm font-semibold text-warning">{formatInr(b.payable)}</span>
                    <span className="block text-xs font-medium text-warning">due</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Recent payments</CardTitle>
            <Link to={`/supplier-payments?supplierId=${s.id}&status=all`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              All payments
            </Link>
          </CardHeader>
          <CardContent>
            {payments.isPending && <LoadingState skeleton="list" />}
            {payments.isError && <ErrorState error={payments.error} />}
            {payments.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No payments recorded yet.</p>}
            <ul className="divide-y">
              {payments.data?.items.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/supplier-payments/${p.id}`}
                    className="-mx-2 flex min-h-12 items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{formatDate(p.paymentDate)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {PAYMENT_MODE_LABELS[p.paymentMode]}
                        {p.reference && ` · ${p.reference}`}
                        {p.status === 'active' && p.unallocatedAmount !== '0.00' && ` · ${formatInr(p.unallocatedAmount)} unallocated`}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {p.status === 'reversed' && <StatusBadge status="reversed" />}
                      <span className={cn('figure text-sm font-semibold', p.status === 'reversed' && 'text-muted-foreground line-through')}>
                        {formatInr(p.amount)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Details</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog('edit')}>
              <Pencil aria-hidden="true" /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog('archive')}>
              {s.isActive ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
              {s.isActive ? 'Archive' : 'Reactivate'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('history')}>
              <History aria-hidden="true" /> History
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {s.phone ? (
              <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} className="flex min-h-9 items-center gap-2 font-medium">
                <Phone className="size-4 text-muted-foreground" aria-hidden="true" /> {s.phone}
              </a>
            ) : (
              <p className="flex min-h-9 items-center text-muted-foreground">No phone number</p>
            )}
            {s.address && (
              <p className="flex items-start gap-2 sm:pt-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="break-words">{s.address}</span>
              </p>
            )}
          </div>
          {s.notes && <p className="break-words rounded-lg bg-surface-muted px-3 py-2.5 text-muted-foreground">{s.notes}</p>}
          {s.categories.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Usual categories</p>
              <div className="flex flex-wrap gap-1.5">
                {s.categories.map((c) => (
                  <Badge key={c.id} tone={c.isActive ? 'accent' : 'neutral'}>
                    {c.name}
                    {!c.isActive && ' (archived)'}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {(s.brands?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Brands supplied</p>
              <div className="flex flex-wrap gap-1.5">
                {s.brands.map((b) => (
                  <Badge key={b.id} tone={b.isActive ? 'accent' : 'neutral'}>
                    {b.name}
                    {!b.isActive && ' (archived)'}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <SupplierFormDialog open={dialog === 'edit'} supplier={s} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />
      <ArchiveDialog supplier={dialog === 'archive' ? s : null} onClose={() => setDialog(null)} />
      <HistoryDialog supplier={dialog === 'history' ? s : null} onClose={() => setDialog(null)} />
    </Page>
  );
}
