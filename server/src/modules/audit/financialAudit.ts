import type { Queryable } from '../../database/connection.js';

export type AuditEntityType =
  | 'expense'
  | 'expense_category'
  | 'supplier'
  | 'supplier_payment'
  | 'customer'
  | 'customer_transaction'
  /** Salesmen directory (migration 0013). */
  | 'salesman'
  /** Monthly e-mail report configuration and manual actions (Stage 5). */
  | 'report_settings'
  | 'report_recipient'
  | 'report_job'
  | 'report_delivery'
  /** Brand master data (migration 0012). */
  | 'brand';
/** 'import' is written only by migrations (no actor); the application never records it. */
export type AuditAction =
  | 'create'
  | 'update'
  | 'void'
  | 'restore'
  | 'archive'
  | 'reactivate'
  | 'link_category'
  | 'unlink_category'
  | 'import'
  /** Recorded on the expense: a bill document was attached / removed (reason required). */
  | 'document_add'
  | 'document_remove'
  /** Supplier payment / customer transaction reversed (reason required). */
  | 'reverse'
  /** Supplier payment allocated to a bill (recorded on the payment AND on the expense). */
  | 'allocate'
  /** Allocation released (reason required; recorded on the payment AND on the expense). */
  | 'release_allocation'
  /** Owner re-queued a failed report delivery. */
  | 'retry'
  /** Supplier default brand added / removed (migration 0012). */
  | 'link_brand'
  | 'unlink_brand';
type RecordableAction = Exclude<AuditAction, 'import'>;
export type AuditSnapshot = Record<string, string | number | boolean | null>;

export interface FinancialAuditEvent {
  entityType: AuditEntityType;
  entityId: string;
  action: RecordableAction;
  actorUserId: string;
  reason?: string | null;
  before: AuditSnapshot | null;
  after: AuditSnapshot;
}

/**
 * Appends one row to financial_audit_events. MUST be called with the transaction client of the
 * change it describes, so the record and the change commit (or roll back) together.
 * Rows are append-only (enforced by a database trigger).
 */
export async function recordFinancialAudit(client: Queryable, event: FinancialAuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO financial_audit_events
       (entity_type, entity_id, action, actor_user_id, reason, before_values, after_values)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      event.entityType,
      event.entityId,
      event.action,
      event.actorUserId,
      event.reason ?? null,
      event.before === null ? null : JSON.stringify(event.before),
      JSON.stringify(event.after),
    ],
  );
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Fields whose values differ between two snapshots (in the order of the "after" snapshot). */
export function diffSnapshots(before: AuditSnapshot | null, after: AuditSnapshot): FieldChange[] {
  if (!before) return [];
  return Object.keys(after)
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

export interface AuditHistoryEntry {
  id: string;
  occurredAt: string;
  action: AuditAction;
  /** null for migration imports. */
  actor: { id: string; name: string } | null;
  reason: string | null;
  changes: FieldChange[];
  after: AuditSnapshot;
}

export async function listAuditHistory(
  db: Queryable,
  entityType: AuditEntityType,
  entityId: string,
): Promise<AuditHistoryEntry[]> {
  const result = await db.query<{
    id: string;
    occurred_at: Date;
    action: AuditAction;
    actor_id: string | null;
    actor_name: string | null;
    reason: string | null;
    before_values: AuditSnapshot | null;
    after_values: AuditSnapshot;
  }>(
    `SELECT a.id, a.occurred_at, a.action, u.id AS actor_id, u.name AS actor_name, a.reason,
            a.before_values, a.after_values
       FROM financial_audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.entity_type = $1 AND a.entity_id = $2
      ORDER BY a.occurred_at DESC, a.id DESC`,
    [entityType, entityId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    occurredAt: row.occurred_at.toISOString(),
    action: row.action,
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name ?? '' } : null,
    reason: row.reason,
    changes: diffSnapshots(row.before_values, row.after_values),
    after: row.after_values,
  }));
}
