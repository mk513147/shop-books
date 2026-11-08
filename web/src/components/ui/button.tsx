import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Sizes: `default` is a 44px touch target on phones (40px from md up); `sm` is for dense rows and
 * secondary actions; `lg` for the main action of a screen; `icon` is square.
 */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-card hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        soft: 'bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft/70',
        outline: 'border border-input bg-card text-foreground shadow-card hover:bg-accent',
        ghost: 'text-foreground hover:bg-accent',
        destructive: 'bg-destructive text-white shadow-card hover:bg-destructive/90',
        link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 px-4 md:h-10',
        sm: 'h-9 px-3',
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
