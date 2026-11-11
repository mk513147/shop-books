/**
 * Offline-first attachment queue (bill photos / PDFs chosen on this device).
 *
 * A chosen file is first saved in this browser's IndexedDB, then moved to the shop's permanent
 * document storage (the storage agent on the owner's PC, reached through the API) when that is
 * reachable. The local copy is deleted ONLY after the API has confirmed, and an independent read
 * has re-confirmed, that the PC holds exactly these bytes (same SHA-256).
 *
 * Local copies are NOT a backup: they live in one browser on one device, can be evicted by the
 * browser under storage pressure, and are lost if site data is cleared.
 */

export type AttachmentStatus = 'pending' | 'uploading' | 'waiting_pc' | 'stored' | 'failed';

export const ATTACHMENT_STATUS_LABELS: Record<AttachmentStatus, string> = {
  pending: 'Pending sync',
  uploading: 'Uploading',
  waiting_pc: 'Waiting for PC',
  stored: 'Stored on PC',
  failed: 'Failed',
};

export interface QueuedAttachment {
  /** Attachment id, generated on this device; becomes the document id on the server. */
  id: string;
  expenseId: string;
  /** The signed-in user who chose the file: other users of this browser never see it. */
  userId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 of `blob`, computed when the file was chosen. */
  sha256: string;
  /** ISO timestamp. */
  createdAt: string;
  status: AttachmentStatus;
  /** Automatic attempts since the last success or manual retry. */
  retryCount: number;
  lastError: string | null;
  /** Epoch ms before which no automatic attempt is made (exponential backoff); null = now. */
  nextAttemptAt: number | null;
  /**
   * Set once the server has a document for these bytes (its id may differ when the identical file
   * was already attached). Later attempts then only re-check it instead of uploading again.
   */
  serverDocumentId: string | null;
  /** The original file. */
  blob: Blob;
}

/** What the API says about a document when asked to confirm permanent storage. */
export interface ServerDocumentState {
  id: string;
  sha256: string;
  status: 'active' | 'removed';
  /** True while the bytes are only in the server's temporary queue (not yet on the PC). */
  pendingDelivery: boolean;
}

/** Thrown by stores when the browser refuses to keep more data. */
export class AttachmentStorageFullError extends Error {
  constructor() {
    super('This browser has run out of storage space for attachments. Free some space or upload when the shop PC is online.');
    this.name = 'AttachmentStorageFullError';
  }
}

/** Thrown when local storage cannot be used at all (private mode, blocked site data, very old browser). */
export class AttachmentStorageUnavailableError extends Error {
  constructor(message = 'This browser cannot keep attachments offline.') {
    super(message);
    this.name = 'AttachmentStorageUnavailableError';
  }
}
