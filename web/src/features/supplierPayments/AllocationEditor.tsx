import { MoneyInput } from '@/components/finance/MoneyInput';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/dates';
import { formatInr, fromPaise, MONEY_INPUT, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { AllocationInput, OpenBill } from '@/types/api';

export type AllocationDraft = Record<string, string>;

/** Valid, non-zero entries in bill order (what is sent to the server). */
export function draftToAllocations(bills: OpenBill[], draft: AllocationDraft): AllocationInput[] {
  return bills
    .map((b) => ({ expenseId: b.id, amount: (draft[b.id] ?? '').trim() }))
    .filter((a) => MONEY_INPUT.test(a.amount) && toPaise(a.amount) > 0n);
}

/** Client-side problems (the server re-checks everything under locks). */
export function draftProblems(bills: OpenBill[], draft: AllocationDraft, available: string | null): Record<string, string> {
  const problems: Record<string, string> = {};
  let total = 0n;
  for (const bill of bills) {
    const text = (draft[bill.id] ?? '').trim();
    if (!text) continue;
    if (!MONEY_INPUT.test(text)) problems[bill.id] = 'Use digits only, e.g. 1250 or 1250.50';
    else if (toPaise(text) > toPaise(bill.payable)) problems[bill.id] = `At most ${formatInr(bill.payable)} is payable`;
    else total += toPaise(text);
  }
  if (available !== null && total > toPaise(available)) problems._total = `Allocations exceed the ${formatInr(available)} available`;
  return problems;
}

/**
 * Choose how much of a payment settles which bills. Nothing is allocated automatically: amounts are
 * typed per bill, or filled by the explicit "Fill oldest first" / "Full" buttons.
 */
export function AllocationEditor({
  bills,
  available,
  draft,
  onChange,
  serverErrors = {},
  disabled = false,
}: {
  bills: OpenBill[];
  /** Amount that may be allocated (payment amount or its unallocated part); null while unknown. */
  available: string | null;
  draft: AllocationDraft;
  onChange: (next: AllocationDraft) => void;
  serverErrors?: Record<string, string>;
  disabled?: boolean;
}) {
  const problems = draftProblems(bills, draft, available);
  const total = draftToAllocations(bills, draft).reduce((s, a) => s + toPaise(a.amount), 0n);
  const left = available !== null ? toPaise(available) - total : null;

  function fillOldestFirst() {
    if (available === null) return;
    let remaining = toPaise(available);
    const next: AllocationDraft = {};
    for (const bill of bills) {
      if (remaining <= 0n) break;
      const take = toPaise(bill.payable) < remaining ? toPaise(bill.payable) : remaining;
      next[bill.id] = fromPaise(take);
      remaining -= take;
    }
    onChange(next);
  }

  function fillOne(bill: OpenBill) {
    const others = total - (MONEY_INPUT.test(draft[bill.id] ?? '') ? toPaise(draft[bill.id]!) : 0n);
    const room = available !== null ? toPaise(available) - others : toPaise(bill.payable);
    const take = room < toPaise(bill.payable) ? room : toPaise(bill.payable);
    onChange({ ...draft, [bill.id]: take > 0n ? fromPaise(take) : '' });
  }

  if (bills.length === 0) {
    return <p className="text-sm text-muted-foreground">This supplier has no unpaid bills. The payment will stay unallocated until bills are added.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="soft" disabled={disabled || available === null} onClick={fillOldestFirst}>
          Fill oldest bills first
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || total === 0n} onClick={() => onChange({})}>
          Clear
        </Button>
      </div>
      <ul className="space-y-2">
        {bills.map((bill) => {
          const error = serverErrors[bill.id] ?? problems[bill.id];
          const inputId = `alloc-${bill.id}`;
          return (
            <li key={bill.id} className={cn('rounded-lg border p-3', error && 'border-destructive/40')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <label htmlFor={inputId} className="block truncate text-sm font-medium">
                    {bill.description}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(bill.expenseDate)}
                    {bill.invoiceReference && ` · ${bill.invoiceReference}`} · bill {formatInr(bill.amount)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted-foreground">Payable</p>
                  <p className="figure text-sm font-semibold text-warning">{formatInr(bill.payable)}</p>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1">
                  <MoneyInput
                    id={inputId}
                    value={draft[bill.id] ?? ''}
                    disabled={disabled}
                    placeholder="Not paid from this payment"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${inputId}-error` : undefined}
                    onChange={(e) => onChange({ ...draft, [bill.id]: e.target.value })}
                  />
                </div>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => fillOne(bill)}>
                  Full
                </Button>
              </div>
              {error && (
                <p id={`${inputId}-error`} className="mt-1 text-sm text-destructive">
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="space-y-1 rounded-lg bg-surface-muted px-3 py-2.5 text-sm" aria-live="polite">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Allocating to bills</span>
          <strong className="figure">{formatInr(fromPaise(total))}</strong>
        </div>
        {left !== null && (
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Stays unallocated</span>
            <strong className={cn('figure', left < 0n && 'text-destructive')}>{formatInr(fromPaise(left))}</strong>
          </div>
        )}
        {problems._total && <p className="text-destructive">{problems._total}</p>}
      </div>
    </div>
  );
}
