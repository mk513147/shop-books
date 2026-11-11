import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PaymentModeChips } from '@/components/finance/PaymentModeChips';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/select';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { ApiError } from '@/lib/api-client';
import { formatDate, todayInKolkata } from '@/lib/dates';
import { optionalText, pastOrTodayDate } from '@/lib/form-schemas';
import { newIdempotencyKey } from '@/lib/ids';
import { formatInr } from '@/lib/money';
import type { Customer, PaymentMode } from '@/types/api';
import { useOpenDues, useSettleAllDues } from './customers-api';
import { dueTitle, outstandingOf, previewFifo } from './due-helpers';

const schema = z.object({
  txnDate: pastOrTodayDate,
  paymentMode: z.string().min(1, 'Choose how the money was paid'),
  reference: optionalText(100),
  notes: optionalText(1000),
});
type Values = z.infer<typeof schema>;

/**
 * "Pay full outstanding amount": the customer pays everything they owe at once. The amount is the
 * total of the open dues; it is split over them oldest first (FIFO) and recorded in ONE server
 * transaction (all dues settled, or nothing). A confirmation step shows exactly what will happen.
 */
export function SettleAllDialog({
  customer,
  open,
  onClose,
  onSaved,
}: {
  customer: Customer;
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const dues = useOpenDues(customer.id, open);
  const settle = useSettleAllDues();
  const [key, setKey] = useState(newIdempotencyKey);
  const [confirming, setConfirming] = useState<Values | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const inFlight = useRef(false);
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { txnDate: todayInKolkata(), paymentMode: '', reference: '', notes: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({ txnDate: todayInKolkata(), paymentMode: '', reference: '', notes: '' });
    setConfirming(null);
    setChanged(null);
    setKey(newIdempotencyKey());
    settle.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openDues = dues.data ?? [];
  const total = outstandingOf(openDues);
  const lines = previewFifo(openDues, total);

  async function send(v: Values) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await settle.mutateAsync({
        customerId: customer.id,
        idempotencyKey: key,
        input: {
          amount: total,
          txnDate: v.txnDate,
          paymentMode: v.paymentMode as PaymentMode,
          reference: v.reference.trim() || null,
          notes: v.notes.trim() || null,
        },
      });
      onSaved(`Full outstanding payment recorded: ${formatInr(total)} settled ${lines.length} due${lines.length === 1 ? '' : 's'}.`);
      onClose();
    } catch (err) {
      setConfirming(null);
      if (err instanceof ApiError && (err.code === 'OUTSTANDING_CHANGED' || err.code === 'NOTHING_DUE')) {
        // Someone else recorded something meanwhile: show the new total; nothing was recorded.
        setChanged(err.message);
        setKey(newIdempotencyKey());
        settle.reset();
        await dues.refetch();
      }
    } finally {
      inFlight.current = false;
    }
  }

  const busy = settle.isPending;
  return (
    <Dialog
      open={open}
      title={confirming ? 'Confirm full payment' : 'Pay full outstanding amount'}
      description={confirming ? undefined : customer.name}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => (confirming ? setConfirming(null) : onClose())}>
            {confirming ? 'Back' : 'Cancel'}
          </Button>
          {confirming ? (
            <Button loading={busy} onClick={() => void send(confirming)}>
              {busy ? 'Saving…' : `Record ${formatInr(total)}`}
            </Button>
          ) : (
            <Button type="submit" form="settle-all-form" disabled={dues.isPending || lines.length === 0}>
              Continue
            </Button>
          )}
        </DialogActions>
      }
    >
      {dues.isPending && <LoadingState label="Loading dues…" />}
      {dues.isError && <ErrorState error={dues.error} onRetry={() => void dues.refetch()} />}
      {dues.isSuccess && lines.length === 0 && <p className="text-sm text-muted-foreground">This customer has no unpaid dues.</p>}

      {dues.isSuccess && lines.length > 0 && (
        <div className="space-y-4 text-sm">
          {changed && (
            <p role="alert" className="rounded-lg border border-warning/30 bg-warning-soft p-3">
              {changed} The total below is up to date.
            </p>
          )}
          <div className="rounded-lg bg-surface-muted p-3">
            <p className="text-muted-foreground">Total outstanding</p>
            <p className="figure text-2xl font-semibold" data-testid="settle-total">
              {formatInr(total)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Settles {lines.length} due{lines.length === 1 ? '' : 's'}, oldest first. Each due keeps its own record and payment.
            </p>
          </div>

          <ul className="divide-y rounded-lg border" aria-label="How the payment is allocated" data-testid="settle-allocation">
            {lines.map((l) => (
              <li key={l.due.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{dueTitle(l.due)}</span>
                  <span className="block text-xs text-muted-foreground">{formatDate(l.due.txnDate)}</span>
                </span>
                <span className="figure shrink-0 font-semibold">{formatInr(l.pay)}</span>
              </li>
            ))}
          </ul>

          {confirming ? (
            <div className="space-y-2">
              <p>
                Record <strong className="figure">{formatInr(total)}</strong> received from <strong>{customer.name}</strong> on{' '}
                {formatDate(confirming.txnDate)} by {PAYMENT_MODE_LABELS[confirming.paymentMode as PaymentMode]}?
              </p>
              <p className="text-muted-foreground">Their due becomes ₹0.00. Their advance ({formatInr(customer.advanceBalance)}) is not touched.</p>
              {settle.isError && (
                <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-destructive">
                  {errorMessage(settle.error)}
                </p>
              )}
            </div>
          ) : (
            <form id="settle-all-form" noValidate className="space-y-4" onSubmit={handleSubmit((v) => setConfirming(v))}>
              <PaymentModeChips
                idPrefix="settle-mode"
                legend="Received by"
                value={watch('paymentMode')}
                registration={register('paymentMode')}
                error={errors.paymentMode?.message}
              />
              <Field id="settle-date" label="Payment date" error={errors.txnDate?.message}>
                <Input id="settle-date" type="date" max={todayInKolkata()} {...errorProps('settle-date', errors.txnDate)} {...register('txnDate')} />
              </Field>
              <Field id="settle-reference" label="Reference (optional)" error={errors.reference?.message}>
                <Input id="settle-reference" autoComplete="off" {...register('reference')} />
              </Field>
              <Field id="settle-notes" label="Notes (optional)" error={errors.notes?.message}>
                <Textarea id="settle-notes" {...register('notes')} />
              </Field>
              {settle.isError && !changed && (
                <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-destructive">
                  {errorMessage(settle.error)}
                </p>
              )}
            </form>
          )}
        </div>
      )}
    </Dialog>
  );
}
