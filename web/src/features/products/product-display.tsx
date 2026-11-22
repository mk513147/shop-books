import { Eye, EyeOff } from 'lucide-react';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { SellingUnit } from '@/types/api';

export const UNIT_LABELS: Record<SellingUnit, string> = { piece: 'Piece', pack: 'Pack', box: 'Box', set: 'Set', ream: 'Ream' };

/** "A4 · 140 pages · 70 GSM · spiral" (only the specifications that exist). */
export function specSummary(p: { size: string | null; pageCount: number | null; gsm: number | null; binding: string | null }): string {
  return [p.size, p.pageCount ? `${p.pageCount} pages` : null, p.gsm ? `${p.gsm} GSM` : null, p.binding].filter(Boolean).join(' · ');
}

/** "Pack of 12" / "" for single pieces. */
export function unitSummary(p: { sellingUnit: SellingUnit; packQty: number }): string {
  if (p.sellingUnit === 'piece') return '';
  return p.packQty > 1 ? `${UNIT_LABELS[p.sellingUnit]} of ${p.packQty}` : UNIT_LABELS[p.sellingUnit];
}

export function productTitle(p: { name: string; brand: { name: string } | string | null }): string {
  const brand = typeof p.brand === 'string' ? p.brand : p.brand?.name;
  return brand ? `${brand} ${p.name}` : p.name;
}

/**
 * A purchase price cell. Hidden: a masked pill with an eye-off icon (and "hidden" for screen
 * readers). Revealed: the amount on an info-tinted chip, clearly different from selling prices.
 */
export function PurchasePriceValue({
  revealed,
  value,
  loading = false,
  className,
}: {
  revealed: boolean;
  value: string | null | undefined;
  loading?: boolean;
  className?: string;
}) {
  if (!revealed) {
    return (
      <span className={cn('inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground', className)} data-testid="cost-hidden">
        <EyeOff className="size-3" aria-hidden="true" />
        <span aria-hidden="true">•••••</span>
        <span className="sr-only">Purchase price hidden</span>
      </span>
    );
  }
  if (loading) return <span className={cn('text-xs text-muted-foreground', className)}>Loading…</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 text-xs font-medium text-info figure', className)} data-testid="cost-visible">
      <Eye className="size-3" aria-hidden="true" />
      {value ? formatInr(value) : <span className="font-normal">Not set</span>}
    </span>
  );
}
