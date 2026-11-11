import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DB_NAME, openAttachmentStore } from './store';

const HIDDEN_KEY = 'shop-books-paused-device-files-hidden';

function readHidden(): boolean {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Counts bill files that an earlier version of the app kept in THIS browser (the offline upload
 * queue and unsaved form drafts) before bill attachments were postponed. Read-only: nothing is sent,
 * changed or deleted. Does not create the browser database on devices that never used attachments.
 */
async function countDeviceFiles(userId: string): Promise<number> {
  const idb = globalThis.indexedDB;
  if (!idb) return 0;
  if (typeof idb.databases === 'function') {
    const existing = await idb.databases();
    if (!existing.some((d) => d.name === DB_NAME)) return 0;
  }
  const opened = await openAttachmentStore();
  const [queued, drafts] = await Promise.all([opened.store.list(userId), opened.drafts ? opened.drafts.list(userId) : Promise.resolve([])]);
  return queued.length + drafts.length;
}

/**
 * Shown (while bill attachments are postponed) when this device still holds bill files that were
 * never uploaded, so they are not silently forgotten. They stay in the browser untouched.
 */
export function PausedDeviceFilesNotice({ userId }: { userId: string }) {
  const [count, setCount] = useState(0);
  const [hidden, setHidden] = useState(readHidden);

  useEffect(() => {
    let cancelled = false;
    countDeviceFiles(userId).then(
      (n) => !cancelled && setCount(n),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (count === 0 || hidden) return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm" data-testid="paused-device-files">
      <span className="min-w-0 flex-1">
        {count} bill file{count === 1 ? '' : 's'} chosen on this device before bill attachments were paused {count === 1 ? 'is' : 'are'} still
        kept in this browser. {count === 1 ? 'It is' : 'They are'} not uploaded and not backed up; do not clear this browser&apos;s site data if
        you still need {count === 1 ? 'it' : 'them'}.
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          try {
            sessionStorage.setItem(HIDDEN_KEY, '1');
          } catch {
            // Hiding for this page view only.
          }
          setHidden(true);
        }}
      >
        Hide
      </Button>
    </div>
  );
}
