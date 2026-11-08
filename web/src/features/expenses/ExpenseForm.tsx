import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useBrands } from '@/features/brands/brands-api';
import { useBrandCreator, useCategoryCreator } from '@/features/classification/useOptionCreators';
import { DocumentPicker, usePendingFiles } from '@/features/documents/DocumentPicker';
import { MAX_DOCUMENTS_PER_EXPENSE } from '@/features/documents/limits';
import { SupplierFormDialog } from '@/features/suppliers/SupplierForm';
import { SupplierPicker } from '@/features/suppliers/SupplierPicker';
import { ApiError, apiRequest } from '@/lib/api-client';
import { todayInKolkata } from '@/lib/dates';
import { formatInr, fromPaise, MONEY_INPUT, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Category, Expense, ExpenseInput, PaymentMode, Supplier, SupplierRef } from '@/types/api';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES } from './expenses-api';
import { isPaymentSplitValid, paymentStatusOf, splitPayments, type PaymentStatus } from './payment-split';

/** Same bound as the server (one row per method is plenty). */
const MAX_PAYMENT_ROWS = 10;

const money = (label: string) =>
  z.string().trim().min(1, `Enter the ${label}`).regex(MONEY_INPUT, 'Use digits only, e.g. 1250 or 1250.50');

// Mirrors the server rules for fast feedback; the server re-validates everything.
const schema = z
  .object({
    amount: money('total amount').refine((v) => !MONEY_INPUT.test(v) || toPaise(v) > 0n, 'Must be more than zero'),
    payments: z.array(z.object({ amount: z.string(), paymentMode: z.string() })).min(1).max(MAX_PAYMENT_ROWS),
    supplierId: z.string(),
    // Ordered; the first is the primary category. Labels only: the amount is never split.
    categoryIds: z.array(z.string()).min(1, 'Choose at least one category').max(20, 'At most 20 categories'),
    brandIds: z.array(z.string()).max(50, 'At most 50 brands'),
    // Optional: the category is shown instead when it is left empty.
    description: z.string().trim().max(500, 'At most 500 characters'),
    expenseDate: z
      .string()
      .min(1, 'Choose a date')
      .refine((v) => v <= todayInKolkata(), 'The date cannot be in the future'),
    invoiceReference: z.string().trim().max(100, 'At most 100 characters'),
  })
  .superRefine((v, ctx) => {
    const split = splitPayments(v.amount, v.payments, v.supplierId !== '');
    split.rowErrors.forEach((e, i) => {
      if (e.amount) ctx.addIssue({ code: 'custom', path: ['payments', i, 'amount'], message: e.amount });
      if (e.paymentMode) ctx.addIssue({ code: 'custom', path: ['payments', i, 'paymentMode'], message: e.paymentMode });
    });
    if (split.problem) ctx.addIssue({ code: 'custom', path: ['payments'], message: split.problem });
  });
type FormValues = z.infer<typeof schema>;

const blankRow = (paymentMode = 'cash') => ({ amount: '', paymentMode });

export function toFormValues(expense?: Expense): FormValues {
  if (!expense) {
    return {
      amount: '',
      payments: [blankRow()],
      supplierId: '',
      categoryIds: [],
      brandIds: [],
      description: '',
      expenseDate: todayInKolkata(),
      invoiceReference: '',
    };
  }
  return {
    amount: expense.amount,
    // An unpaid bill loads as one blank row ("Not paid yet"): editing never marks it paid by itself.
    payments: expense.payments.length > 0 ? expense.payments.map((p) => ({ amount: p.amount, paymentMode: p.paymentMode })) : [blankRow('')],
    supplierId: expense.supplier?.id ?? '',
    // The selections saved on THIS expense (never the supplier's current defaults).
    categoryIds: (expense.categories?.length ? expense.categories : [expense.category]).map((c) => c.id),
    brandIds: (expense.brands ?? []).map((b) => b.id),
    description: expense.description ?? '',
    expenseDate: expense.expenseDate,
    invoiceReference: expense.invoiceReference ?? '',
  };
}

function toInput(v: FormValues): ExpenseInput {
  return {
    expenseDate: v.expenseDate,
    supplierId: v.supplierId || null,
    categoryIds: v.categoryIds,
    brandIds: v.brandIds,
    description: v.description.trim() || null,
    amount: v.amount.trim(),
    // A lone blank row means "not paid yet": it is not sent.
    payments: v.payments
      .filter((p) => p.amount.trim() !== '')
      .map((p) => ({ amount: p.amount.trim(), paymentMode: p.paymentMode as PaymentMode })),
    invoiceReference: v.invoiceReference.trim() || null,
  };
}

const paiseToString = (p: bigint) => `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;

interface Defaults {
  categoryIds: string[];
  brandIds: string[];
}
const NO_DEFAULTS: Defaults = { categoryIds: [], brandIds: [] };
/** A supplier's ACTIVE default categories and brands (archived ones are never auto-selected). */
export const defaultsOf = (s: Supplier): Defaults => ({
  categoryIds: s.categories.filter((c) => c.isActive).map((c) => c.id),
  brandIds: (s.brands ?? []).filter((b) => b.isActive).map((b) => b.id),
});
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

const STATUS_OPTIONS: { value: PaymentStatus; label: string }[] = [
  { value: 'full', label: 'Paid in full' },
  { value: 'partial', label: 'Part paid' },
  { value: 'none', label: 'Not paid yet' },
];

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
  const [paymentsServerError, setPaymentsServerError] = useState<string | null>(null);
  const pending = usePendingFiles();
  const toast = useToast();
  const queryClient = useQueryClient();
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
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    setFocus,
    getValues,
    watch,
    control,
    formState: { errors, isSubmitting, submitCount },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toFormValues(initial) });
  const { fields, append, remove } = useFieldArray({ control, name: 'payments' });

  const amount = watch('amount').trim();
  const rows = watch('payments');
  const categoryIds = watch('categoryIds');
  const brandIds = watch('brandIds');
  const amountValid = MONEY_INPUT.test(amount);
  const amountPositive = amountValid && toPaise(amount) > 0n;
  const hasSupplier = supplier !== null;
  const split = splitPayments(amount, rows, hasSupplier);
  const splitOk = isPaymentSplitValid(split);

  // ---- Payment status (derived from the rows; see paymentStatusOf) -------------------------------
  // New expense: the single payment row follows the expense amount ("Paid in full" by default) until
  // the user changes the breakdown or picks another status. Choosing a supplier never changes it.
  const followAmount = useRef(!initial);
  // "Part paid" chosen while no part amount is typed yet (the derived status would say "Not paid").
  const [partialIntent, setPartialIntent] = useState(false);
  useEffect(() => {
    if (!followAmount.current || getValues('payments').length !== 1) return;
    setValue('payments.0.amount', amountPositive ? amount : '', { shouldValidate: submitCount > 0 });
  }, [amount, amountPositive, getValues, setValue, submitCount]);
  const derivedStatus = paymentStatusOf(split);
  const status: PaymentStatus | null = partialIntent && derivedStatus !== 'full' ? 'partial' : derivedStatus;

  // Supplier payments already allocated to this bill (edit only) also reduce what is still payable.
  const supplierPaid = initial ? toPaise(initial.allocatedPayments) : 0n;
  const showProblem = split.problem !== null && (split.anyEntered || submitCount > 0 || status !== 'full');
  const lastIndex = rows.length - 1;

  function addRow() {
    followAmount.current = false;
    const used = new Set(rows.map((r) => r.paymentMode));
    const next = PAYMENT_MODES.find((m) => !used.has(m)) ?? 'cash';
    // Pre-fill what is still unallocated so the new row usually needs no typing.
    const rest = split.remaining !== null && split.remaining > 0n ? fromPaise(split.remaining) : '';
    // Move focus to the new amount field (react-hook-form focuses it once the row is registered).
    append(blankRow(next), { focusName: `payments.${rows.length}.amount` });
    if (rest) setValue(`payments.${rows.length}.amount`, rest, { shouldValidate: submitCount > 0 });
  }
  function removeRow(index: number) {
    followAmount.current = false;
    remove(index);
    // Keep keyboard and screen-reader users in the list: focus the row above the removed one.
    setFocus(`payments.${index - 1}.amount`);
  }
  function choosePaidInFull() {
    setPartialIntent(false);
    const validate = { shouldValidate: submitCount > 0 };
    if (rows.length === 1) {
      followAmount.current = true;
      setValue('payments.0.amount', amount, validate);
      if (!rows[0]!.paymentMode) setValue('payments.0.paymentMode', 'cash', validate);
    } else if (split.remaining !== null && split.remaining > 0n) {
      // Several methods: the last row takes whatever is still unpaid.
      const last = rows[lastIndex]!;
      const own = MONEY_INPUT.test(last.amount.trim()) ? toPaise(last.amount.trim()) : 0n;
      setValue(`payments.${lastIndex}.amount`, fromPaise(own + split.remaining), validate);
    }
  }
  function choosePartial() {
    followAmount.current = false;
    setPartialIntent(true);
    // Coming from "paid in full": clear the single row so the amount paid now can be typed.
    if (derivedStatus === 'full' && rows.length === 1) {
      setValue('payments.0.amount', '', { shouldValidate: submitCount > 0 });
      if (!rows[0]!.paymentMode) setValue('payments.0.paymentMode', 'cash');
    }
    setFocus('payments.0.amount');
  }
  function chooseNotPaid() {
    followAmount.current = false;
    setPartialIntent(false);
    setValue('payments', [blankRow('')], { shouldValidate: submitCount > 0 });
  }

  // ---- Categories and brands, with supplier defaults ----------------------------------------------
  const brandsQuery = useBrands('active');
  const categoryCreator = useCategoryCreator();
  const brandCreator = useBrandCreator();
  // The defaults applied automatically for the current supplier (null: none, or editing an expense,
  // whose saved selections always count as the user's own).
  const autoApplied = useRef<Defaults | null>(null);
  const [supplierDefaults, setSupplierDefaults] = useState<Defaults>(NO_DEFAULTS);
  // `defaults: null` = loading the new supplier's defaults FAILED (the dialog then only asks what to do
  // with the previous supplier's pre-selected items).
  const [replaceAsk, setReplaceAsk] = useState<{ next: SupplierRef | null; defaults: Defaults | null } | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  // Set when the chosen supplier's defaults could not be loaded (cleared on success or another supplier).
  const [defaultsError, setDefaultsError] = useState<SupplierRef | null>(null);
  const supplierSeq = useRef(0);

  const categoryOptions: MultiSelectOption[] = [...categories];
  for (const c of initial?.categories ?? (initial ? [initial.category] : [])) {
    if (!categoryOptions.some((o) => o.id === c.id)) categoryOptions.push(c);
  }
  const brandOptions: MultiSelectOption[] = [...(brandsQuery.data ?? [])];
  for (const b of initial?.brands ?? []) if (!brandOptions.some((o) => o.id === b.id)) brandOptions.push(b);

  /** True when replacing the selections would throw away something the user chose. */
  function selectionsModified(): boolean {
    const current = { categoryIds: getValues('categoryIds'), brandIds: getValues('brandIds') };
    if (current.categoryIds.length === 0 && current.brandIds.length === 0) return false;
    const auto = autoApplied.current;
    return !(auto && sameSet(current.categoryIds, auto.categoryIds) && sameSet(current.brandIds, auto.brandIds));
  }

  function applySupplier(next: SupplierRef | null, defaults: Defaults, replace: boolean) {
    setSupplier(next);
    setValue('supplierId', next?.id ?? '', { shouldDirty: true });
    setSupplierDefaults(defaults);
    setDefaultsError(null);
    if (replace) {
      // Only these two fields change; amount, payments, status, description, date and files never do.
      const validate = { shouldValidate: submitCount > 0, shouldDirty: true };
      setValue('categoryIds', defaults.categoryIds, validate);
      setValue('brandIds', defaults.brandIds, validate);
      autoApplied.current = defaults;
    } else {
      // The user kept their own selections: from now on they are theirs, not the previous supplier's.
      autoApplied.current = null;
    }
  }

  /**
   * The new supplier is chosen but its defaults could not be loaded. Nothing is guessed: the
   * previous supplier's pre-selected items are never kept silently ('remove' drops exactly those;
   * anything the user added themselves stays) and nothing else on the form changes. 'keep' is the
   * user's explicit decision to keep their current selections as their own.
   */
  function applyDefaultsFailure(next: SupplierRef, action: 'remove' | 'keep') {
    setSupplier(next);
    setValue('supplierId', next.id, { shouldDirty: true });
    setSupplierDefaults(NO_DEFAULTS);
    if (action === 'remove') {
      const previous = autoApplied.current;
      if (previous) {
        const validate = { shouldValidate: submitCount > 0, shouldDirty: true };
        setValue('categoryIds', getValues('categoryIds').filter((id) => !previous.categoryIds.includes(id)), validate);
        setValue('brandIds', getValues('brandIds').filter((id) => !previous.brandIds.includes(id)), validate);
      }
    }
    autoApplied.current = null;
    setDefaultsError(next);
  }

  function handleDefaultsFailure(next: SupplierRef) {
    const previous = autoApplied.current;
    const current = { categoryIds: getValues('categoryIds'), brandIds: getValues('brandIds') };
    if (previous && !(sameSet(current.categoryIds, previous.categoryIds) && sameSet(current.brandIds, previous.brandIds))) {
      // The previous supplier's defaults were edited by hand: ask what to do with them.
      setReplaceAsk({ next, defaults: null });
      return;
    }
    // Untouched previous defaults are dropped; the user's own (or saved) selections are left alone.
    applyDefaultsFailure(next, 'remove');
  }

  /** `force` re-loads the defaults of the supplier that is already chosen (the "Try again" button). */
  async function selectSupplier(next: SupplierRef | null, detail?: Supplier, force = false) {
    if (!force && (next?.id ?? null) === (supplier?.id ?? null)) return;
    const seq = ++supplierSeq.current;
    let defaults: Defaults | null = NO_DEFAULTS;
    if (next) {
      try {
        setLoadingDefaults(true);
        const full: Supplier =
          detail ??
          (await queryClient.fetchQuery<Supplier>({
            queryKey: ['suppliers', 'detail', next.id],
            queryFn: ({ signal }) => apiRequest<{ supplier: Supplier }>(`/suppliers/${next.id}`, { signal }).then((r) => r.supplier),
            staleTime: 10_000,
          }));
        defaults = defaultsOf(full);
      } catch {
        defaults = null;
      } finally {
        if (seq === supplierSeq.current) setLoadingDefaults(false);
      }
    }
    if (seq !== supplierSeq.current) return; // a newer choice was made meanwhile
    if (defaults === null) {
      if (next) handleDefaultsFailure(next);
      return;
    }
    // Ask only when the user's own choices would be replaced by something different.
    const differs = !sameSet(getValues('categoryIds'), defaults.categoryIds) || !sameSet(getValues('brandIds'), defaults.brandIds);
    if (selectionsModified() && differs) {
      setReplaceAsk({ next, defaults });
      return;
    }
    applySupplier(next, defaults, true);
  }

  const supplierName = supplier?.name ?? 'this supplier';
  const suggestedCategoryIds = new Set(supplierDefaults.categoryIds);
  const suggestedBrandIds = new Set(supplierDefaults.brandIds);
  const categoryError = errors.categoryIds?.message ?? (errors.categoryIds as { root?: { message?: string } } | undefined)?.root?.message;
  const brandError = errors.brandIds?.message;

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
          setPaymentsServerError(null);
          try {
            const expense = await onSubmit(toInput(values), baseVersion.current);
            if (pending.pendingCount === 0) onDone(expense, savedNotice);
            else await finishUploads(expense);
          } catch (err) {
            // Everything typed stays in the form; only the errors are shown.
            if (err instanceof ApiError && err.details?.length) {
              for (const d of err.details) {
                if (d.path in values) setError(d.path as keyof FormValues, { message: d.message });
                else if (d.path.startsWith('payments')) setPaymentsServerError(d.message);
              }
            }
            setFormError({ message: errorMessage(err), conflict: err instanceof ApiError && err.code === 'VERSION_CONFLICT' });
            toast({ title: initial ? 'Changes not saved' : 'Expense not saved', description: errorMessage(err), tone: 'error' });
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
              {amountPositive ? formatInr(amount) : 'Enter the full bill amount, including anything still unpaid.'}
            </p>
          </Section>

          <Section step={2} title="Payment">
            {status !== null && (
              <div className="space-y-1.5">
                <p id="payment-status-label" className="text-sm font-medium">
                  Payment status
                </p>
                <div role="radiogroup" aria-labelledby="payment-status-label" className="grid grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1" data-testid="payment-status">
                  {STATUS_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={status === o.value}
                      onClick={() => (o.value === 'full' ? choosePaidInFull() : o.value === 'partial' ? choosePartial() : chooseNotPaid())}
                      className={cn(
                        'h-10 rounded-md px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        status === o.value ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground" role="status">
                  {status === 'full' && 'The whole amount was paid now.'}
                  {status !== 'full' &&
                    (hasSupplier
                      ? `Anything not paid now stays payable to ${supplier?.name}.`
                      : 'Choose the supplier below: an unpaid or part-paid bill stays payable to them.')}
                  {status === 'partial' && split.allocated === 0n && ' Enter the amount paid now.'}
                </p>
              </div>
            )}

            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-sm font-medium">{status === 'none' ? 'Paid now (nothing yet)' : 'How it was paid'}</legend>
              {fields.map((field, i) => {
                const rowErrors = errors.payments?.[i];
                return (
                  <div key={field.id} className="space-y-1" data-testid="payment-row">
                    <div className="flex items-start gap-2">
                      <div className="relative min-w-0 flex-1">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</span>
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0.00"
                          aria-label={`Payment ${i + 1} amount`}
                          className="figure pl-7"
                          {...errorProps(`payment-${i}-amount`, rowErrors?.amount)}
                          {...register(`payments.${i}.amount`, {
                            onChange: () => {
                              if (i === 0) followAmount.current = false;
                            },
                          })}
                        />
                      </div>
                      <Select
                        aria-label={`Payment ${i + 1} method`}
                        className="w-40 shrink-0 sm:w-44"
                        {...errorProps(`payment-${i}-method`, rowErrors?.paymentMode)}
                        {...register(`payments.${i}.paymentMode`)}
                      >
                        <option value="">Method…</option>
                        {PAYMENT_MODES.map((m) => (
                          <option key={m} value={m}>
                            {PAYMENT_MODE_LABELS[m]}
                          </option>
                        ))}
                      </Select>
                      {i > 0 ? (
                        <Button variant="ghost" size="icon" className="shrink-0" aria-label={`Remove payment ${i + 1}`} onClick={() => removeRow(i)}>
                          <X aria-hidden="true" />
                        </Button>
                      ) : (
                        // The first row is never removable; keep its columns aligned with the rows below.
                        fields.length > 1 && <span className="size-11 shrink-0 md:size-10" aria-hidden="true" />
                      )}
                    </div>
                    {rowErrors?.amount?.message && (
                      <p id={`payment-${i}-amount-error`} className="text-sm text-destructive">
                        Payment {i + 1} amount: {rowErrors.amount.message}
                      </p>
                    )}
                    {rowErrors?.paymentMode?.message && (
                      <p id={`payment-${i}-method-error`} className="text-sm text-destructive">
                        Payment {i + 1} method: {rowErrors.paymentMode.message}
                      </p>
                    )}
                    {i === lastIndex && split.remaining !== null && split.remaining > 0n && split.anyEntered && (
                      <button
                        type="button"
                        className="text-xs text-primary underline-offset-2 hover:underline"
                        onClick={() => {
                          followAmount.current = false;
                          const own = MONEY_INPUT.test(rows[i]!.amount.trim()) ? toPaise(rows[i]!.amount.trim()) : 0n;
                          setValue(`payments.${i}.amount`, fromPaise(own + split.remaining!), { shouldValidate: submitCount > 0 });
                        }}
                      >
                        Use remaining {formatInr(fromPaise(split.remaining))}
                      </button>
                    )}
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="soft" size="sm" disabled={fields.length >= MAX_PAYMENT_ROWS} onClick={addRow}>
                  <Plus aria-hidden="true" /> Add payment
                </Button>
              </div>
            </fieldset>

            <dl className="space-y-1.5 rounded-lg bg-surface-muted px-3 py-2.5 text-sm" aria-live="polite" data-testid="payment-summary">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Total expense</dt>
                <dd className="figure font-medium">{split.total === null ? '—' : formatInr(fromPaise(split.total))}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Total allocated</dt>
                <dd className="figure font-medium">{formatInr(fromPaise(split.allocated))}</dd>
              </div>
              <div className="flex items-center justify-between border-t pt-1.5">
                <dt className="text-muted-foreground">
                  Remaining
                  {supplierPaid > 0n && <span className="block text-xs">after {formatInr(paiseToString(supplierPaid))} of supplier payments</span>}
                </dt>
                <dd
                  className={cn(
                    'figure text-base font-semibold',
                    split.remaining !== null && split.remaining > 0n && (hasSupplier ? 'text-warning' : 'text-destructive'),
                    split.remaining !== null && split.remaining < 0n && 'text-destructive',
                  )}
                  data-testid="payment-remaining"
                >
                  {split.remaining === null ? '—' : formatInr(fromPaise(split.remaining - supplierPaid))}
                </dd>
              </div>
            </dl>
            {(showProblem || paymentsServerError) && (
              <p role="alert" className="text-sm text-destructive">
                {showProblem ? split.problem : paymentsServerError}
              </p>
            )}
            {!splitOk && submitCount > 0 && !showProblem && !paymentsServerError && !hasSupplier && split.total !== null && !split.anyEntered && (
              <p role="alert" className="text-sm text-destructive">
                Enter how the expense was paid.
              </p>
            )}
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
                onChange={(next) => void selectSupplier(next)}
                onAddSupplier={(name) => setAddSupplier({ name })}
                invalid={Boolean(errors.supplierId)}
                describedBy={errors.supplierId ? 'supplier-error' : undefined}
              />
              {loadingDefaults && <p className="text-xs text-muted-foreground">Loading the supplier’s usual brands and categories…</p>}
              {defaultsError && supplier?.id === defaultsError.id && (
                <div role="alert" className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm" data-testid="defaults-error">
                  <p>
                    Could not load the usual brands and categories of <strong>{defaultsError.name}</strong>. Nothing was pre-selected: choose
                    them below, or try again. Everything else you entered is unchanged.
                  </p>
                  <Button size="sm" variant="outline" loading={loadingDefaults} onClick={() => void selectSupplier(supplier, undefined, true)}>
                    {loadingDefaults ? 'Loading…' : 'Try again'}
                  </Button>
                </div>
              )}
            </Field>

            <Field id="description" label="Description (optional)" error={errors.description?.message}>
              <Input
                id="description"
                autoComplete="off"
                placeholder="What was bought or paid for (optional)"
                {...errorProps('description', errors.description)}
                {...register('description')}
              />
            </Field>

            <div className="md:col-span-2">
              <MultiSelect
                label="Categories"
                noun="category"
                options={categoryOptions}
                selected={categoryIds}
                onChange={(ids) => setValue('categoryIds', ids, { shouldValidate: submitCount > 0, shouldDirty: true })}
                suggestedIds={suggestedCategoryIds}
                suggestedLabel={`Usual for ${supplierName}`}
                onCreate={categoryCreator.create}
                creating={categoryCreator.creating}
                note={categoryCreator.note}
                firstBadge="Primary"
                hint={
                  <>
                    Choose one or more. The first is the primary category (used for category totals); the amount is never split or counted twice.
                    {categories.length === 0 && (
                      <>
                        {' '}
                        No categories yet: type a name to add one, or{' '}
                        <Link to="/categories" className="text-primary underline">
                          manage categories
                        </Link>
                        .
                      </>
                    )}
                  </>
                }
                error={categoryError}
                testId="expense-categories"
              />
            </div>

            <div className="md:col-span-2">
              <MultiSelect
                label="Brands (optional)"
                noun="brand"
                options={brandOptions}
                selected={brandIds}
                onChange={(ids) => setValue('brandIds', ids, { shouldValidate: submitCount > 0, shouldDirty: true })}
                suggestedIds={suggestedBrandIds}
                suggestedLabel={`Usual for ${supplierName}`}
                onCreate={brandCreator.create}
                creating={brandCreator.creating}
                note={brandCreator.note}
                loading={brandsQuery.isPending}
                error={brandError}
                testId="expense-brands"
              />
            </div>

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
              <Button size="sm" loading={pending.uploading} onClick={() => void finishUploads(saved)}>
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
          <Button type="submit" size="lg" className="md:min-w-44" loading={isSubmitting || pending.uploading} disabled={saved !== null}>
            {pending.uploading ? 'Uploading files…' : isSubmitting ? (initial ? 'Updating…' : 'Saving…') : submitLabel}
          </Button>
        </div>
      </form>

      <Dialog
        open={replaceAsk !== null}
        title={replaceAsk?.defaults === null ? 'Remove the previous supplier’s brands and categories?' : 'Replace brands and categories?'}
        size="sm"
        onClose={() => setReplaceAsk(null)}
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setReplaceAsk(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (replaceAsk?.next && replaceAsk.defaults === null) applyDefaultsFailure(replaceAsk.next, 'keep');
                else if (replaceAsk?.defaults) applySupplier(replaceAsk.next, replaceAsk.defaults, false);
                setReplaceAsk(null);
              }}
            >
              Keep my selections
            </Button>
            <Button
              onClick={() => {
                if (replaceAsk?.next && replaceAsk.defaults === null) applyDefaultsFailure(replaceAsk.next, 'remove');
                else if (replaceAsk?.defaults) applySupplier(replaceAsk.next, replaceAsk.defaults, true);
                setReplaceAsk(null);
              }}
            >
              {replaceAsk?.defaults === null ? 'Remove them' : replaceAsk?.next ? `Use ${replaceAsk.next.name}’s` : 'Clear them'}
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          {replaceAsk?.defaults === null
            ? `The usual brands and categories of ${replaceAsk.next?.name ?? 'the new supplier'} could not be loaded. Brands and categories that came from the previous supplier are still selected. Remove those (anything you added yourself stays), or keep your selections as they are?`
            : replaceAsk?.next
              ? `You changed the brands or categories of this expense. Replace them with the usual ones for ${replaceAsk.next.name}?`
              : 'You changed the brands or categories of this expense. Clear them along with the supplier?'}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Cancel keeps the current supplier and everything entered. Amounts, payments, description, date and bill photos are never changed
          here.
        </p>
      </Dialog>

      <SupplierFormDialog
        open={addSupplier !== null}
        initialName={addSupplier?.name ?? ''}
        onClose={() => setAddSupplier(null)}
        onSaved={(created) => {
          setAddSupplier(null);
          void selectSupplier({ id: created.id, name: created.name, isActive: created.isActive }, created);
        }}
      />
    </>
  );
}
