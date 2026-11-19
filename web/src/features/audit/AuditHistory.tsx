import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@/components/states';
import { formatDateTime } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { AuditAction, AuditHistoryEntry } from '@/types/api';

const ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Edited',
  void: 'Voided',
  restore: 'Restored',
  archive: 'Archived',
  reactivate: 'Reactivated',
  link_category: 'Usual category added',
  unlink_category: 'Usual category removed',
  link_brand: 'Brand added',
  unlink_brand: 'Brand removed',
  import: 'Created from existing expenses',
  document_add: 'Document attached',
  document_remove: 'Document removed',
  reverse: 'Reversed',
  allocate: 'Payment allocated',
  release_allocation: 'Allocation released',
};

/** Events about one linked item: shown as "<label>: <item>" without a field diff. */
function itemText(entry: AuditHistoryEntry): string | null {
  const a = entry.after;
  switch (entry.action) {
    case 'link_category':
    case 'unlink_category':
      return String(a.categoryName ?? '');
    case 'link_brand':
    case 'unlink_brand':
      return String(a.brandName ?? '');
    case 'document_add':
    case 'document_remove':
      return String(a.fileName ?? '');
    case 'allocate':
    case 'release_allocation':
      return `${formatInr(String(a.amount ?? '0'))} · ${String(a.expenseDescription ?? '')}`;
    default:
      return null;
  }
}

/** Timeline dot: red for cancelling events, jade for records coming into effect, grey otherwise. */
function dotClass(action: AuditAction): string {
  if (action === 'void' || action === 'reverse' || action === 'release_allocation') return 'bg-destructive';
  if (action === 'create' || action === 'import' || action === 'restore' || action === 'reactivate' || action === 'allocate') return 'bg-primary';
  return 'bg-muted-foreground/50';
}

/** Newest-first change history (financial audit log), with field-by-field before → after. */
export function AuditHistory({
  history,
  fieldLabels,
  display,
  hideChange,
}: {
  history: UseQueryResult<AuditHistoryEntry[]>;
  fieldLabels: Record<string, string>;
  display: (field: string, value: unknown) => string;
  /** Hides a change line that another line of the same entry already describes (display only). */
  hideChange?: (change: AuditHistoryEntry['changes'][number], entry: AuditHistoryEntry) => boolean;
}) {
  if (history.isPending) return <LoadingState label="Loading history…" />;
  if (history.isError) return <ErrorState error={history.error} onRetry={() => void history.refetch()} />;
  if (history.data.length === 0) return <p className="text-sm text-muted-foreground">No changes recorded.</p>;
  return (
    <ol className="relative space-y-5 ml-1 border-l border-border pl-5">
      {history.data.map((entry) => {
        const changes = itemText(entry) === null ? entry.changes.filter((c) => c.field in fieldLabels && !hideChange?.(c, entry)) : [];
        return (
          <li key={entry.id} className="relative text-sm">
            <span
              className={cn('absolute -left-[1.6rem] top-1 size-2.5 rounded-full ring-4 ring-card', dotClass(entry.action))}
              aria-hidden="true"
            />
            <p className="break-words leading-snug">
              <strong className="font-semibold">{ACTION_LABELS[entry.action]}</strong>
              {itemText(entry) !== null && <>: {itemText(entry)}</>}{' '}
              <span className="text-muted-foreground">by {entry.actor?.name ?? 'System (data migration)'}</span>
            </p>
            <p className="figure mt-0.5 text-xs text-muted-foreground">{formatDateTime(entry.occurredAt)}</p>
            {entry.reason && <p className="mt-1.5 break-words text-muted-foreground">Reason: {entry.reason}</p>}
            {changes.length > 0 && (
              <ul className="mt-2 space-y-1 rounded-lg border bg-surface-muted px-3 py-2 text-[0.8125rem]">
                {changes.map((c) => (
                  <li key={c.field} className="break-words">
                    <span className="text-muted-foreground">{fieldLabels[c.field]}:</span>{' '}
                    <span className="text-muted-foreground line-through">{display(c.field, c.before)}</span>
                    {' → '}
                    <span className="font-medium">{display(c.field, c.after)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
