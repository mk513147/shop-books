import { zodResolver } from '@hookform/resolvers/zod';
import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { Salesman } from '@/types/api';
import { useCreateSalesman, useUpdateSalesman } from './salesmen-api';

// Mirrors the server rules for fast feedback; the server re-validates everything.
const schema = z.object({
  name: z.string().trim().min(1, 'Enter the salesman’s name').max(120, 'At most 120 characters'),
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/.test(v.replace(/\s+/g, ' ')), 'Use digits, spaces, +, - or ( )'),
  notes: z.string().trim().max(1000, 'At most 1000 characters'),
});
type Values = z.infer<typeof schema>;

/**
 * Create or edit a salesman (name, phone, notes). The save button shows progress and cannot be
 * pressed twice; on failure the typed values stay and the error is shown.
 */
export function SalesmanFormDialog({
  open,
  salesman,
  onClose,
  onSaved,
}: {
  open: boolean;
  salesman?: Salesman;
  onClose: () => void;
  onSaved: (salesman: Salesman) => void;
}) {
  const toast = useToast();
  const create = useCreateSalesman();
  const update = useUpdateSalesman();
  const mutation = salesman ? update : create;
  const inFlight = useRef(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    values: open ? { name: salesman?.name ?? '', phone: salesman?.phone ?? '', notes: salesman?.notes ?? '' } : undefined,
    // Keep what the user typed if the record is refetched while the dialog is open.
    resetOptions: { keepDirtyValues: true },
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
      title={salesman ? 'Edit salesman' : 'Add salesman'}
      onClose={close}
      dismissible={!mutation.isPending}
      footer={
        <DialogActions>
          <Button variant="outline" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="salesman-form" loading={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : salesman ? 'Save changes' : 'Add salesman'}
          </Button>
        </DialogActions>
      }
    >
      <form
        id="salesman-form"
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit(async (v) => {
          // Synchronous guard: a fast double tap must not send twice.
          if (inFlight.current) return;
          inFlight.current = true;
          const input = { name: v.name, phone: v.phone || null, notes: v.notes || null };
          try {
            const saved = salesman
              ? await update.mutateAsync({ id: salesman.id, version: salesman.version, ...input })
              : await create.mutateAsync(input);
            toast({ title: salesman ? 'Salesman updated' : 'Salesman added', description: saved.name, tone: 'success' });
            onSaved(saved);
            close();
          } catch (err) {
            for (const d of err instanceof ApiError ? (err.details ?? []) : []) {
              if (d.path in v) setError(d.path as keyof Values, { message: d.message });
            }
            toast({ title: 'Could not save the salesman', description: errorMessage(err), tone: 'error' });
          } finally {
            inFlight.current = false;
          }
        })}
      >
        <Field id="salesman-name" label="Name" error={errors.name?.message}>
          <Input id="salesman-name" autoComplete="off" autoFocus {...errorProps('salesman-name', errors.name)} {...register('name')} />
        </Field>
        <Field id="salesman-phone" label="Phone (optional)" error={errors.phone?.message}>
          <Input
            id="salesman-phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+91 98765 43210"
            {...errorProps('salesman-phone', errors.phone)}
            {...register('phone')}
          />
        </Field>
        <Field id="salesman-notes" label="Notes (optional)" error={errors.notes?.message}>
          <Textarea id="salesman-notes" {...errorProps('salesman-notes', errors.notes)} {...register('notes')} />
        </Field>
        {mutation.isError && (
          <div role="alert" className="space-y-1 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
            <p>{errorMessage(mutation.error)}</p>
            {mutation.error instanceof ApiError && mutation.error.code === 'VERSION_CONFLICT' && (
              <p className="text-muted-foreground">Close this window and open the salesman again to see the latest details.</p>
            )}
          </div>
        )}
      </form>
    </Dialog>
  );
}
