import type { UseFormRegisterReturn } from 'react-hook-form';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES } from '@/features/expenses/expenses-api';
import { FieldError } from '@/components/ui/field';
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
              'flex h-11 cursor-pointer select-none items-center justify-center rounded-lg border px-2 text-center text-sm transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.97] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring md:h-10',
              value === m ? 'border-primary bg-primary-soft font-semibold text-primary-soft-foreground shadow-[inset_0_0_0_1px_var(--primary)]' : 'border-input bg-card font-medium hover:bg-surface-muted',
            )}
          >
            <input type="radio" value={m} className="sr-only" {...registration} />
            {PAYMENT_MODE_LABELS[m]}
          </label>
        ))}
      </div>
      {error && (
        <FieldError id={`${idPrefix}-error`} className="mt-1.5">
          {error}
        </FieldError>
      )}
    </fieldset>
  );
}
