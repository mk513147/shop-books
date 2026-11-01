import type { UseFormRegisterReturn } from 'react-hook-form';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES } from '@/features/expenses/expenses-api';
import { cn } from '@/lib/utils';

/** Touch-friendly radio chips for the payment mode (same set as expenses). */
export function PaymentModeChips({
  value,
  registration,
  error,
  legend = 'Payment mode',
  idPrefix,
}: {
  value: string;
  registration: UseFormRegisterReturn;
  error?: string;
  legend?: string;
  idPrefix: string;
}) {
  return (
    <fieldset aria-describedby={error ? `${idPrefix}-error` : undefined}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-3 gap-2">
        {PAYMENT_MODES.map((m) => (
          <label
            key={m}
            className={cn(
              'flex h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring md:h-10',
              value === m ? 'border-primary bg-primary-soft font-medium text-primary-soft-foreground' : 'border-input bg-card hover:bg-accent',
            )}
          >
            <input type="radio" value={m} className="sr-only" {...registration} />
            {PAYMENT_MODE_LABELS[m]}
          </label>
        ))}
      </div>
      {error && (
        <p id={`${idPrefix}-error`} className="mt-1.5 text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
