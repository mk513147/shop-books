import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { recordFinancialAudit, type AuditSnapshot } from '../audit/financialAudit.js';
import type { Role } from '../auth/sessions.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { MAX_DOCUMENTS_PER_EXPENSE, type DocumentMimeType, type ValidatedUpload } from './documents.validation.js';
import { newStorageKey, StorageObjectMissing, StorageUnavailable, type DocumentStorage } from './storage.js';

interface PersonRef {
  id: string;
  name: string;
}

/** Document metadata as returned by the API. The storage key is never exposed. */
export interface ExpenseDocument {
  id: string;
  expenseId: string;
  fileName: string;
  mimeType: DocumentMimeType;
  sizeBytes: number;
  /** Hex SHA-256 of the stored bytes. */
  sha256: string;
  status: 'active' | 'removed';
  uploadedBy: PersonRef;
  createdAt: string;
  removedAt: string | null;
  removedBy: PersonRef | null;
  removeReason: string | null;
  /**
   * True while the file waits in the upload queue because the document storage (the desktop agent)
   * was unreachable when it was uploaded. It is safely stored and can be opened meanwhile.
   */
  pendingDelivery: boolean;
}

interface DocumentRow {
  id: string;
  expense_id: string;
  original_filename: string;
  storage_key: string;
  mime_type: DocumentMimeType;
  size_bytes: number;
  sha256: Buffer;
  status: 'active' | 'removed';
  created_at: Date;
  removed_at: Date | null;
  remove_reason: string | null;
  uploaded_by_id: string;
  uploaded_by_name: string;
  removed_by_id: string | null;
  removed_by_name: string | null;
  pending_delivery: boolean;
}

const SELECT_DOCUMENT = `
  SELECT d.id, d.expense_id, d.original_filename, d.storage_key, d.mime_type, d.size_bytes, d.sha256, d.status,
         d.created_at, d.removed_at, d.remove_reason,
         EXISTS (SELECT 1 FROM document_upload_queue q WHERE q.document_id = d.id) AS pending_delivery,
         uu.id AS uploaded_by_id, uu.name AS uploaded_by_name, ru.id AS removed_by_id, ru.name AS removed_by_name
    FROM expense_documents d
    JOIN users uu ON uu.id = d.uploaded_by
    LEFT JOIN users ru ON ru.id = d.removed_by`;

function toDocument(row: DocumentRow): ExpenseDocument {
  return {
    id: row.id,
    expenseId: row.expense_id,
    fileName: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256.toString('hex'),
    status: row.status,
    uploadedBy: { id: row.uploaded_by_id, name: row.uploaded_by_name },
    createdAt: row.created_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null,
    removedBy: row.removed_by_id ? { id: row.removed_by_id, name: row.removed_by_name ?? '' } : null,
    removeReason: row.remove_reason,
    pendingDelivery: row.pending_delivery,
  };
}

function snapshot(row: Pick<DocumentRow, 'id' | 'original_filename' | 'mime_type' | 'size_bytes'>, attached: boolean): AuditSnapshot {
  return {
    documentId: row.id,
    fileName: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    attached,
  };
}

async function expenseState(client: Queryable, expenseId: string, lock: boolean): Promise<{ voided: boolean }> {
  const result = await client.query<{ voided: boolean }>(
    `SELECT voided_at IS NOT NULL AS voided FROM expenses WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [expenseId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Expense not found');
  return row;
}

const VOIDED = () =>
  new AppError(409, 'EXPENSE_VOIDED', 'This expense is voided. Restore it before changing its documents.');
const LIMIT_REACHED = () =>
  new AppError(409, 'DOCUMENT_LIMIT_REACHED', `An expense can have at most ${MAX_DOCUMENTS_PER_EXPENSE} documents.`);

/**
 * Always scoped by BOTH ids: a document id that belongs to another expense is "not found", so ids
 * cannot be swapped to reach another expense's files.
 */
async function selectDocument(client: Queryable, expenseId: string, documentId: string, lock = false): Promise<DocumentRow> {
  const result = await client.query<DocumentRow>(
    `${SELECT_DOCUMENT} WHERE d.id = $1 AND d.expense_id = $2 ${lock ? 'FOR UPDATE OF d' : ''}`,
    [documentId, expenseId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Document not found');
  return row;
}

async function findActiveDuplicate(client: Queryable, expenseId: string, sha256: Buffer): Promise<DocumentRow | undefined> {
  const result = await client.query<DocumentRow>(
    `${SELECT_DOCUMENT} WHERE d.expense_id = $1 AND d.sha256 = $2 AND d.status = 'active'`,
    [expenseId, sha256],
  );
  return result.rows[0];
}

async function activeCount(client: Queryable, expenseId: string): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM expense_documents WHERE expense_id = $1 AND status = 'active'`,
    [expenseId],
  );
  return result.rows[0]!.n;
}

export async function listDocuments(db: Queryable, expenseId: string, includeRemoved: boolean): Promise<ExpenseDocument[]> {
  await expenseState(db, expenseId, false);
  const result = await db.query<DocumentRow>(
    `${SELECT_DOCUMENT} WHERE d.expense_id = $1 ${includeRemoved ? '' : `AND d.status = 'active'`}
      ORDER BY d.created_at, d.id`,
    [expenseId],
  );
  return result.rows.map(toDocument);
}

export async function getDocument(db: Queryable, expenseId: string, documentId: string): Promise<ExpenseDocument> {
  return toDocument(await selectDocument(db, expenseId, documentId));
}

export interface UploadResult {
  document: ExpenseDocument;
  /** false when the identical file was already attached (nothing new was stored). */
  created: boolean;
}

/**
 * Stores the file, then records its metadata + audit event in ONE session-bound transaction.
 *
 * Failure handling:
 *  - validation/limits/voided expense are checked before anything is stored;
 *  - storage unreachable      -> (StorageUnavailable, e.g. the desktop agent is offline) the bytes are
 *                                queued in document_upload_queue in the SAME transaction as the
 *                                metadata row, and delivered later (documentQueue.ts): nothing is lost;
 *  - storage write fails      -> nothing was recorded; the error is returned;
 *  - transaction fails        -> the stored file is deleted again (best effort);
 *  - crash between the two    -> an orphan FILE without metadata, which `documents:reconcile`
 *                                finds and (after a grace period) deletes.
 * A metadata row therefore never points at a file that was not stored.
 */
export async function uploadDocument(
  db: Database,
  storage: DocumentStorage,
  expenseId: string,
  file: ValidatedUpload & { data: Buffer },
  actor: Actor,
): Promise<UploadResult> {
  const sha256 = createHash('sha256').update(file.data).digest();

  // Cheap pre-checks (no lock) so we do not store files that would be rejected anyway.
  if ((await expenseState(db, expenseId, false)).voided) throw VOIDED();
  const existing = await findActiveDuplicate(db, expenseId, sha256);
  if (existing) return { document: toDocument(existing), created: false };
  if ((await activeCount(db, expenseId)) >= MAX_DOCUMENTS_PER_EXPENSE) throw LIMIT_REACHED();

  const key = newStorageKey();
  let queued = false;
  try {
    await storage.put(key, file.data, file.mimeType);
  } catch (err) {
    if (!(err instanceof StorageUnavailable)) throw err;
    queued = true;
  }

  let result: UploadResult;
  try {
    result = await withSessionTransaction(db, actor.sessionId, async (client) => {
      // Lock the expense: serializes concurrent uploads (count limit) and void/restore.
      if ((await expenseState(client, expenseId, true)).voided) throw VOIDED();
      const duplicate = await findActiveDuplicate(client, expenseId, sha256);
      if (duplicate) return { document: toDocument(duplicate), created: false };
      if ((await activeCount(client, expenseId)) >= MAX_DOCUMENTS_PER_EXPENSE) throw LIMIT_REACHED();

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO expense_documents (expense_id, original_filename, storage_key, mime_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [expenseId, file.fileName, key, file.mimeType, file.sizeBytes, sha256, actor.userId],
      );
      if (queued) {
        await client.query(`INSERT INTO document_upload_queue (document_id, content) VALUES ($1, $2)`, [inserted.rows[0]!.id, file.data]);
      }
      const row = await selectDocument(client, expenseId, inserted.rows[0]!.id);
      await recordFinancialAudit(client, {
        entityType: 'expense',
        entityId: expenseId,
        action: 'document_add',
        actorUserId: actor.userId,
        before: snapshot(row, false),
        after: snapshot(row, true),
      });
      return { document: toDocument(row), created: true };
    });
  } catch (err) {
    if (!queued) await storage.delete(key).catch(() => undefined);
    throw err;
  }
  // A concurrent identical upload won: our copy is not referenced by any row.
  if (!result.created && !queued) await storage.delete(key).catch(() => undefined);
  return result;
}

/**
 * Removes a document from the expense (status change + audit event with reason). The metadata row
 * and the stored file are KEPT as evidence; only the owner can still open removed documents.
 */
export async function removeDocument(
  db: Database,
  expenseId: string,
  documentId: string,
  reason: string,
  actor: Actor,
): Promise<ExpenseDocument> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    if ((await expenseState(client, expenseId, true)).voided) throw VOIDED();
    const current = await selectDocument(client, expenseId, documentId, true);
    if (current.status === 'removed') {
      throw new AppError(409, 'DOCUMENT_ALREADY_REMOVED', 'This document was already removed.');
    }
    await client.query(
      `UPDATE expense_documents SET status = 'removed', removed_at = now(), removed_by = $2, remove_reason = $3 WHERE id = $1`,
      [documentId, actor.userId, reason],
    );
    const after = await selectDocument(client, expenseId, documentId);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: expenseId,
      action: 'document_remove',
      actorUserId: actor.userId,
      reason,
      before: snapshot(current, true),
      after: snapshot(after, false),
    });
    return toDocument(after);
  });
}

export interface DocumentContent {
  document: ExpenseDocument;
  /** Set when the storage provider issued a short-lived URL (redirect); otherwise stream. */
  accessUrl: string | null;
  stream: Readable | null;
  sizeBytes: number;
}

/** Authorises and opens a document's bytes. Removed documents: owner only. */
export async function openDocumentContent(
  db: Queryable,
  storage: DocumentStorage,
  expenseId: string,
  documentId: string,
  role: Role,
  download: boolean,
): Promise<DocumentContent> {
  const row = await selectDocument(db, expenseId, documentId);
  if (row.status === 'removed' && role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Removed documents can only be opened by the owner.');
  }
  const document = toDocument(row);
  // Still waiting in the upload queue: serve the (verified) bytes from there.
  const queued = await db.query<{ content: Buffer }>(`SELECT content FROM document_upload_queue WHERE document_id = $1`, [row.id]);
  if (queued.rows[0]) {
    const content = queued.rows[0].content;
    return { document, accessUrl: null, stream: Readable.from([content]), sizeBytes: content.length };
  }
  const accessUrl = await storage.createAccessUrl(row.storage_key, {
    expiresInSeconds: 60,
    fileName: row.original_filename,
    download,
  });
  if (accessUrl) return { document, accessUrl, stream: null, sizeBytes: row.size_bytes };
  try {
    const opened = await storage.open(row.storage_key);
    return { document, accessUrl: null, stream: opened.stream, sizeBytes: opened.sizeBytes };
  } catch (err) {
    if (err instanceof StorageUnavailable) {
      throw new AppError(503, 'DOCUMENT_STORAGE_OFFLINE', 'Document storage is offline right now. Try again later.');
    }
    if (err instanceof StorageObjectMissing) {
      throw new AppError(
        500,
        'DOCUMENT_UNAVAILABLE',
        'The file for this document could not be found. Ask the owner to run the document check (documents:reconcile).',
      );
    }
    throw err;
  }
}
