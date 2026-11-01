import { Badge } from '@/components/ui/badge';

const LABELS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'danger' | 'warning' }> = {
  active: { label: 'Active', tone: 'accent' },
  voided: { label: 'Voided', tone: 'danger' },
  reversed: { label: 'Reversed', tone: 'danger' },
  released: { label: 'Released', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
};

/** Consistent status chip for financial records. Cancelled states read as "not counted". */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = LABELS[status] ?? { label: status, tone: 'neutral' as const };
  return (
    <Badge tone={s.tone} className={className}>
      {s.label}
    </Badge>
  );
}
