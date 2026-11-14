import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock, Plus, Tag, Truck, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { SearchSelect, type SearchSelectOption } from '@/components/ui/search-select';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useBrands } from '@/features/brands/brands-api';
import { useBrandCreator, useCategoryCreator } from '@/features/classification/useOptionCreators';
import { DocumentPicker, usePendingFiles } from '@/features/documents/DocumentPicker';
import { MAX_DOCUMENTS_PER_EXPENSE } from '@/features/documents/limits';
import { requestPersistentStorage, useAttachmentQueue } from '@/features/documents/queue/AttachmentQueueProvider';
import { useAttachmentDrafts } from '@/features/documents/queue/drafts';
import { billAttachmentsEnabled } from '@/features/documents/attachments-feature';
import { SupplierFormDialog } from '@/features/suppliers/SupplierForm';
import { SupplierPicker } from '@/features/suppliers/SupplierPicker';
import { ApiError, apiRequest } from '@/lib/api-client';
import { todayInKolkata } from '@/lib/dates';
import { formatInr, fromPaise, MONEY_INPUT, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import { isPhoneLayout, KEYBOARD_MIN_PX, useViewportInset } from '@/lib/visual-viewport';
import type { Category, ClassRef, Expense, ExpenseInput, PaymentMode, Supplier, SupplierRef } from '@/types/api';
import {
  categoriesModified,
  defaultCategoryIds,
  planSupplierForBrand,
  sameSet,
  type BrandSupplierOption,
  type SupplierPlan,
} from './brand-first';
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
    // Brand-first entry: the PRIMARY brand ('' = none); it decides which suppliers are offered.
    brandId: z.string(),
    supplierId: z.string(),
    // Ordered; the first is the primary category. Labels only: the amount is never split.
    categoryIds: z.array(z.string()).min(1, 'Choose at least one category').max(20, 'At most 20 categories'),
    // Any further brands of the expense (rare; kept for expenses that already have several).
    extraBrandIds: z.array(z.string()).max(49, 'At most 50 brands'),
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
      brandId: '',
      supplierId: '',
      categoryIds: [],
      extraBrandIds: [],
      description: '',
      expenseDate: todayInKolkata(),
      invoiceReference: '',
    };
  }
  const brands = expense.brands ?? [];
  return {
    amount: expense.amount,
    // An unpaid bill loads as one blank row ("Not paid yet"): editing never marks it paid by itself.
    payments: expense.payments.length > 0 ? expense.payments.map((p) => ({ amount: p.amount, paymentMode: p.paymentMode })) : [blankRow('')],
    // The brand, supplier and categories saved on THIS expense (never the current defaults).
    brandId: brands[0]?.id ?? '',
    supplierId: expense.supplier?.id ?? '',
    categoryIds: (expense.categories?.length ? expense.categories : [expense.category]).map((c) => c.id),
    extraBrandIds: brands.slice(1).map((b) => b.id),
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
    // The chosen brand is the primary (first) one; without it no other brands are kept.
    brandIds: v.brandId ? [v.brandId, ...v.extraBrandIds.filter((id) => id !== v.brandId)] : [],
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
}
const NO_DEFAULTS: Defaults = { categoryIds: [] };
/** A supplier's ACTIVE default categories (archived ones are never auto-selected). */
export const defaultsOf = (s: { categories: ClassRef[] }): Defaults => ({ categoryIds: defaultCategoryIds(s) });

const STATUS_OPTIONS: { value: PaymentStatus; label: string }[] = [
  { value: 'full', label: 'Paid in full' },
  { value: 'partial', label: 'Part paid' },
  { value: 'none', label: 'Not paid yet' },
];

/**
 * One numbered part of the paper-like form: a tinted heading bar, then its fields. The heading names
 * the section in plain words; `description` says in one line what belongs there.
 */
function Section({
  step,
  title,
  description,
  children,
  className,
}: {
  step: number;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `expense-section-${step}`;
  return (
    <Card className={cn('overflow-hidden', className)} role="group" aria-labelledby={headingId} data-testid={`expense-section-${step}`}>
      <div className="border-b border-primary/15 bg-primary-soft px-4 py-3 md:px-6">
        <h2 id={headingId} className="flex items-center gap-3 text-lg font-semibold text-foreground">
          <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground">
            {step}
          </span>
          {title}
        </h2>
        {description && <p className="mt-1 pl-11 text-sm text-primary-soft-foreground">{description}</p>}
      </div>
      <div className="space-y-5 p-4 md:p-6">{children}</div>
    </Card>
  );
}

/** Larger, easier controls on this form (48px tall, 16px text on every screen). */
const BIG_CONTROL = 'h-12 text-base md:h-12 md:text-base';

/**
 * Enter in a text field moves to the next field instead of saving the form, so the phone keyboard's
 * Enter/Go key can never save a half-filled expense. Saving is only ever the "Save expense" button.
 */
function enterMovesToNextField(e: KeyboardEvent<HTMLFormElement>) {
  const target = e.target;
  if (e.key !== 'Enter' || !(target instanceof HTMLInputElement) || e.defaultPrevented) return;
  if (['submit', 'button', 'checkbox', 'radio', 'file'].includes(target.type)) return;
  e.preventDefault();
  const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, select, textarea, button[aria-haspopup]')).filter(
    (el) => !(el as HTMLInputElement).disabled && el.getAttribute('aria-hidden') !== 'true' && el.tabIndex >= 0,
  );
  fields[fields.indexOf(target) + 1]?.focus();
}

/** A brand change that needs the user's confirmation before it is applied. */
interface BrandChange {
  brand: ClassRef;
  options: BrandSupplierOption[];
  plan: SupplierPlan;
  /** The supplier after the change (null: none / to be chosen). */
  supplier: SupplierRef | null;
  /** Default categories of that supplier. */
  defaults: Defaults;
  /** The categories were chosen by hand and would be replaced. */
  categoriesAtRisk: boolean;
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
   * Called once the expense is saved AND every selected file is either saved on this device for
   * upload (offline queue) or uploaded, or the user chose to continue without the failed ones.
   */
  onDone: (expense: Expense, notice: string) => void;
}

const toSupplierRef = (s: { id: string; name: string; isActive: boolean }): SupplierRef => ({ id: s.id, name: s.name, isActive: s.isActive });

export function ExpenseForm({ initial, categories, submitLabel, cancelTo, onSubmit, onDone }: ExpenseFormProps) {
  const [formError, setFormError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [paymentsServerError, setPaymentsServerError] = useState<string | null>(null);
  // Files picked before saving are also kept as drafts on this device, so a refresh or a closed
  // tab does not lose them (offered again when this form is reopened).
  const drafts = useAttachmentDrafts(initial ? initial.id : 'new');
  const pending = usePendingFiles({ onAdded: drafts.keep, onRemoved: (key) => drafts.forget([key]) });
  const [confirmDiscardDrafts, setConfirmDiscardDrafts] = useState(false);
  const { queue } = useAttachmentQueue();
  const toast = useToast();
  const queryClient = useQueryClient();
  // Set once the expense is saved but some files could not be uploaded/kept: the form then offers a retry.
  const [saved, setSaved] = useState<Expense | null>(null);
  const [queueProblems, setQueueProblems] = useState<string[]>([]);
  const savedNotice = initial ? 'Changes saved.' : 'Expense saved.';

  /** Without the offline queue (no provider): upload now, one by one. */
  async function finishUploads(expense: Expense) {
    const failed = await pending.uploadAll(expense.id);
    if (failed === 0) onDone(expense, pending.files.length > 0 ? `${savedNotice} Documents uploaded.` : savedNotice);
    else setSaved(expense);
  }

  /** With the offline queue: keep the files on this device; they are sent to the shop PC automatically. */
  async function queueFiles(expense: Expense) {
    if (!queue) return finishUploads(expense);
    const waiting = pending.files.filter((f) => f.status !== 'done');
    const result = await queue.enqueue(
      expense.id,
      waiting.map((f) => f.file),
      initial?.documentCount ?? 0,
    );
    const added = new Set(result.added.map((a) => a.blob));
    const queuedKeys = waiting.filter((f) => added.has(f.file)).map((f) => f.key);
    pending.markDone(queuedKeys);
    // They are in the upload queue now (saved before this point): the draft copies can go.
    drafts.forget(queuedKeys);
    if (result.added.length > 0) {
      requestPersistentStorage();
      void queue.syncNow({ force: true });
    }
    if (result.problems.length === 0) {
      const n = result.added.length;
      onDone(expense, `${savedNotice} ${n} bill file${n === 1 ? '' : 's'} saved on this device; sent to the shop PC automatically.`);
    } else {
      setQueueProblems(result.problems);
      setSaved(expense);
    }
  }
  const inFlight = useRef(false);
  const baseVersion = useRef(initial?.version);
  const [supplier, setSupplier] = useState<SupplierRef | null>(initial?.supplier ?? null);
  const [addSupplier, setAddSupplier] = useState<{ name: string } | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
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
  const brandId = watch('brandId');
  const extraBrandIds = watch('extraBrandIds');
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

  // ---- Brand first, then its suppliers, then categories -------------------------------------------
  const brandsQuery = useBrands('active');
  const categoryCreator = useCategoryCreator();
  const brandCreator = useBrandCreator();
  const dirty = { shouldDirty: true };
  // The category defaults applied automatically for the current supplier (null: none, or editing an
  // expense, whose saved selections always count as the user's own).
  const autoApplied = useRef<Defaults | null>(null);
  const [supplierDefaults, setSupplierDefaults] = useState<Defaults>(NO_DEFAULTS);
  // `defaults: null` = loading the new supplier's defaults FAILED (the dialog then only asks what to do
  // with the previous supplier's pre-selected categories).
  const [replaceAsk, setReplaceAsk] = useState<{ next: SupplierRef | null; defaults: Defaults | null } | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  // Set when the chosen supplier's defaults could not be loaded (cleared on success or another supplier).
  const [defaultsError, setDefaultsError] = useState<SupplierRef | null>(null);
  const supplierSeq = useRef(0);

  // Suppliers of the chosen brand (null while no brand is chosen or they could not be loaded).
  const [brandSuppliers, setBrandSuppliers] = useState<BrandSupplierOption[] | null>(null);
  const [brandLoad, setBrandLoad] = useState<'idle' | 'loading' | 'error'>('idle');
  const [brandAsk, setBrandAsk] = useState<BrandChange | null>(null);
  const [brandNotice, setBrandNotice] = useState<string | null>(null);
  const brandSeq = useRef(0);

  const categoryOptions: MultiSelectOption[] = [...categories];
  for (const c of initial?.categories ?? (initial ? [initial.category] : [])) {
    if (!categoryOptions.some((o) => o.id === c.id)) categoryOptions.push(c);
  }
  const brandOptions: MultiSelectOption[] = [...(brandsQuery.data ?? [])];
  for (const b of initial?.brands ?? []) if (!brandOptions.some((o) => o.id === b.id)) brandOptions.push(b);
  const brand: ClassRef | null = brandOptions.find((b) => b.id === brandId) ?? null;

  const fetchBrandSuppliers = (id: string) =>
    queryClient.fetchQuery({
      queryKey: ['brands', 'suppliers', id],
      queryFn: ({ signal }) => apiRequest<{ suppliers: BrandSupplierOption[] }>(`/brands/${id}/suppliers`, { signal }).then((r) => r.suppliers),
      staleTime: 10_000,
    });

  // Editing: load the saved brand's suppliers for the dropdown only. Nothing saved is replaced.
  useEffect(() => {
    const saved = initial?.brands?.[0];
    if (!saved) return;
    const seq = ++brandSeq.current;
    setBrandLoad('loading');
    fetchBrandSuppliers(saved.id)
      .then((options) => {
        if (seq !== brandSeq.current) return;
        setBrandSuppliers(options);
        setBrandLoad('idle');
      })
      .catch(() => seq === brandSeq.current && setBrandLoad('error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applySupplier(next: SupplierRef | null, defaults: Defaults, replace: boolean) {
    setSupplier(next);
    setValue('supplierId', next?.id ?? '', dirty);
    clearErrors('supplierId');
    setSupplierDefaults(defaults);
    setDefaultsError(null);
    if (replace) {
      // Only the categories change; amount, payments, status, description, date and files never do.
      setValue('categoryIds', defaults.categoryIds, { shouldValidate: submitCount > 0, shouldDirty: true });
      autoApplied.current = defaults;
    } else {
      // The user kept their own selections: from now on they are theirs, not the previous supplier's.
      autoApplied.current = null;
    }
  }

  /**
   * The new supplier is chosen but its defaults could not be loaded. Nothing is guessed: the
   * previous supplier's pre-selected categories are never kept silently ('remove' drops exactly
   * those; anything the user added themselves stays) and nothing else on the form changes. 'keep'
   * is the user's explicit decision to keep their current selections as their own.
   */
  function applyDefaultsFailure(next: SupplierRef, action: 'remove' | 'keep') {
    setSupplier(next);
    setValue('supplierId', next.id, dirty);
    clearErrors('supplierId');
    setSupplierDefaults(NO_DEFAULTS);
    if (action === 'remove') {
      const previous = autoApplied.current;
      if (previous) {
        setValue('categoryIds', getValues('categoryIds').filter((id) => !previous.categoryIds.includes(id)), {
          shouldValidate: submitCount > 0,
          shouldDirty: true,
        });
      }
    }
    autoApplied.current = null;
    setDefaultsError(next);
  }

  function handleDefaultsFailure(next: SupplierRef) {
    const previous = autoApplied.current;
    if (previous && !sameSet(getValues('categoryIds'), previous.categoryIds)) {
      // The previous supplier's defaults were edited by hand: ask what to do with them.
      setReplaceAsk({ next, defaults: null });
      return;
    }
    // Untouched previous defaults are dropped; the user's own (or saved) selections are left alone.
    applyDefaultsFailure(next, 'remove');
  }

  /**
   * Manual supplier choice (or change). Loads that supplier's ACTIVE default categories; asks before
   * replacing categories chosen by hand. `detail` skips the request when the categories are known
   * (brand suppliers come with them). `force` re-loads the defaults ("Try again").
   */
  async function selectSupplier(next: SupplierRef | null, detail?: { categories: ClassRef[] }, force = false) {
    if (!force && (next?.id ?? null) === (supplier?.id ?? null)) return;
    const seq = ++supplierSeq.current;
    let defaults: Defaults | null = NO_DEFAULTS;
    if (next) {
      try {
        setLoadingDefaults(true);
        const full: { categories: ClassRef[] } =
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
    const current = getValues('categoryIds');
    if (categoriesModified(current, autoApplied.current?.categoryIds ?? null) && !sameSet(current, defaults.categoryIds)) {
      setReplaceAsk({ next, defaults });
      return;
    }
    applySupplier(next, defaults, true);
  }

  /** Applies a (confirmed) brand change: brand, its supplier list, the supplier, maybe the categories. */
  function applyBrand(change: BrandChange, replaceCategories: boolean) {
    const previous = supplier;
    setValue('brandId', change.brand.id, dirty);
    setBrandSuppliers(change.options);
    setBrandLoad('idle');
    const supplierChanges = (change.supplier?.id ?? null) !== (previous?.id ?? null);
    if (supplierChanges) {
      supplierSeq.current += 1; // cancels a supplier-defaults request still in flight
      applySupplier(change.supplier, change.defaults, replaceCategories);
    }
    const removed = supplierChanges && previous ? `${previous.name} is not linked to ${change.brand.name}, so it was removed. ` : '';
    const notice =
      change.plan.kind === 'auto'
        ? `${change.plan.supplier.name} is the only supplier of ${change.brand.name}, so it was selected. You can change it.`
        : change.plan.kind === 'choose'
          ? `${removed}Choose which of ${change.brand.name}'s ${change.options.length} suppliers this bill is from.`
          : change.plan.kind === 'none'
            ? `${removed}${change.brand.name} has no linked supplier: continue without one, or add one.`
            : null;
    setBrandNotice(notice);
  }

  /**
   * Brand first: loads the brand's active suppliers, keeps a compatible supplier, selects the only
   * one automatically, or asks for a choice. Explains (and asks) before replacing or removing a
   * chosen supplier or hand-picked categories; amount, payments, date, description and files are
   * never touched.
   */
  async function selectBrand(next: ClassRef | null, force = false) {
    if (!force && (next?.id ?? '') === brandId) return;
    const seq = ++brandSeq.current;
    setBrandNotice(null);
    clearErrors('supplierId');
    if (!next) {
      // No brand: every supplier may be chosen again; the current one stays. Other brands only exist
      // next to a main brand, so they go too (said so, never silently).
      const extras = getValues('extraBrandIds').filter((id) => id !== brandId);
      setValue('brandId', '', dirty);
      setValue('extraBrandIds', [], dirty);
      setBrandSuppliers(null);
      setBrandLoad('idle');
      if (extras.length > 0) setBrandNotice(`No brand: the other brand${extras.length === 1 ? '' : 's'} of this expense ${extras.length === 1 ? 'was' : 'were'} removed too.`);
      return;
    }
    setBrandLoad('loading');
    let options: BrandSupplierOption[];
    try {
      options = await fetchBrandSuppliers(next.id);
    } catch {
      if (seq !== brandSeq.current) return;
      // The brand is applied, the supplier is left as it is (the server checks the pair on save).
      setValue('brandId', next.id, dirty);
      setBrandSuppliers(null);
      setBrandLoad('error');
      return;
    }
    if (seq !== brandSeq.current) return;
    const plan = planSupplierForBrand(supplier?.id ?? null, options);
    const nextSupplier = plan.kind === 'keep' ? supplier : plan.kind === 'auto' ? toSupplierRef(plan.supplier) : null;
    const defaults: Defaults = plan.kind === 'auto' ? defaultsOf(plan.supplier) : NO_DEFAULTS;
    const current = getValues('categoryIds');
    const atRisk = categoriesModified(current, autoApplied.current?.categoryIds ?? null) && !sameSet(current, defaults.categoryIds);
    const change: BrandChange = { brand: next, options, plan, supplier: nextSupplier, defaults, categoriesAtRisk: atRisk };
    const supplierChanges = (nextSupplier?.id ?? null) !== (supplier?.id ?? null);
    // Replacing or removing a chosen supplier, or hand-picked categories, is explained first.
    if (supplierChanges && (supplier !== null || atRisk)) {
      setBrandLoad('idle');
      setBrandAsk(change);
      return;
    }
    applyBrand(change, true);
  }

  const supplierName = supplier?.name ?? 'this supplier';
  const suggestedCategoryIds = new Set(supplierDefaults.categoryIds);
  const categoryError = errors.categoryIds?.message ?? (errors.categoryIds as { root?: { message?: string } } | undefined)?.root?.message;
  const extraBrandOptions = brandOptions.filter((b) => b.id !== brandId);
  const [showExtraBrands, setShowExtraBrands] = useState((initial?.brands?.length ?? 0) > 1);

  // Supplier choices when a brand is chosen: its suppliers (+ the saved one on an older expense).
  const supplierOptions: SearchSelectOption[] = (brandSuppliers ?? []).map((s) => ({ id: s.id, name: s.name, detail: s.phone, isActive: s.isActive }));
  if (supplier && brandSuppliers && !brandSuppliers.some((s) => s.id === supplier.id)) {
    supplierOptions.unshift({ id: supplier.id, name: supplier.name, detail: `Saved on this expense; not linked to ${brand?.name ?? 'this brand'}`, isActive: supplier.isActive });
  }
  const brandHasSuppliers = (brandSuppliers?.length ?? 0) > 0;
  // What is still owed on this bill after everything paid (the same split the server's rules use).
  const remainingDue = split.remaining === null ? null : split.remaining - supplierPaid;

  // Phones: the sticky Save bar steps aside while the on-screen keyboard is open.
  const [phone] = useState(isPhoneLayout);
  const inset = useViewportInset(phone);
  const keyboardOpen = (inset?.bottom ?? 0) >= KEYBOARD_MIN_PX;

  return (
    <>
      <form
        noValidate
        aria-label={initial ? 'Edit expense' : 'Add expense'}
        className="space-y-4 md:space-y-6 [&_button]:scroll-mb-32 [&_input]:scroll-mb-32 [&_select]:scroll-mb-32"
        onKeyDown={enterMovesToNextField}
        onSubmit={handleSubmit(async (values) => {
          // Synchronous re-entry guard: a fast double tap must not send twice (the server's
          // idempotency key is the second line of defence).
          if (inFlight.current || saved) return;
          // A newly chosen brand with suppliers needs one of them (the server checks the pair too).
          // An older expense keeps its saved brand without a supplier if it had none.
          const brandIsNew = !initial || values.brandId !== (initial.brands?.[0]?.id ?? '');
          if (values.brandId && brandIsNew && brandHasSuppliers && !values.supplierId) {
            setError('supplierId', { message: `Choose which of ${brand?.name ?? 'the brand'}'s suppliers this bill is from` });
            setFocus('supplierId');
            return;
          }
          inFlight.current = true;
          setFormError(null);
          setPaymentsServerError(null);
          try {
            const expense = await onSubmit(toInput(values), baseVersion.current);
            if (pending.pendingCount === 0) onDone(expense, savedNotice);
            else await queueFiles(expense);
          } catch (err) {
            // Everything typed stays in the form; only the errors are shown.
            if (err instanceof ApiError && err.details?.length) {
              for (const d of err.details) {
                if (d.path in values) setError(d.path as keyof FormValues, { message: d.message });
                else if (d.path === 'brandIds') setError('brandId', { message: d.message });
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
        <div className="space-y-4 md:space-y-6">
          <Section step={1} title="Amount" description="The full bill amount, including anything not paid yet.">
            <Field id="amount" label="Total expense amount" error={errors.amount?.message}>
              <div className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-3xl font-semibold text-muted-foreground">
                  ₹
                </span>
                <Input
                  id="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="next"
                  placeholder="0.00"
                  autoFocus={!initial}
                  className={cn('figure h-16 pl-11 text-3xl font-semibold md:h-16 md:text-3xl', amount !== '' && 'pr-14')}
                  {...errorProps('amount', errors.amount)}
                  {...register('amount')}
                />
                {amount !== '' && (
                  <button
                    type="button"
                    aria-label="Clear amount"
                    className="absolute right-2 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setValue('amount', '', { shouldValidate: submitCount > 0, shouldDirty: true });
                      setFocus('amount');
                    }}
                  >
                    <X className="size-5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </Field>
            <p className="figure text-base text-muted-foreground" aria-live="polite" data-testid="amount-in-words">
              {amountPositive ? `Amount: ${formatInr(amount)}` : 'Type the amount in rupees, e.g. 2500 or 2500.50.'}
            </p>
          </Section>

          <Section step={2} title="Supplier" description="Who the bill is from. Leave it empty if there is no supplier, e.g. rent or tea.">
            <div className="grid gap-5 md:grid-cols-2 md:items-start">
              <Field id="brand" label="Brand (optional)" error={errors.brandId?.message} hint="Choosing a brand fills in its supplier for you.">
                <SearchSelect
                  id="brand"
                  noun="brand"
                  icon={Tag}
                  options={brandOptions}
                  value={brand}
                  onChange={(next) => void selectBrand(next ? { id: next.id, name: next.name, isActive: next.isActive ?? true } : null)}
                  placeholder="No brand"
                  noneLabel="No brand"
                  loading={brandsQuery.isPending}
                  emptyText="No brands yet: add them on the Brands page."
                />
              </Field>

              <Field
                id="supplier"
                label="Supplier (optional)"
                error={errors.supplierId?.message}
                hint={
                  <button type="button" className="min-h-11 text-left font-medium text-primary underline underline-offset-2" onClick={() => setAddSupplier({ name: '' })}>
                    {brand ? `+ Add a new supplier for ${brand.name}` : '+ Add a new supplier'}
                  </button>
                }
              >
                {brand ? (
                  <SearchSelect
                    id="supplier"
                    noun="supplier"
                    icon={Truck}
                    options={supplierOptions}
                    value={supplier ? { id: supplier.id, name: supplier.name, isActive: supplier.isActive } : null}
                    onChange={(next) => {
                      const detail = brandSuppliers?.find((s) => s.id === next?.id);
                      void selectSupplier(next ? toSupplierRef({ id: next.id, name: next.name, isActive: next.isActive ?? true }) : null, detail);
                    }}
                    placeholder={brandLoad === 'loading' ? 'Loading suppliers…' : brandHasSuppliers ? `Choose ${brand.name}'s supplier` : 'No supplier'}
                    noneLabel={brandHasSuppliers || brandLoad === 'error' ? null : 'No supplier'}
                    disabled={brandLoad === 'loading'}
                    loading={brandLoad === 'loading'}
                    invalid={Boolean(errors.supplierId)}
                    describedBy={errors.supplierId ? 'supplier-error' : undefined}
                    emptyText={`${brand.name} has no linked supplier.`}
                  />
                ) : (
                  <SupplierPicker
                    id="supplier"
                    value={supplier}
                    onChange={(next) => void selectSupplier(next)}
                    onAddSupplier={(name) => setAddSupplier({ name })}
                    invalid={Boolean(errors.supplierId)}
                    describedBy={errors.supplierId ? 'supplier-error' : undefined}
                  />
                )}
                {!supplier && !errors.supplierId && (
                  <p className="text-sm text-muted-foreground" data-testid="no-supplier-note">
                    No supplier chosen. That is fine for expenses such as rent, wages or tea.
                  </p>
                )}
              </Field>
            </div>
            {brandLoad === 'error' && brand && (
              <div role="alert" className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-base" data-testid="brand-suppliers-error">
                <p>Could not load the suppliers of {brand.name}. The supplier was not changed; try again.</p>
                <Button variant="outline" onClick={() => void selectBrand(brand, true)}>
                  Try again
                </Button>
              </div>
            )}
            {brandNotice && (
              <p role="status" className="rounded-lg bg-surface-muted p-3 text-base" data-testid="brand-notice">
                {brandNotice}
              </p>
            )}
            {loadingDefaults && <p className="text-sm text-muted-foreground">Loading the supplier’s usual categories…</p>}
            {defaultsError && supplier?.id === defaultsError.id && (
              <div role="alert" className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-base" data-testid="defaults-error">
                <p>
                  Could not load the usual categories of <strong>{defaultsError.name}</strong>. Nothing was pre-selected: choose them below,
                  or try again. Everything else you entered is unchanged.
                </p>
                <Button
                  variant="outline"
                  loading={loadingDefaults}
                  onClick={() => void selectSupplier(supplier, brandSuppliers?.find((s) => s.id === supplier.id), true)}
                >
                  {loadingDefaults ? 'Loading…' : 'Try again'}
                </Button>
              </div>
            )}
          </Section>

          <Section step={3} title="What was this expense for?" description="Choose a category. A supplier's usual categories are picked for you.">
            <MultiSelect
              label="Category"
              noun="category"
              options={categoryOptions}
              selected={categoryIds}
              onChange={(ids) => setValue('categoryIds', ids, { shouldValidate: submitCount > 0, shouldDirty: true })}
              suggestedIds={suggestedCategoryIds}
              suggestedLabel={`Usual for ${supplierName}`}
              onCreate={categoryCreator.create}
              creating={categoryCreator.creating}
              note={categoryCreator.note}
              firstBadge="Main"
              hint={
                <>
                  You can choose more than one. The first one is the main category used in reports. The amount is never split.
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

            <Field id="description" label="Description (optional)" error={errors.description?.message} hint="For example: shop name, or what was bought.">
              <Input
                id="description"
                autoComplete="off"
                enterKeyHint="next"
                className={BIG_CONTROL}
                {...errorProps('description', errors.description)}
                {...register('description')}
              />
            </Field>
          </Section>

          <Section step={4} title="Payment" description="How much was paid now, and how.">
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem] md:items-start">
              <div className="min-w-0 space-y-5">
                {status !== null && (
                  <div className="space-y-2">
                    <p id="payment-status-label" className="text-base font-semibold">
                      Was it paid?
                    </p>
                    <div
                      role="radiogroup"
                      aria-labelledby="payment-status-label"
                      className="grid grid-cols-3 gap-1 rounded-xl bg-surface-muted p-1"
                      data-testid="payment-status"
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={status === o.value}
                          onClick={() => (o.value === 'full' ? choosePaidInFull() : o.value === 'partial' ? choosePartial() : chooseNotPaid())}
                          className={cn(
                            'min-h-12 rounded-lg px-2 text-base font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            status === o.value ? 'bg-primary text-primary-foreground shadow-card' : 'text-foreground hover:bg-card',
                          )}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground" role="status">
                      {status === 'full' && 'The whole amount was paid now.'}
                      {status !== 'full' &&
                        (hasSupplier
                          ? `Anything not paid now stays due to ${supplier?.name}.`
                          : 'Choose the supplier above: an unpaid or part-paid bill stays due to them.')}
                      {status === 'partial' && split.allocated === 0n && ' Enter the amount paid now.'}
                    </p>
                  </div>
                )}

                <fieldset className="space-y-3">
                  <legend className="mb-2 text-base font-semibold">{status === 'none' ? 'Paid now (nothing yet)' : 'How it was paid'}</legend>
                  {fields.map((field, i) => {
                    const rowErrors = errors.payments?.[i];
                    const suffix = i === 0 ? '' : ` (payment ${i + 1})`;
                    return (
                      <div key={field.id} className={cn('space-y-1.5', i > 0 && 'border-t pt-3')} data-testid="payment-row">
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
                          <div className="min-w-0 space-y-1.5">
                            <label htmlFor={`payment-${i}-amount`} className="block text-sm font-medium">
                              Amount paid{suffix}
                            </label>
                            <div className="relative">
                              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                ₹
                              </span>
                              <Input
                                id={`payment-${i}-amount`}
                                inputMode="decimal"
                                autoComplete="off"
                                enterKeyHint="next"
                                placeholder="0.00"
                                className={cn('figure pl-7', BIG_CONTROL)}
                                {...errorProps(`payment-${i}-amount`, rowErrors?.amount)}
                                {...register(`payments.${i}.amount`, {
                                  onChange: () => {
                                    if (i === 0) followAmount.current = false;
                                  },
                                })}
                              />
                            </div>
                          </div>
                          <div className="min-w-0 space-y-1.5">
                            <label htmlFor={`payment-${i}-method`} className="block text-sm font-medium">
                              Payment method{suffix}
                            </label>
                            <Select
                              id={`payment-${i}-method`}
                              className={BIG_CONTROL}
                              {...errorProps(`payment-${i}-method`, rowErrors?.paymentMode)}
                              {...register(`payments.${i}.paymentMode`)}
                            >
                              <option value="">Choose…</option>
                              {PAYMENT_MODES.map((m) => (
                                <option key={m} value={m}>
                                  {PAYMENT_MODE_LABELS[m]}
                                </option>
                              ))}
                            </Select>
                          </div>
                          {i > 0 ? (
                            <Button variant="ghost" size="icon" className="size-12 shrink-0 md:size-12" aria-label={`Remove payment ${i + 1}`} onClick={() => removeRow(i)}>
                              <X aria-hidden="true" />
                            </Button>
                          ) : (
                            // The first row is never removable; keep its columns aligned with the rows below.
                            fields.length > 1 && <span className="size-12 shrink-0" aria-hidden="true" />
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
                            className="min-h-11 text-sm font-medium text-primary underline underline-offset-2"
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
                  <Button variant="soft" disabled={fields.length >= MAX_PAYMENT_ROWS} onClick={addRow}>
                    <Plus aria-hidden="true" /> Add payment (another method)
                  </Button>
                </fieldset>
              </div>

              <div className="space-y-3 rounded-xl border bg-surface-muted p-4" data-testid="payment-summary">
                <dl className="space-y-2 text-base" aria-live="polite">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Total expense</dt>
                    <dd className="figure font-semibold">{split.total === null ? '—' : formatInr(fromPaise(split.total))}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Paid</dt>
                    <dd className="figure font-semibold">{formatInr(fromPaise(split.allocated))}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-2">
                    <dt className="font-semibold">
                      Remaining due
                      {supplierPaid > 0n && (
                        <span className="block text-sm font-normal text-muted-foreground">after {formatInr(paiseToString(supplierPaid))} of supplier payments</span>
                      )}
                    </dt>
                    <dd className={cn('figure text-xl font-bold', remainingDue !== null && remainingDue < 0n && 'text-destructive')} data-testid="payment-remaining">
                      {remainingDue === null ? '—' : formatInr(fromPaise(remainingDue))}
                    </dd>
                  </div>
                </dl>
                {remainingDue !== null && remainingDue >= 0n && (
                  <p
                    data-testid="payment-badge"
                    className={cn(
                      'inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-base font-semibold',
                      remainingDue === 0n ? 'bg-primary-soft text-primary-soft-foreground' : 'bg-warning-soft text-foreground ring-1 ring-warning/40',
                    )}
                  >
                    {remainingDue === 0n ? (
                      <>
                        <CircleCheck className="size-5 text-primary" aria-hidden="true" /> Fully paid
                      </>
                    ) : (
                      <>
                        <Clock className="size-5 text-warning" aria-hidden="true" /> Payment pending
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>
            {(showProblem || paymentsServerError) && (
              <p role="alert" className="text-base text-destructive">
                {showProblem ? split.problem : paymentsServerError}
              </p>
            )}
            {!splitOk && submitCount > 0 && !showProblem && !paymentsServerError && !hasSupplier && split.total !== null && !split.anyEntered && (
              <p role="alert" className="text-base text-destructive">
                Enter how the expense was paid.
              </p>
            )}
          </Section>

          <Section step={5} title="Date and bill number">
            <div className="grid gap-5 md:grid-cols-2 md:items-start">
              <Field id="expenseDate" label="Expense date" error={errors.expenseDate?.message}>
                <Input
                  id="expenseDate"
                  type="date"
                  max={todayInKolkata()}
                  className={BIG_CONTROL}
                  {...errorProps('expenseDate', errors.expenseDate)}
                  {...register('expenseDate')}
                />
              </Field>

              <Field id="invoiceReference" label="Bill number (optional)" error={errors.invoiceReference?.message} hint="The number printed on the bill, if any.">
                <Input
                  id="invoiceReference"
                  autoComplete="off"
                  enterKeyHint="done"
                  className={BIG_CONTROL}
                  {...errorProps('invoiceReference', errors.invoiceReference)}
                  {...register('invoiceReference')}
                />
              </Field>
            </div>

            {brand &&
              (showExtraBrands ? (
                <MultiSelect
                  label="Other brands (optional)"
                  noun="brand"
                  options={extraBrandOptions}
                  selected={extraBrandIds.filter((id) => id !== brandId)}
                  onChange={(ids) => setValue('extraBrandIds', ids, { shouldValidate: submitCount > 0, shouldDirty: true })}
                  onCreate={brandCreator.create}
                  creating={brandCreator.creating}
                  note={brandCreator.note}
                  loading={brandsQuery.isPending}
                  hint={`Only if the bill also covers other brands. ${brand.name} stays the main brand.`}
                  error={errors.extraBrandIds?.message}
                  testId="expense-brands"
                />
              ) : (
                <button type="button" className="min-h-11 text-base font-medium text-primary underline underline-offset-2" onClick={() => setShowExtraBrands(true)}>
                  + The bill covers other brands too
                </button>
              ))}
          </Section>
        </div>

        {/* Bill attachments are postponed: no upload step at all (docs/bill-attachments-postponed.md). */}
        {billAttachmentsEnabled() && (
          <Section step={6} title="Bill photos and documents">
            {initial && initial.documentCount > 0 && (
              <p className="text-sm text-muted-foreground">
                {initial.documentCount} document{initial.documentCount === 1 ? ' is' : 's are'} already attached; manage them on the expense
                details page.
              </p>
            )}
            {drafts.recoverable.length > 0 && (
              <div role="status" className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm" data-testid="draft-recovery">
                {confirmDiscardDrafts ? (
                  <>
                    <p>
                      Delete {drafts.recoverable.length === 1 ? 'this file' : `these ${drafts.recoverable.length} files`} from this device? They
                      were never uploaded, so this cannot be undone.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="destructive" onClick={() => void drafts.discardRecoverable().then(() => setConfirmDiscardDrafts(false))}>
                        Delete from device
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmDiscardDrafts(false)}>
                        Keep them
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      {drafts.recoverable.length} bill file{drafts.recoverable.length === 1 ? '' : 's'} chosen earlier for{' '}
                      {initial ? 'this expense' : 'a new expense'} {drafts.recoverable.length === 1 ? 'is' : 'are'} still on this device (the page
                      was closed or refreshed before saving): {drafts.recoverable.map((d) => d.fileName).join(', ')}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => pending.add(drafts.restore(), MAX_DOCUMENTS_PER_EXPENSE - (initial?.documentCount ?? 0))}
                      >
                        Add them to this expense
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmDiscardDrafts(true)}>
                        Discard…
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
            {drafts.problem && (
              <p role="alert" className="text-sm text-warning">
                {drafts.problem}
              </p>
            )}
            <DocumentPicker
              pending={pending}
              maxCount={MAX_DOCUMENTS_PER_EXPENSE - (initial?.documentCount ?? 0)}
              disabled={isSubmitting || saved !== null}
            />
            {queue && pending.files.length > 0 && (
              <p className="text-xs text-muted-foreground">
                When you save, the files are kept on this device and sent to the shop PC automatically (also later, if it is offline now).
              </p>
            )}
          </Section>
        )}

        {saved && (
          <div role="alert" className="space-y-3 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm">
            <p>
              <strong>{savedNotice}</strong> {pending.pendingCount} file{pending.pendingCount === 1 ? '' : 's'} could not be{' '}
              {queue ? 'kept for upload' : 'uploaded'} (see the errors {queue ? 'below' : 'above'}). The expense is stored; you can retry now or add
              documents later from its details page.
            </p>
            {queueProblems.length > 0 && (
              <ul className="space-y-1 text-destructive">
                {queueProblems.map((m) => (
                  <li key={m} className="break-words">
                    {m}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="sm" loading={pending.uploading} onClick={() => void queueFiles(saved)}>
                {pending.uploading ? 'Uploading…' : 'Retry'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending.uploading}
                onClick={() => {
                  drafts.forget(pending.files.map((f) => f.key));
                  onDone(saved, `${savedNotice} Some documents were not uploaded.`);
                }}
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

        {/* Save bar: sticky above the phone's bottom navigation (and near the bottom on desktop) so it
            is always easy to reach. While the on-screen keyboard is open it stays in place in the page
            instead, so it can never cover the field being typed in. */}
        <div
          data-testid="expense-actions"
          data-sticky={keyboardOpen ? 'false' : 'true'}
          className={cn(
            'z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-xl md:border md:px-5',
            keyboardOpen ? 'static' : 'sticky bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom))] md:bottom-4',
          )}
        >
          <div className="flex flex-col-reverse gap-2 md:flex-row md:items-center md:justify-end">
            <Link to={cancelTo} className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'h-12 text-base' })}>
              Cancel
            </Link>
            <Button type="submit" size="lg" className="h-14 text-lg md:h-12 md:min-w-52 md:text-base" loading={isSubmitting || pending.uploading} disabled={saved !== null}>
              {pending.uploading ? 'Uploading files…' : isSubmitting ? (initial ? 'Updating…' : 'Saving…') : submitLabel}
            </Button>
          </div>
        </div>
      </form>

      <Dialog
        open={replaceAsk !== null}
        title={replaceAsk?.defaults === null ? 'Remove the previous supplier’s categories?' : 'Replace categories?'}
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
            ? `The usual categories of ${replaceAsk.next?.name ?? 'the new supplier'} could not be loaded. Categories that came from the previous supplier are still selected. Remove those (anything you added yourself stays), or keep your selections as they are?`
            : replaceAsk?.next
              ? `You changed the categories of this expense. Replace them with the usual ones for ${replaceAsk.next.name}?`
              : 'You changed the categories of this expense. Clear them along with the supplier?'}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Cancel keeps the current supplier and everything entered. Brand, amounts, payments, description, date and bill photos are never
          changed here.
        </p>
      </Dialog>

      <Dialog
        open={brandAsk !== null}
        title={`Change brand to ${brandAsk?.brand.name ?? ''}?`}
        size="sm"
        onClose={() => setBrandAsk(null)}
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setBrandAsk(null)}>
              Cancel
            </Button>
            {brandAsk?.categoriesAtRisk && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (brandAsk) applyBrand(brandAsk, false);
                  setBrandAsk(null);
                }}
              >
                Keep my categories
              </Button>
            )}
            <Button
              onClick={() => {
                if (brandAsk) applyBrand(brandAsk, true);
                setBrandAsk(null);
              }}
            >
              Change brand
            </Button>
          </DialogActions>
        }
      >
        {brandAsk && (
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            {supplier && (
              <li>
                {brandAsk.supplier
                  ? `${supplier.name} is not linked to ${brandAsk.brand.name}. ${brandAsk.supplier.name}, its only supplier, will be selected instead.`
                  : brandAsk.plan.kind === 'none'
                    ? `${brandAsk.brand.name} has no linked supplier, so ${supplier.name} will be removed.`
                    : `${supplier.name} is not linked to ${brandAsk.brand.name}, so it will be removed and you choose one of its ${brandAsk.options.length} suppliers.`}
              </li>
            )}
            {brandAsk.categoriesAtRisk && (
              <li>
                You chose the categories by hand.{' '}
                {brandAsk.supplier ? `“Change brand” replaces them with ${brandAsk.supplier.name}’s usual categories.` : '“Change brand” clears them.'}{' '}
                “Keep my categories” keeps them.
              </li>
            )}
            <li className="text-muted-foreground">Cancel keeps everything as it is. Amount, payments, date, description and bill photos never change here.</li>
          </ul>
        )}
      </Dialog>

      <SupplierFormDialog
        open={addSupplier !== null}
        initialName={addSupplier?.name ?? ''}
        {...(brand ? { initialBrandIds: [brand.id] } : {})}
        onClose={() => setAddSupplier(null)}
        onSaved={(created) => {
          setAddSupplier(null);
          if (brand && created.brands.some((b) => b.id === brand.id)) {
            const option: BrandSupplierOption = {
              id: created.id,
              name: created.name,
              phone: created.phone,
              isActive: created.isActive,
              categories: created.categories,
            };
            setBrandSuppliers((list) => [...(list ?? []).filter((s) => s.id !== created.id), option]);
            void queryClient.invalidateQueries({ queryKey: ['brands', 'suppliers', brand.id] });
          }
          void selectSupplier(toSupplierRef(created), created);
        }}
      />
    </>
  );
}
