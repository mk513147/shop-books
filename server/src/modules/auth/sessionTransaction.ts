import type pg from 'pg';
import type { Database } from '../../database/connection.js';
import { withTransaction } from '../../database/transaction.js';
import { AppError } from '../../utils/errors.js';

/**
 * Transaction for a state-changing request that must not outlive its session.
 *
 * requireAuth validates the session when the request starts, but a request already in flight
 * could otherwise still commit after the session was revoked. Here the session row is re-checked
 * and share-locked inside the same transaction as the change:
 *  - revoked first   -> this check fails, nothing is written (401);
 *  - checked first   -> the revoking UPDATE waits until this transaction commits, so the change is
 *                       ordered strictly before the revocation.
 * Every future financial mutation must go through this helper.
 */
export async function withSessionTransaction<T>(
  db: Database,
  sessionId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (client) => {
    const live = await client.query(
      `SELECT 1
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.absolute_expires_at > now() AND u.is_active
          FOR SHARE OF s`,
      [sessionId],
    );
    if (live.rowCount === 0) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
    return work(client);
  });
}
