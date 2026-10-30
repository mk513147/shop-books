import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
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
    <div role="status" className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-4 text-sm">
      <p>
        Temporary password for <strong>{value.name}</strong>. Give it to them privately; they must change it when
        they first sign in. <strong>It will not be shown again.</strong>
      </p>
      <code className="block select-all break-all rounded bg-card px-3 py-2 font-mono text-base">{value.password}</code>
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
      className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
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
      <Button type="submit" disabled={createUser.isPending}>
        {createUser.isPending ? 'Adding…' : 'Add manager'}
      </Button>
      {createUser.isError && (
        <p role="alert" className="text-sm text-destructive sm:col-span-3">
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
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {user.name} {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
          </p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
        </div>
        <p className="text-sm">
          <span className="capitalize">{user.role}</span> · {statusText(user)}
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
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
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
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>

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
        <CardContent>
          {users.isPending && <LoadingState label="Loading users…" />}
          {users.isError && <ErrorState error={users.error} onRetry={() => void users.refetch()} />}
          {users.isSuccess && (
            <ul className="divide-y">
              {users.data.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === me?.id} onTemporaryPassword={setTemporary} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
