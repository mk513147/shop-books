import { Archive, ArchiveRestore, ArrowDownLeft, ArrowUpRight, BookOpenText, CheckCheck, HandCoins, History, MapPin, Pencil, Phone, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { CustomerBalances } from '@/features/customers/CustomerBalances';
import { CustomerFormDialog } from '@/features/customers/CustomerFormDialog';
import { CustomerTxnDialog } from '@/features/customers/CustomerTxnDialog';
import { dueTitle, entryDetail } from '@/features/customers/due-helpers';
import { SettleAllDialog } from '@/features/customers/SettleAllDialog';
import {
  TXN_LABELS,
  useCustomer,
  useCustomerHistory,
  useCustomerLedger,
  useOpenDues,
  useUpdateCustomer,
} from '@/features/customers/customers-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { CustomerTxnType } from '@/types/api';

const PROFILE_FIELDS: Record<string, string> = { name: 'Name', phone: 'Phone', address: 'Address', notes: 'Notes', isActive: 'Active' };
const displayProfile = (field: string, value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : field === 'isActive' ? (value ? 'Yes' : 'No') : String(value);

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const customer = useCustomer(id);
  const dues = useOpenDues(id);
  const ledger = useCustomerLedger(id, {});
  const update = useUpdateCustomer();
  const toast = useToast();
  const [txn, setTxn] = useState<{ type: CustomerTxnType; dueId?: string } | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'archive' | 'history' | 'settle' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const history = useCustomerHistory(id, dialog === 'history');

  if (customer.isPending) return <LoadingState label="Loading customer…" />;
  if (customer.isError) return <ErrorState title="Could not load this customer" error={customer.error} />;
  const c = customer.data;
  const recent = [...(ledger.data?.entries ?? [])].reverse().slice(0, 8);

  const action = (type: CustomerTxnType, label: string, Icon: typeof HandCoins, disabled: boolean, title?: string) => (
    <Button
      variant="outline"
      className="h-auto min-h-11 justify-start whitespace-normal py-2.5 text-left leading-tight"
      disabled={disabled}
      title={title}
      onClick={() => setTxn({ type })}
    >
      <Icon aria-hidden="true" /> {label}
    </Button>
  );

  return (
    <Page width="medium">
      <PageHeader
        back={{ to: '/customers', label: 'Customers' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name}
            {!c.isActive && <Badge>Archived</Badge>}
          </span>
        }
        actions={
          <Link to={`/customers/${c.id}/ledger`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <BookOpenText aria-hidden="true" /> Ledger
          </Link>
        }
      />

      {notice && (
        <p role="status" className="rounded-xl border border-primary/20 bg-primary-soft p-3 text-sm text-primary-soft-foreground">
          {notice}
        </p>
      )}

      <CustomerBalances due={c.dueBalance} advance={c.advanceBalance} />

      <div className="grid grid-cols-2 gap-2">
        {action('due', 'Record due', ArrowUpRight, !c.isActive, !c.isActive ? 'Reactivate the customer first' : undefined)}
        {action('due_payment', 'Receive payment', HandCoins, c.dueBalance === '0.00')}
        {action('advance', 'Receive advance', ArrowDownLeft, !c.isActive, !c.isActive ? 'Reactivate the customer first' : undefined)}
        {action('advance_refund', 'Refund advance', Undo2, c.advanceBalance === '0.00')}
      </div>
      {c.dueBalance !== '0.00' && (
        <Button className="w-full" variant="soft" onClick={() => setDialog('settle')}>
          <CheckCheck aria-hidden="true" /> Pay full outstanding amount ({formatInr(c.dueBalance)})
        </Button>
      )}
      {!c.isActive && (
        <p className="text-xs text-muted-foreground">Archived: new dues and advances are disabled; existing dues can still be paid and advances refunded.</p>
      )}

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Card>
          <CardHeader>
            <CardTitle>Unpaid dues</CardTitle>
          </CardHeader>
          <CardContent>
            {dues.isPending && <LoadingState />}
            {dues.isError && <ErrorState error={dues.error} />}
            {dues.data?.length === 0 && <p className="text-sm text-muted-foreground">Nothing is owed.</p>}
            <ul className="divide-y">
              {dues.data?.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0 flex-1 basis-40">
                    <Link to={`/customers/${c.id}/transactions/${d.id}`} className="block truncate text-sm font-medium hover:underline">
                      {dueTitle(d)}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(d.txnDate)} · {formatInr(d.amount)}
                      {d.paidAmount !== '0.00' && ` · ${formatInr(d.paidAmount ?? '0')} paid`}
                    </p>
                  </div>
                  <span className="flex items-center gap-2">
                    <span className="figure text-sm font-semibold text-warning">{formatInr(d.remainingAmount ?? d.amount)}</span>
                    <Button size="sm" variant="soft" onClick={() => setTxn({ type: 'due_payment', dueId: d.id })}>
                      Receive
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Recent entries</CardTitle>
            <Link to={`/customers/${c.id}/ledger`} className="text-sm text-primary hover:underline">
              Full ledger
            </Link>
          </CardHeader>
          <CardContent>
            {ledger.isPending && <LoadingState />}
            {ledger.isError && <ErrorState error={ledger.error} />}
            {ledger.data && recent.length === 0 && <p className="text-sm text-muted-foreground">No entries yet.</p>}
            <ul className="divide-y">
              {recent.map((e) => (
                <li key={e.id}>
                  <Link to={`/customers/${c.id}/transactions/${e.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-accent/40">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{TXN_LABELS[e.type]}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {formatDate(e.txnDate)}
                        {entryDetail(e) && ` · ${entryDetail(e)}`}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {!e.counted && <StatusBadge status="reversed" />}
                      <span className={cn('figure text-sm font-semibold', !e.counted && 'text-muted-foreground line-through')}>{formatInr(e.amount)}</span>
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
              {c.isActive ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
              {c.isActive ? 'Archive' : 'Reactivate'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('history')}>
              <History aria-hidden="true" /> History
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {c.phone ? (
            <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-2">
              <Phone className="size-4 text-muted-foreground" aria-hidden="true" /> {c.phone}
            </a>
          ) : (
            <p className="text-muted-foreground">No phone number</p>
          )}
          {c.address && (
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="break-words">{c.address}</span>
            </p>
          )}
          {c.notes && <p className="break-words text-muted-foreground">{c.notes}</p>}
        </CardContent>
      </Card>

      <CustomerTxnDialog customer={c} type={txn?.type ?? null} presetDueId={txn?.dueId} onClose={() => setTxn(null)} onSaved={setNotice} />
      <SettleAllDialog customer={c} open={dialog === 'settle'} onClose={() => setDialog(null)} onSaved={setNotice} />
      <CustomerFormDialog open={dialog === 'edit'} customer={c} onClose={() => setDialog(null)} onSaved={() => setNotice('Customer details saved.')} />
      <Dialog
        open={dialog === 'archive'}
        title={c.isActive ? 'Archive customer?' : 'Reactivate customer?'}
        onClose={() => {
          update.reset();
          setDialog(null);
        }}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" disabled={update.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={c.isActive ? 'destructive' : 'default'}
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: c.id, version: c.version, isActive: !c.isActive },
                  {
                    onSuccess: () => {
                      toast({ title: c.isActive ? 'Customer archived' : 'Customer reactivated', description: c.name, tone: 'success' });
                      setDialog(null);
                    },
                  },
                )
              }
            >
              {update.isPending ? (c.isActive ? 'Archiving…' : 'Reactivating…') : c.isActive ? 'Archive' : 'Reactivate'}
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          {c.isActive
            ? `“${c.name}” will be hidden from the active list and cannot get new dues or advances. The ledger and balances stay (due ${formatInr(c.dueBalance)}, advance ${formatInr(c.advanceBalance)}).`
            : `“${c.name}” can receive new dues and advances again.`}
        </p>
        {update.isError && <p role="alert" className="mt-3 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">{errorMessage(update.error)}</p>}
      </Dialog>
      <Dialog open={dialog === 'history'} title={`History: ${c.name}`} onClose={() => setDialog(null)}>
        <AuditHistory history={history} fieldLabels={PROFILE_FIELDS} display={displayProfile} />
      </Dialog>
    </Page>
  );
}
