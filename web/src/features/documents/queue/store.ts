import { AttachmentStorageFullError, AttachmentStorageUnavailableError, type QueuedAttachment } from './types';

/**
 * Where queued attachments are kept on this device. `durable` is false for the in-memory fallback
 * (used only when IndexedDB is unavailable): those files are lost when the page closes.
 */
export interface AttachmentStore {
  readonly durable: boolean;
  /** Adds or replaces one record. Throws AttachmentStorageFullError when the quota is exhausted. */
  put(item: QueuedAttachment): Promise<void>;
  get(id: string): Promise<QueuedAttachment | undefined>;
  /** All records of one user (oldest first). */
  list(userId: string): Promise<QueuedAttachment[]>;
  delete(id: string): Promise<void>;
}

export const DB_NAME = 'shop-books-attachments';
/** v1: `uploads` (the queue). v2: + `drafts` (files picked in a form that is not saved yet; never synced). */
const DB_VERSION = 2;
export type AttachmentStoreName = 'uploads' | 'drafts';

function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number } | null;
  return e?.name === 'QuotaExceededError' || e?.code === 22 || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function toStoreError(err: unknown): Error {
  if (isQuotaError(err)) return new AttachmentStorageFullError();
  if (err instanceof Error) return err;
  const e = err as { name?: string; message?: string } | null;
  return new Error(e?.message || e?.name || 'Browser storage error');
}

const byCreated = (a: QueuedAttachment, b: QueuedAttachment) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** IndexedDB-backed store: survives refreshes, crashes and browser restarts (not site-data clearing). */
export class IndexedDbAttachmentStore implements AttachmentStore {
  readonly durable = true;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly storeName: AttachmentStoreName = 'uploads',
  ) {}

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(new AttachmentStorageUnavailableError(err instanceof Error ? err.message : undefined));
        return;
      }
      request.onupgradeneeded = () => {
        // Additive only: existing queued files are never touched by an upgrade.
        const db = request.result;
        for (const name of ['uploads', 'drafts'] as const) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('userId', 'userId', { unique: false });
          store.createIndex('expenseId', 'expenseId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the schema: let it, re-open lazily next time.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(new AttachmentStorageUnavailableError(request.error?.message));
      };
      request.onblocked = () => undefined;
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
    const db = await this.open();
    return new Promise<T | undefined>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(this.storeName, mode);
      } catch (err) {
        reject(toStoreError(err));
        return;
      }
      let result: T | undefined;
      let request: IDBRequest<T> | null;
      try {
        request = work(tx.objectStore(this.storeName));
      } catch (err) {
        reject(toStoreError(err));
        return;
      }
      if (request) request.onsuccess = () => (result = request!.result);
      // Resolve only when the transaction is COMMITTED (durable), not when the request succeeded.
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(toStoreError(tx.error ?? request?.error));
      tx.onerror = () => undefined; // handled by onabort
    });
  }

  async put(item: QueuedAttachment): Promise<void> {
    await this.run('readwrite', (s) => s.put(item));
  }

  async get(id: string): Promise<QueuedAttachment | undefined> {
    return (await this.run<QueuedAttachment>('readonly', (s) => s.get(id) as IDBRequest<QueuedAttachment>)) ?? undefined;
  }

  async list(userId: string): Promise<QueuedAttachment[]> {
    const rows = (await this.run<QueuedAttachment[]>('readonly', (s) => s.index('userId').getAll(userId) as IDBRequest<QueuedAttachment[]>)) ?? [];
    return rows.sort(byCreated);
  }

  async delete(id: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(id));
  }
}

/** Fallback when IndexedDB cannot be used: works while the page is open, nothing survives a reload. */
export class MemoryAttachmentStore implements AttachmentStore {
  readonly durable: boolean;
  private readonly items = new Map<string, QueuedAttachment>();

  constructor(options: { durable?: boolean; quotaBytes?: number } = {}) {
    this.durable = options.durable ?? false;
    this.quotaBytes = options.quotaBytes ?? Number.POSITIVE_INFINITY;
  }

  private readonly quotaBytes: number;

  async put(item: QueuedAttachment): Promise<void> {
    const used = [...this.items.values()].filter((i) => i.id !== item.id).reduce((n, i) => n + i.sizeBytes, 0);
    if (used + item.sizeBytes > this.quotaBytes) throw new AttachmentStorageFullError();
    this.items.set(item.id, { ...item });
  }

  async get(id: string): Promise<QueuedAttachment | undefined> {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  async list(userId: string): Promise<QueuedAttachment[]> {
    return [...this.items.values()].filter((i) => i.userId === userId).map((i) => ({ ...i })).sort(byCreated);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

/**
 * The best store this browser offers. Probes IndexedDB once (opening can fail in private modes or
 * when site data is blocked) and falls back to memory, reporting why.
 */
export async function openAttachmentStore(): Promise<{ store: AttachmentStore; drafts: AttachmentStore | null; problem: string | null }> {
  if (typeof globalThis.indexedDB === 'undefined') {
    return { store: new MemoryAttachmentStore(), drafts: null, problem: 'This browser cannot keep attachments offline.' };
  }
  const store = new IndexedDbAttachmentStore();
  try {
    await store.list('__probe__');
    // Drafts only make sense when they survive a reload: no in-memory fallback for them.
    return { store, drafts: new IndexedDbAttachmentStore(globalThis.indexedDB, 'drafts'), problem: null };
  } catch (err) {
    return {
      store: new MemoryAttachmentStore(),
      drafts: null,
      problem: `Browser storage is unavailable (${err instanceof Error ? err.message : 'blocked'}).`,
    };
  }
}
