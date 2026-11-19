import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from './label';

/** Inline validation message: icon + words, eased in so it does not jolt the form. */
export function FieldError({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={cn('flex animate-fade-in items-start gap-1.5 text-sm font-medium text-destructive', className)}>
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Label + control + inline error, wired for screen readers via `<id>-error`. */
export function Field({
  id,
  label,
  error,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  );
}

export function errorProps(id: string, error: unknown) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
}
