import express, { Router, type Response } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor, getAuth } from '../../middleware/auth.js';
import { perUserRateLimit } from '../../middleware/rateLimit.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import {
  ATTACHMENTS_DISABLED,
  attachmentsDisabled,
  documentStorageStatus,
  getDocument,
  listDocuments,
  openDocumentContent,
  removeDocument,
  uploadDocument,
  type DocumentViewer,
} from './documents.service.js';
import { MAX_DOCUMENT_BYTES, validateUpload } from './documents.validation.js';
import type { DocumentStorage } from './storage.js';

function parseId(raw: string | undefined, what: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}

const removeSchema = z.strictObject({
  reason: z.string().trim().min(1, 'A reason is required').max(500, 'Reason must be at most 500 characters'),
});

const listQuerySchema = z.object({ status: z.enum(['active', 'all']).default('active') });

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback and the exact UTF-8 name. */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function viewerOf(res: Response): DocumentViewer {
  const { user } = getAuth(res);
  return { userId: user.id, role: user.role };
}

/**
 * Optional headers of the offline attachment queue:
 *   X-Storage-Mode: permanent   store on the PC and verify there, never queue on the server (503 instead)
 *   X-Attachment-Id: <uuid>     becomes the document id (retries return the same document)
 *   X-Content-SHA256: <hex>     the received bytes must match
 */
function uploadOptions(req: express.Request) {
  const mode = req.get('X-Storage-Mode');
  if (mode !== undefined && mode !== 'permanent' && mode !== 'default') {
    throw new AppError(400, 'INVALID_STORAGE_MODE', 'X-Storage-Mode must be "permanent" or "default".');
  }
  const id = req.get('X-Attachment-Id');
  if (id !== undefined && !z.uuid().safeParse(id).success) {
    throw new AppError(400, 'INVALID_ATTACHMENT_ID', 'X-Attachment-Id must be a UUID.');
  }
  const sha = req.get('X-Content-SHA256')?.toLowerCase();
  if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) {
    throw new AppError(400, 'INVALID_CHECKSUM', 'X-Content-SHA256 must be a hex SHA-256.');
  }
  return {
    mode: mode === 'permanent' ? ('permanent' as const) : ('default' as const),
    ...(id ? { documentId: id.toLowerCase() } : {}),
    ...(sha ? { expectedSha256: sha } : {}),
  };
}

/**
 * GET /document-storage/status -> { available, driver }: can permanent document storage (the
 * storage agent on the shop PC) be reached right now? Asked by the offline attachment queue before
 * it sends files. The answer is cached for a few seconds so many devices do not ping the PC at once.
 */
export function createDocumentStorageStatusRouter({ storage, cacheMs = 5000 }: { storage: DocumentStorage; cacheMs?: number }): Router {
  const router = Router();
  let cached: { at: number; value: Promise<{ available: boolean; driver: string }> } | null = null;
  router.get('/status', async (_req, res) => {
    const now = Date.now();
    if (!cached || now - cached.at > cacheMs) cached = { at: now, value: documentStorageStatus(storage) };
    res.json(await cached.value);
  });
  return router;
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

/**
 * Bill documents of one expense: mounted at /expenses/:expenseId/documents (owner and managers).
 *
 *   GET    /                         list (active; ?status=all includes removed)
 *   POST   /                         upload ONE file: raw body, Content-Type application/octet-stream,
 *                                    X-File-Name (percent-encoded), optional X-File-Type, and the
 *                                    optional X-Storage-Mode / X-Attachment-Id / X-Content-SHA256
 *   GET    /:documentId              metadata
 *   GET    /:documentId/content      the file itself (?download=1 for an attachment), never cached
 *   POST   /:documentId/remove       { reason }
 */
export function createDocumentsRouter({ db, storage }: { db: Database; storage: DocumentStorage }): Router {
  const router = Router({ mergeParams: true });
  const expenseIdOf = (params: Record<string, unknown>) => parseId(String(params.expenseId ?? ''), 'Expense');

  router.get('/', async (req, res) => {
    const { status } = listQuerySchema.parse(req.query);
    res.json({ documents: await listDocuments(db, expenseIdOf(req.params), status === 'all', viewerOf(res)) });
  });

  router.post(
    '/',
    // Attachments postponed: refuse before reading (up to 10 MB of) body.
    (_req, _res, next) => next(attachmentsDisabled(storage) ? ATTACHMENTS_DISABLED() : undefined),
    perUserRateLimit('document-upload', 60, 10 * 60 * 1000),
    express.raw({ type: 'application/octet-stream', limit: MAX_DOCUMENT_BYTES }),
    async (req, res) => {
      const expenseId = expenseIdOf(req.params);
      const options = uploadOptions(req);
      const file = validateUpload(req.body, req.get('X-File-Name'), req.get('X-File-Type'));
      const result = await uploadDocument(db, storage, expenseId, { ...file, data: req.body as Buffer }, getActor(res), options);
      res.status(result.created ? 201 : 200).json(result);
    },
  );

  router.get('/:documentId', async (req, res) => {
    res.json({ document: await getDocument(db, expenseIdOf(req.params), parseId(req.params.documentId, 'Document'), viewerOf(res)) });
  });

  router.get('/:documentId/content', async (req, res) => {
    const download = req.query.download === '1';
    const content = await openDocumentContent(
      db,
      storage,
      expenseIdOf(req.params),
      parseId(req.params.documentId, 'Document'),
      viewerOf(res),
      download,
    );
    noStore(res);
    if (content.accessUrl) {
      res.redirect(302, content.accessUrl);
      return;
    }
    res.set('Content-Type', content.document.mimeType);
    res.set('Content-Length', String(content.sizeBytes));
    res.set('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', content.document.fileName));
    const stream = content.stream!;
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  router.post('/:documentId/remove', async (req, res) => {
    const { reason } = removeSchema.parse(req.body);
    const document = await removeDocument(
      db,
      expenseIdOf(req.params),
      parseId(req.params.documentId, 'Document'),
      reason,
      getActor(res),
    );
    res.json({ document });
  });

  return router;
}
