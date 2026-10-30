import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@/components/states';
import { formatDateTime } from '@/lib/dates';
import type { AuditAction, AuditHistoryEntry } from '@/types/api';

const ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Edited',
  void: 'Voided',
  restore: 'Restored',
  archive: 'Archived',
  reactivate: 'Reactivated',
  link_category: 'Category suggestion added',
  unlink_category: 'Category suggestion removed',
  import: 'Created from existing expenses',
};

/** Newest-first change history (financial audit log), with field-by-field before → after. */
export function AuditHistory({
  history,
  fieldLabels,
  display,
}: {
  history: UseQueryResult<AuditHistoryEntry[]>;
  fieldLabels: Record<string, string>;
  display: (field: string, value: unknown) => string;
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
            {(entry.action === 'link_category' || entry.action === 'unlink_category') && (
              <>: {String(entry.after.categoryName ?? '')}</>
            )}{' '}
            <span className="text-muted-foreground">by {entry.actor?.name ?? 'System (data migration)'}</span>
          </p>
          <p className="text-xs text-muted-foreground">{formatDateTime(entry.occurredAt)}</p>
          {entry.reason && <p className="mt-1 text-muted-foreground">Reason: {entry.reason}</p>}
          {entry.action !== 'link_category' && entry.action !== 'unlink_category' && entry.changes.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {entry.changes
                .filter((c) => c.field in fieldLabels)
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
