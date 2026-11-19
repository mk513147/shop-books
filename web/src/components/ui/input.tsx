import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

/** Shared look of every text-like control (input, select, textarea). 16px text on phones prevents iOS zoom. */
export const controlClass =
  'w-full rounded-lg border border-input bg-card px-3 text-base text-foreground shadow-card transition-[border-color,box-shadow,background-color] duration-150 ease-out placeholder:text-muted-foreground/80 hover:border-[oklch(0.8_0.01_245)] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20 md:text-sm';

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(controlClass, 'flex h-11 md:h-10', className)} {...props} />;
}
