import { Badge } from '@/components/ui/badge';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { CustomerTxnType } from '@/types/api';

/**
 * Colour of an entry's amount by what it does (the entry type is always shown in words too):
 * due added = amber (owed), due payment = jade (settling), advance = blue (held), refund = plain.
 */
export const TXN_AMOUNT_TONE: Record<CustomerTxnType, string> = {
  due: 'text-warning',
  due_payment: 'text-primary',
  advance: 'text-info',
  advance_refund: '',
};

/**
 * The two independent customer balances, side by side and never combined into a net figure
 * (business rule: a due is not paid from an advance unless someone records that explicitly).
 * Amber + "Due" = the customer still owes the shop; blue + "Advance" = money held for them;
 * muted/jade + "No dues" = nothing outstanding. The meaning is always in words, not colour alone.
 */
export function CustomerBalances({ due, advance, compact = false }: { due: string; advance: string; compact?: boolean }) {
  const owes = due !== '0.00';
  const holds = advance !== '0.00';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 md:gap-3">
        <div
          className={cn(
            'relative min-w-0 overflow-hidden rounded-xl border p-3.5 shadow-card md:p-4',
            owes ? 'border-warning-strong/35 bg-warning-soft' : 'bg-card',
          )}
        >
          <span aria-hidden="true" className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', owes ? 'bg-warning-strong' : 'bg-surface-strong')} />
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <p className="text-xs font-medium text-muted-foreground">Customer due</p>
            {owes ? (
              <Badge tone="warning" dot>
                Due
              </Badge>
            ) : (
              <Badge tone="accent" dot>
                No dues
              </Badge>
            )}
          </div>
          <p
            className={cn(
              'figure mt-1 truncate font-semibold tracking-tight',
              compact ? 'text-lg' : 'text-2xl md:text-[1.75rem]',
              owes ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {formatInr(due)}
          </p>
          {!compact && <p className="mt-0.5 text-xs text-muted-foreground">Amount the customer owes the shop</p>}
        </div>
        <div
          className={cn(
            'relative min-w-0 overflow-hidden rounded-xl border p-3.5 shadow-card md:p-4',
            holds ? 'border-info/20 bg-info-soft' : 'bg-card',
          )}
        >
          <span aria-hidden="true" className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', holds ? 'bg-info' : 'bg-surface-strong')} />
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <p className="text-xs font-medium text-muted-foreground">Customer advance</p>
            {holds ? (
              <Badge tone="info" dot>
                Advance
              </Badge>
            ) : (
              <Badge tone="neutral">No advance</Badge>
            )}
          </div>
          <p
            className={cn(
              'figure mt-1 truncate font-semibold tracking-tight',
              compact ? 'text-lg' : 'text-2xl md:text-[1.75rem]',
              holds ? 'text-info' : 'text-muted-foreground',
            )}
          >
            {formatInr(advance)}
          </p>
          {!compact && <p className="mt-0.5 text-xs text-muted-foreground">Held for the customer; can be refunded</p>}
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
