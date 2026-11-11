import { File as NodeFile } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { AttachmentQueue, BACKOFF_BASE_MS, backoffDelay, MAX_AUTO_RETRIES, MIN_CHECK_GAP_MS, type AttachmentQueueApi } from './engine';
import { IndexedDbAttachmentStore, MemoryAttachmentStore, type AttachmentStore } from './store';
import type { QueuedAttachment, ServerDocumentState } from './types';

/**
 * Node's File (not jsdom's): like a browser File it survives structured cloning into IndexedDB
 * (fake-indexeddb), which jsdom's Blob does not.
 */
const pdf = (name = 'bill.pdf', body = '%pdf-1 ' + name) => new NodeFile([body], name, { type: 'application/pdf' }) as unknown as File;
/** Deterministic, lower-case stand-in for the SHA-256 hex (the real one needs Web Crypto): the file's text. */
const checksum = async (blob: Blob) => `sum:${(await blob.text()).toLowerCase()}`;

interface Harness {
  queue: AttachmentQueue;
  store: AttachmentStore;
  api: AttachmentQueueApi & { calls: string[] };
  clock: { now: number };
  timers: { fn: () => void; ms: number }[];
  /** What the fake server holds: document id -> state. */
  server: Map<string, ServerDocumentState>;
}

function harness(
  options: {
    store?: AttachmentStore;
    userId?: string;
    online?: () => boolean;
    pc?: () => boolean;
    upload?: (item: QueuedAttachment) => Promise<{ document: ServerDocumentState }>;
    getDocument?: (expenseId: string, id: string) => Promise<ServerDocumentState>;
    withLock?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  } = {},
): Harness {
  const store = options.store ?? new MemoryAttachmentStore({ durable: true });
  const clock = { now: 1_000_000 };
  const timers: Harness['timers'] = [];
  const server = new Map<string, ServerDocumentState>();
  let n = 0;
  const calls: string[] = [];
  const api: Harness['api'] = {
    calls,
    storageStatus: async () => {
      calls.push('status');
      return { available: options.pc ? options.pc() : true };
    },
    upload: async (item) => {
      calls.push(`upload:${item.id}`);
      if (options.upload) return options.upload(item);
      const doc = { id: item.id, sha256: item.sha256, status: 'active' as const, pendingDelivery: false };
      server.set(item.id, doc);
      return { document: doc };
    },
    getDocument: async (expenseId, id) => {
      calls.push(`get:${id}`);
      if (options.getDocument) return options.getDocument(expenseId, id);
      const doc = server.get(id);
      if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
      return doc;
    },
  };
  const queue = new AttachmentQueue({
    store,
    api,
    userId: options.userId ?? 'user-a',
    now: () => clock.now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as Harness['timers'][number]);
      if (i >= 0) timers.splice(i, 1);
    },
    ...(options.withLock ? { withLock: options.withLock } : {}),
    isOnline: options.online ?? (() => true),
    newId: () => `att-${++n}`,
    checksum,
  });
  return { queue, store, api, clock, timers, server };
}

describe('backoff', () => {
  it('starts at 15 s, doubles, and is capped at 30 min', () => {
    const fixed = () => 0.5; // no jitter
    expect(backoffDelay(1, fixed)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(2, fixed)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffDelay(4, fixed)).toBe(8 * BACKOFF_BASE_MS);
    expect(backoffDelay(30, fixed)).toBe(30 * 60_000);
  });
});

describe('IndexedDB persistence', () => {
  it('keeps the original file, its metadata and status across a "refresh" (a new queue on the same database)', async () => {
    const factory = new IDBFactory();
    const first = harness({ store: new IndexedDbAttachmentStore(factory), pc: () => false });
    const { added } = await first.queue.enqueue('exp-1', [pdf('one.pdf')], 0);
    expect(added).toHaveLength(1);
    await first.queue.syncNow({ force: true }); // PC offline: waits
    first.queue.dispose();

    // Browser refreshed / restarted: a brand new queue object, same IndexedDB.
    const second = harness({ store: new IndexedDbAttachmentStore(factory) });
    await second.queue.load();
    const [item] = second.queue.getSnapshot();
    expect(item).toMatchObject({
      id: 'att-1',
      expenseId: 'exp-1',
      fileName: 'one.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdf('one.pdf').size,
      sha256: 'sum:%pdf-1 one.pdf',
      status: 'waiting_pc',
      retryCount: 1,
      lastError: expect.stringMatching(/offline/),
    });
    expect(typeof item!.createdAt).toBe('string');
    expect(await item!.blob.text()).toBe('%pdf-1 one.pdf');
    // ... and it is resumed and uploaded once the PC is back.
    second.clock.now += 60 * 60_000;
    expect(await second.queue.syncNow()).toMatchObject({ stored: 1 });
    expect(await second.store.list('user-a')).toEqual([]);
  });

  it('upgrading the database (v1 -> v2, adds the drafts store) keeps files already queued', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('shop-books-attachments', 1);
      open.onupgradeneeded = () => {
        const s = open.result.createObjectStore('uploads', { keyPath: 'id' });
        s.createIndex('userId', 'userId');
        s.createIndex('expenseId', 'expenseId');
        s.put({ id: 'old-1', userId: 'user-a', expenseId: 'exp-9', createdAt: '2026-01-01T00:00:00Z', status: 'waiting_pc', blob: pdf('old.pdf') });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const uploads = new IndexedDbAttachmentStore(factory);
    expect((await uploads.list('user-a')).map((i) => i.id)).toEqual(['old-1']);
    const drafts = new IndexedDbAttachmentStore(factory, 'drafts');
    expect(await drafts.list('user-a')).toEqual([]);
  });

  it('other users of the same browser never see someone else’s pending files', async () => {
    const factory = new IDBFactory();
    const a = harness({ store: new IndexedDbAttachmentStore(factory), userId: 'user-a', online: () => false });
    await a.queue.enqueue('exp-1', [pdf()], 0);
    const b = harness({ store: new IndexedDbAttachmentStore(factory), userId: 'user-b' });
    await b.queue.load();
    expect(b.queue.getSnapshot()).toEqual([]);
    expect(await b.queue.syncNow({ force: true })).toMatchObject({ stored: 0 });
    expect(b.api.calls).toEqual([]);
  });
});

describe('attachment queue', () => {
  it('offline: the file is kept locally and nothing is sent', async () => {
    const h = harness({ online: () => false });
    const { added } = await h.queue.enqueue('exp-1', [pdf()], 0);
    expect(added[0]).toMatchObject({ status: 'pending', expenseId: 'exp-1' });
    await h.queue.syncNow({ force: true });
    expect(h.api.calls).toEqual([]);
    expect(await h.store.list('user-a')).toHaveLength(1);
  });

  it('PC unavailable: "Waiting for PC" with growing backoff, no upload; resumes automatically when it is back', async () => {
    let pcUp = false;
    const h = harness({ pc: () => pcUp });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.syncNow({ force: true });
    let [item] = h.queue.getSnapshot();
    expect(item).toMatchObject({ status: 'waiting_pc', retryCount: 1, nextAttemptAt: h.clock.now + BACKOFF_BASE_MS });
    expect(h.api.calls).toEqual(['status']);

    // An automatic trigger before the backoff is over does nothing (no tight loop).
    h.clock.now += 1000;
    await h.queue.syncNow();
    expect(h.api.calls).toEqual(['status']);

    h.clock.now += BACKOFF_BASE_MS;
    await h.queue.syncNow();
    [item] = h.queue.getSnapshot();
    expect(item).toMatchObject({ status: 'waiting_pc', retryCount: 2, nextAttemptAt: h.clock.now + 2 * BACKOFF_BASE_MS });

    // The armed timer fires once the PC is back.
    pcUp = true;
    h.clock.now += 2 * BACKOFF_BASE_MS;
    expect(h.timers.length).toBe(1);
    h.timers[0]!.fn();
    await vi.waitFor(() => expect(h.queue.getSnapshot()).toEqual([]));
    expect(h.api.calls.filter((c) => c.startsWith('upload'))).toEqual(['upload:att-1']);
  });

  it('success: deleted locally only after the upload AND an independent read confirm the same checksum on the PC', async () => {
    const h = harness();
    const stored: string[] = [];
    (h.queue as unknown as { options: { onStored: (i: QueuedAttachment) => void } }).options.onStored = (i) => stored.push(i.id);
    await h.queue.enqueue('exp-1', [pdf()], 0);
    const summary = await h.queue.syncNow({ force: true });
    expect(summary).toMatchObject({ stored: 1, failed: 0 });
    expect(h.api.calls).toEqual(['status', 'upload:att-1', 'get:att-1']);
    expect(await h.store.list('user-a')).toEqual([]);
    expect(stored).toEqual(['att-1']); // the app refreshes the shared document lists
  });

  it('a successful HTTP response alone is not enough: a document still pending delivery is kept locally', async () => {
    const h = harness({
      getDocument: async (_e, id) => ({ id, sha256: 'sum:%pdf-1 bill.pdf', status: 'active', pendingDelivery: true }),
    });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.syncNow({ force: true });
    expect(h.queue.getSnapshot()[0]).toMatchObject({ status: 'waiting_pc', serverDocumentId: 'att-1' });
    // The next attempt only re-checks; it does not upload again.
    h.clock.now += 60 * 60_000;
    await h.queue.syncNow();
    expect(h.api.calls.filter((c) => c.startsWith('upload'))).toHaveLength(1);
  });

  it('checksum mismatch (upload response or re-read): Failed, and the local copy is kept', async () => {
    const h = harness({ upload: async (item) => ({ document: { id: item.id, sha256: 'sum:other', status: 'active', pendingDelivery: false } }) });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.syncNow({ force: true });
    expect(h.queue.getSnapshot()[0]).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/checksum mismatch/) });
    expect(await h.store.list('user-a')).toHaveLength(1);

    const h2 = harness({ getDocument: async (_e, id) => ({ id, sha256: 'sum:tampered', status: 'active', pendingDelivery: false }) });
    await h2.queue.enqueue('exp-1', [pdf()], 0);
    await h2.queue.syncNow({ force: true });
    expect(h2.queue.getSnapshot()[0]).toMatchObject({ status: 'failed' });
    expect(await h2.store.list('user-a')).toHaveLength(1);
  });

  it('an upload interrupted by a refresh/crash is resumed with the SAME attachment id (no duplicate document)', async () => {
    const store = new MemoryAttachmentStore({ durable: true });
    const first = harness({ store });
    await first.queue.enqueue('exp-1', [pdf()], 0);
    const [item] = await store.list('user-a');
    await store.put({ ...item!, status: 'uploading' }); // the tab died mid-upload
    const second = harness({ store });
    await second.queue.load();
    await second.queue.syncNow({ force: true });
    expect(second.api.calls).toEqual(['status', 'upload:att-1', 'get:att-1']);
    expect(await store.list('user-a')).toEqual([]);
  });

  it('a lost upload response: the retry reuses the id, and a known server document is only re-checked', async () => {
    let lose = true;
    const h = harness({
      upload: async (item) => {
        h.server.set(item.id, { id: item.id, sha256: item.sha256, status: 'active', pendingDelivery: false });
        if (lose) throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
        return { document: h.server.get(item.id)! };
      },
    });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.syncNow({ force: true });
    expect(h.queue.getSnapshot()[0]).toMatchObject({ status: 'pending', lastError: expect.stringMatching(/connection/) });
    lose = false;
    h.clock.now += 60 * 60_000;
    await h.queue.syncNow();
    expect(h.api.calls.filter((c) => c.startsWith('upload'))).toEqual(['upload:att-1', 'upload:att-1']);
    expect(h.server.size).toBe(1);
    expect(h.queue.getSnapshot()).toEqual([]);
  });

  it('duplicates: the same file twice for one expense is refused; the 10-per-expense limit counts server and queued files', async () => {
    const h = harness({ online: () => false });
    const first = await h.queue.enqueue('exp-1', [pdf('a.pdf'), pdf('a.pdf')], 0);
    expect(first.added).toHaveLength(1);
    expect(first.problems[0]).toMatch(/already waiting/);
    const many = await h.queue.enqueue('exp-1', ['b', 'c', 'd'].map((x) => pdf(`${x}.pdf`)), 8);
    expect(many.added.map((a) => a.fileName)).toEqual(['b.pdf']);
    expect(many.problems.filter((p) => /at most 10/.test(p))).toHaveLength(2);
    const invalid = await h.queue.enqueue('exp-2', [new NodeFile(['x'], 'virus.exe') as unknown as File], 0);
    expect(invalid.added).toEqual([]);
  });

  it('multiple attachments upload one after another; the PC dropping mid-way leaves the rest waiting', async () => {
    let uploads = 0;
    const h = harness({
      upload: async (item) => {
        uploads += 1;
        if (uploads === 2) throw new ApiError(503, 'DOCUMENT_STORAGE_OFFLINE', 'Document storage is offline');
        const doc = { id: item.id, sha256: item.sha256, status: 'active' as const, pendingDelivery: false };
        h.server.set(item.id, doc);
        return { document: doc };
      },
    });
    await h.queue.enqueue('exp-1', [pdf('1.pdf'), pdf('2.pdf'), pdf('3.pdf')], 0);
    const summary = await h.queue.syncNow({ force: true });
    expect(summary.stored).toBe(1);
    expect(h.queue.getSnapshot().map((i) => [i.fileName, i.status])).toEqual([
      ['2.pdf', 'waiting_pc'],
      ['3.pdf', 'waiting_pc'],
    ]);
    expect(uploads).toBe(2); // 3.pdf was not attempted while the PC is down
  });

  it('browser storage full: reported, nothing else queued, nothing lost', async () => {
    const h = harness({ store: new MemoryAttachmentStore({ durable: true, quotaBytes: 30 }), online: () => false });
    const result = await h.queue.enqueue('exp-1', [pdf('small.pdf'), pdf('big.pdf', 'x'.repeat(100)), pdf('later.pdf')], 0);
    expect(result.storageFull).toBe(true);
    expect(result.added.map((a) => a.fileName)).toEqual(['small.pdf']);
    expect(result.problems[0]).toMatch(/run out of storage space/);
  });

  it('a refused file (4xx) is Failed until retried manually; transient errors give up after the retry limit', async () => {
    let fail: ApiError | null = new ApiError(409, 'DOCUMENT_LIMIT_REACHED', 'An expense can have at most 10 documents.');
    const h = harness({
      upload: async (item) => {
        if (fail) throw fail;
        const doc = { id: item.id, sha256: item.sha256, status: 'active' as const, pendingDelivery: false };
        h.server.set(item.id, doc);
        return { document: doc };
      },
    });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.syncNow({ force: true });
    expect(h.queue.getSnapshot()[0]).toMatchObject({ status: 'failed', lastError: 'An expense can have at most 10 documents.' });
    h.clock.now += 60 * 60_000;
    await h.queue.syncNow();
    expect(h.api.calls.filter((c) => c.startsWith('upload'))).toHaveLength(1); // failed items are not retried automatically

    fail = new ApiError(500, 'INTERNAL', 'Server error');
    await h.queue.retry('att-1');
    for (let i = 1; i < MAX_AUTO_RETRIES; i++) {
      h.clock.now += 2 * 60 * 60_000;
      await h.queue.syncNow();
    }
    expect(h.queue.getSnapshot()[0]).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/gave up/) });

    fail = null;
    await h.queue.retry('att-1');
    expect(h.queue.getSnapshot()).toEqual([]);
  });

  it('automatic triggers are rate-limited; only one tab syncs at a time', async () => {
    const h = harness({ pc: () => false });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.retry('att-1');
    const first = h.api.calls.length;
    await h.queue.retry('att-1'); // manual: allowed
    expect(h.api.calls.length).toBe(first + 1);
    h.clock.now += BACKOFF_BASE_MS * 4;
    await h.queue.syncNow();
    await h.queue.syncNow();
    expect(h.clock.now).toBeGreaterThan(MIN_CHECK_GAP_MS);
    expect(h.api.calls.length).toBe(first + 2);

    const locked = harness({ withLock: async () => null });
    await locked.queue.enqueue('exp-1', [pdf()], 0);
    expect(await locked.queue.syncNow({ force: true })).toMatchObject({ skipped: true });
    expect(locked.api.calls).toEqual([]);
  });

  it('discarding deletes the local copy (the caller asks the user first)', async () => {
    const h = harness({ online: () => false });
    await h.queue.enqueue('exp-1', [pdf()], 0);
    await h.queue.discard('att-1');
    expect(await h.store.list('user-a')).toEqual([]);
  });
});
