import { Download, ExternalLink, FileText, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReasonDialog } from '@/components/ui/reason-dialog';
import { useAuth } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/dates';
import { cn } from '@/lib/utils';
import type { ExpenseDocument } from '@/types/api';
import { billAttachmentsEnabled } from './attachments-feature';
import { documentContentUrl, useExpenseDocuments, useRemoveDocument } from './documents-api';
import { DocumentPicker, FileChooserButtons, usePendingFiles } from './DocumentPicker';
import { formatBytes, MAX_DOCUMENTS_PER_EXPENSE } from './limits';
import { requestPersistentStorage, useAttachmentQueue } from './queue/AttachmentQueueProvider';
import { LocalAttachmentList, OfflineStorageWarning } from './queue/LocalAttachments';

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
      // CORS-mode request with the session cookie: works when the API is on another origin (staging
      // tunnel) while the server keeps Cross-Origin-Resource-Policy: same-origin for no-cors embeds.
      crossOrigin="use-credentials"
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
  const { queue, items: queued, storageProblem } = useAttachmentQueue();
  const [queueProblems, setQueueProblems] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  // Attachments postponed: existing records stay listed (read-only), nothing new can be added.
  const attachmentsOn = billAttachmentsEnabled();

  if (docs.isPending) return <LoadingState label="Loading documents…" />;
  if (docs.isError) return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;

  const active = docs.data.filter((d) => d.status === 'active');
  const removed = docs.data.filter((d) => d.status === 'removed');
  const serverIds = new Set(docs.data.map((d) => d.id));
  // Files chosen on this device that the server does not list yet (once it does, its row is shown).
  const local = queued.filter((i) => i.expenseId === expenseId && !(i.serverDocumentId && serverIds.has(i.serverDocumentId)));
  const remaining = MAX_DOCUMENTS_PER_EXPENSE - active.length - local.length;
  const shown = showRemoved ? docs.data : active;

  /** Saves the chosen files on this device at once; the queue then moves them to the shop PC. */
  async function addToQueue(files: File[]) {
    if (!queue) return;
    setAdding(true);
    setUploadNotice(null);
    try {
      const result = await queue.enqueue(expenseId, files, active.length);
      setQueueProblems(result.problems);
      if (result.added.length > 0) {
        requestPersistentStorage();
        const n = result.added.length;
        setUploadNotice(`${n} file${n === 1 ? '' : 's'} saved on this device; ${n === 1 ? 'it is' : 'they are'} sent to the shop PC automatically.`);
        void queue.syncNow({ force: true }).then(() => queryClient.invalidateQueries({ queryKey: ['expenses'] }));
      }
    } finally {
      setAdding(false);
    }
  }

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
      {!attachmentsOn && (
        <p className="text-sm text-muted-foreground" data-testid="attachments-paused-note">
          Adding bill photos and PDFs is paused. These records are kept as they are; a file can only be opened here if the app itself still holds
          it.
        </p>
      )}
      {shown.length === 0 && local.length === 0 && <p className="text-sm text-muted-foreground">No bill photos or documents attached.</p>}
      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((doc) => {
            const isRemoved = doc.status === 'removed';
            // While attachments are paused, only bytes held by the app itself (the server-side upload
            // queue) can be served; files in the shop PC's storage cannot be reached, so no dead links.
            const reachable = attachmentsOn || doc.pendingDelivery;
            const canOpen = (!isRemoved || user?.role === 'owner') && reachable;
            return (
              <li key={doc.id} className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-2', isRemoved && 'bg-surface-muted')}>
                {canOpen ? <DocumentThumb doc={doc} /> : <FileText className="size-6 text-muted-foreground" aria-hidden="true" />}
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm font-medium">{doc.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {doc.mimeType === 'application/pdf' ? 'PDF' : 'Photo'} · {formatBytes(doc.sizeBytes)} · {doc.uploadedBy.name},{' '}
                    {formatDateTime(doc.createdAt)}
                  </p>
                  {doc.pendingDelivery && attachmentsOn && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <Badge tone="warning" className="mr-1">
                        Waiting for storage
                      </Badge>
                      Saved safely; it moves to the shop's document storage when that is back online.
                    </p>
                  )}
                  {!attachmentsOn && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {doc.pendingDelivery
                        ? 'Kept in the app; it can still be opened.'
                        : 'File kept in the shop’s document storage; it cannot be opened while attachments are paused.'}
                    </p>
                  )}
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
      {queue && <LocalAttachmentList queue={queue} items={local} />}
      {removed.length > 0 && (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowRemoved((v) => !v)}>
          {showRemoved ? 'Hide removed documents' : `Show removed documents (${removed.length})`}
        </button>
      )}

      {!attachmentsOn ? null : voided ? (
        <p className="text-xs text-muted-foreground">Restore the expense to add or remove documents.</p>
      ) : (
        <div className="space-y-3 border-t pt-4">
          {queue ? (
            <>
              <OfflineStorageWarning problem={storageProblem} />
              <p id="add-documents-hint" className="text-xs text-muted-foreground">
                Photos (JPEG, PNG, WebP) or PDF, up to 10 MB each
                {remaining < 10 ? ` (${Math.max(0, remaining)} more allowed)` : ', at most 10 per expense'}. Works offline: files wait on this
                device until the shop PC is online.
              </p>
              <FileChooserButtons onFiles={(files) => void addToQueue(files)} disabled={adding || remaining <= 0} hintId="add-documents-hint" />
              {queueProblems.length > 0 && (
                <ul role="alert" className="space-y-1 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
                  {queueProblems.map((m) => (
                    <li key={m} className="break-words">
                      {m}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <DocumentPicker pending={pending} maxCount={remaining} />
          )}
          {!queue && pending.pendingCount > 0 && (
            <Button size="sm" loading={pending.uploading} onClick={() => void uploadSelected()}>
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

/**
 * Expense details while bill attachments are postponed: the documents card appears only when the
 * expense already has document records (active or removed), so nothing on record is hidden and no
 * empty upload area is shown.
 */
export function ExpenseDocumentsOnRecord({ expenseId, voided }: { expenseId: string; voided: boolean }) {
  const docs = useExpenseDocuments(expenseId, true);
  if (docs.isPending) return null;
  if (!docs.isError && docs.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bill documents on record</CardTitle>
      </CardHeader>
      <CardContent>
        <ExpenseDocuments expenseId={expenseId} voided={voided} />
      </CardContent>
    </Card>
  );
}
