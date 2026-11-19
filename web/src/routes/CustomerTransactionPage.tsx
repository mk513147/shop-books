import { Ban } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
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
import { formatInr, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { CustomerTransaction, PaymentMode } from '@/types/api';

const FIELD_LABELS: Record<string, string> = { status: 'Status', reversalReason: 'Reversal reason' };
const display = (field: string, value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : field === 'paymentMode' ? (PAYMENT_MODE_LABELS[value as PaymentMode] ?? String(value)) : String(value);

function Row({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-sm font-medium">{children}</dd>
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

  if (txn.isPending) return <LoadingState label="Loading entry…" skeleton="detail" />;
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
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setReversing(true)}>
              <Ban aria-hidden="true" /> Reverse
            </Button>
          )
        }
      />
      {reversed && (
        <div role="status" className="callout callout-danger text-foreground">
          <p className="font-semibold text-destructive">Reversed — this entry no longer counts.</p>
          <p className="mt-1 text-muted-foreground">
            By {t.reversedBy?.name} on {t.reversedAt && formatDateTime(t.reversedAt)}. Reason: {t.reversalReason}
          </p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-5 pt-4 md:pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">Amount</p>
              <p className={cn('figure mt-1 text-2xl font-semibold tracking-tight md:text-3xl', reversed && 'text-muted-foreground line-through')}>
                {formatInr(t.amount)}
              </p>
            </div>
            <StatusBadge status={t.status} />
          </div>
          {t.type === 'due' && t.paidAmount !== null && (
            <div className="grid grid-cols-2 gap-2 md:gap-3">
              <StatTile label="Paid so far" amount={t.paidAmount} tone={t.paidAmount !== '0.00' ? 'accent' : 'muted'} />
              <StatTile
                label="Still due"
                amount={t.remainingAmount ?? '0'}
                tone={toPaise(t.remainingAmount ?? '0') > 0n ? 'warning' : 'muted'}
                hint={toPaise(t.remainingAmount ?? '0') > 0n ? 'Owes the shop' : 'Settled'}
              />
            </div>
          )}
          <dl className="grid gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-2">
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
            {t.settlementId && (
              <Row label="Recorded as" wide>
                Part of a full outstanding payment (several dues settled at once)
              </Row>
            )}
            {(t.type !== 'due' || t.description) && (
              <Row label="Description" wide>
                {t.description ?? '—'}
              </Row>
            )}
            <Row label="Reference">{t.reference ?? '—'}</Row>
            <Row label="Recorded by">
              {t.createdBy.name} <span className="font-normal text-muted-foreground">· {formatDateTime(t.createdAt)}</span>
            </Row>
            <Row label="Notes" wide>
              <span className="whitespace-pre-line font-normal">{t.notes ?? '—'}</span>
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
