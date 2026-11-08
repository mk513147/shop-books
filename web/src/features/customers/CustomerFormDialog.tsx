import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import type { Customer } from '@/types/api';
import { useCreateCustomer, useUpdateCustomer } from './customers-api';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter the customer’s name').max(120, 'At most 120 characters'),
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/.test(v.replace(/\s+/g, ' ')), 'Use digits, spaces, +, - or ( )'),
  address: z.string().trim().max(300, 'At most 300 characters'),
  notes: z.string().trim().max(1000, 'At most 1000 characters'),
});
type Values = z.infer<typeof schema>;

/** Create or edit a customer (name, phone, address, notes). */
export function CustomerFormDialog({
  open,
  customer,
  onClose,
  onSaved,
}: {
  open: boolean;
  customer?: Customer;
  onClose: () => void;
  onSaved: (customer: Customer) => void;
}) {
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const mutation = customer ? update : create;
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    values: open
      ? {
          name: customer?.name ?? '',
          phone: customer?.phone ?? '',
          address: customer?.address ?? '',
          notes: customer?.notes ?? '',
        }
      : undefined,
  });

  const close = () => {
    create.reset();
    update.reset();
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      title={customer ? 'Edit customer' : 'Add customer'}
      onClose={close}
      dismissible={!mutation.isPending}
      footer={
        <DialogActions>
          <Button variant="outline" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="customer-form" loading={mutation.isPending}>
            {mutation.isPending ? (customer ? 'Updating…' : 'Saving…') : customer ? 'Save changes' : 'Add customer'}
          </Button>
        </DialogActions>
      }
    >
      <form
        id="customer-form"
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit(async (v) => {
          const input = { name: v.name, phone: v.phone || null, address: v.address || null, notes: v.notes || null };
          try {
            const saved = customer ? await update.mutateAsync({ id: customer.id, version: customer.version, ...input }) : await create.mutateAsync(input);
            onSaved(saved);
            close();
          } catch (err) {
            if (err instanceof ApiError && err.code === 'CUSTOMER_PHONE_TAKEN') setError('phone', { message: err.message });
            for (const d of err instanceof ApiError ? (err.details ?? []) : []) {
              if (d.path in v) setError(d.path as keyof Values, { message: d.message });
            }
          }
        })}
      >
        <Field id="customer-name" label="Name" error={errors.name?.message}>
          <Input id="customer-name" autoComplete="off" autoFocus {...errorProps('customer-name', errors.name)} {...register('name')} />
        </Field>
        <Field id="customer-phone" label="Phone (optional)" hint="Used to avoid duplicate customers." error={errors.phone?.message}>
          <Input id="customer-phone" type="tel" autoComplete="off" {...errorProps('customer-phone', errors.phone)} {...register('phone')} />
        </Field>
        <Field id="customer-address" label="Address (optional)" error={errors.address?.message}>
          <Input id="customer-address" autoComplete="off" {...register('address')} />
        </Field>
        <Field id="customer-notes" label="Notes (optional)" error={errors.notes?.message}>
          <Textarea id="customer-notes" {...register('notes')} />
        </Field>
        {mutation.isError && !(mutation.error instanceof ApiError && mutation.error.code === 'CUSTOMER_PHONE_TAKEN') && (
          <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
