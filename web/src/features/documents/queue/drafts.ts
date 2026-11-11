import { useCallback, useEffect, useRef, useState } from 'react';
import { newUuid } from '@/lib/ids';
import type { PendingFile } from '../DocumentPicker';
import { useAttachmentQueueContext } from './AttachmentQueueProvider';
import { AttachmentStorageFullError, type QueuedAttachment } from './types';

/**
 * Draft copies of the bill files picked in an expense form that has not been saved yet.
 *
 * The expense does not exist until it is saved, so these files cannot be queued for upload. They
 * are kept in a SEPARATE IndexedDB store (`drafts`, never synced) so that a refresh, a crash or a
 * closed tab does not lose them: reopening the same form offers to add them again. A draft is
 * deleted only when its file is saved with the expense (it is then in the upload queue), removed
 * from the form, or discarded by the user after a confirmation. Like the queue, drafts are per user
 * and per browser, and are not a backup.
 *
 * `scope` names the form: "new" for a new expense, the expense id when editing one.
 */
export function useAttachmentDrafts(scope: string) {
  const ctx = useAttachmentQueueContext();
  const drafts = ctx?.drafts ?? null;
  const userId = ctx?.userId ?? null;
  /** Drafts left by an earlier visit of this form (offered for recovery). */
  const [recoverable, setRecoverable] = useState<QueuedAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /** Pending-file key -> draft id, for the files of this visit. */
  const byKey = useRef(new Map<string, string>());
  /** Restored files -> their existing draft id (so they are not saved twice). */
  const adopted = useRef(new Map<File, string>());

  useEffect(() => {
    if (!drafts || !userId) return;
    let cancelled = false;
    drafts
      .list(userId)
      .then((list) => !cancelled && setRecoverable(list.filter((d) => d.expenseId === `draft:${scope}`)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [drafts, userId, scope]);

  /** Keeps a draft copy of newly picked files (best effort; a full browser storage is reported). */
  const keep = useCallback(
    (files: PendingFile[]) => {
      if (!drafts || !userId) return;
      for (const f of files) {
        const existing = adopted.current.get(f.file);
        if (existing) {
          byKey.current.set(f.key, existing);
          continue;
        }
        const id = newUuid();
        byKey.current.set(f.key, id);
        const draft: QueuedAttachment = {
          id,
          expenseId: `draft:${scope}`,
          userId,
          fileName: f.file.name,
          mimeType: f.file.type,
          sizeBytes: f.file.size,
          sha256: '',
          createdAt: new Date().toISOString(),
          status: 'pending',
          retryCount: 0,
          lastError: null,
          nextAttemptAt: null,
          serverDocumentId: null,
          blob: f.file,
        };
        drafts.put(draft).catch((err: unknown) => {
          byKey.current.delete(f.key);
          setProblem(
            err instanceof AttachmentStorageFullError
              ? 'This browser is out of storage space: the chosen files are kept only while this page stays open until you save.'
              : 'The chosen files could not be kept on this device: they are kept only while this page stays open until you save.',
          );
        });
      }
    },
    [drafts, userId, scope],
  );

  /** Deletes the draft copies of these pending files (saved with the expense, or removed). */
  const forget = useCallback(
    (keys: string[]) => {
      if (!drafts) return;
      for (const key of keys) {
        const id = byKey.current.get(key);
        if (!id) continue;
        byKey.current.delete(key);
        void drafts.delete(id).catch(() => undefined);
      }
    },
    [drafts],
  );

  /** The files of earlier drafts, to add to the form again (they keep their draft copy). */
  const restore = useCallback((): File[] => {
    const files = recoverable.map((d) => {
      const file = d.blob instanceof File ? d.blob : new File([d.blob], d.fileName, { type: d.mimeType });
      adopted.current.set(file, d.id);
      return file;
    });
    setRecoverable([]);
    return files;
  }, [recoverable]);

  /** Deletes the earlier drafts for good (the caller has asked the user first). */
  const discardRecoverable = useCallback(async () => {
    if (!drafts) return;
    for (const d of recoverable) await drafts.delete(d.id).catch(() => undefined);
    setRecoverable([]);
  }, [drafts, recoverable]);

  return { enabled: drafts !== null, recoverable, problem, keep, forget, restore, discardRecoverable };
}
