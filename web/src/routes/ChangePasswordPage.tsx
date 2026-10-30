import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { errorMessage } from '@/components/states';
import { Button } from '@/components/ui/button';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';

// Mirrors the server policy; the server remains the authority.
const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters')
      .max(128, 'Use at most 128 characters')
      .refine((v) => v.trim().length > 0, 'Password must not be blank'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one',
  });
type Values = z.infer<typeof schema>;

export function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const forced = user?.mustChangePassword === true;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  return (
    <AuthLayout
      title="Change password"
      description={
        forced
          ? 'You signed in with a temporary password. Choose your own password to continue.'
          : 'Changing your password signs you out on every other device.'
      }
    >
          <form
            noValidate
            className="space-y-4"
            onSubmit={handleSubmit(async (values) => {
              setFormError(null);
              try {
                await changePassword(values.currentPassword, values.newPassword);
                navigate('/', { replace: true });
              } catch (err) {
                setFormError(errorMessage(err));
              }
            })}
          >
            <Field id="currentPassword" label={forced ? 'Temporary password' : 'Current password'} error={errors.currentPassword?.message}>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                {...errorProps('currentPassword', errors.currentPassword)}
                {...register('currentPassword')}
              />
            </Field>
            <Field id="newPassword" label="New password" hint="At least 12 characters." error={errors.newPassword?.message}>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                {...errorProps('newPassword', errors.newPassword)}
                {...register('newPassword')}
              />
            </Field>
            <Field id="confirmPassword" label="Repeat new password" error={errors.confirmPassword?.message}>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                {...errorProps('confirmPassword', errors.confirmPassword)}
                {...register('confirmPassword')}
              />
            </Field>
            {formError && (
              <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Change password'}
            </Button>
            {!forced && (
              <Link to="/" className="block text-center text-sm text-muted-foreground underline">
                Cancel
              </Link>
            )}
          </form>
    </AuthLayout>
  );
}
