import type { Logger } from 'pino';
import type { Database } from '../../database/connection.js';
import { withTransaction } from '../../database/transaction.js';
import { StorageAgentRejected, StorageUnavailable, type DocumentStorage } from './storage.js';

export interface DeliveryResult {
  delivered: number;
  /** Rows that failed for another reason than "storage unreachable" (kept; see last_error). */
  failed: number;
  /** The storage was unreachable: the run stopped early and will be retried. */
  storageUnavailable: boolean;
  /** ...because the agent refused our signature (configuration, see StorageAgentRejected). */
  agentRejected: boolean;
}

/**
 * Hands queued uploads (document_upload_queue) to the document storage. Each row is delivered in
 * its own transaction and locked with SKIP LOCKED, so several API instances never deliver the same
 * file twice at once; the queue row is deleted only after the storage confirmed the write. A
 * retried delivery of bytes that already arrived is accepted by the storage as identical.
 * Failures keep the row and record the attempt; nothing is ever lost or deleted from storage.
 */
export async function deliverQueuedDocuments(db: Database, storage: DocumentStorage, limit = 20): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, failed: 0, storageUnavailable: false, agentRejected: false };
  const tried: string[] = [];
  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (client) => {
      const row = (
        await client.query<{ document_id: string; storage_key: string; content: Buffer; mime_type: string }>(
          `SELECT q.document_id, d.storage_key, q.content, d.mime_type
             FROM document_upload_queue q JOIN expense_documents d ON d.id = q.document_id
            WHERE NOT (q.document_id = ANY($1::uuid[]))
            ORDER BY q.queued_at, q.document_id
            LIMIT 1
              FOR UPDATE OF q SKIP LOCKED`,
          [tried],
        )
      ).rows[0];
      if (!row) return 'empty' as const;
      tried.push(row.document_id);
      try {
        await storage.put(row.storage_key, row.content, row.mime_type);
      } catch (err) {
        await client.query(
          `UPDATE document_upload_queue
              SET attempts = attempts + 1, last_attempt_at = now(), last_error = left($2, 500)
            WHERE document_id = $1`,
          [row.document_id, err instanceof Error ? err.message : 'unknown error'],
        );
        if (err instanceof StorageAgentRejected) return 'rejected' as const;
        return err instanceof StorageUnavailable ? ('unavailable' as const) : ('failed' as const);
      }
      await client.query(`DELETE FROM document_upload_queue WHERE document_id = $1`, [row.document_id]);
      return 'delivered' as const;
    });
    if (outcome === 'empty') break;
    if (outcome === 'unavailable' || outcome === 'rejected') {
      result.storageUnavailable = true;
      result.agentRejected = outcome === 'rejected';
      break;
    }
    result[outcome] += 1;
  }
  return result;
}

/** Periodic delivery in the API process (only with the `agent` storage driver). */
export class DocumentQueueWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly options: { db: Database; storage: DocumentStorage; logger: Logger; intervalMs: number },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One delivery run; overlapping calls share the run in progress. */
  tick(): Promise<void> {
    this.running ??= deliverQueuedDocuments(this.options.db, this.options.storage)
      .then((r) => {
        if (r.delivered || r.failed) this.options.logger.info(r, 'Queued documents delivered to storage');
        if (r.agentRejected) {
          this.options.logger.error(
            'Document storage agent REJECTED our requests (HTTP 401/403): check DOCUMENT_STORAGE_AGENT_SECRET = AGENT_SECRET and the desktop clock; queued documents are kept',
          );
        } else if (r.storageUnavailable) {
          this.options.logger.warn('Document storage unreachable; queued documents will be retried');
        }
      })
      .catch((err: unknown) => this.options.logger.error({ err }, 'Queued document delivery failed'))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
