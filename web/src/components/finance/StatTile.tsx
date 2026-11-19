import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

const TONE_TEXT = {
  default: '',
  warning: 'text-warning',
  accent: 'text-primary',
  info: 'text-info',
  muted: 'text-muted-foreground',
} as const;

const TONE_RAIL = {
  default: 'bg-surface-strong',
  warning: 'bg-warning-strong',
  accent: 'bg-primary',
  info: 'bg-info',
  muted: 'bg-surface-strong',
} as const;

/** One labelled money figure (balances, totals). Values are server-computed decimal strings. */
export function StatTile({
  label,
  amount,
  hint,
  tone = 'default',
  icon: Icon,
  className,
}: {
  label: string;
  amount: string;
  hint?: ReactNode;
  tone?: keyof typeof TONE_TEXT;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn('relative min-w-0 overflow-hidden rounded-xl border bg-card p-3.5 shadow-card md:p-4', className)}>
      {/* Thin tone rail: a quiet cue that the figure is owed (amber), positive (jade) or neutral. */}
      <span aria-hidden="true" className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', TONE_RAIL[tone])} />
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="truncate">{label}</span>
      </p>
      <p className={cn('figure mt-1 truncate text-lg font-semibold tracking-tight md:text-[1.375rem]', TONE_TEXT[tone])}>{formatInr(amount)}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
