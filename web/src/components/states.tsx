import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
  children,
}: {
  error?: unknown;
  onRetry?: () => void;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive-soft p-4">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="space-y-2 text-sm">
        <p className="font-medium">{title}</p>
        {error !== undefined && <p className="text-muted-foreground">{errorMessage(error)}</p>}
        {children}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-10 text-center">
      {Icon && (
        <span className="mb-1 inline-flex size-11 items-center justify-center rounded-full bg-primary-soft text-primary">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      )}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
