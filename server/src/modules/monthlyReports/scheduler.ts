import type pg from 'pg';
import type { Logger } from 'pino';
import type { Database } from '../../database/connection.js';
import { withTransaction } from '../../database/transaction.js';
import { EmailSendError, type EmailAttachment, type EmailSender } from '../email/email.js';
import { workbookBuffer } from '../exports/excel.js';
import { buildMonthlyWorkbook } from '../exports/exports.service.js';
import { monthLabel } from '../reports/period.js';
import { monthlySummary } from '../reports/reports.service.js';
import { SCHEDULED_AT_SQL } from './settings.service.js';
import { renderMonthlyEmail } from './template.js';

/**
 * Monthly report scheduler. Runs inside the API process on a timer, but ALL state lives in
 * PostgreSQL, so restarts, crashes and several API instances are safe:
 *
 *  - one tick at a time across instances: pg_try_advisory_lock(SCHEDULER_LOCK_KEY);
 *  - a month's job is created at most once (report_jobs.period_start UNIQUE);
 *  - one delivery per recipient per month (UNIQUE (job_id, recipient_email));
 *  - a delivery is claimed with FOR UPDATE SKIP LOCKED and moved to `processing` before sending;
 *  - sent/simulated deliveries are final (trigger), so a successful recipient is never re-sent
 *    because another recipient failed;
 *  - a delivery left in `processing` (crash during sending) is marked `failed` with an
 *    "outcome unknown" error instead of being re-sent automatically: the provider may already
 *    have accepted it. The owner can retry it manually.
 *
 * Delivery is at-least-once only if the owner retries an uncertain failure, and at-most-once
 * otherwise; exactly-once is impossible without provider-side idempotency (the delivery id is
 * passed to the provider as an idempotency key for providers that support one).
 */
export const SCHEDULER_LOCK_KEY = 726_001_002;
export const MAX_ATTEMPTS = 5;
/** Waits after attempts 1–4 (then the delivery fails). */
export const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
export const STALE_PROCESSING_MS = 15 * 60_000;
const MAX_PER_TICK = 50;

export interface SchedulerDeps {
  db: Database;
  sender: EmailSender;
  shopName: string;
  from: string;
  logger?: Logger;
  intervalMs?: number;
  /** Clock (tests). */
  now?: () => Date;
}

export interface TickResult {
  ran: boolean;
  jobCreated: string | null;
  recovered: number;
  processed: { id: string; status: string }[];
}

interface ClaimedDelivery {
  id: string;
  job_id: string;
  recipient_email: string;
  attempt_count: number;
  period_start: string;
  include_excel: boolean;
}

interface JobContent {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

export class ReportScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly deps: SchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 60_000;
    this.timer = setInterval(() => void this.safeTick(), interval);
    this.timer.unref();
    setTimeout(() => void this.safeTick(), 5_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask for a tick soon (e.g. after a manual job or retry); never throws. */
  nudge(): void {
    setImmediate(() => void this.safeTick());
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.deps.logger?.error({ err }, 'Monthly report scheduler tick failed');
    }
  }

  /** One scheduler pass. Safe to call concurrently from any number of processes. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { ran: false, jobCreated: null, recovered: 0, processed: [] };
    if (this.running) return result;
    this.running = true;
    const lockClient = await this.deps.db.connect();
    let locked = false;
    try {
      locked = (await lockClient.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [SCHEDULER_LOCK_KEY])).rows[0]!.ok;
      if (!locked) return result;
      result.ran = true;
      const now = this.now();
      result.jobCreated = await this.ensureDueJob(now);
      result.recovered = await this.recoverStale(now);
      const cache = new Map<string, Promise<JobContent>>();
      for (let i = 0; i < MAX_PER_TICK; i++) {
        const claimed = await this.claim(this.now());
        if (!claimed) break;
        if ('skipped' in claimed) {
          result.processed.push({ id: claimed.id, status: 'failed' });
          continue;
        }
        result.processed.push({ id: claimed.id, status: await this.deliver(claimed, cache) });
      }
      return result;
    } finally {
      if (locked) await lockClient.query(`SELECT pg_advisory_unlock($1)`, [SCHEDULER_LOCK_KEY]).catch(() => undefined);
      lockClient.release();
      this.running = false;
    }
  }

  /**
   * When reports are enabled and this month's delivery time (Asia/Kolkata) has passed, make sure
   * the PREVIOUS month's job exists with one delivery per active recipient. Idempotent.
   * A server that was down at the scheduled time catches up on the next tick; only the most
   * recent completed month is created automatically (older missed months: manual run).
   */
  private async ensureDueJob(now: Date): Promise<string | null> {
    return withTransaction(this.deps.db, async (client) => {
      const due = (
        await client.query<{ scheduled_at: Date; period_start: string; include_excel: boolean }>(
          `SELECT ${SCHEDULED_AT_SQL('k.y', 'k.m')} AS scheduled_at,
                  (date_trunc('month', k.t) - interval '1 month')::date AS period_start, s.include_excel
             FROM report_settings s
             CROSS JOIN LATERAL (SELECT t, extract(year FROM t)::int AS y, extract(month FROM t)::int AS m
                                   FROM (SELECT ($1::timestamptz AT TIME ZONE 'Asia/Kolkata') AS t) x) k
            WHERE s.enabled AND ${SCHEDULED_AT_SQL('k.y', 'k.m')} <= $1::timestamptz`,
          [now],
        )
      ).rows[0];
      if (!due) return null;
      return createJob(client, { periodStart: due.period_start, scheduledFor: due.scheduled_at, trigger: 'schedule', includeExcel: due.include_excel, createdBy: null, now });
    });
  }

  /** Deliveries stuck in `processing` (process died while sending) -> failed, outcome unknown. */
  private async recoverStale(now: Date): Promise<number> {
    return withTransaction(this.deps.db, async (client) => {
      const stale = await client.query<{ id: string; attempt_count: number; last_attempt_at: Date }>(
        `SELECT id, attempt_count, last_attempt_at FROM report_deliveries
          WHERE status = 'processing' AND locked_at < $1::timestamptz - make_interval(secs => $2)
          FOR UPDATE SKIP LOCKED`,
        [now, STALE_PROCESSING_MS / 1000],
      );
      const message = 'Interrupted while sending (the server stopped). The e-mail may or may not have been delivered; retry only if the recipient did not receive it.';
      for (const d of stale.rows) {
        await client.query(
          `UPDATE report_deliveries SET status = 'failed', locked_at = NULL, last_error = $2 WHERE id = $1`,
          [d.id, message],
        );
        await client.query(
          `INSERT INTO report_delivery_attempts (delivery_id, attempt_number, started_at, outcome, error)
           VALUES ($1, $2, $3, 'interrupted', $4) ON CONFLICT DO NOTHING`,
          [d.id, d.attempt_count, d.last_attempt_at ?? now, message],
        );
      }
      return stale.rowCount ?? 0;
    });
  }

  /**
   * Claims the next due delivery. A delivery whose recipient was removed, or whose address was
   * changed, after the month's job was created is NOT sent (the owner no longer wants financial
   * data going there): it is marked failed with an explanation instead.
   */
  private async claim(now: Date): Promise<ClaimedDelivery | { id: string; skipped: true } | null> {
    return withTransaction(this.deps.db, async (client) => {
      const row = (
        await client.query<ClaimedDelivery & { recipient_ok: boolean }>(
          `SELECT d.id, d.job_id, d.recipient_email, d.attempt_count, j.period_start::text AS period_start, j.include_excel,
                  COALESCE(r.is_active AND r.email = d.recipient_email, false) AS recipient_ok
             FROM report_deliveries d JOIN report_jobs j ON j.id = d.job_id
             LEFT JOIN report_recipients r ON r.id = d.recipient_id
            WHERE d.status IN ('pending', 'retry_scheduled') AND d.next_attempt_at <= $1
            ORDER BY d.next_attempt_at, d.id
            LIMIT 1
            FOR UPDATE OF d SKIP LOCKED`,
          [now],
        )
      ).rows[0];
      if (!row) return null;
      if (!row.recipient_ok) {
        const message = 'Not sent: this recipient was removed or their address changed after the report was queued.';
        await client.query(
          `UPDATE report_deliveries SET status = 'failed', last_error = $2, last_attempt_at = $3, attempt_count = attempt_count + 1 WHERE id = $1`,
          [row.id, message, now],
        );
        await client.query(
          `INSERT INTO report_delivery_attempts (delivery_id, attempt_number, started_at, finished_at, outcome, error)
           VALUES ($1, $2, $3, $3, 'failed', $4)`,
          [row.id, row.attempt_count + 1, now, message],
        );
        return { id: row.id, skipped: true as const };
      }
      await client.query(
        `UPDATE report_deliveries SET status = 'processing', locked_at = $2, last_attempt_at = $2, attempt_count = attempt_count + 1
          WHERE id = $1`,
        [row.id, now],
      );
      const { recipient_ok: _ok, ...claimed } = row;
      return { ...claimed, attempt_count: row.attempt_count + 1 };
    });
  }

  private content(d: ClaimedDelivery, cache: Map<string, Promise<JobContent>>): Promise<JobContent> {
    let entry = cache.get(d.job_id);
    if (!entry) {
      entry = (async () => {
        const [y, m] = d.period_start.split('-').map(Number) as [number, number];
        const summary = await monthlySummary(this.deps.db, y, m, monthLabel(y, m));
        const rendered = renderMonthlyEmail(summary, this.deps.shopName, summary.generatedAt, d.include_excel);
        const attachments: EmailAttachment[] = [];
        if (d.include_excel) {
          const wb = await buildMonthlyWorkbook(this.deps.db, this.deps.shopName, summary);
          attachments.push({
            filename: `monthly-summary_${d.period_start.slice(0, 7)}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            content: await workbookBuffer(wb),
          });
        }
        return { ...rendered, attachments };
      })();
      cache.set(d.job_id, entry);
    }
    return entry;
  }

  /** Generates (once per job per tick, in memory only), sends and records the outcome. */
  private async deliver(d: ClaimedDelivery, cache: Map<string, Promise<JobContent>>): Promise<string> {
    const started = this.now();
    let outcome: { status: string; attempt: string; provider: string | null; messageId: string | null; error: string | null; retryAt: Date | null };
    try {
      const content = await this.content(d, cache);
      const result = await this.deps.sender.send({
        from: this.deps.from,
        to: d.recipient_email,
        subject: content.subject,
        html: content.html,
        text: content.text,
        attachments: content.attachments,
        idempotencyKey: d.id,
      });
      const status = result.simulated ? 'simulated' : 'sent';
      outcome = { status, attempt: status, provider: result.provider, messageId: result.messageId, error: null, retryAt: null };
    } catch (err) {
      const retryable = err instanceof EmailSendError ? err.retryable : true;
      const message = (err instanceof Error ? err.message : 'Unknown error').slice(0, 1000);
      const canRetry = retryable && d.attempt_count < MAX_ATTEMPTS;
      outcome = {
        status: canRetry ? 'retry_scheduled' : 'failed',
        attempt: canRetry ? 'retryable_failure' : 'failed',
        provider: this.deps.sender.provider,
        messageId: null,
        error: canRetry ? message : d.attempt_count >= MAX_ATTEMPTS && retryable ? `${message} (gave up after ${MAX_ATTEMPTS} attempts)` : message,
        retryAt: canRetry ? new Date(this.now().getTime() + RETRY_DELAYS_MS[d.attempt_count - 1]!) : null,
      };
      if (!(err instanceof EmailSendError)) this.deps.logger?.error({ err, deliveryId: d.id }, 'Monthly report generation failed');
    }
    await withTransaction(this.deps.db, async (client: pg.PoolClient) => {
      const finished = this.now();
      await client.query(
        `UPDATE report_deliveries
            SET status = $2, locked_at = NULL, provider = $3, provider_message_id = $4, last_error = $5,
                sent_at = CASE WHEN $2 IN ('sent', 'simulated') THEN $6::timestamptz ELSE NULL END,
                next_attempt_at = COALESCE($7, next_attempt_at)
          WHERE id = $1 AND status = 'processing'`,
        [d.id, outcome.status, outcome.provider, outcome.messageId, outcome.error, finished, outcome.retryAt],
      );
      await client.query(
        `INSERT INTO report_delivery_attempts (delivery_id, attempt_number, started_at, finished_at, outcome, provider, provider_message_id, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [d.id, d.attempt_count, started, finished, outcome.attempt, outcome.provider, outcome.messageId, outcome.error],
      );
    });
    this.deps.logger?.info({ deliveryId: d.id, status: outcome.status, attempt: d.attempt_count }, 'Monthly report delivery attempt');
    return outcome.status;
  }
}

/**
 * Creates the job for a month (if it does not exist) and one pending delivery per ACTIVE
 * recipient. Returns the new job id, or null when the month already had a job.
 */
export async function createJob(
  client: pg.PoolClient,
  j: { periodStart: string; scheduledFor: Date; trigger: 'schedule' | 'manual'; includeExcel: boolean; createdBy: string | null; now: Date },
): Promise<string | null> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO report_jobs (period_start, period_end, scheduled_for, trigger, include_excel, created_by)
     VALUES ($1::date, ($1::date + interval '1 month - 1 day')::date, $2, $3, $4, $5)
     ON CONFLICT (period_start) DO NOTHING RETURNING id`,
    [j.periodStart, j.scheduledFor, j.trigger, j.includeExcel, j.createdBy],
  );
  const id = inserted.rows[0]?.id ?? null;
  if (id) {
    await client.query(
      `INSERT INTO report_deliveries (job_id, recipient_id, recipient_email, next_attempt_at)
       SELECT $1, id, email, $2 FROM report_recipients WHERE is_active
       ON CONFLICT (job_id, recipient_email) DO NOTHING`,
      [id, j.now],
    );
  }
  return id;
}
