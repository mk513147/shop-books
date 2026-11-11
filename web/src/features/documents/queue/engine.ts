import { ApiError } from '@/lib/api-client';
import { newUuid } from '@/lib/ids';
import { checkFile, MAX_DOCUMENTS_PER_EXPENSE } from '../limits';
import { sha256Hex } from './checksum';
import type { AttachmentStore } from './store';
import { AttachmentStorageFullError, type QueuedAttachment, type ServerDocumentState } from './types';

/** The API calls the queue needs (injected, so the engine is testable without a browser or server). */
export interface AttachmentQueueApi {
  /** Is the PC document storage reachable right now (asked through the API)? */
  storageStatus(): Promise<{ available: boolean }>;
  /**
   * Uploads one queued file in "permanent" mode: the API stores it on the PC, verifies it there, and
   * only then records it. It never parks the file in a server-side queue (503 instead).
   */
  upload(item: QueuedAttachment, onProgress?: (fraction: number) => void): Promise<{ document: ServerDocumentState }>;
  /** Independent re-read of a document's metadata (the second confirmation before deleting locally). */
  getDocument(expenseId: string, documentId: string): Promise<ServerDocumentState>;
}

export interface AttachmentQueueOptions {
  store: AttachmentStore;
  api: AttachmentQueueApi;
  userId: string;
  now?: () => number;
  random?: () => number;
  /** Timer hooks (tests use fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Runs `fn` while holding the cross-tab sync lock, or returns null at once when another tab of
   * this browser already holds it (that tab is syncing the same IndexedDB queue).
   */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  isOnline?: () => boolean;
  /** Called after this tab changed the queue (other tabs then reload it). */
  onChanged?: () => void;
  /** Called once a file is confirmed on the PC and its local copy removed (refresh the shared lists). */
  onStored?: (item: QueuedAttachment) => void;
  newId?: () => string;
  checksum?: (blob: Blob) => Promise<string>;
}

/** First automatic retry after 15 s, doubling up to 30 min (with ±20 % jitter). */
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** Transient errors (server errors, rate limits, read failures) give up after this many attempts. */
export const MAX_AUTO_RETRIES = 8;
/** Automatic triggers (focus, online, visibility) ask the API about the PC at most this often. */
export const MIN_CHECK_GAP_MS = 10_000;

export function backoffDelay(retryCount: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, retryCount - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export interface EnqueueResult {
  added: QueuedAttachment[];
  /** One message per file that was not queued (invalid, duplicate, over the limit, storage full). */
  problems: string[];
  /** True when the browser ran out of space: nothing after that file was queued. */
  storageFull: boolean;
}

export interface SyncSummary {
  stored: number;
  waiting: number;
  failed: number;
  /** Another tab held the lock (it is syncing). */
  skipped: boolean;
}

type Outcome = 'stored' | 'pc_offline' | 'waiting' | 'network' | 'auth' | 'transient' | 'failed';

const PC_OFFLINE = 'The shop PC is offline. The file stays on this device and is sent when the PC is back.';
const WAITING_DELIVERY = 'The server has the file but the shop PC has not stored it yet.';
const CHECKSUM_MISMATCH = 'The stored copy did not match this file (checksum mismatch). Your local copy is kept; retry to send it again.';

const SYNCABLE = new Set(['pending', 'waiting_pc', 'uploading']);

/**
 * The offline-first attachment queue of ONE signed-in user in this browser.
 *
 * Safety rules:
 *  - a local file is deleted only after the upload response AND an independent metadata read both
 *    say the document is on the PC (not pending delivery) with exactly the local SHA-256;
 *  - a successful HTTP response alone never counts as stored;
 *  - every attempt is spaced by exponential backoff; automatic triggers are rate-limited; only one
 *    tab syncs at a time (Web Locks), and uploads are idempotent on the server (the attachment id
 *    becomes the document id), so an interrupted or repeated upload never creates a second document.
 */
export class AttachmentQueue {
  private items: QueuedAttachment[] = [];
  private readonly listeners = new Set<() => void>();
  private running: Promise<SyncSummary> | null = null;
  private timer: unknown = null;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  private disposed = false;
  /** Upload progress (0..1) of the item being uploaded, for the UI. */
  readonly progress = new Map<string, number>();

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly withLock: <T>(fn: () => Promise<T>) => Promise<T | null>;
  private readonly isOnline: () => boolean;
  private readonly newId: () => string;
  private readonly checksum: (blob: Blob) => Promise<string>;

  constructor(private readonly options: AttachmentQueueOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.withLock = options.withLock ?? ((fn) => fn());
    this.isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    this.newId = options.newId ?? newUuid;
    this.checksum = options.checksum ?? sha256Hex;
  }

  get durable(): boolean {
    return this.options.store.durable;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The current items (a new array after every change, for useSyncExternalStore). */
  getSnapshot = (): readonly QueuedAttachment[] => this.items;

  forExpense(expenseId: string): QueuedAttachment[] {
    return this.items.filter((i) => i.expenseId === expenseId);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private setLocal(item: QueuedAttachment | null, id: string): void {
    const rest = this.items.filter((i) => i.id !== id);
    this.items = item ? [...rest, item].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) : rest;
    this.emit();
  }

  /** Re-reads the queue from the store (start-up, or another tab changed it). */
  async load(): Promise<void> {
    this.items = await this.options.store.list(this.options.userId);
    this.emit();
    this.schedule();
  }

  private async save(item: QueuedAttachment): Promise<void> {
    await this.options.store.put(item);
    this.setLocal(item, item.id);
    this.options.onChanged?.();
  }

  private async patch(item: QueuedAttachment, change: Partial<QueuedAttachment>): Promise<QueuedAttachment> {
    const next = { ...item, ...change };
    await this.save(next);
    return next;
  }

  /**
   * Validates the files and saves each in local storage for `expenseId` (in order). `serverCount` is
   * the number of documents the expense already has on the server: with the files already queued
   * here it may not exceed 10.
   */
  async enqueue(expenseId: string, files: File[], serverCount: number): Promise<EnqueueResult> {
    const result: EnqueueResult = { added: [], problems: [], storageFull: false };
    const queued = this.items.filter((i) => i.expenseId === expenseId);
    let used = serverCount + queued.length;
    const seen = new Set(queued.map((i) => i.sha256));
    for (const file of files) {
      const problem = checkFile(file);
      if (problem) {
        result.problems.push(problem);
        continue;
      }
      if (used >= MAX_DOCUMENTS_PER_EXPENSE) {
        result.problems.push(`${file.name}: an expense can have at most ${MAX_DOCUMENTS_PER_EXPENSE} documents.`);
        continue;
      }
      let sha256: string;
      try {
        sha256 = await this.checksum(file);
      } catch (err) {
        result.problems.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
        continue;
      }
      if (seen.has(sha256)) {
        result.problems.push(`${file.name}: this file is already waiting to be uploaded for this expense.`);
        continue;
      }
      const item: QueuedAttachment = {
        id: this.newId(),
        expenseId,
        userId: this.options.userId,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        sha256,
        createdAt: new Date(this.now()).toISOString(),
        status: 'pending',
        retryCount: 0,
        lastError: null,
        nextAttemptAt: null,
        serverDocumentId: null,
        blob: file,
      };
      try {
        await this.save(item);
      } catch (err) {
        if (err instanceof AttachmentStorageFullError) {
          result.storageFull = true;
          result.problems.push(`${file.name}: ${err.message}`);
          break;
        }
        result.problems.push(`${file.name}: could not be saved on this device (${err instanceof Error ? err.message : 'storage error'}).`);
        continue;
      }
      seen.add(sha256);
      used += 1;
      result.added.push(item);
    }
    return result;
  }

  /** Manual retry: clears the backoff and the retry count, then syncs at once. */
  async retry(id: string): Promise<SyncSummary> {
    const item = this.items.find((i) => i.id === id);
    if (item && item.status !== 'uploading') {
      await this.patch(item, { status: 'pending', retryCount: 0, nextAttemptAt: null, lastError: null });
    }
    return this.syncNow({ force: true });
  }

  /** Deletes the local copy WITHOUT uploading it. The caller must have asked the user first. */
  async discard(id: string): Promise<void> {
    if (this.items.find((i) => i.id === id)?.status === 'uploading') {
      throw new Error('This file is being uploaded right now. Wait for the upload to finish.');
    }
    await this.options.store.delete(id);
    this.setLocal(null, id);
    this.options.onChanged?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** Arms one timer for the earliest backoff deadline. */
  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const deadlines = this.items
      .filter((i) => i.status === 'pending' || i.status === 'waiting_pc')
      .map((i) => i.nextAttemptAt ?? this.now());
    if (deadlines.length === 0) return;
    const wait = Math.max(Math.min(...deadlines) - this.now(), MIN_CHECK_GAP_MS);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.syncNow();
    }, wait);
  }

  /**
   * One sync pass. Automatic callers (timer, focus, online, visibility) respect each item's backoff
   * and the check rate limit; `force` (manual retry, a newly added file) does not.
   */
  syncNow(options: { force?: boolean } = {}): Promise<SyncSummary> {
    this.running ??= this.runSync(options.force ?? false).finally(() => {
      this.running = null;
      this.schedule();
    });
    return this.running;
  }

  private async runSync(force: boolean): Promise<SyncSummary> {
    const summary: SyncSummary = { stored: 0, waiting: 0, failed: 0, skipped: false };
    if (this.disposed || !this.isOnline()) return summary;
    const ran = await this.withLock(async () => {
      // Fresh state from the store: another tab may have changed it.
      this.items = await this.options.store.list(this.options.userId);
      // An item still marked "uploading" here was interrupted (tab closed, crash, refresh).
      for (const item of this.items.filter((i) => i.status === 'uploading')) {
        await this.patch(item, { status: 'pending', lastError: 'The previous upload was interrupted.' });
      }
      const now = this.now();
      const due = this.items.filter((i) => SYNCABLE.has(i.status) && (force || i.nextAttemptAt === null || i.nextAttemptAt <= now));
      this.emit();
      if (due.length === 0) return;
      if (!force && now - this.lastCheckAt < MIN_CHECK_GAP_MS) return;
      this.lastCheckAt = now;

      let available: boolean;
      try {
        available = (await this.options.api.storageStatus()).available;
      } catch {
        return; // API unreachable or session ended: nothing changes; the timer/triggers try again.
      }
      if (!available) {
        for (const item of due) {
          if (item.serverDocumentId) continue; // only needs re-checking, done below
          await this.wait(item, 'waiting_pc', PC_OFFLINE);
          summary.waiting += 1;
        }
        // Items the server already has can still be confirmed without the PC answering us directly.
        for (const item of due.filter((i) => i.serverDocumentId)) {
          const outcome = await this.process(item);
          this.count(summary, outcome);
        }
        return;
      }
      for (const original of due) {
        const item = this.items.find((i) => i.id === original.id);
        if (!item || !SYNCABLE.has(item.status)) continue; // discarded meanwhile
        const outcome = await this.process(item);
        this.count(summary, outcome);
        if (outcome === 'pc_offline') {
          // The PC dropped mid-way: the rest waits too (no point sending them now).
          for (const rest of due.slice(due.indexOf(original) + 1)) {
            const current = this.items.find((i) => i.id === rest.id);
            if (current && SYNCABLE.has(current.status) && !current.serverDocumentId) {
              await this.wait(current, 'waiting_pc', PC_OFFLINE);
              summary.waiting += 1;
            }
          }
          break;
        }
        if (outcome === 'network' || outcome === 'auth') break;
      }
    });
    if (ran === null) summary.skipped = true;
    return summary;
  }

  private count(summary: SyncSummary, outcome: Outcome): void {
    if (outcome === 'stored') summary.stored += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else if (outcome !== 'auth') summary.waiting += 1;
  }

  /** Keeps the item for a later attempt, with backoff. */
  private async wait(item: QueuedAttachment, status: 'pending' | 'waiting_pc', error: string): Promise<QueuedAttachment> {
    const retryCount = item.retryCount + 1;
    return this.patch(item, { status, retryCount, lastError: error, nextAttemptAt: this.now() + backoffDelay(retryCount, this.random) });
  }

  private async fail(item: QueuedAttachment, error: string): Promise<'failed'> {
    await this.patch(item, { status: 'failed', lastError: error, nextAttemptAt: null });
    return 'failed';
  }

  /** Transient problem: retried with backoff until MAX_AUTO_RETRIES, then "Failed" (manual retry). */
  private async transient(item: QueuedAttachment, error: string): Promise<'transient' | 'failed'> {
    if (item.retryCount + 1 >= MAX_AUTO_RETRIES) {
      return this.fail({ ...item, retryCount: item.retryCount + 1 }, `${error} (gave up after ${MAX_AUTO_RETRIES} attempts; retry manually).`);
    }
    await this.wait(item, 'pending', error);
    return 'transient';
  }

  /** Maps an API error to what happens to the item. */
  private async onError(item: QueuedAttachment, err: unknown): Promise<Outcome> {
    if (err instanceof ApiError) {
      if (err.status === 0) {
        await this.wait(item, 'pending', 'No connection to the server.');
        return 'network';
      }
      if (err.status === 401) {
        await this.patch(item, { status: 'pending', lastError: 'Sign in again to continue uploading.' });
        return 'auth';
      }
      if (err.code === 'DOCUMENT_STORAGE_OFFLINE' || (err.status === 503 && err.code !== 'HTTP_ERROR')) {
        await this.wait(item, 'waiting_pc', PC_OFFLINE);
        return 'pc_offline';
      }
      if (err.status === 408 || err.status === 429 || err.status >= 500) return this.transient(item, err.message);
      // 4xx: the server will refuse this file every time (invalid, limit reached, expense voided...).
      return this.fail(item, err.message);
    }
    return this.transient(item, err instanceof Error ? err.message : 'Unexpected error');
  }

  /** Upload (unless the server already has it), then confirm, then delete the local copy. */
  private async process(start: QueuedAttachment): Promise<Outcome> {
    let item = await this.patch(start, { status: 'uploading' });
    if (!item.serverDocumentId) {
      try {
        this.progress.set(item.id, 0);
        const { document } = await this.options.api.upload(item, (p) => {
          this.progress.set(item.id, p);
          this.items = [...this.items]; // new snapshot so the UI re-renders the progress
          this.emit();
        });
        if (document.sha256.toLowerCase() !== item.sha256) return this.fail(item, CHECKSUM_MISMATCH);
        item = await this.patch(item, { serverDocumentId: document.id });
      } catch (err) {
        return this.onError(item, err);
      } finally {
        this.progress.delete(item.id);
      }
    }
    // Second, independent confirmation: what the server says NOW about that document.
    let state: ServerDocumentState;
    try {
      state = await this.options.api.getDocument(item.expenseId, item.serverDocumentId!);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // The server does not know it (e.g. the upload was rolled back): send it again.
        await this.wait({ ...item, serverDocumentId: null }, 'pending', 'The server did not keep the upload; it will be sent again.');
        return 'transient';
      }
      return this.onError(item, err);
    }
    if (state.sha256.toLowerCase() !== item.sha256) return this.fail(item, CHECKSUM_MISMATCH);
    if (state.pendingDelivery) {
      await this.wait(item, 'waiting_pc', WAITING_DELIVERY);
      return 'waiting';
    }
    // Confirmed on the PC with the same checksum: only now is the local copy removed.
    await this.patch(item, { status: 'stored', lastError: null, nextAttemptAt: null });
    await this.options.store.delete(item.id);
    this.setLocal(null, item.id);
    this.options.onChanged?.();
    this.options.onStored?.(item);
    return 'stored';
  }
}
