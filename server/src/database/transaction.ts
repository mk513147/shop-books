import type pg from 'pg';
import type { Database } from './connection.js';

/**
 * Runs `work` inside BEGIN/COMMIT on a dedicated client. Any thrown error rolls back and is
 * re-thrown. If the rollback itself fails, the connection is discarded rather than reused.
 */
export async function withTransaction<T>(db: Database, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
