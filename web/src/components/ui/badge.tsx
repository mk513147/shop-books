import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Small status label. Meaning is always in the text; the colour (and optional dot) only reinforces
 * it, so nothing relies on colour alone.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
  {
    variants: {
      tone: {
        neutral: 'bg-secondary text-muted-foreground ring-border',
        accent: 'bg-primary-soft text-primary-soft-foreground ring-primary/15',
        danger: 'bg-destructive-soft text-destructive ring-destructive/15',
        warning: 'bg-warning-soft text-warning ring-warning/20',
        info: 'bg-info-soft text-info ring-info/15',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const DOT = {
  neutral: 'bg-muted-foreground/60',
  accent: 'bg-primary',
  danger: 'bg-destructive',
  warning: 'bg-warning-strong',
  info: 'bg-info',
} as const;

export function Badge({
  className,
  tone,
  dot = false,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', DOT[tone ?? 'neutral'])} />}
      {children}
    </span>
  );
}
