import { Ban } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReasonDialog } from '@/components/ui/reason-dialog';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { TXN_LABELS, useCustomer, useCustomerTransaction, useCustomerTransactionHistory, useReverseCustomerTxn } from '@/features/customers/customers-api';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { CustomerTransaction, PaymentMode } from '@/types/api';

const FIELD_LABELS: Record<string, string> = { status: 'Status', reversalReason: 'Reversal reason' };
const display = (field: string, value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : field === 'paymentMode' ? (PAYMENT_MODE_LABELS[value as PaymentMode] ?? String(value)) : String(value);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 text-sm sm:grid sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** What reversing this entry does, in plain words (shown in the confirmation). */
function reverseEffect(t: CustomerTransaction): string {
  switch (t.type) {
    case 'due':
      return `The customer's due goes down by ${formatInr(t.amount)}.`;
    case 'due_payment':
      return `The customer's due goes back up by ${formatInr(t.amount)}.`;
    case 'advance':
      return `The customer's advance goes down by ${formatInr(t.amount)}.`;
    case 'advance_refund':
      return `The customer's advance goes back up by ${formatInr(t.amount)}.`;
  }
}

export function CustomerTransactionPage() {
  const { id = '', txnId = '' } = useParams();
  const customer = useCustomer(id);
  const txn = useCustomerTransaction(id, txnId);
  const history = useCustomerTransactionHistory(id, txnId);
  const reverse = useReverseCustomerTxn();
  const [reversing, setReversing] = useState(false);

  if (txn.isPending) return <LoadingState label="Loading entry…" />;
  if (txn.isError) return <ErrorState title="Could not load this entry" error={txn.error} />;
  const t = txn.data;
  const reversed = t.status === 'reversed';
  const name = customer.data?.name ?? 'Customer';

  return (
    <Page width="narrow">
      <PageHeader
        back={{ to: `/customers/${id}`, label: name }}
        title={TXN_LABELS[t.type]}
        description={`${name} · ${formatDate(t.txnDate)}`}
        actions={
          !reversed && (
            <Button variant="outline" size="sm" onClick={() => setReversing(true)}>
              <Ban aria-hidden="true" /> Reverse
            </Button>
          )
        }
      />
      {reversed && (
        <div role="status" className="rounded-xl border border-destructive/25 bg-destructive-soft p-4 text-sm">
          <p className="font-medium text-destructive">Reversed — this entry no longer counts.</p>
          <p className="mt-1">
            By {t.reversedBy?.name} on {t.reversedAt && formatDateTime(t.reversedAt)}. Reason: {t.reversalReason}
          </p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 pt-4 md:pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Amount</p>
              <p className={cn('figure text-3xl font-semibold tracking-tight', reversed && 'text-muted-foreground line-through')}>{formatInr(t.amount)}</p>
            </div>
            <StatusBadge status={t.status} />
          </div>
          {t.type === 'due' && t.paidAmount !== null && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p className="rounded-lg bg-surface-muted px-3 py-2.5">
                <span className="block text-xs text-muted-foreground">Paid so far</span>
                <strong className="figure">{formatInr(t.paidAmount)}</strong>
              </p>
              <p className="rounded-lg bg-surface-muted px-3 py-2.5">
                <span className="block text-xs text-muted-foreground">Still due</span>
                <strong className={cn('figure', t.remainingAmount !== '0.00' && 'text-warning')}>{formatInr(t.remainingAmount ?? '0')}</strong>
              </p>
            </div>
          )}
          <dl className="divide-y border-t">
            {t.due && (
              <Row label="Pays the due of">
                <Link to={`/customers/${id}/transactions/${t.due.id}`} className="text-primary hover:underline">
                  {formatDate(t.due.txnDate)} · {t.due.categoryName ?? t.due.description ?? 'Due'} ({formatInr(t.due.amount)})
                </Link>
              </Row>
            )}
            {t.paymentMode && <Row label="Paid by">{PAYMENT_MODE_LABELS[t.paymentMode]}</Row>}
            {t.type === 'due' && (
              <Row label="Category">
                {t.category ? `${t.category.name}${t.category.isActive ? '' : ' (archived)'}` : '— (recorded before categories)'}
              </Row>
            )}
            {t.settlementId && <Row label="Recorded as">Part of a full outstanding payment (several dues settled at once)</Row>}
            {(t.type !== 'due' || t.description) && <Row label="Description">{t.description ?? '—'}</Row>}
            <Row label="Reference">{t.reference ?? '—'}</Row>
            <Row label="Notes">{t.notes ?? '—'}</Row>
            <Row label="Recorded by">
              {t.createdBy.name} · {formatDateTime(t.createdAt)}
            </Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <AuditHistory history={history} fieldLabels={FIELD_LABELS} display={display} />
        </CardContent>
      </Card>

      <ReasonDialog
        open={reversing}
        title="Reverse this entry?"
        description={`${reverseEffect(t)} The entry stays visible in the ledger, crossed out. This cannot be undone; record a new entry if needed.`}
        confirmLabel="Reverse entry"
        destructive
        pending={reverse.isPending}
        error={reverse.isError ? errorMessage(reverse.error) : null}
        onCancel={() => {
          setReversing(false);
          reverse.reset();
        }}
        onConfirm={(reason) =>
          reverse.mutate({ customerId: id, id: t.id, reason, version: t.version }, { onSuccess: () => setReversing(false) })
        }
      />
    </Page>
  );
}
