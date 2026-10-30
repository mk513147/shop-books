import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { errorMessage, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const { status, user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }
  if (status === 'authenticated' && user) {
    return <Navigate to={user.mustChangePassword ? '/change-password' : from} replace />;
  }

  return (
    <AuthLayout title="Sign in to Shop-Books" description="Access is limited to authorised shop staff.">
          <form
            noValidate
            className="space-y-4"
            onSubmit={handleSubmit(async (values) => {
              setFormError(null);
              try {
                const signedIn = await login(values.email, values.password);
                navigate(signedIn.mustChangePassword ? '/change-password' : from, { replace: true });
              } catch (err) {
                resetField('password');
                setFormError(errorMessage(err));
              }
            })}
          >
            <Field id="email" label="Email" error={errors.email?.message}>
              <Input id="email" type="email" autoComplete="username" {...errorProps('email', errors.email)} {...register('email')} />
            </Field>
            <Field id="password" label="Password" error={errors.password?.message}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...errorProps('password', errors.password)}
                {...register('password')}
              />
            </Field>
            {formError && (
              <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="text-xs text-muted-foreground">Forgotten your password? Ask the shop owner to reset it.</p>
          </form>
    </AuthLayout>
  );
}
