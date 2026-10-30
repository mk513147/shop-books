import type { ReactNode } from 'react';
import { Label } from './label';

/** Label + control + inline error, wired for screen readers via `<id>-error`. */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function errorProps(id: string, error: unknown) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
}
