import type { InputHTMLAttributes, Ref } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * INR amount entry: a decimal STRING (never parsed to a float), numeric keypad on phones,
 * ₹ prefix, tabular figures. Validate with `moneyField()` from lib/money.
 */
export function MoneyInput({
  className,
  ref,
  large = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement>; large?: boolean }) {
  return (
    <div className="relative">
      <span
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          large ? 'left-4 text-xl font-medium' : 'left-3',
        )}
        aria-hidden="true"
      >
        ₹
      </span>
      <Input
        ref={ref}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        className={cn('figure', large ? 'h-14 pl-9 text-2xl font-semibold md:h-14 md:text-2xl' : 'pl-7', className)}
        {...props}
      />
    </div>
  );
}
