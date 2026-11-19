import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Sizes: `default` is a 44px touch target on phones (40px from md up); `sm` is for dense rows and
 * secondary actions; `lg` for the main action of a screen; `icon` is square.
 * Feedback: colour eases on hover (pointer devices), a slight press-in on tap, a spinner while busy.
 */
export const buttonVariants = cva(
  [
    'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold tracking-[-0.005em]',
    'transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out active:scale-[0.97]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50 aria-busy:opacity-90 [&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_oklch(0.3_0.06_170/0.25),inset_0_1px_0_oklch(1_0_0/0.12)] hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-surface-strong',
        soft: 'bg-primary-soft text-primary-soft-foreground hover:bg-[oklch(0.94_0.03_170)]',
        outline: 'border border-input bg-card text-foreground shadow-card hover:border-[oklch(0.8_0.01_245)] hover:bg-surface-muted',
        ghost: 'font-medium text-foreground hover:bg-accent',
        destructive: 'bg-destructive text-white shadow-[0_1px_2px_oklch(0.35_0.12_27/0.25)] hover:bg-[oklch(0.49_0.18_27)]',
        link: 'h-auto px-0 font-medium text-primary underline-offset-4 hover:underline active:scale-100',
      },
      size: {
        default: 'h-11 px-4 md:h-10',
        sm: 'h-9 px-3 text-[0.8125rem]',
        lg: 'h-12 px-6 text-base',
        icon: 'size-11 md:size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * A request started by this button is running: shows a spinner, disables the button (no double
   * submissions) and marks it busy for assistive technology. Pass the in-progress label
   * ("Saving…") as children. Always derive it from the request state, so it clears on failure too.
   */
  loading?: boolean;
}

export function Button({ className, variant, size, type = 'button', loading = false, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden="true" data-testid="button-spinner" />}
      {children}
    </button>
  );
}
