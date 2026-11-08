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
import { useCategories, useCreateCategory, useUpdateCategory } from '@/features/categories/categories-api';
import type { Category } from '@/types/api';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80, 'At most 80 characters'),
  description: z.string().trim().max(500, 'At most 500 characters'),
});
type Values = z.infer<typeof schema>;

function CategoryForm({
  idPrefix,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: Values;
  submitLabel: string;
  onSubmit: (v: { name: string; description: string | null }) => Promise<unknown>;
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
      className="grid gap-3 md:grid-cols-[1fr_2fr_auto] md:items-end"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        try {
          await onSubmit({ name: v.name.trim(), description: v.description.trim() || null });
          if (!onCancel) reset({ name: '', description: '' });
        } catch (err) {
          setFormError(errorMessage(err));
        }
      })}
    >
      <Field id={`${idPrefix}-name`} label="Name" error={errors.name?.message}>
        <Input id={`${idPrefix}-name`} autoComplete="off" {...errorProps(`${idPrefix}-name`, errors.name)} {...register('name')} />
      </Field>
      <Field id={`${idPrefix}-description`} label="Description (optional)" error={errors.description?.message}>
        <Input id={`${idPrefix}-description`} autoComplete="off" {...register('description')} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" className="flex-1 md:flex-none" loading={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {formError && (
        <p role="alert" className="text-sm text-destructive md:col-span-3">
          {formError}
        </p>
      )}
    </form>
  );
}

function CategoryRow({ category }: { category: Category }) {
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const update = useUpdateCategory();
  const toast = useToast();
  const setActive = (isActive: boolean) =>
    update.mutate(
      { id: category.id, isActive },
      { onSuccess: () => toast({ title: isActive ? 'Category reactivated' : 'Category archived', description: category.name, tone: 'success' }) },
    );

  if (editing) {
    return (
      <li className="py-3">
        <CategoryForm
          idPrefix={`edit-${category.id}`}
          initial={{ name: category.name, description: category.description ?? '' }}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => {
            await update.mutateAsync({ id: category.id, ...v });
            toast({ title: 'Category updated', description: v.name, tone: 'success' });
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3">
      <div className="min-w-0">
        <p className="font-medium">{category.name}</p>
        <p className="text-sm text-muted-foreground">
          {category.description ? `${category.description} · ` : ''}
          {category.expenseCount} expense{category.expenseCount === 1 ? '' : 's'}
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
            if (category.isActive) setConfirmArchive(true);
            else setActive(true);
          }}
        >
          {update.isPending ? (category.isActive ? 'Archiving…' : 'Reactivating…') : category.isActive ? 'Archive' : 'Reactivate'}
        </Button>
      </div>
      <Dialog
        open={confirmArchive}
        title={`Archive “${category.name}”?`}
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
          Its {category.expenseCount} existing expense(s) keep this category and supplier defaults stay linked, but it can no
          longer be chosen for new expenses or pre-selected automatically.
        </p>
      </Dialog>
    </li>
  );
}

export function CategoriesPage() {
  const categories = useCategories('all');
  const create = useCreateCategory();
  const toast = useToast();
  const active = categories.data?.filter((c) => c.isActive) ?? [];
  const archived = categories.data?.filter((c) => !c.isActive) ?? [];

  return (
    <Page width="narrow">
      <PageHeader
        title="Expense categories"
        back={{ to: '/expenses', label: 'Expenses' }}
        description="Shared by everyone and usable with any supplier."
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a category</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryForm
            idPrefix="new-category"
            initial={{ name: '', description: '' }}
            submitLabel="Add"
            onSubmit={async (v) => {
              await create.mutateAsync(v);
              toast({ title: 'Category added', description: v.name, tone: 'success' });
            }}
          />
        </CardContent>
      </Card>

      {categories.isPending && <LoadingState label="Loading categories…" />}
      {categories.isError && <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />}
      {categories.isSuccess && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Active ({active.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {active.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active categories yet. Add one above.</p>
              ) : (
                <ul className="divide-y">
                  {active.map((c) => (
                    <CategoryRow key={c.id} category={c} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {archived.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Archived ({archived.length})</CardTitle>
                <CardDescription>Not available for new expenses. Existing expenses keep their category.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {archived.map((c) => (
                    <CategoryRow key={c.id} category={c} />
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
