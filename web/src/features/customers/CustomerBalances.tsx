import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * The two independent customer balances, side by side and never combined into a net figure
 * (business rule: a due is not paid from an advance unless someone records that explicitly).
 */
export function CustomerBalances({ due, advance, compact = false }: { due: string; advance: string; compact?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-xl border border-warning/30 bg-warning-soft p-3 md:p-4">
          <p className="text-xs font-medium">Customer due</p>
          <p className={cn('figure truncate font-semibold', compact ? 'text-lg' : 'text-2xl', due !== '0.00' ? 'text-warning' : 'text-muted-foreground')}>
            {formatInr(due)}
          </p>
          {!compact && <p className="text-xs text-muted-foreground">Amount the customer owes the shop</p>}
        </div>
        <div className="min-w-0 rounded-xl border border-primary/25 bg-primary-soft p-3 md:p-4">
          <p className="text-xs font-medium">Customer advance</p>
          <p className={cn('figure truncate font-semibold', compact ? 'text-lg' : 'text-2xl', advance !== '0.00' ? 'text-primary' : 'text-muted-foreground')}>
            {formatInr(advance)}
          </p>
          {!compact && <p className="text-xs text-muted-foreground">Held for the customer; can be refunded</p>}
        </div>
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          These are separate balances. An advance is never used to pay a due automatically.
        </p>
      )}
    </div>
  );
}
