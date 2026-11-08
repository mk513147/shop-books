import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import { Textarea } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useBrands } from '@/features/brands/brands-api';
import { useCategories } from '@/features/categories/categories-api';
import { useBrandCreator, useCategoryCreator } from '@/features/classification/useOptionCreators';
import { ApiError } from '@/lib/api-client';
import type { ClassRef, Supplier } from '@/types/api';
import { useCreateSupplier, useUpdateSupplier } from './suppliers-api';

// Mirrors the server rules for fast feedback; the server re-validates everything.
const schema = z.object({
  name: z.string().trim().min(1, 'Enter the supplier name').max(120, 'At most 120 characters'),
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/.test(v.replace(/\s+/g, ' ')), 'Use digits, spaces, +, - or ( )'),
  address: z.string().trim().max(300, 'At most 300 characters'),
  notes: z.string().trim().max(1000, 'At most 1000 characters'),
});
type Values = z.infer<typeof schema>;

/** Active options plus already-linked ones that were archived since (they can be removed, not added). */
const withLinked = (active: ClassRef[] | undefined, linked: ClassRef[]) => [
  ...(active ?? []),
  ...linked.filter((l) => !l.isActive && !(active ?? []).some((a) => a.id === l.id)),
];

interface SupplierFormDialogProps {
  open: boolean;
  /** Edit this supplier; omitted to create a new one. */
  supplier?: Supplier;
  /** Prefill for a new supplier (e.g. the text typed into the supplier search). */
  initialName?: string;
  onClose: () => void;
  onSaved: (supplier: Supplier) => void;
}

export function SupplierFormDialog({ open, supplier, initialName = '', onClose, onSaved }: SupplierFormDialogProps) {
  const formId = useId();
  // Lifted from the form so the footer's submit button can show progress and block double taps.
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open={open}
      title={supplier ? 'Edit supplier' : 'Add supplier'}
      onClose={() => {
        if (!saving) onClose();
      }}
      size="md"
      footer={
        <DialogActions>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {saving ? (supplier ? 'Updating…' : 'Saving…') : supplier ? 'Save changes' : 'Save supplier'}
          </Button>
        </DialogActions>
      }
    >
      {/* Mounted per opening: starts from the data shown when it was opened. */}
      {open && <SupplierForm formId={formId} supplier={supplier} initialName={initialName} onSaved={onSaved} onSavingChange={setSaving} />}
    </Dialog>
  );
}

function SupplierForm({
  formId,
  supplier,
  initialName,
  onSaved,
  onSavingChange,
}: {
  formId: string;
  supplier: Supplier | undefined;
  initialName: string;
  onSaved: (supplier: Supplier) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  // Frozen at opening, like the expense form: if someone else saves meanwhile, our save gets a 409
  // instead of silently overwriting their change (and our typed edits are not reset by a refetch).
  const [base] = useState(supplier);
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const toast = useToast();
  const inFlight = useRef(false);
  const [formError, setFormError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [categoryIds, setCategoryIds] = useState<string[]>(base?.categories.map((c) => c.id) ?? []);
  const [brandIds, setBrandIds] = useState<string[]>(base?.brands.map((b) => b.id) ?? []);
  const categories = useCategories('active');
  const brands = useBrands('active');
  const categoryCreator = useCategoryCreator();
  const brandCreator = useBrandCreator();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: base?.name ?? initialName,
      phone: base?.phone ?? '',
      address: base?.address ?? '',
      notes: base?.notes ?? '',
    },
  });

  return (
    <form
      id={formId}
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit(async (v) => {
        // Synchronous guard: a double tap must not send twice.
        if (inFlight.current) return;
        inFlight.current = true;
        onSavingChange(true);
        setFormError(null);
        const input = {
          name: v.name.trim(),
          phone: v.phone.trim() || null,
          address: v.address.trim() || null,
          notes: v.notes.trim() || null,
          categoryIds,
          brandIds,
        };
        try {
          const saved = base
            ? await update.mutateAsync({ id: base.id, version: base.version, ...input })
            : await create.mutateAsync(input);
          toast({ title: base ? 'Supplier updated' : 'Supplier added', description: saved.name, tone: 'success' });
          onSaved(saved);
        } catch (err) {
          // Everything typed stays in the form; only the error is shown.
          if (err instanceof ApiError && err.details?.length) {
            for (const d of err.details) if (d.path in v) setError(d.path as keyof Values, { message: d.message });
          }
          if (err instanceof ApiError && err.code === 'SUPPLIER_NAME_TAKEN') setError('name', { message: err.message });
          setFormError({ message: errorMessage(err), conflict: err instanceof ApiError && err.code === 'VERSION_CONFLICT' });
        } finally {
          inFlight.current = false;
          onSavingChange(false);
        }
      })}
    >
      <Field id={`${formId}-name`} label="Supplier name" error={errors.name?.message}>
        <Input id={`${formId}-name`} autoComplete="off" {...errorProps(`${formId}-name`, errors.name)} {...register('name')} />
      </Field>
      <Field id={`${formId}-phone`} label="Phone (optional)" error={errors.phone?.message}>
        <Input
          id={`${formId}-phone`}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          {...errorProps(`${formId}-phone`, errors.phone)}
          {...register('phone')}
        />
      </Field>
      <Field id={`${formId}-address`} label="Address (optional)" error={errors.address?.message}>
        <Textarea id={`${formId}-address`} rows={2} className="min-h-16" {...errorProps(`${formId}-address`, errors.address)} {...register('address')} />
      </Field>
      <Field id={`${formId}-notes`} label="Notes (optional)" error={errors.notes?.message}>
        <Textarea id={`${formId}-notes`} rows={2} className="min-h-16" {...errorProps(`${formId}-notes`, errors.notes)} {...register('notes')} />
      </Field>
      <MultiSelect
        label="Brands supplied"
        noun="brand"
        hint="Optional. Pre-selected (and removable) when this supplier is chosen for a new expense."
        options={withLinked(brands.data, base?.brands ?? [])}
        selected={brandIds}
        onChange={setBrandIds}
        onCreate={brandCreator.create}
        creating={brandCreator.creating}
        note={brandCreator.note}
        loading={brands.isPending}
        testId="supplier-brands"
      />
      <MultiSelect
        label="Associated expense categories"
        noun="category"
        hint="Optional. Pre-selected (and removable) when this supplier is chosen for a new expense; any category can still be used. New categories are shared by every supplier."
        options={withLinked(categories.data, base?.categories ?? [])}
        selected={categoryIds}
        onChange={setCategoryIds}
        onCreate={categoryCreator.create}
        creating={categoryCreator.creating}
        note={categoryCreator.note}
        loading={categories.isPending}
        testId="supplier-categories"
      />
      {formError && (
        <div role="alert" className="space-y-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          <p>{formError.message}</p>
          {formError.conflict && <p className="text-muted-foreground">Close this window and open the supplier again to see the latest details.</p>}
        </div>
      )}
    </form>
  );
}
