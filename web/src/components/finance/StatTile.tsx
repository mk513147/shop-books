import type { ReactNode } from 'react';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

/** One labelled money figure (balances, totals). Values are server-computed decimal strings. */
export function StatTile({
  label,
  amount,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  amount: string;
  hint?: ReactNode;
  tone?: 'default' | 'warning' | 'accent' | 'muted';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 rounded-xl border bg-card p-3 shadow-card md:p-4', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'figure mt-0.5 truncate text-lg font-semibold md:text-xl',
          tone === 'warning' && 'text-warning',
          tone === 'accent' && 'text-primary',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {formatInr(amount)}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
