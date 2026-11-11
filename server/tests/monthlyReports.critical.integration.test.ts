/**
 * Essential Stage 5 checks for monthly e-mail reports: owner-only configuration (audited), the
 * PostgreSQL-backed scheduler (due time in Asia/Kolkata, idempotent jobs, no duplicate sends,
 * concurrency, retries, crash recovery, restart) and honest handling of missing e-mail
 * configuration. No real e-mail is sent: a recording sender, the outbox and the "none" adapter.
 */
import ExcelJS from 'exceljs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { DisabledEmailSender, EmailSendError, OutboxEmailSender, RecordingEmailSender, type EmailSender } from '../src/modules/email/email.js';
import { ReportScheduler } from '../src/modules/monthlyReports/scheduler.js';
import { monthRange } from '../src/modules/reports/period.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('monthly e-mail reports (critical paths)', () => {
  const db = pool!;
  const recording = new RecordingEmailSender();
  const app = createApp({ config: testConfig(), db, logger: silentLogger, emailSender: recording });
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let manager: Session;
  const today = todayInReportingZone();
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  // A fixed "now" in the CURRENT month: the 1st at 07:59 and 08:01 Asia/Kolkata (= 02:29/02:31 UTC).
  const first = `${today.slice(0, 7)}-01`;
  const at = (iso: string) => () => new Date(iso);
  const beforeTime = at(`${first}T02:29:00Z`);
  const afterTime = at(`${first}T02:31:00Z`);
  const previousMonth = monthRange(ty, tm - 1).from.slice(0, 7);
  const scheduler = (sender: EmailSender, now: () => Date) =>
    new ReportScheduler({ db, sender, shopName: 'Test Shop', from: 'Test Shop <reports@example.test>', now });

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    return { agent, csrf: res.body.csrfToken };
  }
  const send = (s: Session, method: 'post' | 'put' | 'patch', p: string, body: object) =>
    s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const deliveries = async () =>
    (await db.query(`SELECT d.*, j.period_start::text AS period FROM report_deliveries d JOIN report_jobs j ON j.id = d.job_id ORDER BY recipient_email`)).rows;
  const resetJobs = async () => {
    await db.query('TRUNCATE report_delivery_attempts, report_deliveries, report_jobs');
    recording.sent.length = 0;
    recording.failWith = [];
  };

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner6@example.test', 'Owner', 'owner', $1), ('mgr6@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner6@example.test');
    manager = await signIn('mgr6@example.test');
    // Some data in the previous month so the report has figures.
    const cat = (await send(owner, 'post', '/categories', { name: 'Stock' })).body.category.id;
    await send(manager, 'post', '/expenses', {
      expenseDate: monthRange(ty, tm - 1).to,
      supplierId: null,
      categoryId: cat,
      description: 'Last month bill',
      amount: '1234.50',
      amountPaid: '1234.50',
      paymentMode: 'cash',
      invoiceReference: null,
    });
    const c = (await send(manager, 'post', '/customers', { name: 'Report Customer' })).body.customer.id;
    await send(manager, 'post', `/customers/${c}/dues`, { amount: '5000', txnDate: monthRange(ty, tm - 1).to, categoryId: cat, notes: 'Credit' });
    await send(manager, 'post', `/customers/${c}/advances`, { amount: '2000', txnDate: monthRange(ty, tm - 1).to, paymentMode: 'cash' });
  });

  afterAll(async () => {
    await db.end();
  });

  describe('configuration', () => {
    it('is owner-only, validated, duplicate-safe and audited', async () => {
      for (const p of ['/monthly-reports/settings', '/monthly-reports/recipients', '/monthly-reports/deliveries']) {
        expect((await manager.agent.get(`/api/v1${p}`)).status).toBe(403);
      }
      expect((await send(manager, 'post', '/monthly-reports/recipients', { email: 'x@example.com' })).status).toBe(403);
      expect((await request(app).get('/api/v1/monthly-reports/settings')).status).toBe(401);

      const s = (await owner.agent.get('/api/v1/monthly-reports/settings')).body;
      expect(s.settings).toMatchObject({ enabled: false, deliveryDay: 1, deliveryTime: '08:00', includeExcel: true, nextRunAt: null });
      expect(s.email).toMatchObject({ provider: 'test' });
      expect((await send(owner, 'put', '/monthly-reports/settings', { ...s.settings, deliveryDay: 31, version: s.settings.version })).status).toBe(400);
      expect((await send(owner, 'put', '/monthly-reports/settings', { enabled: true, deliveryDay: 1, deliveryTime: '25:00', includeExcel: true, version: 1 })).status).toBe(400);
      const updated = await send(owner, 'put', '/monthly-reports/settings', { enabled: true, deliveryDay: 1, deliveryTime: '08:00', includeExcel: true, version: s.settings.version });
      expect(updated.status).toBe(200);
      expect(updated.body.settings).toMatchObject({ enabled: true, updatedBy: 'Owner' });
      expect(updated.body.settings.nextRunAt).toBeTruthy();

      expect((await send(owner, 'post', '/monthly-reports/recipients', { email: 'not-an-email' })).status).toBe(400);
      const r1 = await send(owner, 'post', '/monthly-reports/recipients', { email: 'Owner@Example.com', name: 'Owner' });
      expect(r1.status).toBe(201);
      expect(r1.body.recipient.email).toBe('owner@example.com');
      expect((await send(owner, 'post', '/monthly-reports/recipients', { email: 'OWNER@example.com' })).body.error.code).toBe('RECIPIENT_EXISTS');
      expect((await send(owner, 'post', '/monthly-reports/recipients', { email: 'accountant@example.com' })).status).toBe(201);
      const removed = await send(owner, 'post', '/monthly-reports/recipients', { email: 'old@example.com' });
      expect((await send(owner, 'patch', `/monthly-reports/recipients/${removed.body.recipient.id}`, { isActive: false, version: 1 })).status).toBe(200);

      const audit = await db.query(`SELECT entity_type, action FROM financial_audit_events WHERE entity_type LIKE 'report_%' ORDER BY id`);
      expect(audit.rows.map((r) => `${r.entity_type}:${r.action}`)).toEqual([
        'report_settings:update',
        'report_recipient:create',
        'report_recipient:create',
        'report_recipient:create',
        'report_recipient:archive',
      ]);
    });
  });

  describe('scheduler', () => {
    beforeEach(resetJobs);

    it('waits for the delivery time (Asia/Kolkata), then sends the previous month once per active recipient', async () => {
      const early = await scheduler(recording, beforeTime).tick();
      expect(early).toMatchObject({ ran: true, jobCreated: null });
      expect(recording.sent).toHaveLength(0);

      const due = await scheduler(recording, afterTime).tick();
      expect(due.jobCreated).toBeTruthy();
      expect(due.processed.map((p) => p.status)).toEqual(['sent', 'sent']);
      expect(recording.sent.map((m) => m.to).sort()).toEqual(['accountant@example.com', 'owner@example.com']); // not the archived one
      const rows = await deliveries();
      expect(rows.every((d) => d.status === 'sent' && d.period === `${previousMonth}-01` && d.attempt_count === 1)).toBe(true);

      const message = recording.sent[0]!;
      expect(message.subject).toContain('Test Shop');
      expect(message.idempotencyKey).toBe(rows.find((d) => d.recipient_email === message.to)!.id);
      expect(message.html).toContain('₹1,234.50');
      expect(message.html).toContain('Customer dues');
      expect(message.html).toContain('Customer advances');
      expect(message.html).toContain('₹5,000.00');
      expect(message.html).toContain('₹2,000.00');
      expect(message.html).not.toContain('₹3,000.00'); // never netted
      expect(message.text).toContain('recorded transactions');
      expect(message.attachments).toHaveLength(1);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(message.attachments[0]!.content as never);
      expect(wb.worksheets.map((w) => w.name)).toContain('Customer Advance Summary');

      // Running again (or after a restart) never re-sends.
      const again = await scheduler(recording, at(`${first}T05:00:00Z`)).tick();
      expect(again).toMatchObject({ jobCreated: null, processed: [] });
      expect(recording.sent).toHaveLength(2);
    });

    it('concurrent schedulers (several instances) create one job and send each recipient once', async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() => scheduler(recording, afterTime).tick()));
      expect(results.filter((r) => r.jobCreated).length).toBe(1);
      expect(recording.sent).toHaveLength(2);
      expect((await db.query('SELECT count(*)::int AS n FROM report_jobs')).rows[0].n).toBe(1);
    });

    it('retries temporary failures with backoff without re-sending to recipients who already received it', async () => {
      recording.failWith = [new EmailSendError('Provider timeout', true)];
      const first1 = await scheduler(recording, afterTime).tick();
      expect(first1.processed.map((p) => p.status).sort()).toEqual(['retry_scheduled', 'sent']);
      const failed = (await deliveries()).find((d) => d.status === 'retry_scheduled')!;
      expect(failed.last_error).toBe('Provider timeout');
      expect(new Date(failed.next_attempt_at).getTime()).toBe(afterTime().getTime() + 5 * 60_000);

      expect((await scheduler(recording, at(`${first}T02:33:00Z`)).tick()).processed).toEqual([]); // too early
      const later = await scheduler(recording, at(`${first}T02:37:00Z`)).tick();
      expect(later.processed).toEqual([{ id: failed.id, status: 'sent' }]);
      expect(recording.sent.map((m) => m.to).sort()).toEqual(['accountant@example.com', 'owner@example.com']);
      const attempts = (await db.query('SELECT outcome FROM report_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number', [failed.id])).rows;
      expect(attempts.map((a) => a.outcome)).toEqual(['retryable_failure', 'sent']);
      await expect(db.query(`UPDATE report_deliveries SET status = 'pending' WHERE id = $1`, [failed.id])).rejects.toThrow(/cannot change state/);
      await expect(db.query(`DELETE FROM report_delivery_attempts`)).rejects.toThrow(/append-only/);
    });

    it('permanent failures stop; the owner can retry them; uncertain (interrupted) sends are not re-sent automatically', async () => {
      recording.failWith = [new EmailSendError('Mailbox does not exist', false)];
      await scheduler(recording, afterTime).tick();
      const failed = (await deliveries()).find((d) => d.status === 'failed')!;
      expect(failed.last_error).toBe('Mailbox does not exist');
      expect((await scheduler(recording, at(`${first}T09:00:00Z`)).tick()).processed).toEqual([]);

      expect((await send(manager, 'post', `/monthly-reports/deliveries/${failed.id}/retry`, {})).status).toBe(403);
      const retried = await send(owner, 'post', `/monthly-reports/deliveries/${failed.id}/retry`, {});
      expect(retried.body.delivery.status).toBe('retry_scheduled');
      // The retry makes the delivery due at the DATABASE's now() (microseconds); the scheduler compares
      // with its own clock. Node's clock read right afterwards can still be at or before that instant
      // (measured: up to 1.3 ms behind PostgreSQL's here, plus millisecond truncation), which made an
      // immediate tick with new Date() find nothing due now and then. Tick one second after the due time.
      const dueAt = new Date((await deliveries()).find((d) => d.id === failed.id)!.next_attempt_at).getTime();
      await scheduler(recording, () => new Date(dueAt + 1000)).tick();
      expect((await deliveries()).find((d) => d.id === failed.id)!.status).toBe('sent');
      const sentOne = (await deliveries()).find((d) => d.id !== failed.id)!;
      expect((await send(owner, 'post', `/monthly-reports/deliveries/${sentOne.id}/retry`, {})).body.error.code).toBe('DELIVERY_NOT_FAILED');

      // Crash simulation: a delivery stuck in "processing" for 20 minutes.
      await resetJobs();
      recording.failWith = [];
      await db.query(`UPDATE report_settings SET enabled = false`);
      const job = await send(owner, 'post', '/monthly-reports/jobs', { year: Number(previousMonth.slice(0, 4)), month: Number(previousMonth.slice(5)) });
      expect(job.status).toBe(201);
      expect((await send(owner, 'post', '/monthly-reports/jobs', { year: Number(previousMonth.slice(0, 4)), month: Number(previousMonth.slice(5)) })).body.error.code).toBe('JOB_EXISTS');
      const stuck = (await deliveries())[0]!;
      await db.query(`UPDATE report_deliveries SET status = 'processing', locked_at = now() - interval '20 minutes', attempt_count = 1 WHERE id = $1`, [stuck.id]);
      const recovered = await scheduler(recording, () => new Date()).tick();
      expect(recovered.recovered).toBe(1);
      const after = (await deliveries()).find((d) => d.id === stuck.id)!;
      expect(after.status).toBe('failed');
      expect(after.last_error).toMatch(/may or may not have been delivered/);
      expect(recording.sent.map((m) => m.to)).not.toContain(stuck.recipient_email);
      await db.query(`UPDATE report_settings SET enabled = true`);
    });

    it('is honest without a real provider: "none" fails clearly, the outbox is "simulated" (never "sent")', async () => {
      await scheduler(new DisabledEmailSender(), afterTime).tick();
      const none = await deliveries();
      expect(none.every((d) => d.status === 'failed' && /not configured/.test(d.last_error) && d.sent_at === null)).toBe(true);

      await resetJobs();
      const dir = await mkdtemp(path.join(tmpdir(), 'sb-outbox-'));
      try {
        await scheduler(new OutboxEmailSender(dir), afterTime).tick();
        const rows = await deliveries();
        expect(rows.every((d) => d.status === 'simulated' && d.provider === 'outbox')).toBe(true);
        const folders = await readdir(dir);
        expect(folders).toHaveLength(2);
        const meta = JSON.parse(await readFile(path.join(dir, folders[0]!, 'message.json'), 'utf8'));
        expect(meta.note).toContain('NOT sent');
        const list = (await owner.agent.get(`/api/v1/monthly-reports/deliveries?period=${previousMonth}`)).body.items;
        expect(list.map((d: { status: string }) => d.status)).toEqual(['simulated', 'simulated']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('never sends to a recipient removed (or re-addressed) after the month was queued', async () => {
      const [y, m] = previousMonth.split('-').map(Number) as [number, number];
      expect((await send(owner, 'post', '/monthly-reports/jobs', { year: y, month: m })).status).toBe(201);
      const recipients = (await owner.agent.get('/api/v1/monthly-reports/recipients')).body.recipients as { id: string; email: string; version: number; isActive: boolean }[];
      const accountant = recipients.find((r) => r.email === 'accountant@example.com')!;
      const ownerR = recipients.find((r) => r.email === 'owner@example.com')!;
      await send(owner, 'patch', `/monthly-reports/recipients/${accountant.id}`, { isActive: false, version: accountant.version });
      await send(owner, 'patch', `/monthly-reports/recipients/${ownerR.id}`, { email: 'new-owner@example.com', version: ownerR.version });
      const tick = await scheduler(recording, () => new Date()).tick();
      expect(tick.processed.map((p) => p.status)).toEqual(['failed', 'failed']);
      expect(recording.sent).toHaveLength(0);
      const rows = await deliveries();
      expect(rows.every((d) => /removed or their address changed/.test(d.last_error))).toBe(true);
      expect((await send(owner, 'post', `/monthly-reports/deliveries/${rows[0].id}/retry`, {})).body.error.code).toBe('RECIPIENT_REMOVED');
      // Restore the recipients for any later test.
      const now = (await owner.agent.get('/api/v1/monthly-reports/recipients')).body.recipients as { id: string; version: number }[];
      await send(owner, 'patch', `/monthly-reports/recipients/${accountant.id}`, { isActive: true, version: now.find((r) => r.id === accountant.id)!.version });
      await send(owner, 'patch', `/monthly-reports/recipients/${ownerR.id}`, { email: 'owner@example.com', version: now.find((r) => r.id === ownerR.id)!.version });
    });

    it('preview renders the same e-mail for the owner', async () => {
      const p = (await owner.agent.get(`/api/v1/monthly-reports/preview?year=${previousMonth.slice(0, 4)}&month=${Number(previousMonth.slice(5))}`)).body.preview;
      expect(p.subject).toContain('monthly financial summary');
      expect(p.html).toContain('₹1,234.50');
    });
  });
});
