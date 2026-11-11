import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { fetchDocumentStorageStatus, fetchExpenseDocument, uploadQueuedAttachment } from '../documents-api';
import { AttachmentQueue, type AttachmentQueueApi } from './engine';
import { openAttachmentStore, type AttachmentStore } from './store';
import type { QueuedAttachment } from './types';

export interface AttachmentQueueContextValue {
  queue: AttachmentQueue;
  /** Files picked in a form that is not saved yet (survive a refresh); null when not durable. */
  drafts: AttachmentStore | null;
  userId: string;
  /** Why files cannot be kept offline in this browser (null when IndexedDB works). */
  storageProblem: string | null;
}

const QueueContext = createContext<AttachmentQueueContextValue | null>(null);

const defaultApi: AttachmentQueueApi = {
  storageStatus: fetchDocumentStorageStatus,
  upload: (item, onProgress) => uploadQueuedAttachment(item, onProgress),
  getDocument: fetchExpenseDocument,
};

/** Only one tab of this browser syncs the shared IndexedDB queue at a time (Web Locks, when supported). */
function crossTabLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request('shop-books-attachment-sync', { ifAvailable: true }, async (lock) => (lock ? fn() : null));
}

/** Asks the browser not to evict our data under storage pressure (best effort; never guaranteed). */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persisted?.().then((already) => (already ? true : navigator.storage.persist?.()));
  } catch {
    // Not supported: nothing to do.
  }
}

/**
 * Owns the offline attachment queue of the signed-in user and keeps it moving. There is NO
 * reliable background sync once the browser is closed: pending files are resumed when the app
 * starts, comes back to the foreground, regains focus or the network, and on a backoff timer while
 * it is open.
 */
export function AttachmentQueueProvider({
  userId,
  children,
  store,
  drafts,
  api = defaultApi,
}: {
  userId: string;
  children: ReactNode;
  /** Tests inject stores; the app opens IndexedDB (falling back to memory, without drafts). */
  store?: AttachmentStore;
  drafts?: AttachmentStore;
  api?: AttachmentQueueApi;
}) {
  const [value, setValue] = useState<AttachmentQueueContextValue | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let queue: AttachmentQueue | null = null;
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('shop-books-attachments') : null;
    const sync = () => void queue?.syncNow();
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };

    void (async () => {
      const opened = store ? { store, drafts: drafts ?? null, problem: null } : await openAttachmentStore();
      if (cancelled) return;
      queue = new AttachmentQueue({
        store: opened.store,
        api,
        userId,
        withLock: crossTabLock,
        onChanged: () => channel?.postMessage('changed'),
        // The file is now a shared document: refresh document lists and counts wherever they show.
        onStored: () => void queryClient.invalidateQueries({ queryKey: ['expenses'] }),
      });
      setValue({ queue, drafts: opened.drafts, userId, storageProblem: opened.problem });
      await queue.load();
      sync(); // app start-up (also after a refresh or browser restart)
    })();

    if (channel) channel.onmessage = () => void queue?.load();
    window.addEventListener('online', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      queue?.dispose();
      channel?.close();
      window.removeEventListener('online', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('pageshow', sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, store, drafts, api, queryClient]);

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

/** The whole context (null outside the provider or while it opens). */
export function useAttachmentQueueContext(): AttachmentQueueContextValue | null {
  return useContext(QueueContext);
}

const EMPTY: readonly QueuedAttachment[] = [];
const noop = () => () => undefined;

/** The queue (null outside the provider or while it opens) and its current items. */
export function useAttachmentQueue(): {
  queue: AttachmentQueue | null;
  items: readonly QueuedAttachment[];
  storageProblem: string | null;
} {
  const ctx = useContext(QueueContext);
  const items = useSyncExternalStore(
    ctx ? (l) => ctx.queue.subscribe(l) : noop,
    ctx ? ctx.queue.getSnapshot : () => EMPTY,
    () => EMPTY,
  );
  return { queue: ctx?.queue ?? null, items, storageProblem: ctx?.storageProblem ?? null };
}
