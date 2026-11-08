import type { Queryable } from '../../database/connection.js';
import type { AuditAction } from '../audit/financialAudit.js';

/**
 * Change feed for live updates across devices.
 *
 * Every successful write already appends a row to financial_audit_events IN THE SAME TRANSACTION
 * (rolled-back writes leave nothing), so the audit log is an exact, durable list of committed
 * changes with a monotonically increasing id. Clients poll with the highest id they have seen.
 * Because the database (not process memory) is the source, this works with any number of API
 * instances, survives restarts, and a reconnecting client simply continues from its cursor.
 *
 * Exposed per event: what kind of record changed, which one, what happened, who did it, when.
 * Never amounts, names of records, reasons or any before/after values.
 */

/** Records shown in live updates. Owner-only configuration (monthly e-mail reports) is excluded. */
export const SYNC_ENTITY_TYPES = [
  'expense',
  'expense_category',
  'brand',
  'supplier',
  'supplier_payment',
  'customer',
  'customer_transaction',
  'salesman',
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export interface SyncEvent {
  /** Audit row id (decimal string): unique, increasing in insertion order. */
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  action: AuditAction;
  actor: { id: string; name: string } | null;
  occurredAt: string;
}

export interface SyncChanges {
  /** Pass back as `after` on the next poll. */
  cursor: string;
  events: SyncEvent[];
  /**
   * More changes happened than one response carries (e.g. a phone that was offline for long): the
   * client should simply reload everything it shows. `cursor` then points at the newest change.
   */
  truncated: boolean;
}

/** Most events per response. */
export const SYNC_PAGE_LIMIT = 200;
/**
 * Ids are assigned when a row is inserted, not when its transaction commits, so a short-lived
 * transaction can commit a slightly LOWER id after a higher one was already served. Each poll
 * therefore also re-sends the events of the last two minutes (clients de-duplicate by id), bounded
 * to the last LATE_COMMIT_WINDOW ids so the query stays an index range scan.
 */
const LATE_COMMIT_WINDOW = 1000;

interface Row {
  id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  action: AuditAction;
  actor_id: string | null;
  actor_name: string | null;
  occurred_at: Date;
}

async function latestId(db: Queryable): Promise<string> {
  const result = await db.query<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM financial_audit_events`);
  return result.rows[0]!.id;
}

/**
 * Changes after `after`. Without a cursor (first poll after opening the app) only the current
 * cursor is returned: what happened before the app was opened is already in the data it loads.
 */
export async function listChanges(db: Queryable, after: string | null): Promise<SyncChanges> {
  if (after === null) return { cursor: await latestId(db), events: [], truncated: false };

  const result = await db.query<Row>(
    `SELECT a.id::text AS id, a.entity_type, a.entity_id, a.action, u.id AS actor_id, u.name AS actor_name, a.occurred_at
       FROM financial_audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.id > $1::bigint - ${LATE_COMMIT_WINDOW}
        AND (a.id > $1::bigint OR a.occurred_at > now() - interval '2 minutes')
        AND a.entity_type = ANY($2::text[])
      ORDER BY a.id
      LIMIT ${SYNC_PAGE_LIMIT + 1}`,
    [after, SYNC_ENTITY_TYPES],
  );
  if (result.rows.length > SYNC_PAGE_LIMIT) {
    return { cursor: await latestId(db), events: [], truncated: true };
  }
  let cursor = BigInt(after);
  const events = result.rows.map((r): SyncEvent => {
    const id = BigInt(r.id);
    if (id > cursor) cursor = id;
    return {
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      action: r.action,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? '' } : null,
      occurredAt: r.occurred_at.toISOString(),
    };
  });
  return { cursor: cursor.toString(), events, truncated: false };
}
