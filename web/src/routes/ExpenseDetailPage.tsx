import { Pencil, RotateCcw, Ban } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { PaymentStatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReasonDialog } from '@/components/ui/reason-dialog';
import { useToast } from '@/components/ui/toast';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { ExpenseDocuments, ExpenseDocumentsOnRecord } from '@/features/documents/ExpenseDocuments';
import { billAttachmentsEnabled } from '@/features/documents/attachments-feature';
import {
  PAYMENT_MODE_LABELS,
  useExpense,
  useExpenseHistory,
  useRestoreExpense,
  useVoidExpense,
} from '@/features/expenses/expenses-api';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn, expenseLabel } from '@/lib/utils';
import type { AuditHistoryEntry, PaymentMode } from '@/types/api';

const FIELD_LABELS: Record<string, string> = {
  expenseDate: 'Date',
  supplierName: 'Supplier',
  categoryName: 'Primary category',
  categories: 'Categories',
  brands: 'Brands',
  description: 'Description',
  amount: 'Amount',
  amountPaid: 'Amount paid at purchase',
  paymentMode: 'Payment mode',
  payments: 'Payments',
  invoiceReference: 'Invoice ref.',
  status: 'Status',
  voidReason: 'Void reason',
};

/** Audit snapshots store payments as "upi:1000.00,cash:1500.00". */
function paymentsText(value: string): string {
  return value
    .split(',')
    .map((part) => {
      const [mode = '', amount = '0'] = part.split(':');
      return `${PAYMENT_MODE_LABELS[mode as PaymentMode] ?? mode} ${formatInr(amount)}`;
    })
    .join(' + ');
}

/**
 * Since migration 0010 an edit to the payments also records the summary `paymentMode` (the first
 * payment's method). When the same entry shows the full "Payments" change, that line is redundant.
 * Older entries (no `payments` field) keep their "Payment mode" line. Stored records are unchanged.
 */
export function hideRedundantChange(change: AuditHistoryEntry['changes'][number], entry: AuditHistoryEntry): boolean {
  return change.field === 'paymentMode' && entry.changes.some((c) => c.field === 'payments');
}

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'amount' || field === 'amountPaid') return formatInr(String(value));
  if (field === 'expenseDate') return formatDate(String(value));
  if (field === 'payments') return paymentsText(String(value));
  if (field === 'paymentMode') return PAYMENT_MODE_LABELS[value as PaymentMode] ?? String(value);
  return String(value);
}

function Row({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className="min-w-0 rounded-lg border bg-surface-muted px-3 py-2.5">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('figure mt-0.5 truncate text-base font-semibold', tone === 'warning' && 'text-warning')}>{value}</p>
    </div>
  );
}

export function ExpenseDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const expense = useExpense(id);
  const history = useExpenseHistory(id);
  const voidMutation = useVoidExpense();
  const restoreMutation = useRestoreExpense();
  const toast = useToast();
  const [dialog, setDialog] = useState<'void' | 'restore' | null>(null);

  // Rules of Hooks: every hook above is called on every render. Nothing below this line may call
  // a hook, because the loading/error renders return early (React error #310 otherwise).
  if (expense.isPending) return <LoadingState label="Loading expense…" skeleton="detail" />;
  if (expense.isError) return <ErrorState title="Could not load this expense" error={expense.error} />;
  const e = expense.data;
  const voided = e.status === 'voided';
  const mutation = dialog === 'restore' ? restoreMutation : voidMutation;
  const showLegacy = e.legacySupplierName !== null && e.legacySupplierName !== e.supplier?.name;

  return (
    <Page width="narrow">
      <PageHeader
        back={{ to: '/expenses', label: 'Expenses' }}
        title={expenseLabel(e)}
        actions={
          voided ? (
            <Button variant="outline" size="sm" onClick={() => setDialog('restore')}>
              <RotateCcw aria-hidden="true" /> Restore
            </Button>
          ) : (
            <>
              <Link to={`/expenses/${e.id}/edit`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <Pencil aria-hidden="true" /> Edit
              </Link>
              <Button variant="outline" size="sm" onClick={() => setDialog('void')}>
                <Ban aria-hidden="true" /> Void
              </Button>
            </>
          )
        }
      />

      {notice && !voided && (
        <p role="status" className="callout callout-success">
          {notice}
        </p>
      )}
      {voided && (
        <div role="status" className="callout callout-danger p-4 text-foreground">
          <p className="font-medium text-destructive">Voided — excluded from totals.</p>
          <p className="mt-1">
            By {e.voidedBy?.name} on {e.voidedAt && formatDateTime(e.voidedAt)}. Reason: {e.voidReason}
          </p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 pt-4 md:pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">Total amount</p>
              <p className={cn('figure mt-1 text-2xl font-semibold tracking-tight md:text-3xl', voided && 'text-muted-foreground line-through')}>
                {formatInr(e.amount)}
              </p>
            </div>
            <PaymentStatusBadge amount={e.amount} outstanding={e.outstanding} voided={voided} className="mt-0.5" />
          </div>
          <div className={cn('grid gap-2', e.allocatedPayments !== '0.00' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2')}>
            <Figure label="Paid at purchase" value={formatInr(e.amountPaid)} />
            {e.allocatedPayments !== '0.00' && <Figure label="Paid by supplier payments" value={formatInr(e.allocatedPayments)} />}
            <Figure label="Outstanding" value={formatInr(e.outstanding)} tone={e.outstanding !== '0.00' ? 'warning' : undefined} />
          </div>
          {e.supplier && e.outstanding !== '0.00' && !voided && (
            <Link to={`/supplier-payments/new?supplierId=${e.supplier.id}`} className={buttonVariants({ variant: 'soft', size: 'sm' })}>
              Record a payment to {e.supplier.name}
            </Link>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Row label="Date">{formatDate(e.expenseDate)}</Row>
            <Row label="Supplier">
              {e.supplier ? (
                <>
                  <Link to={`/suppliers/${e.supplier.id}`} className="text-primary underline-offset-4 hover:underline">
                    {e.supplier.name}
                  </Link>
                  {!e.supplier.isActive && <span className="font-normal text-muted-foreground"> (archived)</span>}
                </>
              ) : (
                '—'
              )}
              {showLegacy && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">Originally typed as “{e.legacySupplierName}”</span>}
            </Row>
            <Row label={(e.categories?.length ?? 1) > 1 ? 'Categories' : 'Category'} wide>
              <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="expense-categories">
                {(e.categories?.length ? e.categories : [e.category]).map((c, i, all) => (
                  <li key={c.id}>
                    <Badge tone={i === 0 && all.length > 1 ? 'accent' : 'neutral'}>
                      {c.name}
                      {!c.isActive && ' (archived)'}
                      {i === 0 && all.length > 1 && ' · primary'}
                    </Badge>
                  </li>
                ))}
              </ul>
              {(e.categories?.length ?? 1) > 1 && (
                <span className="mt-1.5 block text-xs font-normal text-muted-foreground">Labels only: the amount is counted once, under the primary category.</span>
              )}
            </Row>
            <Row label="Brands" wide>
              {e.brands?.length ? (
                <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="expense-brands">
                  {e.brands.map((b) => (
                    <li key={b.id}>
                      <Badge tone="neutral">
                        {b.name}
                        {!b.isActive && ' (archived)'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                '—'
              )}
            </Row>
            <Row label={e.payments.length > 1 ? 'Payments' : 'Payment mode'} wide={e.payments.length > 1}>
              {e.payments.length === 0 ? (
                '—'
              ) : e.payments.length === 1 ? (
                PAYMENT_MODE_LABELS[e.payments[0]!.paymentMode]
              ) : (
                <ul className="mt-1 divide-y rounded-lg border sm:max-w-sm">
                  {e.payments.map((p, i) => (
                    <li key={i} className="flex justify-between gap-3 px-3 py-2">
                      <span className="text-muted-foreground">{PAYMENT_MODE_LABELS[p.paymentMode]}</span>
                      <span className="figure">{formatInr(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            <Row label="Invoice ref.">{e.invoiceReference ?? '—'}</Row>
            <Row label="Recorded by">
              {e.createdBy.name}
              <span className="font-normal text-muted-foreground"> · {formatDateTime(e.createdAt)}</span>
            </Row>
            <Row label="Last changed">
              {e.updatedBy.name}
              <span className="font-normal text-muted-foreground"> · {formatDateTime(e.updatedAt)}</span>
            </Row>
          </dl>
        </CardContent>
      </Card>

      {billAttachmentsEnabled() ? (
        <Card>
          <CardHeader>
            <CardTitle>Bill photos and documents</CardTitle>
          </CardHeader>
          <CardContent>
            <ExpenseDocuments expenseId={e.id} voided={voided} />
          </CardContent>
        </Card>
      ) : (
        <ExpenseDocumentsOnRecord expenseId={e.id} voided={voided} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <AuditHistory history={history} fieldLabels={FIELD_LABELS} display={displayValue} hideChange={hideRedundantChange} />
        </CardContent>
      </Card>

      <ReasonDialog
        open={dialog !== null}
        title={dialog === 'restore' ? 'Restore this expense?' : 'Void this expense?'}
        description={
          dialog === 'restore'
            ? 'The expense will count in totals again. The void stays in the history.'
            : 'The expense is kept with all its values but excluded from totals and cannot be edited until restored.'
        }
        confirmLabel={dialog === 'restore' ? 'Restore expense' : 'Void expense'}
        destructive={dialog === 'void'}
        pending={mutation.isPending}
        error={mutation.isError ? errorMessage(mutation.error) : null}
        onCancel={() => {
          setDialog(null);
          mutation.reset();
        }}
        onConfirm={(reason) =>
          mutation.mutate(
            { id: e.id, reason, version: e.version },
            {
              onSuccess: () => {
                toast({ title: dialog === 'restore' ? 'Expense restored' : 'Expense voided', tone: 'success' });
                setDialog(null);
              },
            },
          )
        }
      />
    </Page>
  );
}
