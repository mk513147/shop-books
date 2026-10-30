import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Plus } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/select';
import { useCategories, useCreateCategory } from '@/features/categories/categories-api';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { Category, Supplier } from '@/types/api';
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

type CategoryOption = Pick<Category, 'id' | 'name' | 'isActive'>;

/**
 * Multi-select of GLOBAL categories with inline creation. A new category is a normal shared
 * category (POST /categories); an existing name (any letter case) is selected instead of duplicated.
 */
function CategoryChooser({
  selected,
  onChange,
  linkedArchived,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Already-linked categories that have since been archived (can be removed, not added). */
  linkedArchived: CategoryOption[];
}) {
  const id = useId();
  const categories = useCategories('active');
  const create = useCreateCategory();
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options: CategoryOption[] = [...(categories.data ?? []), ...linkedArchived];

  const toggle = (cid: string) => onChange(selected.includes(cid) ? selected.filter((x) => x !== cid) : [...selected, cid]);

  async function addCategory() {
    const name = newName.trim().replace(/\s+/g, ' ');
    if (!name) {
      inputRef.current?.focus();
      return;
    }
    const existing = categories.data?.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!selected.includes(existing.id)) onChange([...selected, existing.id]);
      setNote({ text: `“${existing.name}” already exists, so it was selected.`, error: false });
      setNewName('');
      return;
    }
    try {
      const { category } = (await create.mutateAsync({ name, description: null })) as { category: Category };
      onChange([...selected, category.id]);
      setNote({ text: `Created “${category.name}” (available for every supplier) and selected it.`, error: false });
      setNewName('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CATEGORY_NAME_TAKEN') {
        // Created by someone else a moment ago: pick theirs.
        const fresh = (await categories.refetch()).data?.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (fresh) {
          onChange([...selected, fresh.id]);
          setNote({ text: `“${fresh.name}” already exists, so it was selected.`, error: false });
          setNewName('');
          return;
        }
      }
      setNote({ text: errorMessage(err), error: true });
    }
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Categories usually bought from this supplier</legend>
      <p className="text-xs text-muted-foreground">
        Optional. These are suggested first when recording an expense; any category can still be used.
      </p>
      {categories.isPending && <p className="text-sm text-muted-foreground">Loading categories…</p>}
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((c) => {
            const on = selected.includes(c.id);
            if (!c.isActive && !on) return null;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(c.id)}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-primary bg-primary-soft text-primary-soft-foreground' : 'border-input bg-card hover:bg-accent',
                )}
              >
                {on && <Check className="size-3.5" aria-hidden="true" />}
                {c.name}
                {!c.isActive && <span className="text-xs text-muted-foreground">(archived)</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="space-y-1.5 pt-1">
        <Label htmlFor={`${id}-new`} className="text-xs text-muted-foreground">
          New category
        </Label>
        <div className="flex gap-2">
          <Input
            id={`${id}-new`}
            ref={inputRef}
            value={newName}
            maxLength={80}
            autoComplete="off"
            placeholder="e.g. Packaging"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addCategory();
              }
            }}
          />
          <Button variant="outline" className="shrink-0" disabled={create.isPending} onClick={() => void addCategory()}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
        {note && (
          <p role={note.error ? 'alert' : 'status'} className={cn('text-xs', note.error ? 'text-destructive' : 'text-muted-foreground')}>
            {note.text}
          </p>
        )}
      </div>
    </fieldset>
  );
}

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
  return (
    <Dialog
      open={open}
      title={supplier ? 'Edit supplier' : 'Add supplier'}
      onClose={onClose}
      size="md"
      footer={
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            {supplier ? 'Save changes' : 'Save supplier'}
          </Button>
        </DialogActions>
      }
    >
      {/* Mounted per opening: starts from the data shown when it was opened. */}
      {open && <SupplierForm formId={formId} supplier={supplier} initialName={initialName} onSaved={onSaved} />}
    </Dialog>
  );
}

function SupplierForm({
  formId,
  supplier,
  initialName,
  onSaved,
}: {
  formId: string;
  supplier: Supplier | undefined;
  initialName: string;
  onSaved: (supplier: Supplier) => void;
}) {
  // Frozen at opening, like the expense form: if someone else saves meanwhile, our save gets a 409
  // instead of silently overwriting their change (and our typed edits are not reset by a refetch).
  const [base] = useState(supplier);
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const inFlight = useRef(false);
  const [formError, setFormError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [categoryIds, setCategoryIds] = useState<string[]>(base?.categories.map((c) => c.id) ?? []);
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
        if (inFlight.current) return;
        inFlight.current = true;
        setFormError(null);
        const input = {
          name: v.name.trim(),
          phone: v.phone.trim() || null,
          address: v.address.trim() || null,
          notes: v.notes.trim() || null,
          categoryIds,
        };
        try {
          const saved = base
            ? await update.mutateAsync({ id: base.id, version: base.version, ...input })
            : await create.mutateAsync(input);
          onSaved(saved);
        } catch (err) {
          if (err instanceof ApiError && err.details?.length) {
            for (const d of err.details) if (d.path in v) setError(d.path as keyof Values, { message: d.message });
          }
          if (err instanceof ApiError && err.code === 'SUPPLIER_NAME_TAKEN') setError('name', { message: err.message });
          setFormError({ message: errorMessage(err), conflict: err instanceof ApiError && err.code === 'VERSION_CONFLICT' });
        } finally {
          inFlight.current = false;
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
      <CategoryChooser
        selected={categoryIds}
        onChange={setCategoryIds}
        linkedArchived={base?.categories.filter((c) => !c.isActive) ?? []}
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
