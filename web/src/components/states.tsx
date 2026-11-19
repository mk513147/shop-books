import { AlertTriangle, Loader2, RotateCw, WifiOff, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/** A grey placeholder block with a slow, cheap opacity pulse (no shimmer gradients). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-skeleton rounded-md bg-surface-strong', className)} />;
}

type SkeletonLayout = 'list' | 'table' | 'cards' | 'detail' | 'dashboard';

function SkeletonRows({ count, card }: { count: number; card: boolean }) {
  return (
    <div className={cn(card ? 'space-y-2' : 'divide-y rounded-xl border bg-card shadow-card')}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn('flex items-center justify-between gap-4', card ? 'rounded-xl border bg-card p-3.5 shadow-card' : 'px-4 py-3.5')}>
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5 opacity-70" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

function LayoutSkeleton({ layout }: { layout: SkeletonLayout }) {
  if (layout === 'list') return <SkeletonRows count={6} card />;
  if (layout === 'table')
    return (
      <>
        <div className="md:hidden">
          <SkeletonRows count={6} card />
        </div>
        <div className="hidden md:block">
          <SkeletonRows count={8} card={false} />
        </div>
      </>
    );
  if (layout === 'cards')
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border bg-card p-4 shadow-card">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-3 w-2/3 opacity-70" />
          </div>
        ))}
      </div>
    );
  if (layout === 'detail')
    return (
      <div className="space-y-4">
        <div className="space-y-3 rounded-xl border bg-card p-5 shadow-card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-3 w-1/2 opacity-70" />
        </div>
        <SkeletonRows count={4} card={false} />
      </div>
    );
  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border bg-card p-5 shadow-card">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-3 w-3/4 opacity-70" />
            <Skeleton className="h-3 w-2/3 opacity-70" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2.5 rounded-xl border bg-card p-4 shadow-card">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5 shadow-card">
          <Skeleton className="h-44 w-full" />
        </div>
        <SkeletonRows count={5} card={false} />
      </div>
    </div>
  );
}

/**
 * Loading indicator. Inline (spinner + words) by default; with `skeleton`, a placeholder in the
 * shape of the content that is coming, so the page does not jump when it arrives. The label is
 * always present for screen readers.
 */
export function LoadingState({ label = 'Loading…', skeleton }: { label?: string; skeleton?: SkeletonLayout }) {
  if (skeleton) {
    return (
      <div role="status" aria-live="polite" className="animate-fade-in">
        <span className="sr-only">{label}</span>
        <LayoutSkeleton layout={skeleton} />
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="flex animate-fade-in items-center gap-2.5 py-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

/** The server could not be reached (shown with a "no connection" icon; the message stays the client's). */
function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NETWORK_ERROR';
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
  const offline = isNetworkError(error);
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <div role="alert" className="flex animate-fade-in items-start gap-3 rounded-xl border border-destructive/20 bg-destructive-soft p-4">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-card text-destructive shadow-card">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 space-y-2 pt-1 text-sm">
        <p className="font-semibold text-foreground">{title}</p>
        {error !== undefined && (
          <p className="text-muted-foreground">{errorMessage(error)}</p>
        )}
        {children}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
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
    <div className="flex animate-fade-in flex-col items-center gap-2 rounded-xl border border-dashed border-input bg-card/70 px-6 py-12 text-center">
      {Icon && (
        <span className="mb-2 inline-flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-primary ring-1 ring-primary/10">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      )}
      <p className="text-[0.9375rem] font-semibold">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
