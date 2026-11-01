import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { todayInReportingZone } from '../../utils/dates.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { recordFinancialAudit } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { monthLabel } from '../reports/period.js';
import { monthlySummary } from '../reports/reports.service.js';
import { createJob } from './scheduler.js';
import { renderMonthlyEmail } from './template.js';

export type DeliveryStatus = 'pending' | 'processing' | 'sent' | 'simulated' | 'retry_scheduled' | 'failed';

export interface Delivery {
  id: string;
  jobId: string;
  /** 'YYYY-MM' */
  period: string;
  periodLabel: string;
  trigger: 'schedule' | 'manual';
  recipientEmail: string;
  scheduledFor: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  provider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
}

interface DeliveryRow {
  id: string;
  job_id: string;
  period_start: string;
  trigger: 'schedule' | 'manual';
  recipient_email: string;
  scheduled_for: Date;
  status: DeliveryStatus;
  attempt_count: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date;
  sent_at: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  last_error: string | null;
}

const SELECT_DELIVERY = `
  SELECT d.id, d.job_id, j.period_start::text AS period_start, j.trigger, d.recipient_email, j.scheduled_for, d.status,
         d.attempt_count, d.last_attempt_at, d.next_attempt_at, d.sent_at, d.provider, d.provider_message_id, d.last_error
    FROM report_deliveries d JOIN report_jobs j ON j.id = d.job_id`;

function toDelivery(r: DeliveryRow): Delivery {
  const [y, m] = r.period_start.split('-').map(Number) as [number, number];
  return {
    id: r.id,
    jobId: r.job_id,
    period: r.period_start.slice(0, 7),
    periodLabel: monthLabel(y, m),
    trigger: r.trigger,
    recipientEmail: r.recipient_email,
    scheduledFor: r.scheduled_for.toISOString(),
    status: r.status,
    attemptCount: r.attempt_count,
    lastAttemptAt: r.last_attempt_at?.toISOString() ?? null,
    nextAttemptAt: r.status === 'pending' || r.status === 'retry_scheduled' ? r.next_attempt_at.toISOString() : null,
    sentAt: r.sent_at?.toISOString() ?? null,
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    lastError: r.last_error,
  };
}

export async function listDeliveries(
  db: Queryable,
  q: { period?: string; status?: DeliveryStatus; page: number; pageSize: number },
): Promise<{ items: Delivery[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.period) {
    params.push(`${q.period}-01`);
    where.push(`j.period_start = $${params.length}::date`);
  }
  if (q.status) {
    params.push(q.status);
    where.push(`d.status = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_deliveries d JOIN report_jobs j ON j.id = d.job_id ${whereSql}`, params)).rows[0]!.n;
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await db.query<DeliveryRow>(
    `${SELECT_DELIVERY} ${whereSql} ORDER BY j.period_start DESC, d.created_at, d.recipient_email LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    items: rows.rows.map(toDelivery),
    pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
  };
}

/** The attempt log of one delivery (newest first). */
export async function listAttempts(db: Queryable, deliveryId: string) {
  const rows = await db.query<{ attempt_number: number; started_at: Date; finished_at: Date; outcome: string; provider: string | null; provider_message_id: string | null; error: string | null }>(
    `SELECT attempt_number, started_at, finished_at, outcome, provider, provider_message_id, error
       FROM report_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number DESC`,
    [deliveryId],
  );
  return rows.rows.map((r) => ({
    attemptNumber: r.attempt_number,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at.toISOString(),
    outcome: r.outcome,
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    error: r.error,
  }));
}

/**
 * Owner retry of a FAILED delivery (including an interrupted one with an unknown outcome — the
 * UI warns that the recipient might receive it twice). Delivered ones can never be retried.
 */
export async function retryDelivery(db: Database, id: string, actor: Actor): Promise<Delivery> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const row = (await client.query<DeliveryRow>(`${SELECT_DELIVERY} WHERE d.id = $1 FOR UPDATE OF d`, [id])).rows[0];
    if (!row) throw new NotFoundError('Delivery not found');
    if (row.status !== 'failed') {
      throw new AppError(409, 'DELIVERY_NOT_FAILED', 'Only failed deliveries can be retried.');
    }
    await client.query(`UPDATE report_deliveries SET status = 'retry_scheduled', next_attempt_at = now() WHERE id = $1`, [id]);
    await recordFinancialAudit(client, {
      entityType: 'report_delivery',
      entityId: id,
      action: 'retry',
      actorUserId: actor.userId,
      before: { status: row.status, recipient: row.recipient_email, period: row.period_start.slice(0, 7) },
      after: { status: 'retry_scheduled', recipient: row.recipient_email, period: row.period_start.slice(0, 7) },
    });
    return toDelivery((await client.query<DeliveryRow>(`${SELECT_DELIVERY} WHERE d.id = $1`, [id])).rows[0]!);
  });
}

/** Owner "send now" for a completed month that has no job yet (the scheduler sends it). */
export async function createManualJob(db: Database, year: number, month: number, actor: Actor): Promise<{ jobId: string; deliveries: number }> {
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
  if (periodStart >= `${todayInReportingZone().slice(0, 7)}-01`) {
    throw new AppError(400, 'MONTH_NOT_COMPLETE', 'Only a completed month can be sent.');
  }
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const recipients = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_recipients WHERE is_active`)).rows[0]!.n;
    if (recipients === 0) throw new AppError(400, 'NO_RECIPIENTS', 'Add at least one active recipient first.');
    const settings = (await client.query<{ include_excel: boolean }>(`SELECT include_excel FROM report_settings`)).rows[0]!;
    const now = new Date();
    const jobId = await createJob(client, { periodStart, scheduledFor: now, trigger: 'manual', includeExcel: settings.include_excel, createdBy: actor.userId, now });
    if (!jobId) {
      throw new AppError(409, 'JOB_EXISTS', `The ${monthLabel(year, month)} report was already created. Retry failed deliveries from the history instead.`);
    }
    await recordFinancialAudit(client, {
      entityType: 'report_job',
      entityId: jobId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: { period: periodStart.slice(0, 7), trigger: 'manual', recipients, includeExcel: settings.include_excel },
    });
    return { jobId, deliveries: recipients };
  });
}

/** The e-mail exactly as it would be generated now (for the owner's preview). */
export async function previewEmail(db: Queryable, shopName: string, year: number, month: number, includeExcel: boolean) {
  const summary = await monthlySummary(db, year, month, monthLabel(year, month));
  return renderMonthlyEmail(summary, shopName, summary.generatedAt, includeExcel);
}
