import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { recordFinancialAudit, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';

/** Fixed audit entity id for the singleton settings row. */
export const SETTINGS_ENTITY_ID = '00000000-0000-0000-0000-000000000001';

export interface ReportSettings {
  enabled: boolean;
  deliveryDay: number;
  /** 'HH:MM', Asia/Kolkata. */
  deliveryTime: string;
  includeExcel: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  /** Next scheduled run (ISO instant) when enabled; derived. */
  nextRunAt: string | null;
}

interface SettingsRow {
  enabled: boolean;
  delivery_day: number;
  delivery_time: string;
  include_excel: boolean;
  version: number;
  updated_at: Date;
  updated_by_name: string | null;
  next_run_at: Date | null;
}

/**
 * The scheduled instant for month (y, m): delivery_day at delivery_time, Asia/Kolkata. Used here
 * and by the scheduler so both agree.
 */
export const SCHEDULED_AT_SQL = (y: string, m: string) =>
  `make_timestamptz(${y}, ${m}, s.delivery_day, extract(hour FROM s.delivery_time)::int, extract(minute FROM s.delivery_time)::int, 0, 'Asia/Kolkata')`;

const SELECT_SETTINGS = `
  SELECT s.enabled, s.delivery_day, to_char(s.delivery_time, 'HH24:MI') AS delivery_time, s.include_excel, s.version,
         s.updated_at, u.name AS updated_by_name,
         CASE WHEN s.enabled THEN
           CASE WHEN ${SCHEDULED_AT_SQL('k.y', 'k.m')} > now() THEN ${SCHEDULED_AT_SQL('k.y', 'k.m')}
                ELSE ${SCHEDULED_AT_SQL('k.ny', 'k.nm')} END END AS next_run_at
    FROM report_settings s
    LEFT JOIN users u ON u.id = s.updated_by
    CROSS JOIN LATERAL (
      SELECT extract(year FROM t)::int AS y, extract(month FROM t)::int AS m,
             extract(year FROM t + interval '1 month')::int AS ny, extract(month FROM t + interval '1 month')::int AS nm
        FROM (SELECT (now() AT TIME ZONE 'Asia/Kolkata') AS t) x) k`;

function toSettings(r: SettingsRow): ReportSettings {
  return {
    enabled: r.enabled,
    deliveryDay: r.delivery_day,
    deliveryTime: r.delivery_time,
    includeExcel: r.include_excel,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by_name,
    nextRunAt: r.next_run_at?.toISOString() ?? null,
  };
}

const snap = (s: Pick<ReportSettings, 'enabled' | 'deliveryDay' | 'deliveryTime' | 'includeExcel'>): AuditSnapshot => ({
  enabled: s.enabled,
  deliveryDay: s.deliveryDay,
  deliveryTime: s.deliveryTime,
  includeExcel: s.includeExcel,
});

/** The singleton row is created by migration 0009; re-create the defaults if it is ever missing. */
async function ensureRow(db: Queryable): Promise<void> {
  await db.query(`INSERT INTO report_settings (id) VALUES (true) ON CONFLICT DO NOTHING`);
}

export async function getSettings(db: Queryable): Promise<ReportSettings> {
  await ensureRow(db);
  return toSettings((await db.query<SettingsRow>(SELECT_SETTINGS)).rows[0]!);
}

export async function updateSettings(
  db: Database,
  input: { enabled: boolean; deliveryDay: number; deliveryTime: string; includeExcel: boolean },
  expectedVersion: number,
  actor: Actor,
): Promise<ReportSettings> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    await ensureRow(client);
    await client.query(`SELECT 1 FROM report_settings FOR UPDATE`);
    const before = toSettings((await client.query<SettingsRow>(SELECT_SETTINGS)).rows[0]!);
    if (before.version !== expectedVersion) {
      throw new AppError(409, 'VERSION_CONFLICT', 'The report settings were changed by someone else. Reload and try again.');
    }
    if (JSON.stringify(snap(before)) === JSON.stringify(snap(input))) return before;
    await client.query(
      `UPDATE report_settings SET enabled = $1, delivery_day = $2, delivery_time = $3::time, include_excel = $4,
              updated_by = $5, version = version + 1`,
      [input.enabled, input.deliveryDay, input.deliveryTime, input.includeExcel, actor.userId],
    );
    const after = toSettings((await client.query<SettingsRow>(SELECT_SETTINGS)).rows[0]!);
    await recordFinancialAudit(client, {
      entityType: 'report_settings',
      entityId: SETTINGS_ENTITY_ID,
      action: 'update',
      actorUserId: actor.userId,
      before: snap(before),
      after: snap(after),
    });
    return after;
  });
}

export interface Recipient {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RecipientRow {
  id: string;
  email: string;
  name: string | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toRecipient = (r: RecipientRow): Recipient => ({
  id: r.id,
  email: r.email,
  name: r.name,
  isActive: r.is_active,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const recipientSnap = (r: { email: string; name: string | null; is_active: boolean }): AuditSnapshot => ({
  email: r.email,
  name: r.name,
  isActive: r.is_active,
});

const taken = (err: unknown) => {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'report_recipients_active_email_unique';
};
const TAKEN = () => new AppError(409, 'RECIPIENT_EXISTS', 'This e-mail address is already an active recipient.');

export async function listRecipients(db: Queryable): Promise<Recipient[]> {
  return (await db.query<RecipientRow>(`SELECT * FROM report_recipients ORDER BY is_active DESC, lower(email::text)`)).rows.map(toRecipient);
}

export async function addRecipient(db: Database, input: { email: string; name: string | null }, actor: Actor): Promise<Recipient> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const row = (
        await client.query<RecipientRow>(
          `INSERT INTO report_recipients (email, name, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING *`,
          [input.email, input.name, actor.userId],
        )
      ).rows[0]!;
      await recordFinancialAudit(client, {
        entityType: 'report_recipient',
        entityId: row.id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: recipientSnap(row),
      });
      return toRecipient(row);
    });
  } catch (err) {
    if (taken(err)) throw TAKEN();
    throw err;
  }
}

export async function updateRecipient(
  db: Database,
  id: string,
  changes: { email?: string; name?: string | null; isActive?: boolean },
  expectedVersion: number,
  actor: Actor,
): Promise<Recipient> {
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const before = (await client.query<RecipientRow>(`SELECT * FROM report_recipients WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundError('Recipient not found');
      if (before.version !== expectedVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'This recipient was changed by someone else. Reload and try again.');
      }
      const next = {
        email: changes.email ?? before.email,
        name: changes.name === undefined ? before.name : changes.name,
        is_active: changes.isActive ?? before.is_active,
      };
      if (JSON.stringify(recipientSnap(before)) === JSON.stringify(recipientSnap(next))) return toRecipient(before);
      const after = (
        await client.query<RecipientRow>(
          `UPDATE report_recipients SET email = $2, name = $3, is_active = $4, updated_by = $5, version = version + 1
            WHERE id = $1 RETURNING *`,
          [id, next.email, next.name, next.is_active, actor.userId],
        )
      ).rows[0]!;
      await recordFinancialAudit(client, {
        entityType: 'report_recipient',
        entityId: id,
        action: before.is_active === next.is_active ? 'update' : next.is_active ? 'reactivate' : 'archive',
        actorUserId: actor.userId,
        before: recipientSnap(before),
        after: recipientSnap(after),
      });
      return toRecipient(after);
    });
  } catch (err) {
    if (taken(err)) throw TAKEN();
    throw err;
  }
}
