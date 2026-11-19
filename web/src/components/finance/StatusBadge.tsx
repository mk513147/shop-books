import { Badge } from '@/components/ui/badge';
import { toPaise } from '@/lib/money';

type Tone = 'neutral' | 'accent' | 'danger' | 'warning' | 'info';

const LABELS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'accent' },
  voided: { label: 'Voided', tone: 'danger' },
  reversed: { label: 'Reversed', tone: 'danger' },
  released: { label: 'Released', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'accent' },
  partial: { label: 'Part paid', tone: 'warning' },
  unpaid: { label: 'Unpaid', tone: 'warning' },
  outstanding: { label: 'Outstanding', tone: 'warning' },
  settled: { label: 'Settled', tone: 'accent' },
};

/** Consistent status chip for financial records. Cancelled states read as "not counted". */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = LABELS[status] ?? { label: status, tone: 'neutral' as const };
  return (
    <Badge tone={s.tone} dot className={className}>
      {s.label}
    </Badge>
  );
}

/**
 * Paid / Part paid / Unpaid for a bill, read from the server's own figures (the total and what is
 * still outstanding). Display only: nothing is calculated or stored from it.
 */
export function paymentStatusOf(amount: string, outstanding: string): 'paid' | 'partial' | 'unpaid' {
  if (outstanding.trim().startsWith('-')) return 'paid';
  const due = toPaise(outstanding);
  if (due <= 0n) return 'paid';
  return due >= toPaise(amount) ? 'unpaid' : 'partial';
}

export function PaymentStatusBadge({ amount, outstanding, voided, className }: { amount: string; outstanding: string; voided?: boolean; className?: string }) {
  return <StatusBadge status={voided ? 'voided' : paymentStatusOf(amount, outstanding)} className={className} />;
}
