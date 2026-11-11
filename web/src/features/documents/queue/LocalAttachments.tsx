import { AlertTriangle, FileText, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { formatBytes } from '../limits';
import type { AttachmentQueue } from './engine';
import { ATTACHMENT_STATUS_LABELS, type AttachmentStatus, type QueuedAttachment } from './types';

const TONES: Record<AttachmentStatus, 'neutral' | 'accent' | 'warning' | 'danger'> = {
  pending: 'neutral',
  uploading: 'accent',
  waiting_pc: 'warning',
  stored: 'accent',
  failed: 'danger',
};

/** Preview from the local Blob (object URL, revoked on unmount). */
function LocalThumb({ item }: { item: QueuedAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = item.mimeType.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(item.fileName);
  useEffect(() => {
    if (!isImage || typeof URL.createObjectURL !== 'function') return;
    const u = URL.createObjectURL(item.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [item.blob, isImage]);
  if (url) return <img src={url} alt={`Preview of ${item.fileName}`} className="size-14 shrink-0 rounded-md border object-cover" />;
  return (
    <span className="inline-flex size-14 shrink-0 flex-col items-center justify-center rounded-md border bg-surface-muted text-muted-foreground">
      <FileText className="size-5" aria-hidden="true" />
      <span className="text-[10px] font-semibold">{isImage ? 'IMG' : 'PDF'}</span>
    </span>
  );
}

/**
 * Files chosen on THIS device for one expense that are not yet confirmed on the shop PC. Only the
 * person who chose them sees them (they live in this browser); other managers see a file once the
 * PC has stored it.
 */
export function LocalAttachmentList({ queue, items }: { queue: AttachmentQueue; items: QueuedAttachment[] }) {
  const [discarding, setDiscarding] = useState<QueuedAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <ul className="space-y-2" aria-label="Files on this device, not yet on the shop PC">
        {items.map((item) => {
          const progress = queue.progress.get(item.id);
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-2" data-testid="local-attachment">
              <LocalThumb item={item} />
              <div className="min-w-0 flex-1 basis-40">
                <p className="truncate text-sm font-medium">{item.fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {item.mimeType === 'application/pdf' ? 'PDF' : 'Photo'} · {formatBytes(item.sizeBytes)} · on this device only
                </p>
                <p className="mt-0.5 text-xs">
                  <Badge tone={TONES[item.status]}>{ATTACHMENT_STATUS_LABELS[item.status]}</Badge>
                  {item.lastError && item.status !== 'uploading' && <span className="ml-1 break-words text-muted-foreground">{item.lastError}</span>}
                </p>
                {item.status === 'uploading' && progress !== undefined && (
                  <div
                    role="progressbar"
                    aria-label={`Uploading ${item.fileName}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"
                  >
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                )}
              </div>
              <div className="flex gap-1">
                {item.status !== 'uploading' && (
                  <Button variant="ghost" size="icon" aria-label={`Retry ${item.fileName} now`} onClick={() => void queue.retry(item.id)}>
                    <RotateCw aria-hidden="true" />
                  </Button>
                )}
                {item.status !== 'uploading' && (
                  <Button variant="ghost" size="icon" aria-label={`Remove ${item.fileName} from this device`} onClick={() => setDiscarding(item)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        These files are kept in this browser until the shop PC confirms it has stored them. They are not backed up: keep this device and do
        not clear the browser&apos;s site data until they show as stored.
      </p>

      <Dialog
        open={discarding !== null}
        title="Remove this file from this device?"
        size="sm"
        onClose={() => {
          setDiscarding(null);
          setError(null);
        }}
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setDiscarding(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = discarding;
                if (!target) return;
                queue
                  .discard(target.id)
                  .then(() => setDiscarding(null))
                  .catch((err: unknown) => setError(errorMessage(err)));
              }}
            >
              Remove from device
            </Button>
          </DialogActions>
        }
      >
        <p className="flex gap-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            <strong>{discarding?.fileName}</strong> has not been stored on the shop PC yet. This is the only copy: removing it here deletes it
            for good.
          </span>
        </p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </Dialog>
    </div>
  );
}

/** Warning when this browser cannot keep files offline (memory fallback) or ran out of space. */
export function OfflineStorageWarning({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <p role="alert" className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
      {problem} Files you attach are kept only while this page stays open and are uploaded when the shop PC is online. Do not close the page
      until they show as stored.
    </p>
  );
}

/**
 * App-wide reminder while files chosen on this device are not yet stored on the shop PC (they are
 * only in this browser until then).
 */
export function AttachmentSyncBanner({ items, onRetry }: { items: readonly QueuedAttachment[]; onRetry: () => void }) {
  if (items.length === 0) return null;
  const failed = items.filter((i) => i.status === 'failed').length;
  const waiting = items.filter((i) => i.status === 'waiting_pc').length;
  const n = items.length;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm" data-testid="attachment-sync-banner">
      <span className="min-w-0 flex-1">
        {n} bill file{n === 1 ? ' is' : 's are'} on this device only
        {waiting > 0 && ` · ${waiting} waiting for the shop PC`}
        {failed > 0 && ` · ${failed} failed`}. Keep this device until {n === 1 ? 'it shows' : 'they show'} as stored.
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RotateCw aria-hidden="true" /> Sync now
      </Button>
    </div>
  );
}
