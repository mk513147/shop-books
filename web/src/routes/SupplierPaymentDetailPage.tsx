import { zodResolver } from '@hookform/resolvers/zod';
import { Ban, Link2, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useParams } from 'react-router-dom';
import { z } from 'zod';
import { PaymentModeChips } from '@/components/finance/PaymentModeChips';
import { StatTile } from '@/components/finance/StatTile';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ReasonDialog } from '@/components/ui/reason-dialog';
import { Textarea } from '@/components/ui/select';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { AllocationEditor, draftProblems, draftToAllocations, type AllocationDraft } from '@/features/supplierPayments/AllocationEditor';
import {
  useAllocatePayment,
  useOpenBills,
  usePaymentHistory,
  useReleaseAllocation,
  useReversePayment,
  useSupplierPayment,
  useUpdatePayment,
} from '@/features/supplierPayments/payments-api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, todayInKolkata } from '@/lib/dates';
import { optionalText, pastOrTodayDate } from '@/lib/form-schemas';
import { newIdempotencyKey } from '@/lib/ids';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PaymentAllocation, PaymentMode, SupplierPaymentDetail } from '@/types/api';

const FIELD_LABELS: Record<string, string> = {
  paymentDate: 'Date',
  amount: 'Amount',
  paymentMode: 'Payment mode',
  reference: 'Reference',
  notes: 'Notes',
  allocatedAmount: 'Allocated',
  status: 'Status',
  reversalReason: 'Reversal reason',
};

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'amount' || field === 'allocatedAmount') return formatInr(String(value));
  if (field === 'paymentDate') return formatDate(String(value));
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

const editSchema = z.object({
  paymentDate: pastOrTodayDate,
  paymentMode: z.string().min(1, 'Choose how you paid'),
  reference: optionalText(100),
  notes: optionalText(1000),
});

function EditDialog({ payment, open, onClose }: { payment: SupplierPaymentDetail; open: boolean; onClose: () => void }) {
  const update = useUpdatePayment();
  const { register, handleSubmit, watch, formState } = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    values: {
      paymentDate: payment.paymentDate,
      paymentMode: payment.paymentMode,
      reference: payment.reference ?? '',
      notes: payment.notes ?? '',
    },
  });
  const close = () => {
    update.reset();
    onClose();
  };
  const errors = formState.errors;
  return (
    <Dialog
      open={open}
      title="Correct payment details"
      description="The amount and supplier cannot be changed. If they are wrong, reverse this payment and record it again."
      onClose={close}
      dismissible={!update.isPending}
      footer={
        <DialogActions>
          <Button variant="outline" onClick={close} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="edit-payment" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogActions>
      }
    >
      <form
        id="edit-payment"
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit((v) =>
          update.mutate(
            {
              id: payment.id,
              version: payment.version,
              paymentDate: v.paymentDate,
              paymentMode: v.paymentMode,
              reference: v.reference.trim() || null,
              notes: v.notes.trim() || null,
            },
            { onSuccess: close },
          ),
        )}
      >
        <Field id="edit-date" label="Payment date" error={errors.paymentDate?.message}>
          <Input id="edit-date" type="date" max={todayInKolkata()} {...errorProps('edit-date', errors.paymentDate)} {...register('paymentDate')} />
        </Field>
        <PaymentModeChips idPrefix="edit-mode" value={watch('paymentMode')} registration={register('paymentMode')} error={errors.paymentMode?.message} />
        <Field id="edit-ref" label="Reference (optional)" error={errors.reference?.message}>
          <Input id="edit-ref" autoComplete="off" {...register('reference')} />
        </Field>
        <Field id="edit-notes" label="Notes (optional)" error={errors.notes?.message}>
          <Textarea id="edit-notes" {...register('notes')} />
        </Field>
        {update.isError && (
          <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
            {errorMessage(update.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function AllocateDialog({ payment, open, onClose }: { payment: SupplierPaymentDetail; open: boolean; onClose: () => void }) {
  const bills = useOpenBills(open ? payment.supplier.id : null);
  const allocate = useAllocatePayment();
  const [draft, setDraft] = useState<AllocationDraft>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  // One key per opening of the dialog: a double tap cannot allocate twice.
  const [key, setKey] = useState(newIdempotencyKey);
  const close = () => {
    allocate.reset();
    setDraft({});
    setServerErrors({});
    setKey(newIdempotencyKey());
    onClose();
  };
  const list = bills.data ?? [];
  const allocations = draftToAllocations(list, draft);
  const invalid = Object.keys(draftProblems(list, draft, payment.unallocatedAmount)).length > 0;
  return (
    <Dialog
      open={open}
      title="Allocate to bills"
      description={`${formatInr(payment.unallocatedAmount)} of this payment is not allocated yet.`}
      onClose={close}
      dismissible={!allocate.isPending}
      size="lg"
      footer={
        <DialogActions>
          <Button variant="outline" onClick={close} disabled={allocate.isPending}>
            Cancel
          </Button>
          <Button
            disabled={allocate.isPending || allocations.length === 0 || invalid}
            onClick={() =>
              allocate.mutate(
                { id: payment.id, allocations, idempotencyKey: key },
                {
                  onSuccess: close,
                  onError: (err) => {
                    const next: Record<string, string> = {};
                    if (err instanceof ApiError) {
                      for (const d of err.details ?? []) {
                        const m = /^allocations\.(\d+)\./.exec(d.path);
                        if (m) next[allocations[Number(m[1])]?.expenseId ?? ''] = d.message;
                      }
                    }
                    setServerErrors(next);
                    setKey(newIdempotencyKey());
                  },
                },
              )
            }
          >
            {allocate.isPending ? 'Saving…' : 'Allocate'}
          </Button>
        </DialogActions>
      }
    >
      {bills.isPending && <LoadingState label="Loading unpaid bills…" />}
      {bills.isError && <ErrorState error={bills.error} onRetry={() => void bills.refetch()} />}
      {bills.data && (
        <AllocationEditor
          bills={bills.data}
          available={payment.unallocatedAmount}
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setServerErrors({});
          }}
          serverErrors={serverErrors}
          disabled={allocate.isPending}
        />
      )}
      {allocate.isError && (
        <p role="alert" className="mt-3 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          {errorMessage(allocate.error)}
        </p>
      )}
    </Dialog>
  );
}

export function SupplierPaymentDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const payment = useSupplierPayment(id);
  const history = usePaymentHistory(id);
  const reverse = useReversePayment();
  const release = useReleaseAllocation();
  const [dialog, setDialog] = useState<'edit' | 'allocate' | 'reverse' | null>(null);
  const [releasing, setReleasing] = useState<PaymentAllocation | null>(null);
  const [showReleased, setShowReleased] = useState(false);

  if (payment.isPending) return <LoadingState label="Loading payment…" />;
  if (payment.isError) return <ErrorState title="Could not load this payment" error={payment.error} />;
  const p = payment.data;
  const reversed = p.status === 'reversed';
  const activeAllocations = p.allocations.filter((a) => a.status === 'active');
  const shownAllocations = showReleased ? p.allocations : activeAllocations;

  return (
    <Page width="narrow">
      <PageHeader
        back={{ to: `/suppliers/${p.supplier.id}`, label: p.supplier.name }}
        title={`Payment to ${p.supplier.name}`}
        description={`${formatDate(p.paymentDate)} · ${PAYMENT_MODE_LABELS[p.paymentMode]}`}
        actions={
          !reversed && (
            <>
              <Button variant="outline" size="sm" onClick={() => setDialog('edit')}>
                <Pencil aria-hidden="true" /> Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDialog('reverse')}>
                <Ban aria-hidden="true" /> Reverse
              </Button>
            </>
          )
        }
      />

      {notice && !reversed && (
        <p role="status" className="rounded-xl border border-primary/20 bg-primary-soft p-3 text-sm text-primary-soft-foreground">
          {notice}
        </p>
      )}
      {reversed && (
        <div role="status" className="rounded-xl border border-destructive/25 bg-destructive-soft p-4 text-sm">
          <p className="font-medium text-destructive">Reversed — this payment no longer counts.</p>
          <p className="mt-1">
            By {p.reversedBy?.name} on {p.reversedAt && formatDateTime(p.reversedAt)}. Reason: {p.reversalReason}
          </p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 pt-4 md:pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Amount paid</p>
              <p className={cn('figure text-3xl font-semibold tracking-tight', reversed && 'text-muted-foreground line-through')}>
                {formatInr(p.amount)}
              </p>
            </div>
            <StatusBadge status={p.status} />
          </div>
          {!reversed && (
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Allocated to bills" amount={p.allocatedAmount} />
              <StatTile label="Unallocated" amount={p.unallocatedAmount} tone={p.unallocatedAmount !== '0.00' ? 'warning' : 'muted'} />
            </div>
          )}
          <dl className="divide-y border-t">
            <Row label="Supplier">
              <Link to={`/suppliers/${p.supplier.id}`} className="text-primary hover:underline">
                {p.supplier.name}
              </Link>
              {!p.supplier.isActive && <span className="text-muted-foreground"> (archived)</span>}
            </Row>
            <Row label="Reference">{p.reference ?? '—'}</Row>
            <Row label="Notes">{p.notes ?? '—'}</Row>
            <Row label="Recorded by">
              {p.createdBy.name} · {formatDateTime(p.createdAt)}
            </Row>
            <Row label="Last changed">
              {p.updatedBy.name} · {formatDateTime(p.updatedAt)}
            </Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Bills paid by this payment</CardTitle>
          {!reversed && p.unallocatedAmount !== '0.00' && (
            <Button size="sm" variant="soft" onClick={() => setDialog('allocate')}>
              <Link2 aria-hidden="true" /> Allocate {formatInr(p.unallocatedAmount)}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {shownAllocations.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {reversed ? 'No active allocations (released when the payment was reversed).' : 'Not allocated to any bill yet.'}
            </p>
          )}
          <ul className="space-y-2">
            {shownAllocations.map((a) => (
              <li key={a.id} className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-3', a.status === 'released' && 'bg-surface-muted')}>
                <div className="min-w-0 flex-1 basis-48">
                  <Link to={`/expenses/${a.expense.id}`} className="block truncate text-sm font-medium text-primary hover:underline">
                    {a.expense.description}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    Bill of {formatDate(a.expense.expenseDate)}
                    {a.expense.invoiceReference && ` · ${a.expense.invoiceReference}`} · {formatInr(a.expense.amount)}
                  </p>
                  {a.status === 'released' && (
                    <p className="mt-0.5 text-xs break-words text-muted-foreground">
                      Released by {a.releasedBy?.name} · {a.releaseReason}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('figure text-sm font-semibold', a.status === 'released' && 'text-muted-foreground line-through')}>
                    {formatInr(a.amount)}
                  </span>
                  {a.status === 'released' && <StatusBadge status="released" />}
                  {a.status === 'active' && !reversed && (
                    <Button size="sm" variant="ghost" onClick={() => setReleasing(a)}>
                      Release
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {p.allocations.length > activeAllocations.length && (
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowReleased((v) => !v)}>
              {showReleased ? 'Hide released allocations' : `Show released allocations (${p.allocations.length - activeAllocations.length})`}
            </button>
          )}
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

      <EditDialog payment={p} open={dialog === 'edit'} onClose={() => setDialog(null)} />
      <AllocateDialog payment={p} open={dialog === 'allocate'} onClose={() => setDialog(null)} />
      <ReasonDialog
        open={dialog === 'reverse'}
        title="Reverse this payment?"
        description={`The payment of ${formatInr(p.amount)} will stop counting and its allocations (${formatInr(p.allocatedAmount)}) will be released, so those bills become payable again. The original record stays visible. This cannot be undone.`}
        confirmLabel="Reverse payment"
        destructive
        pending={reverse.isPending}
        error={reverse.isError ? errorMessage(reverse.error) : null}
        onCancel={() => {
          setDialog(null);
          reverse.reset();
        }}
        onConfirm={(reason) => reverse.mutate({ id: p.id, reason, version: p.version }, { onSuccess: () => setDialog(null) })}
      />
      <ReasonDialog
        open={releasing !== null}
        title="Release this allocation?"
        description={
          releasing
            ? `${formatInr(releasing.amount)} will no longer pay “${releasing.expense.description}”. The bill becomes payable again and the amount returns to this payment's unallocated balance.`
            : ''
        }
        confirmLabel="Release allocation"
        destructive
        pending={release.isPending}
        error={release.isError ? errorMessage(release.error) : null}
        onCancel={() => {
          setReleasing(null);
          release.reset();
        }}
        onConfirm={(reason) =>
          releasing && release.mutate({ id: p.id, allocationId: releasing.id, reason }, { onSuccess: () => setReleasing(null) })
        }
      />
    </Page>
  );
}
