import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError } from '../../utils/errors.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';

export type IdempotentOperation =
  | 'expense.create'
  | 'supplier_payment.create'
  | 'supplier_payment.allocate'
  | 'customer_transaction.create'
  | 'customer_due.settle_all';

const REUSED_MESSAGES: Record<IdempotentOperation, string> = {
  'expense.create':
    'This form was already used to save a different expense. Check the expenses list before adding it again.',
  'supplier_payment.create':
    'This form was already used to record a different payment. Check the payments list before recording it again.',
  'supplier_payment.allocate': 'This allocation form was already used with different amounts. Reload the payment and try again.',
  'customer_transaction.create':
    'This form was already used to record a different entry. Check the customer ledger before recording it again.',
  'customer_due.settle_all':
    'This form was already used to record a different payment. Check the customer ledger before recording it again.',
};

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

/** Reads the optional `Idempotency-Key` header. A present but malformed key is a 400. */
export function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const key = header.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 16–100 characters of letters, digits, "-" or "_"',
    );
  }
  return key;
}

/** SHA-256 of the normalised request. Callers pass the parsed, normalised input (stable key order). */
export function hashRequest(input: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(input)).digest();
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

interface StoredRow {
  request_hash: Buffer;
  response_status: number;
  response_body: unknown;
}

class ConcurrentDuplicate extends Error {}

async function findStored(client: Queryable, actor: Actor, operation: IdempotentOperation, key: string) {
  const result = await client.query<StoredRow>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_keys WHERE user_id = $1 AND operation = $2 AND key = $3`,
    [actor.userId, operation, key],
  );
  return result.rows[0];
}

function replay<T>(row: StoredRow, requestHash: Buffer, operation: IdempotentOperation): IdempotentResult<T> {
  if (!row.request_hash.equals(requestHash)) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', REUSED_MESSAGES[operation]);
  }
  return { status: row.response_status, body: row.response_body as T, replayed: true };
}

/**
 * Runs a creating operation at most once per (user, operation, key), with the key row and the
 * created record committed in the SAME transaction (withSessionTransaction).
 *
 *  - key already stored, same request   -> the stored response is replayed; nothing is created.
 *  - key already stored, other request  -> 409 IDEMPOTENCY_KEY_REUSED.
 *  - two concurrent requests, same key  -> the primary-key insert makes the second wait for the
 *    first; if the first commits, the second rolls its own work back and replays the stored response.
 *  - failed requests roll back and store nothing, so they can be retried with the same key.
 */
export async function runIdempotent<T>(
  db: Database,
  actor: Actor,
  operation: IdempotentOperation,
  key: string,
  requestHash: Buffer,
  work: (client: pg.PoolClient) => Promise<{ status: number; body: T; resourceId: string }>,
): Promise<IdempotentResult<T>> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const existing = await findStored(client, actor, operation, key);
      if (existing) return replay<T>(existing, requestHash, operation);

      const result = await work(client);
      const stored = await client.query(
        `INSERT INTO idempotency_keys
           (user_id, operation, key, request_hash, response_status, response_body, resource_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT DO NOTHING`,
        [actor.userId, operation, key, requestHash, result.status, JSON.stringify(result.body), result.resourceId],
      );
      // A concurrent request with this key committed first: undo our work, replay theirs.
      if (stored.rowCount === 0) throw new ConcurrentDuplicate();
      return { status: result.status, body: result.body, replayed: false };
    });
  } catch (err) {
    if (!(err instanceof ConcurrentDuplicate)) throw err;
    const winner = await findStored(db, actor, operation, key);
    if (!winner) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Please try again.');
    return replay<T>(winner, requestHash, operation);
  }
}
