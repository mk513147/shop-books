import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { MoneyInput } from '@/components/finance/MoneyInput';
import { PaymentModeChips } from '@/components/finance/PaymentModeChips';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/select';
import { AllocationEditor, draftProblems, draftToAllocations, type AllocationDraft } from '@/features/supplierPayments/AllocationEditor';
import { useCreatePayment, useOpenBills, useSupplierBalance } from '@/features/supplierPayments/payments-api';
import { SupplierPicker } from '@/features/suppliers/SupplierPicker';
import { useSupplier } from '@/features/suppliers/suppliers-api';
import { ApiError } from '@/lib/api-client';
import { todayInKolkata } from '@/lib/dates';
import { optionalText, pastOrTodayDate, positiveMoney } from '@/lib/form-schemas';
import { newIdempotencyKey } from '@/lib/ids';
import { formatInr, MONEY_INPUT } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PaymentMode, SupplierRef } from '@/types/api';

const schema = z.object({
  supplierId: z.string().min(1, 'Choose the supplier you paid'),
  amount: positiveMoney('amount paid'),
  paymentMode: z.string().min(1, 'Choose how you paid'),
  paymentDate: pastOrTodayDate,
  reference: optionalText(100),
  notes: optionalText(1000),
});
type FormValues = z.infer<typeof schema>;

function Section({ title, children, description }: { title: string; children: ReactNode; description?: ReactNode }) {
  return (
    <Card className="space-y-4 p-4 md:p-5">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

/** Record a supplier payment (not an expense) and, optionally, which bills it settles. */
export function NewSupplierPaymentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const presetId = params.get('supplierId');
  const preset = useSupplier(presetId);
  const [supplier, setSupplier] = useState<SupplierRef | null>(null);
  const [draft, setDraft] = useState<AllocationDraft>({});
  const [serverAllocErrors, setServerAllocErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const inFlight = useRef(false);
  const create = useCreatePayment();

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { supplierId: '', amount: '', paymentMode: '', paymentDate: todayInKolkata(), reference: '', notes: '' },
  });

  useEffect(() => {
    if (preset.data && !supplier) {
      setSupplier({ id: preset.data.id, name: preset.data.name, isActive: preset.data.isActive });
      setValue('supplierId', preset.data.id);
    }
  }, [preset.data, supplier, setValue]);

  const supplierId = supplier?.id ?? null;
  const bills = useOpenBills(supplierId);
  const balance = useSupplierBalance(supplierId);
  const amount = watch('amount').trim();
  const available = MONEY_INPUT.test(amount) ? amount : null;

  function chooseSupplier(next: SupplierRef | null) {
    setSupplier(next);
    setValue('supplierId', next?.id ?? '', { shouldValidate: Boolean(next) });
    setDraft({});
    setServerAllocErrors({});
  }

  if (presetId && preset.isPending) return <LoadingState label="Loading supplier…" />;

  return (
    <Page width="medium">
      <PageHeader
        title="Record supplier payment"
        description="Money paid to a supplier. It is not a new expense: it settles bills you already recorded."
        back={supplier ? { to: `/suppliers/${supplier.id}`, label: supplier.name } : { to: '/supplier-payments', label: 'Supplier payments' }}
      />
      {preset.isError && <ErrorState title="Could not load the supplier" error={preset.error} />}

      <form
        noValidate
        className="space-y-4 md:space-y-5"
        onSubmit={handleSubmit(async (values) => {
          if (inFlight.current) return;
          const billList = bills.data ?? [];
          const problems = draftProblems(billList, draft, available);
          if (Object.keys(problems).length > 0) {
            setFormError('Check the bill amounts below.');
            return;
          }
          inFlight.current = true;
          setFormError(null);
          setServerAllocErrors({});
          const allocations = draftToAllocations(billList, draft);
          try {
            const payment = await create.mutateAsync({
              idempotencyKey,
              supplierId: values.supplierId,
              amount: values.amount.trim(),
              paymentMode: values.paymentMode as PaymentMode,
              paymentDate: values.paymentDate,
              reference: values.reference.trim() || null,
              notes: values.notes.trim() || null,
              allocations,
            });
            navigate(`/supplier-payments/${payment.id}`, { state: { notice: 'Payment recorded.' } });
          } catch (err) {
            if (err instanceof ApiError && err.details?.length) {
              const allocErrors: Record<string, string> = {};
              for (const d of err.details) {
                const m = /^allocations\.(\d+)\./.exec(d.path);
                if (m) allocErrors[allocations[Number(m[1])]?.expenseId ?? ''] = d.message;
                else if (d.path in values) setError(d.path as keyof FormValues, { message: d.message });
              }
              setServerAllocErrors(allocErrors);
            }
            setFormError(errorMessage(err));
          } finally {
            inFlight.current = false;
          }
        })}
      >
        <div className="grid gap-4 md:gap-5 lg:grid-cols-2 lg:items-start">
          <Section title="Payment">
            <Field id="supplier" label="Supplier" error={errors.supplierId?.message}>
              <SupplierPicker
                id="supplier"
                value={supplier}
                onChange={chooseSupplier}
                noneLabel={null}
                invalid={Boolean(errors.supplierId)}
                describedBy={errors.supplierId ? 'supplier-error' : undefined}
              />
            </Field>
            {balance.data && (
              <p className="text-sm text-muted-foreground">
                Currently payable: <strong className="figure text-warning">{formatInr(balance.data.payable)}</strong>
                {balance.data.unallocated !== '0.00' && (
                  <> · unallocated payments: <strong className="figure">{formatInr(balance.data.unallocated)}</strong></>
                )}
              </p>
            )}
            <Field id="amount" label="Amount paid" error={errors.amount?.message}>
              <MoneyInput id="amount" large {...errorProps('amount', errors.amount)} {...register('amount')} />
            </Field>
            <PaymentModeChips idPrefix="paymentMode" value={watch('paymentMode')} registration={register('paymentMode')} error={errors.paymentMode?.message} />
          </Section>

          <Section title="Details">
            <Field id="paymentDate" label="Payment date" error={errors.paymentDate?.message}>
              <Input id="paymentDate" type="date" max={todayInKolkata()} {...errorProps('paymentDate', errors.paymentDate)} {...register('paymentDate')} />
            </Field>
            <Field id="reference" label="Reference / transaction no. (optional)" hint="UPI reference, cheque number, receipt…" error={errors.reference?.message}>
              <Input id="reference" autoComplete="off" {...errorProps('reference', errors.reference)} {...register('reference')} />
            </Field>
            {showNotes ? (
              <Field id="notes" label="Notes (optional)" error={errors.notes?.message}>
                <Textarea id="notes" {...errorProps('notes', errors.notes)} {...register('notes')} />
              </Field>
            ) : (
              <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={() => setShowNotes(true)}>
                + Add notes
              </button>
            )}
          </Section>
        </div>

        <Section
          title="Which bills does it pay? (optional)"
          description="Allocated amounts reduce what is payable on those bills. Anything not allocated stays visible as an unallocated payment and can be allocated later."
        >
          {!supplier && <p className="text-sm text-muted-foreground">Choose a supplier first.</p>}
          {supplier && bills.isPending && <LoadingState label="Loading unpaid bills…" />}
          {supplier && bills.isError && <ErrorState error={bills.error} onRetry={() => void bills.refetch()} />}
          {supplier && bills.data && (
            <AllocationEditor
              bills={bills.data}
              available={available}
              draft={draft}
              onChange={(next) => {
                setDraft(next);
                setServerAllocErrors({});
              }}
              serverErrors={serverAllocErrors}
              disabled={isSubmitting}
            />
          )}
        </Section>

        {formError && (
          <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive-soft p-4 text-sm text-destructive">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Link to={supplier ? `/suppliers/${supplier.id}` : '/supplier-payments'} className={buttonVariants({ variant: 'ghost', size: 'lg' })}>
            Cancel
          </Link>
          <Button type="submit" size="lg" className={cn('md:min-w-44')} loading={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Record payment'}
          </Button>
        </div>
      </form>
    </Page>
  );
}
