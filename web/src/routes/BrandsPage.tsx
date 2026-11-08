import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useBrands, useCreateBrand, useUpdateBrand } from '@/features/brands/brands-api';
import type { Brand } from '@/types/api';

const schema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(80, 'At most 80 characters') });
type Values = z.infer<typeof schema>;

function BrandForm({
  idPrefix,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: Values;
  submitLabel: string;
  onSubmit: (v: { name: string }) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: initial });

  return (
    <form
      noValidate
      className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        try {
          await onSubmit({ name: v.name.trim().replace(/\s+/g, ' ') });
          if (!onCancel) reset({ name: '' });
        } catch (err) {
          // The typed name stays in the field.
          setFormError(errorMessage(err));
        }
      })}
    >
      <Field id={`${idPrefix}-name`} label="Brand name" error={errors.name?.message}>
        <Input id={`${idPrefix}-name`} autoComplete="off" placeholder="e.g. Samsung" {...errorProps(`${idPrefix}-name`, errors.name)} {...register('name')} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" className="flex-1 md:flex-none" loading={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={isSubmitting} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {formError && (
        <p role="alert" className="text-sm text-destructive md:col-span-2">
          {formError}
        </p>
      )}
    </form>
  );
}

function BrandRow({ brand }: { brand: Brand }) {
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const update = useUpdateBrand();
  const toast = useToast();
  const setActive = (isActive: boolean) =>
    update.mutate(
      { id: brand.id, isActive },
      { onSuccess: () => toast({ title: isActive ? 'Brand reactivated' : 'Brand archived', description: brand.name, tone: 'success' }) },
    );

  if (editing) {
    return (
      <li className="py-3">
        <BrandForm
          idPrefix={`edit-${brand.id}`}
          initial={{ name: brand.name }}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => {
            await update.mutateAsync({ id: brand.id, ...v });
            toast({ title: 'Brand updated', description: v.name, tone: 'success' });
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3">
      <div className="min-w-0">
        <p className="font-medium">{brand.name}</p>
        <p className="text-sm text-muted-foreground">
          {brand.expenseCount} expense{brand.expenseCount === 1 ? '' : 's'} · default for {brand.supplierCount} supplier
          {brand.supplierCount === 1 ? '' : 's'}
        </p>
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(update.error)}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="outline"
          loading={update.isPending}
          onClick={() => {
            if (brand.isActive) setConfirmArchive(true);
            else setActive(true);
          }}
        >
          {update.isPending ? (brand.isActive ? 'Archiving…' : 'Reactivating…') : brand.isActive ? 'Archive' : 'Reactivate'}
        </Button>
      </div>
      <Dialog
        open={confirmArchive}
        title={`Archive “${brand.name}”?`}
        onClose={() => setConfirmArchive(false)}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmArchive(false);
                setActive(false);
              }}
            >
              Archive
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          Its {brand.expenseCount} existing expense(s) and supplier defaults keep this brand, but it can no longer be chosen for new
          expenses or pre-selected automatically.
        </p>
      </Dialog>
    </li>
  );
}

/** Brands (manufacturers): shared master data, independent of suppliers and categories. */
export function BrandsPage() {
  const brands = useBrands('all');
  const create = useCreateBrand();
  const toast = useToast();
  const active = brands.data?.filter((b) => b.isActive) ?? [];
  const archived = brands.data?.filter((b) => !b.isActive) ?? [];

  return (
    <Page width="narrow">
      <PageHeader
        title="Brands"
        back={{ to: '/suppliers', label: 'Suppliers' }}
        description="Manufacturers. Link them to suppliers as defaults, and tag expenses with them. Labels only: never extra money."
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a brand</CardTitle>
        </CardHeader>
        <CardContent>
          <BrandForm
            idPrefix="new-brand"
            initial={{ name: '' }}
            submitLabel="Add"
            onSubmit={async (v) => {
              await create.mutateAsync(v);
              toast({ title: 'Brand added', description: v.name, tone: 'success' });
            }}
          />
        </CardContent>
      </Card>

      {brands.isPending && <LoadingState label="Loading brands…" />}
      {brands.isError && <ErrorState error={brands.error} onRetry={() => void brands.refetch()} />}
      {brands.isSuccess && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Active ({active.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {active.length === 0 ? (
                <p className="text-sm text-muted-foreground">No brands yet. Add one above, or while editing a supplier or an expense.</p>
              ) : (
                <ul className="divide-y">
                  {active.map((b) => (
                    <BrandRow key={b.id} brand={b} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {archived.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Archived ({archived.length})</CardTitle>
                <CardDescription>Not available for new expenses. Existing expenses keep their brands.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {archived.map((b) => (
                    <BrandRow key={b.id} brand={b} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
