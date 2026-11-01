import { Pencil, RotateCcw, Ban } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReasonDialog } from '@/components/ui/reason-dialog';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { ExpenseDocuments } from '@/features/documents/ExpenseDocuments';
import {
  PAYMENT_MODE_LABELS,
  useExpense,
  useExpenseHistory,
  useRestoreExpense,
  useVoidExpense,
} from '@/features/expenses/expenses-api';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PaymentMode } from '@/types/api';

const FIELD_LABELS: Record<string, string> = {
  expenseDate: 'Date',
  supplierName: 'Supplier',
  categoryName: 'Category',
  description: 'Description',
  amount: 'Amount',
  amountPaid: 'Amount paid at purchase',
  paymentMode: 'Payment mode',
  invoiceReference: 'Invoice ref.',
  status: 'Status',
  voidReason: 'Void reason',
};

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'amount' || field === 'amountPaid') return formatInr(String(value));
  if (field === 'expenseDate') return formatDate(String(value));
  if (field === 'paymentMode') return PAYMENT_MODE_LABELS[value as PaymentMode] ?? String(value);
  return String(value);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 text-sm sm:grid sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-muted px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('figure truncate text-base font-semibold', tone === 'warning' && 'text-warning')}>{value}</p>
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
  const [dialog, setDialog] = useState<'void' | 'restore' | null>(null);

  if (expense.isPending) return <LoadingState label="Loading expense…" />;
  if (expense.isError) return <ErrorState title="Could not load this expense" error={expense.error} />;
  const e = expense.data;
  const voided = e.status === 'voided';
  const mutation = dialog === 'restore' ? restoreMutation : voidMutation;
  const showLegacy = e.legacySupplierName !== null && e.legacySupplierName !== e.supplier?.name;

  return (
    <Page width="narrow">
      <PageHeader
        back={{ to: '/expenses', label: 'Expenses' }}
        title={e.description}
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
        <p role="status" className="rounded-xl border border-primary/20 bg-primary-soft p-3 text-sm text-primary-soft-foreground">
          {notice}
        </p>
      )}
      {voided && (
        <div role="status" className="rounded-xl border border-destructive/25 bg-destructive-soft p-4 text-sm">
          <p className="font-medium text-destructive">Voided — excluded from totals.</p>
          <p className="mt-1">
            By {e.voidedBy?.name} on {e.voidedAt && formatDateTime(e.voidedAt)}. Reason: {e.voidReason}
          </p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 pt-4 md:pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Total amount</p>
              <p className={cn('figure text-3xl font-semibold tracking-tight', voided && 'text-muted-foreground line-through')}>
                {formatInr(e.amount)}
              </p>
            </div>
            <Badge tone={voided ? 'danger' : 'accent'}>{voided ? 'Voided' : 'Active'}</Badge>
          </div>
          <div className={cn('grid gap-2', e.allocatedPayments !== '0.00' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2')}>
            <Figure label="Paid at purchase" value={formatInr(e.amountPaid)} />
            {e.allocatedPayments !== '0.00' && <Figure label="Paid by supplier payments" value={formatInr(e.allocatedPayments)} />}
            <Figure label="Outstanding" value={formatInr(e.outstanding)} tone={e.outstanding !== '0.00' ? 'warning' : undefined} />
          </div>
          {e.supplier && e.outstanding !== '0.00' && !voided && (
            <Link to={`/supplier-payments/new?supplierId=${e.supplier.id}`} className="inline-block text-sm text-primary hover:underline">
              Record a payment to {e.supplier.name}
            </Link>
          )}
          <dl className="divide-y border-t">
            <Row label="Date">{formatDate(e.expenseDate)}</Row>
            <Row label="Supplier">
              {e.supplier ? (
                <>
                  <Link to={`/suppliers/${e.supplier.id}`} className="text-primary hover:underline">
                    {e.supplier.name}
                  </Link>
                  {!e.supplier.isActive && <span className="text-muted-foreground"> (archived)</span>}
                </>
              ) : (
                '—'
              )}
              {showLegacy && <span className="block text-xs text-muted-foreground">Originally typed as “{e.legacySupplierName}”</span>}
            </Row>
            <Row label="Category">
              {e.category.name}
              {!e.category.isActive && <span className="text-muted-foreground"> (archived)</span>}
            </Row>
            <Row label="Payment mode">{e.paymentMode ? PAYMENT_MODE_LABELS[e.paymentMode] : '—'}</Row>
            <Row label="Invoice ref.">{e.invoiceReference ?? '—'}</Row>
            <Row label="Recorded by">
              {e.createdBy.name} · {formatDateTime(e.createdAt)}
            </Row>
            <Row label="Last changed">
              {e.updatedBy.name} · {formatDateTime(e.updatedAt)}
            </Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bill photos and documents</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseDocuments expenseId={e.id} voided={voided} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <AuditHistory history={history} fieldLabels={FIELD_LABELS} display={displayValue} />
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
        onConfirm={(reason) => mutation.mutate({ id: e.id, reason, version: e.version }, { onSuccess: () => setDialog(null) })}
      />
    </Page>
  );
}
