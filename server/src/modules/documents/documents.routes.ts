import express, { Router, type Response } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor, getAuth } from '../../middleware/auth.js';
import { perUserRateLimit } from '../../middleware/rateLimit.js';
import { NotFoundError } from '../../utils/errors.js';
import { listDocuments, getDocument, openDocumentContent, removeDocument, uploadDocument } from './documents.service.js';
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

function noStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

/**
 * Bill documents of one expense: mounted at /expenses/:expenseId/documents (owner and managers).
 *
 *   GET    /                         list (active; ?status=all includes removed)
 *   POST   /                         upload ONE file: raw body, Content-Type application/octet-stream,
 *                                    X-File-Name (percent-encoded), optional X-File-Type
 *   GET    /:documentId              metadata
 *   GET    /:documentId/content      the file itself (?download=1 for an attachment), never cached
 *   POST   /:documentId/remove       { reason }
 */
export function createDocumentsRouter({ db, storage }: { db: Database; storage: DocumentStorage }): Router {
  const router = Router({ mergeParams: true });
  const expenseIdOf = (params: Record<string, unknown>) => parseId(String(params.expenseId ?? ''), 'Expense');

  router.get('/', async (req, res) => {
    const { status } = listQuerySchema.parse(req.query);
    res.json({ documents: await listDocuments(db, expenseIdOf(req.params), status === 'all') });
  });

  router.post(
    '/',
    perUserRateLimit('document-upload', 60, 10 * 60 * 1000),
    express.raw({ type: 'application/octet-stream', limit: MAX_DOCUMENT_BYTES }),
    async (req, res) => {
      const expenseId = expenseIdOf(req.params);
      const file = validateUpload(req.body, req.get('X-File-Name'), req.get('X-File-Type'));
      const result = await uploadDocument(db, storage, expenseId, { ...file, data: req.body as Buffer }, getActor(res));
      res.status(result.created ? 201 : 200).json(result);
    },
  );

  router.get('/:documentId', async (req, res) => {
    res.json({ document: await getDocument(db, expenseIdOf(req.params), parseId(req.params.documentId, 'Document')) });
  });

  router.get('/:documentId/content', async (req, res) => {
    const download = req.query.download === '1';
    const content = await openDocumentContent(
      db,
      storage,
      expenseIdOf(req.params),
      parseId(req.params.documentId, 'Document'),
      getAuth(res).user.role,
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
