import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import {
  useCreateUser,
  useResetPassword,
  useRevokeSessions,
  useSetUserActive,
  useUsers,
} from '@/features/users/users-api';
import type { UserSummary } from '@/types/api';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  email: z.string().trim().min(1, 'Enter an email address').email('Enter a valid email address'),
});
type CreateValues = z.infer<typeof createSchema>;

interface TemporaryPassword {
  name: string;
  password: string;
}

/** Shown exactly once: the server never returns a temporary password again. */
function TemporaryPasswordNotice({ value, onDismiss }: { value: TemporaryPassword; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="space-y-3 callout callout-success p-4">
      <p>
        Temporary password for <strong>{value.name}</strong>. Give it to them privately; they must change it when
        they first sign in. <strong>It will not be shown again.</strong>
      </p>
      <code className="block select-all break-all rounded-lg border bg-card px-3 py-2 font-mono text-base">{value.password}</code>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(value.password).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function CreateUserForm({ onCreated }: { onCreated: (value: TemporaryPassword) => void }) {
  const createUser = useCreateUser();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateValues>({ resolver: zodResolver(createSchema) });

  return (
    <form
      noValidate
      className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
      onSubmit={handleSubmit(async (values) => {
        const result = await createUser.mutateAsync(values).catch(() => null);
        if (result) {
          reset();
          onCreated({ name: result.user.name, password: result.temporaryPassword });
        }
      })}
    >
      <Field id="new-name" label="Name" error={errors.name?.message}>
        <Input id="new-name" autoComplete="off" {...errorProps('new-name', errors.name)} {...register('name')} />
      </Field>
      <Field id="new-email" label="Email" error={errors.email?.message}>
        <Input id="new-email" type="email" autoComplete="off" {...errorProps('new-email', errors.email)} {...register('email')} />
      </Field>
      <Button type="submit" loading={createUser.isPending}>
        {createUser.isPending ? 'Adding…' : 'Add manager'}
      </Button>
      {createUser.isError && (
        <p role="alert" className="callout callout-danger md:col-span-3">
          {errorMessage(createUser.error)}
        </p>
      )}
    </form>
  );
}

function statusText(user: UserSummary): string {
  if (!user.isActive) return 'Deactivated';
  if (user.lockedUntil) return `Locked until ${new Date(user.lockedUntil).toLocaleTimeString()}`;
  if (user.mustChangePassword) return 'Must change password';
  return 'Active';
}

function statusTone(user: UserSummary): 'neutral' | 'accent' | 'warning' | 'danger' {
  if (!user.isActive) return 'neutral';
  if (user.lockedUntil) return 'danger';
  if (user.mustChangePassword) return 'warning';
  return 'accent';
}

function UserRow({
  user,
  isSelf,
  onTemporaryPassword,
}: {
  user: UserSummary;
  isSelf: boolean;
  onTemporaryPassword: (value: TemporaryPassword) => void;
}) {
  const setActive = useSetUserActive();
  const resetPassword = useResetPassword();
  const revokeSessions = useRevokeSessions();
  const [message, setMessage] = useState<string | null>(null);
  const busy = setActive.isPending || resetPassword.isPending || revokeSessions.isPending;
  const error = setActive.error ?? resetPassword.error ?? revokeSessions.error;

  return (
    <li className="space-y-3 px-4 py-4 md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={user.isActive ? 'font-semibold' : 'font-semibold text-muted-foreground'}>
            {user.name} {isSelf && <span className="text-xs font-medium text-muted-foreground">(you)</span>}
          </p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="capitalize text-muted-foreground">{user.role}</span>
          <span aria-hidden="true" className="text-muted-foreground/60">·</span>
          <Badge tone={statusTone(user)} dot>
            {statusText(user)}
          </Badge>
        </p>
      </div>
      {user.role !== 'owner' && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const verb = user.isActive ? 'Deactivate' : 'Reactivate';
              if (!window.confirm(`${verb} ${user.name}?${user.isActive ? ' They will be signed out immediately.' : ''}`)) return;
              setMessage(null);
              setActive.mutate({ id: user.id, isActive: !user.isActive });
            }}
          >
            {user.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Reset the password for ${user.name}? They will be signed out everywhere.`)) return;
              setMessage(null);
              resetPassword.mutate(user.id, {
                onSuccess: (r) => onTemporaryPassword({ name: r.user.name, password: r.temporaryPassword }),
              });
            }}
          >
            Reset password
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Sign ${user.name} out on all devices?`)) return;
              revokeSessions.mutate(user.id, {
                onSuccess: (r) => setMessage(`Signed out of ${r.revoked} session(s).`),
              });
            }}
          >
            Sign out everywhere
          </Button>
        </div>
      )}
      {message && <p className="callout callout-info">{message}</p>}
      {error && (
        <p role="alert" className="callout callout-danger">
          {errorMessage(error)}
        </p>
      )}
    </li>
  );
}

/** Owner-only account management. Managers never reach this (route guard + API 403). */
export function UsersPage() {
  const { user: me } = useAuth();
  const users = useUsers();
  const [temporary, setTemporary] = useState<TemporaryPassword | null>(null);

  return (
    <Page width="narrow">
      <PageHeader title="Users" description="Owner only: manager accounts, password resets and sign-outs." />

      {temporary && <TemporaryPasswordNotice value={temporary} onDismiss={() => setTemporary(null)} />}

      <Card>
        <CardHeader>
          <CardTitle>Add a manager</CardTitle>
          <CardDescription>
            Managers can manage all shop records. A temporary password is generated for them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateUserForm onCreated={setTemporary} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent className={users.isSuccess ? 'px-0 pb-1 md:px-0 md:pb-1' : undefined}>
          {users.isPending && <LoadingState label="Loading users…" skeleton="list" />}
          {users.isError && <ErrorState error={users.error} onRetry={() => void users.refetch()} />}
          {users.isSuccess && (
            <ul className="divide-y border-t">
              {users.data.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === me?.id} onTemporaryPassword={setTemporary} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
