import { zodResolver } from '@hookform/resolvers/zod';
import { Lightbulb } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DocumentPicker, usePendingFiles } from '@/features/documents/DocumentPicker';
import { MAX_DOCUMENTS_PER_EXPENSE } from '@/features/documents/limits';
import { SupplierFormDialog } from '@/features/suppliers/SupplierForm';
import { SupplierPicker } from '@/features/suppliers/SupplierPicker';
import { useLinkSupplierCategory, useSupplier } from '@/features/suppliers/suppliers-api';
import { ApiError } from '@/lib/api-client';
import { todayInKolkata } from '@/lib/dates';
import { formatInr, MONEY_INPUT, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Category, Expense, ExpenseInput, PaymentMode, SupplierRef } from '@/types/api';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES } from './expenses-api';

const money = (label: string) =>
  z.string().trim().min(1, `Enter the ${label}`).regex(MONEY_INPUT, 'Use digits only, e.g. 1250 or 1250.50');

// Mirrors the server rules for fast feedback; the server re-validates everything.
const schema = z
  .object({
    amount: money('total amount').refine((v) => !MONEY_INPUT.test(v) || toPaise(v) > 0n, 'Must be more than zero'),
    amountPaid: money('amount paid'),
    paymentMode: z.string(),
    supplierId: z.string(),
    categoryId: z.string().min(1, 'Choose a category'),
    description: z.string().trim().min(1, 'Describe the expense').max(500, 'At most 500 characters'),
    expenseDate: z
      .string()
      .min(1, 'Choose a date')
      .refine((v) => v <= todayInKolkata(), 'The date cannot be in the future'),
    invoiceReference: z.string().trim().max(100, 'At most 100 characters'),
  })
  .superRefine((v, ctx) => {
    if (!MONEY_INPUT.test(v.amount) || !MONEY_INPUT.test(v.amountPaid)) return;
    if (toPaise(v.amountPaid) > toPaise(v.amount)) {
      ctx.addIssue({ code: 'custom', path: ['amountPaid'], message: 'Cannot be more than the total amount' });
    }
    if (toPaise(v.amountPaid) > 0n && !v.paymentMode) {
      ctx.addIssue({ code: 'custom', path: ['paymentMode'], message: 'Choose how it was paid' });
    }
  });
type FormValues = z.infer<typeof schema>;

export function toFormValues(expense?: Expense): FormValues {
  if (!expense) {
    return {
      amount: '',
      amountPaid: '0',
      paymentMode: '',
      supplierId: '',
      categoryId: '',
      description: '',
      expenseDate: todayInKolkata(),
      invoiceReference: '',
    };
  }
  return {
    amount: expense.amount,
    amountPaid: expense.amountPaid,
    paymentMode: expense.paymentMode ?? '',
    supplierId: expense.supplier?.id ?? '',
    categoryId: expense.category.id,
    description: expense.description,
    expenseDate: expense.expenseDate,
    invoiceReference: expense.invoiceReference ?? '',
  };
}

function toInput(v: FormValues): ExpenseInput {
  return {
    expenseDate: v.expenseDate,
    supplierId: v.supplierId || null,
    categoryId: v.categoryId,
    description: v.description.trim(),
    amount: v.amount.trim(),
    amountPaid: v.amountPaid.trim(),
    paymentMode: (v.paymentMode || null) as PaymentMode | null,
    invoiceReference: v.invoiceReference.trim() || null,
  };
}

const paiseToString = (p: bigint) => `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;

function Section({ step, title, children, className }: { step: number; title: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-4 md:p-5', className)}>
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary-soft text-xs text-primary-soft-foreground">
          {step}
        </span>
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

interface ExpenseFormProps {
  initial?: Expense;
  /** Active categories, plus the expense's current category if it has since been archived. */
  categories: Category[];
  submitLabel: string;
  cancelTo: string;
  /**
   * `baseVersion` is the version of `initial` WHEN THE FORM WAS OPENED, even if newer data has
   * arrived since. Sending it keeps optimistic concurrency honest: a stale form keeps getting 409
   * until the user reloads, instead of silently overwriting someone else's change.
   */
  onSubmit: (input: ExpenseInput, baseVersion: number | undefined) => Promise<Expense>;
  /**
   * Called once the expense is saved AND every selected file is uploaded (or the user chose to
   * continue without the failed ones). Files are uploaded only after the expense itself was saved.
   */
  onDone: (expense: Expense, notice: string) => void;
}

export function ExpenseForm({ initial, categories, submitLabel, cancelTo, onSubmit, onDone }: ExpenseFormProps) {
  const [formError, setFormError] = useState<{ message: string; conflict: boolean } | null>(null);
  const pending = usePendingFiles();
  // Set once the expense is saved but some files failed to upload: the form then offers a retry.
  const [saved, setSaved] = useState<Expense | null>(null);
  const savedNotice = initial ? 'Changes saved.' : 'Expense saved.';

  async function finishUploads(expense: Expense) {
    const failed = await pending.uploadAll(expense.id);
    if (failed === 0) onDone(expense, pending.files.length > 0 ? `${savedNotice} Documents uploaded.` : savedNotice);
    else setSaved(expense);
  }
  const inFlight = useRef(false);
  const baseVersion = useRef(initial?.version);
  const [supplier, setSupplier] = useState<SupplierRef | null>(initial?.supplier ?? null);
  const [addSupplier, setAddSupplier] = useState<{ name: string } | null>(null);
  const [dismissedLink, setDismissedLink] = useState<string | null>(null);
  const linkCategory = useLinkSupplierCategory();
  const supplierDetail = useSupplier(supplier?.id ?? null);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toFormValues(initial) });

  const amount = watch('amount').trim();
  const amountPaid = watch('amountPaid').trim();
  const paymentMode = watch('paymentMode');
  const categoryId = watch('categoryId');
  const amountValid = MONEY_INPUT.test(amount);
  const paidValid = MONEY_INPUT.test(amountPaid);
  // Supplier payments already allocated to this bill (edit only) also reduce what is outstanding.
  const allocated = initial ? toPaise(initial.allocatedPayments) : 0n;
  const outstanding =
    amountValid && paidValid && toPaise(amountPaid) + allocated <= toPaise(amount) ? toPaise(amount) - toPaise(amountPaid) - allocated : null;
  const unpaid = paidValid && toPaise(amountPaid) === 0n;

  function selectSupplier(next: SupplierRef | null) {
    // The chosen category is deliberately kept: suggestions never change it automatically.
    setSupplier(next);
    setValue('supplierId', next?.id ?? '', { shouldDirty: true });
    linkCategory.reset();
  }

  // Category options: the supplier's usual (active) categories first, then all other categories.
  const options = [...categories];
  if (initial && !options.some((c) => c.id === initial.category.id)) {
    options.push({ ...initial.category, description: null, expenseCount: 0, createdAt: '', updatedAt: '' });
  }
  const linked = supplierDetail.data?.id === supplier?.id ? (supplierDetail.data?.categories ?? []) : [];
  const suggestedIds = new Set(linked.filter((c) => c.isActive).map((c) => c.id));
  const suggested = options.filter((c) => suggestedIds.has(c.id));
  const others = options.filter((c) => !suggestedIds.has(c.id));
  const chosenCategory = options.find((c) => c.id === categoryId);

  const offerLink =
    supplier !== null &&
    supplierDetail.data?.id === supplier.id &&
    supplierDetail.data.isActive &&
    chosenCategory?.isActive === true &&
    !suggestedIds.has(chosenCategory.id) &&
    dismissedLink !== `${supplier.id}:${chosenCategory.id}`;

  return (
    <>
      <form
        noValidate
        className="space-y-4 md:space-y-5"
        onSubmit={handleSubmit(async (values) => {
          // Synchronous re-entry guard: a fast double tap must not send twice (the server's
          // idempotency key is the second line of defence).
          if (inFlight.current || saved) return;
          inFlight.current = true;
          setFormError(null);
          try {
            const expense = await onSubmit(toInput(values), baseVersion.current);
            if (pending.pendingCount === 0) onDone(expense, savedNotice);
            else await finishUploads(expense);
          } catch (err) {
            if (err instanceof ApiError && err.details?.length) {
              for (const d of err.details) {
                if (d.path in values) setError(d.path as keyof FormValues, { message: d.message });
              }
            }
            setFormError({ message: errorMessage(err), conflict: err instanceof ApiError && err.code === 'VERSION_CONFLICT' });
          } finally {
            inFlight.current = false;
          }
        })}
      >
        <div className="grid gap-4 md:gap-5 lg:grid-cols-2 lg:items-start">
          <Section step={1} title="Amount">
            <Field id="amount" label="Total expense amount" error={errors.amount?.message}>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-2xl font-medium text-muted-foreground">
                  ₹
                </span>
                <Input
                  id="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="next"
                  placeholder="0.00"
                  autoFocus={!initial}
                  className="figure h-16 pl-10 text-3xl font-semibold md:h-16 md:text-3xl"
                  {...errorProps('amount', errors.amount)}
                  {...register('amount')}
                />
              </div>
            </Field>
            <p className="figure text-sm text-muted-foreground" aria-live="polite">
              {amountValid && toPaise(amount) > 0n ? formatInr(amount) : 'Enter the full bill amount, including anything still unpaid.'}
            </p>
          </Section>

          <Section step={2} title="Payment">
            <Field id="amountPaid" label="Amount paid now" error={errors.amountPaid?.message}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</span>
                <Input
                  id="amountPaid"
                  inputMode="decimal"
                  autoComplete="off"
                  className="figure pl-7"
                  {...errorProps('amountPaid', errors.amountPaid)}
                  {...register('amountPaid')}
                />
              </div>
            </Field>
            <div className="flex gap-2">
              <Button
                variant="soft"
                size="sm"
                disabled={!amountValid}
                onClick={() => setValue('amountPaid', amount, { shouldValidate: true })}
              >
                Paid in full
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setValue('amountPaid', '0', { shouldValidate: true });
                  setValue('paymentMode', '', { shouldValidate: true });
                }}
              >
                Not paid yet
              </Button>
            </div>

            <fieldset aria-describedby={errors.paymentMode ? 'paymentMode-error' : undefined}>
              <legend className="mb-1.5 text-sm font-medium">Payment mode</legend>
              <div className="grid grid-cols-3 gap-2">
                {PAYMENT_MODES.map((m) => (
                  <label
                    key={m}
                    className={cn(
                      'flex h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring md:h-10',
                      paymentMode === m ? 'border-primary bg-primary-soft font-medium text-primary-soft-foreground' : 'border-input bg-card hover:bg-accent',
                    )}
                  >
                    <input type="radio" value={m} className="sr-only" {...register('paymentMode')} />
                    {PAYMENT_MODE_LABELS[m]}
                  </label>
                ))}
              </div>
              {unpaid && paymentMode && (
                <button type="button" className="mt-1.5 text-xs text-muted-foreground underline" onClick={() => setValue('paymentMode', '')}>
                  Clear payment mode
                </button>
              )}
              {errors.paymentMode && (
                <p id="paymentMode-error" className="mt-1.5 text-sm text-destructive">
                  {errors.paymentMode.message}
                </p>
              )}
              {!errors.paymentMode && unpaid && !paymentMode && (
                <p className="mt-1.5 text-xs text-muted-foreground">Not needed while nothing has been paid.</p>
              )}
            </fieldset>

            <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2.5" aria-live="polite">
              <span className="text-sm text-muted-foreground">
                Outstanding
                {allocated > 0n && <span className="block text-xs">after {formatInr(paiseToString(allocated))} of supplier payments</span>}
              </span>
              <strong className={cn('figure text-base', outstanding !== null && outstanding > 0n && 'text-warning')}>
                {outstanding === null ? '—' : formatInr(paiseToString(outstanding))}
              </strong>
            </div>
          </Section>
        </div>

        <Section step={3} title="Expense details">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              id="supplier"
              label="Supplier"
              error={errors.supplierId?.message}
              hint={
                <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setAddSupplier({ name: '' })}>
                  + Add a new supplier
                </button>
              }
            >
              <SupplierPicker
                id="supplier"
                value={supplier}
                onChange={selectSupplier}
                onAddSupplier={(name) => setAddSupplier({ name })}
                invalid={Boolean(errors.supplierId)}
                describedBy={errors.supplierId ? 'supplier-error' : undefined}
              />
            </Field>

            <Field
              id="categoryId"
              label="Category"
              error={errors.categoryId?.message}
              hint={
                supplier && suggested.length > 0
                  ? `Suggested for ${supplier.name} are listed first. Any category can be chosen.`
                  : undefined
              }
            >
              {/* Controlled: the options move between the Suggested/All groups when the supplier
                  changes, and an uncontrolled <select> would then silently show a different choice. */}
              <Select id="categoryId" value={categoryId} {...errorProps('categoryId', errors.categoryId)} {...register('categoryId')}>
                <option value="">Choose a category…</option>
                {suggested.length > 0 ? (
                  <>
                    <optgroup label={`Suggested for ${supplier?.name ?? 'this supplier'}`}>
                      {suggested.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="All categories">
                      {others.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.isActive ? '' : ' (archived)'}
                        </option>
                      ))}
                    </optgroup>
                  </>
                ) : (
                  others.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.isActive ? '' : ' (archived)'}
                    </option>
                  ))
                )}
              </Select>
              {categories.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No categories yet.{' '}
                  <Link to="/categories" className="text-primary underline">
                    Create one first
                  </Link>
                  .
                </p>
              )}
            </Field>

            {offerLink && chosenCategory && supplier && (
              <div role="status" className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary-soft/60 p-3 text-sm md:col-span-2 md:flex-row md:items-center">
                <Lightbulb className="hidden size-4 shrink-0 text-primary md:block" aria-hidden="true" />
                <p className="flex-1">
                  Suggest <strong>{chosenCategory.name}</strong> for <strong>{supplier.name}</strong> next time?
                  {linkCategory.isError && <span className="block text-destructive">{errorMessage(linkCategory.error)}</span>}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={linkCategory.isPending}
                    onClick={() => linkCategory.mutate({ id: supplier.id, categoryId: chosenCategory.id })}
                  >
                    {linkCategory.isPending ? 'Saving…' : 'Add suggestion'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDismissedLink(`${supplier.id}:${chosenCategory.id}`)}>
                    Not now
                  </Button>
                </div>
              </div>
            )}

            <Field id="description" label="Description" error={errors.description?.message} className="md:col-span-2">
              <Input
                id="description"
                autoComplete="off"
                placeholder="What was bought or paid for"
                {...errorProps('description', errors.description)}
                {...register('description')}
              />
            </Field>

            <Field id="expenseDate" label="Expense date" error={errors.expenseDate?.message}>
              <Input id="expenseDate" type="date" max={todayInKolkata()} {...errorProps('expenseDate', errors.expenseDate)} {...register('expenseDate')} />
            </Field>

            <Field id="invoiceReference" label="Invoice / bill number (optional)" error={errors.invoiceReference?.message}>
              <Input id="invoiceReference" autoComplete="off" {...errorProps('invoiceReference', errors.invoiceReference)} {...register('invoiceReference')} />
            </Field>
          </div>
        </Section>

        <Section step={4} title="Bill photos and documents">
          {initial && initial.documentCount > 0 && (
            <p className="text-sm text-muted-foreground">
              {initial.documentCount} document{initial.documentCount === 1 ? ' is' : 's are'} already attached; manage them on the expense
              details page.
            </p>
          )}
          <DocumentPicker
            pending={pending}
            maxCount={MAX_DOCUMENTS_PER_EXPENSE - (initial?.documentCount ?? 0)}
            disabled={isSubmitting || saved !== null}
          />
        </Section>

        {saved && (
          <div role="alert" className="space-y-3 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm">
            <p>
              <strong>{savedNotice}</strong> {pending.pendingCount} file{pending.pendingCount === 1 ? '' : 's'} could not be uploaded (see
              the errors above). The expense is stored; you can retry now or add documents later from its details page.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="sm" disabled={pending.uploading} onClick={() => void finishUploads(saved)}>
                {pending.uploading ? 'Uploading…' : 'Retry upload'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending.uploading}
                onClick={() => onDone(saved, `${savedNotice} Some documents were not uploaded.`)}
              >
                Continue without them
              </Button>
            </div>
          </div>
        )}

        {formError && (
          <div role="alert" className="space-y-2 rounded-xl border border-destructive/25 bg-destructive-soft p-4 text-sm text-destructive">
            <p>{formError.message}</p>
            {formError.conflict && (
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                Reload latest version
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Link to={cancelTo} className={buttonVariants({ variant: 'ghost', size: 'lg' })}>
            Cancel
          </Link>
          <Button type="submit" size="lg" className="md:min-w-44" disabled={isSubmitting || saved !== null}>
            {pending.uploading ? 'Uploading files…' : isSubmitting ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </form>

      <SupplierFormDialog
        open={addSupplier !== null}
        initialName={addSupplier?.name ?? ''}
        onClose={() => setAddSupplier(null)}
        onSaved={(created) => {
          selectSupplier({ id: created.id, name: created.name, isActive: created.isActive });
          setAddSupplier(null);
        }}
      />
    </>
  );
}
