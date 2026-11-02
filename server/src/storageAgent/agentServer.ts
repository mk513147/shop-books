import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AGENT_HEADERS, verifyAgentRequest } from '../modules/documents/agentProtocol.js';
import { MAX_DOCUMENT_BYTES } from '../modules/documents/documents.validation.js';
import type { LocalDocumentStorage } from '../modules/documents/localStorage.js';
import { isValidStorageKey, StorageObjectMissing } from '../modules/documents/storage.js';

/**
 * The storage agent: a tiny HTTP service on the owner's desktop that keeps the bill documents in a
 * private folder (the same LocalDocumentStorage as the `local` driver: atomic writes, validated
 * keys, never overwriting). The API reaches it through Cloudflare Tunnel; it should listen on
 * 127.0.0.1 only. Every request must carry a valid HMAC signature (agentProtocol.ts).
 *
 *   GET    /v1/health          signed ping
 *   GET    /v1/objects         NDJSON list (reconciliation)
 *   HEAD   /v1/objects/<key>   exists?
 *   GET    /v1/objects/<key>   the bytes
 *   PUT    /v1/objects/<key>   store; body SHA-256 must match the signed header; 201 new,
 *                              200 identical bytes already stored, 409 different bytes stored
 *   DELETE /v1/objects/<key>   204 (also when already gone)
 */
export interface StorageAgentOptions {
  storage: LocalDocumentStorage;
  secret: string;
  log?: (entry: { method: string; path: string; status: number; reason?: string }) => void;
}

const OBJECT_PATH = /^\/v1\/objects\/(.+)$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Reads the request body, refusing anything larger than a document may be. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function sha256Hex(storage: LocalDocumentStorage, key: string): Promise<string> {
  const { stream } = await storage.open(key);
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function createStorageAgent({ storage, secret, log }: StorageAgentOptions): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<{ status: number; reason?: string }> {
    const url = new URL(req.url ?? '/', 'http://agent');
    const method = req.method ?? 'GET';
    const contentSha = req.headers[AGENT_HEADERS.contentSha256];
    const rejected = verifyAgentRequest(secret, {
      method,
      pathAndQuery: url.pathname + url.search,
      timestamp: req.headers[AGENT_HEADERS.timestamp] as string | undefined,
      signature: req.headers[AGENT_HEADERS.signature] as string | undefined,
      contentSha256Hex: typeof contentSha === 'string' ? contentSha : '',
    });
    if (rejected) {
      send(res, 401, { error: 'unauthorized' });
      return { status: 401, reason: rejected };
    }
    if (url.search) throw new HttpError(400, 'no query parameters');

    if (url.pathname === '/v1/health' && method === 'GET') {
      send(res, 200, { status: 'ok' });
      return { status: 200 };
    }
    if (url.pathname === '/v1/objects' && method === 'GET') {
      res.statusCode = 200;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/x-ndjson');
      for await (const o of storage.list()) {
        res.write(`${JSON.stringify({ key: o.key, validKey: o.validKey, sizeBytes: o.sizeBytes, modifiedAt: o.modifiedAt.toISOString() })}\n`);
      }
      res.end();
      return { status: 200 };
    }

    const match = OBJECT_PATH.exec(url.pathname);
    if (!match || !isValidStorageKey(match[1]!)) throw new HttpError(404, 'not found');
    const key = match[1]!;

    switch (method) {
      case 'HEAD': {
        const found = await storage.exists(key);
        send(res, found ? 200 : 404);
        return { status: found ? 200 : 404 };
      }
      case 'GET': {
        try {
          const { stream, sizeBytes } = await storage.open(key);
          res.statusCode = 200;
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-content-type-options', 'nosniff');
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-length', String(sizeBytes));
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return { status: 200 };
        } catch (err) {
          if (err instanceof StorageObjectMissing) throw new HttpError(404, 'not found');
          throw err;
        }
      }
      case 'PUT': {
        if (typeof contentSha !== 'string' || !/^[0-9a-f]{64}$/.test(contentSha)) throw new HttpError(400, 'content hash required');
        const body = await readBody(req);
        if (body.length === 0) throw new HttpError(400, 'empty body');
        if (createHash('sha256').update(body).digest('hex') !== contentSha) throw new HttpError(400, 'content hash mismatch');
        try {
          await storage.put(key, body);
          send(res, 201, { stored: true });
          return { status: 201 };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          // Never overwrite: identical bytes are an idempotent retry, anything else a conflict.
          if ((await sha256Hex(storage, key)) === contentSha) {
            send(res, 200, { stored: false });
            return { status: 200 };
          }
          throw new HttpError(409, 'a different object already exists under this key');
        }
      }
      case 'DELETE':
        await storage.delete(key);
        send(res, 204);
        return { status: 204 };
      default:
        throw new HttpError(405, 'method not allowed');
    }
  }

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    handle(req, res)
      .then((r) => log?.({ method: req.method ?? '', path, ...r }))
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (!res.headersSent) send(res, status, { error: err instanceof HttpError ? err.message : 'internal error' });
        else res.destroy();
        // Drain an unread upload so the connection can close cleanly.
        req.resume();
        log?.({ method: req.method ?? '', path, status, reason: err instanceof Error ? err.message : 'error' });
      });
  });
}
