import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@/components/states';
import { formatDateTime } from '@/lib/dates';
import { formatInr } from '@/lib/money';
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
    <ol className="relative space-y-5 border-l border-border pl-5">
      {history.data.map((entry) => (
        <li key={entry.id} className="relative text-sm">
          <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full border-2 border-card bg-primary" aria-hidden="true" />
          <p>
            <strong className="font-medium">{ACTION_LABELS[entry.action]}</strong>
            {itemText(entry) !== null && <>: {itemText(entry)}</>}{' '}
            <span className="text-muted-foreground">by {entry.actor?.name ?? 'System (data migration)'}</span>
          </p>
          <p className="text-xs text-muted-foreground">{formatDateTime(entry.occurredAt)}</p>
          {entry.reason && <p className="mt-1 text-muted-foreground">Reason: {entry.reason}</p>}
          {itemText(entry) === null && entry.changes.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {entry.changes
                .filter((c) => c.field in fieldLabels && !hideChange?.(c, entry))
                .map((c) => (
                  <li key={c.field} className="break-words">
                    <span className="text-muted-foreground">{fieldLabels[c.field]}:</span>{' '}
                    <span className="text-muted-foreground line-through">{display(c.field, c.before)}</span> → {display(c.field, c.after)}
                  </li>
                ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
