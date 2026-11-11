import type { Readable } from 'node:stream';
// StorageDisabled is defined in storage.ts: defining it here would extend StorageUnavailable through
// the import cycle storage.ts -> disabledStorage.ts -> storage.ts before that class exists.
import { StorageDisabled, type DocumentStorage, type StoredObject } from './storage.js';

/** Document storage when attachments are postponed: holds nothing, accepts nothing, never connects anywhere. */
export class DisabledDocumentStorage implements DocumentStorage {
  readonly driver = 'disabled';

  put(): Promise<void> {
    return Promise.reject(new StorageDisabled());
  }

  open(): Promise<{ stream: Readable; sizeBytes: number }> {
    return Promise.reject(new StorageDisabled());
  }

  /** Nothing to delete here; deleting a missing object is not an error (interface contract). */
  delete(): Promise<void> {
    return Promise.resolve();
  }

  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }

  digest(): Promise<{ sizeBytes: number; sha256Hex: string }> {
    return Promise.reject(new StorageDisabled());
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** There is no storage to reconcile against: documents:reconcile refuses to run in this mode. */
  async *list(): AsyncIterable<StoredObject> {
    throw new StorageDisabled();
  }

  createAccessUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
