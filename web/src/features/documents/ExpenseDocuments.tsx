import { Download, ExternalLink, FileText, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ReasonDialog } from '@/components/ui/reason-dialog';
import { useAuth } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/dates';
import { cn } from '@/lib/utils';
import type { ExpenseDocument } from '@/types/api';
import { documentContentUrl, useExpenseDocuments, useRemoveDocument } from './documents-api';
import { DocumentPicker, usePendingFiles } from './DocumentPicker';
import { formatBytes, MAX_DOCUMENTS_PER_EXPENSE } from './limits';

function DocumentThumb({ doc }: { doc: ExpenseDocument }) {
  if (doc.mimeType === 'application/pdf') {
    return (
      <span className="inline-flex size-14 shrink-0 flex-col items-center justify-center rounded-md border bg-surface-muted text-muted-foreground">
        <FileText className="size-5" aria-hidden="true" />
        <span className="text-[10px] font-semibold">PDF</span>
      </span>
    );
  }
  return (
    <img
      src={documentContentUrl(doc)}
      alt={`Preview of ${doc.fileName}`}
      loading="lazy"
      decoding="async"
      className="size-14 shrink-0 rounded-md border bg-surface-muted object-cover"
    />
  );
}

/** Attached bill documents on the expense details page: view, download, remove, add more. */
export function ExpenseDocuments({ expenseId, voided }: { expenseId: string; voided: boolean }) {
  const { user } = useAuth();
  const [showRemoved, setShowRemoved] = useState(false);
  const docs = useExpenseDocuments(expenseId, true);
  const remove = useRemoveDocument();
  const [removing, setRemoving] = useState<ExpenseDocument | null>(null);
  const pending = usePendingFiles();
  const queryClient = useQueryClient();
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  if (docs.isPending) return <LoadingState label="Loading documents…" />;
  if (docs.isError) return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;

  const active = docs.data.filter((d) => d.status === 'active');
  const removed = docs.data.filter((d) => d.status === 'removed');
  const remaining = MAX_DOCUMENTS_PER_EXPENSE - active.length;
  const shown = showRemoved ? docs.data : active;

  async function uploadSelected() {
    setUploadNotice(null);
    const failed = await pending.uploadAll(expenseId);
    await queryClient.invalidateQueries({ queryKey: ['expenses'] });
    if (failed === 0) {
      pending.clear();
      setUploadNotice('Documents uploaded.');
    }
  }

  return (
    <div className="space-y-4">
      {shown.length === 0 && <p className="text-sm text-muted-foreground">No bill photos or documents attached.</p>}
      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((doc) => {
            const isRemoved = doc.status === 'removed';
            const canOpen = !isRemoved || user?.role === 'owner';
            return (
              <li key={doc.id} className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-2', isRemoved && 'bg-surface-muted')}>
                {canOpen ? <DocumentThumb doc={doc} /> : <FileText className="size-6 text-muted-foreground" aria-hidden="true" />}
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm font-medium">{doc.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {doc.mimeType === 'application/pdf' ? 'PDF' : 'Photo'} · {formatBytes(doc.sizeBytes)} · {doc.uploadedBy.name},{' '}
                    {formatDateTime(doc.createdAt)}
                  </p>
                  {isRemoved && (
                    <p className="mt-0.5 text-xs break-words text-muted-foreground">
                      <Badge tone="danger" className="mr-1">
                        Removed
                      </Badge>
                      by {doc.removedBy?.name} · Reason: {doc.removeReason}
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  {canOpen && (
                    <>
                      <a
                        href={documentContentUrl(doc)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                        aria-label={`View ${doc.fileName}`}
                      >
                        <ExternalLink aria-hidden="true" />
                      </a>
                      <a
                        href={documentContentUrl(doc, true)}
                        download={doc.fileName}
                        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                        aria-label={`Download ${doc.fileName}`}
                      >
                        <Download aria-hidden="true" />
                      </a>
                    </>
                  )}
                  {!isRemoved && !voided && (
                    <Button variant="ghost" size="icon" aria-label={`Remove ${doc.fileName}`} onClick={() => setRemoving(doc)}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {removed.length > 0 && (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowRemoved((v) => !v)}>
          {showRemoved ? 'Hide removed documents' : `Show removed documents (${removed.length})`}
        </button>
      )}

      {voided ? (
        <p className="text-xs text-muted-foreground">Restore the expense to add or remove documents.</p>
      ) : (
        <div className="space-y-3 border-t pt-4">
          <DocumentPicker pending={pending} maxCount={remaining} />
          {pending.pendingCount > 0 && (
            <Button size="sm" disabled={pending.uploading} onClick={() => void uploadSelected()}>
              <Upload aria-hidden="true" />
              {pending.uploading ? 'Uploading…' : `Upload ${pending.pendingCount} file${pending.pendingCount === 1 ? '' : 's'}`}
            </Button>
          )}
          {uploadNotice && (
            <p role="status" className="text-sm text-primary">
              {uploadNotice}
            </p>
          )}
        </div>
      )}

      <ReasonDialog
        open={removing !== null}
        title="Remove this document?"
        description="It disappears from the expense but is kept for the record (the owner can still open it). The removal and your reason are recorded in the history."
        confirmLabel="Remove document"
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onCancel={() => {
          setRemoving(null);
          remove.reset();
        }}
        onConfirm={(reason) => removing && remove.mutate({ doc: removing, reason }, { onSuccess: () => setRemoving(null) })}
      />
    </div>
  );
}
