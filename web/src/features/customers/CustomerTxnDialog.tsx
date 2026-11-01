import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { MoneyInput } from '@/components/finance/MoneyInput';
import { PaymentModeChips } from '@/components/finance/PaymentModeChips';
import { errorMessage, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, Textarea } from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { formatDate, todayInKolkata } from '@/lib/dates';
import { optionalText, pastOrTodayDate, positiveMoney } from '@/lib/form-schemas';
import { newIdempotencyKey } from '@/lib/ids';
import { formatInr, fromPaise, MONEY_INPUT, toPaise } from '@/lib/money';
import type { Customer, CustomerTxnType, PaymentMode } from '@/types/api';
import { useOpenDues, useRecordCustomerTxn } from './customers-api';

const COPY: Record<CustomerTxnType, { title: string; help: string; amountLabel: string; submit: string; notice: string }> = {
  due: {
    title: 'Record a due',
    help: 'An amount the customer owes the shop. It increases their due only; their advance is not touched.',
    amountLabel: 'Amount owed',
    submit: 'Record due',
    notice: 'Due recorded',
  },
  due_payment: {
    title: 'Receive a due payment',
    help: 'Money received against one due. It reduces their due only; it is never taken from their advance.',
    amountLabel: 'Amount received',
    submit: 'Record payment',
    notice: 'Payment recorded',
  },
  advance: {
    title: 'Receive an advance',
    help: 'Money received before it is owed. It is kept as an advance and is NOT used to pay dues automatically.',
    amountLabel: 'Advance received',
    submit: 'Record advance',
    notice: 'Advance recorded',
  },
  advance_refund: {
    title: 'Refund advance',
    help: 'Give advance money back to the customer. A refund can never be more than the available advance.',
    amountLabel: 'Amount to refund',
    submit: 'Continue',
    notice: 'Refund recorded',
  },
};

const schema = z.object({
  amount: positiveMoney('amount'),
  txnDate: pastOrTodayDate,
  paymentMode: z.string(),
  dueId: z.string(),
  description: optionalText(500),
  reference: optionalText(100),
  notes: optionalText(1000),
});
type Values = z.infer<typeof schema>;

/**
 * One dialog for the four customer ledger entries. Server-side checks are authoritative; the
 * limits shown here (remaining due, available advance) are for guidance only. Refunds ask for an
 * explicit confirmation before anything is sent.
 */
export function CustomerTxnDialog({
  customer,
  type,
  presetDueId,
  onClose,
  onSaved,
}: {
  customer: Customer;
  type: CustomerTxnType | null;
  presetDueId?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const open = type !== null;
  const t = type ?? 'due';
  const copy = COPY[t];
  const record = useRecordCustomerTxn();
  const dues = useOpenDues(customer.id, open && t === 'due_payment');
  const [key, setKey] = useState(newIdempotencyKey);
  const [confirming, setConfirming] = useState<Values | null>(null);
  const [showMore, setShowMore] = useState(false);
  const inFlight = useRef(false);
  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { amount: '', txnDate: todayInKolkata(), paymentMode: '', dueId: '', description: '', reference: '', notes: '' },
  });

  useEffect(() => {
    if (open) {
      reset({ amount: '', txnDate: todayInKolkata(), paymentMode: '', dueId: presetDueId ?? '', description: '', reference: '', notes: '' });
      setConfirming(null);
      setShowMore(false);
      setKey(newIdempotencyKey());
      record.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type, presetDueId]);

  const dueId = watch('dueId');
  const selectedDue = dues.data?.find((d) => d.id === dueId);
  const amount = watch('amount').trim();
  const limit = t === 'due_payment' ? (selectedDue?.remainingAmount ?? null) : t === 'advance_refund' ? customer.advanceBalance : null;
  const overLimit = limit !== null && MONEY_INPUT.test(amount) && toPaise(amount) > toPaise(limit);

  async function send(v: Values) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await record.mutateAsync({
        customerId: customer.id,
        type: t,
        idempotencyKey: key,
        input: {
          amount: v.amount.trim(),
          txnDate: v.txnDate,
          ...(t !== 'due' ? { paymentMode: v.paymentMode as PaymentMode } : {}),
          ...(t === 'due_payment' ? { dueId: v.dueId } : {}),
          description: v.description.trim() || null,
          reference: v.reference.trim() || null,
          notes: v.notes.trim() || null,
        },
      });
      onSaved(`${COPY[t].notice}: ${formatInr(v.amount.trim())}.`);
      onClose();
    } catch (err) {
      setConfirming(null);
      for (const d of err instanceof ApiError ? (err.details ?? []) : []) {
        if (d.path in v) setError(d.path as keyof Values, { message: d.message });
      }
    } finally {
      inFlight.current = false;
    }
  }

  const onSubmit = handleSubmit((v) => {
    let failed = false;
    if (t !== 'due' && !v.paymentMode) {
      setError('paymentMode', { message: 'Choose how the money was paid' });
      failed = true;
    }
    if (t === 'due' && !v.description.trim()) {
      setError('description', { message: 'Say what the due is for' });
      failed = true;
    }
    if (t === 'due_payment' && !v.dueId) {
      setError('dueId', { message: 'Choose which due is being paid' });
      failed = true;
    }
    if (failed) return;
    if (t === 'advance_refund') setConfirming(v);
    else void send(v);
  });

  return (
    <Dialog
      open={open}
      title={confirming ? 'Confirm refund' : copy.title}
      description={confirming ? undefined : `${customer.name}`}
      onClose={onClose}
      dismissible={!record.isPending}
      footer={
        <DialogActions>
          <Button variant="outline" disabled={record.isPending} onClick={() => (confirming ? setConfirming(null) : onClose())}>
            {confirming ? 'Back' : 'Cancel'}
          </Button>
          {confirming ? (
            <Button variant="destructive" disabled={record.isPending} onClick={() => void send(confirming)}>
              {record.isPending ? 'Saving…' : `Refund ${formatInr(confirming.amount.trim())}`}
            </Button>
          ) : (
            <Button type="submit" form="customer-txn-form" disabled={record.isPending || overLimit}>
              {record.isPending ? 'Saving…' : copy.submit}
            </Button>
          )}
        </DialogActions>
      }
    >
      {confirming ? (
        <div className="space-y-3 text-sm">
          <p>
            Refund <strong className="figure">{formatInr(confirming.amount.trim())}</strong> of advance to <strong>{customer.name}</strong>?
          </p>
          <p className="rounded-lg bg-surface-muted p-3">
            Advance now <strong className="figure">{formatInr(customer.advanceBalance)}</strong> → after refund{' '}
            <strong className="figure">{formatInr(fromPaise(toPaise(customer.advanceBalance) - toPaise(confirming.amount.trim())))}</strong>.
            Their due ({formatInr(customer.dueBalance)}) does not change.
          </p>
          {record.isError && <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-destructive">{errorMessage(record.error)}</p>}
        </div>
      ) : (
        <form id="customer-txn-form" noValidate className="space-y-4" onSubmit={onSubmit}>
          <p className="text-sm text-muted-foreground">{copy.help}</p>

          {t === 'due_payment' && (
            <Field id="txn-due" label="Which due is being paid?" error={errors.dueId?.message}>
              {dues.isPending ? (
                <LoadingState label="Loading dues…" />
              ) : dues.data && dues.data.length > 0 ? (
                <Select id="txn-due" {...errorProps('txn-due', errors.dueId)} {...register('dueId')}>
                  <option value="">Choose a due…</option>
                  {dues.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {formatDate(d.txnDate)} · {d.description} · {formatInr(d.remainingAmount ?? d.amount)} left
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm text-muted-foreground">This customer has no unpaid dues.</p>
              )}
            </Field>
          )}

          <Field
            id="txn-amount"
            label={copy.amountLabel}
            error={errors.amount?.message ?? (overLimit ? `At most ${formatInr(limit!)}` : undefined)}
            hint={
              limit !== null
                ? t === 'advance_refund'
                  ? `Available advance: ${formatInr(limit)}`
                  : `Still due on this entry: ${formatInr(limit)}`
                : undefined
            }
          >
            <MoneyInput id="txn-amount" large {...errorProps('txn-amount', errors.amount ?? (overLimit ? true : undefined))} {...register('amount')} />
          </Field>
          {t === 'due_payment' && selectedDue?.remainingAmount && (
            <Button size="sm" variant="soft" onClick={() => setValue('amount', selectedDue.remainingAmount!, { shouldValidate: true })}>
              Full remaining {formatInr(selectedDue.remainingAmount)}
            </Button>
          )}
          {t === 'advance_refund' && customer.advanceBalance !== '0.00' && (
            <Button size="sm" variant="soft" onClick={() => setValue('amount', customer.advanceBalance, { shouldValidate: true })}>
              Whole advance {formatInr(customer.advanceBalance)}
            </Button>
          )}

          {t !== 'due' && (
            <PaymentModeChips
              idPrefix="txn-mode"
              legend={t === 'advance_refund' ? 'Refunded by' : 'Received by'}
              value={watch('paymentMode')}
              registration={register('paymentMode')}
              error={errors.paymentMode?.message}
            />
          )}

          {t === 'due' && (
            <Field id="txn-description" label="What is it for?" error={errors.description?.message}>
              <Input id="txn-description" autoComplete="off" placeholder="e.g. Goods taken on credit" {...errorProps('txn-description', errors.description)} {...register('description')} />
            </Field>
          )}

          <Field id="txn-date" label="Date" error={errors.txnDate?.message}>
            <Input id="txn-date" type="date" max={todayInKolkata()} {...errorProps('txn-date', errors.txnDate)} {...register('txnDate')} />
          </Field>

          {showMore ? (
            <>
              <Field id="txn-reference" label="Reference (optional)" error={errors.reference?.message}>
                <Input id="txn-reference" autoComplete="off" {...register('reference')} />
              </Field>
              {t !== 'due' && (
                <Field id="txn-note-desc" label="Description (optional)" error={errors.description?.message}>
                  <Input id="txn-note-desc" autoComplete="off" {...register('description')} />
                </Field>
              )}
              <Field id="txn-notes" label="Notes (optional)" error={errors.notes?.message}>
                <Textarea id="txn-notes" {...register('notes')} />
              </Field>
            </>
          ) : (
            <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={() => setShowMore(true)}>
              + Reference and notes
            </button>
          )}

          {record.isError && (
            <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
              {errorMessage(record.error)}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

