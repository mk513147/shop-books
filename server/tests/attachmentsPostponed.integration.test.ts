/**
 * Bill attachments postponed (DOCUMENT_STORAGE_DRIVER=disabled), against the PostgreSQL test database.
 *
 * Existing document records are created first with working storage (one file on "the PC", one parked
 * in document_upload_queue while storage was offline). Then the API runs with storage DISABLED and
 * must: refuse new uploads without storing anything anywhere (also not in PostgreSQL), keep every
 * existing record listed, still serve the bytes it holds itself, explain (not crash) for files it
 * cannot reach, delete nothing, and run every other business workflow normally.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import type { Actor } from '../src/middleware/auth.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { DisabledDocumentStorage } from '../src/modules/documents/disabledStorage.js';
import { uploadDocument } from '../src/modules/documents/documents.service.js';
import { LocalDocumentStorage } from '../src/modules/documents/localStorage.js';
import { StorageUnavailable } from '../src/modules/documents/storage.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\ntrailer\n%%EOF\n`);

/** The desktop storage while it is unreachable: uploads are parked in document_upload_queue. */
class OfflineStorage extends LocalDocumentStorage {
  override put(): Promise<void> {
    return Promise.reject(new StorageUnavailable());
  }
}

describe.skipIf(!pool)('bill attachments postponed (storage disabled)', () => {
  const db = pool!;
  const today = todayInReportingZone();
  let dir: string;
  type App = ReturnType<typeof createApp>;
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let disabledApp: App;
  let owner: Session;
  let manager: Session;
  let expenseId: string;
  let storedDocId: string;
  let queuedDocId: string;
  const queuedBytes = pdf('queued while the PC was offline');

  async function signIn(app: App, email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken };
  }
  const call = async (s: Session, method: 'post' | 'patch', p: string, body: object, headers: Record<string, string> = {}) => {
    const res = await s.agent[method](`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf, ...headers }).send(body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body;
  };
  const get = async (s: Session, p: string) => {
    const res = await s.agent.get(`/api/v1${p}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const upload = (s: Session, id: string, data: Buffer, headers: Record<string, string> = {}) =>
    s.agent
      .post(`/api/v1/expenses/${id}/documents`)
      .set({ Origin: BROWSER_HEADERS.Origin, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'bill.pdf', ...headers })
      .send(data);
  const binary = (s: Session, p: string) =>
    s.agent.get(`/api/v1${p}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  /** Everything document-related in the database, for "nothing was changed or deleted" checks. */
  const documentState = async () => ({
    documents: (await db.query('SELECT id, expense_id, storage_key, sha256, status FROM expense_documents ORDER BY id')).rows,
    queue: (await db.query<{ document_id: string; sha: string }>(`SELECT document_id, encode(sha256(content), 'hex') AS sha FROM document_upload_queue ORDER BY document_id`)).rows,
    audit: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financial_audit_events WHERE action IN ('document_add', 'document_remove')`)).rows[0]!.n,
  });

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('ap-owner@example.test', 'Owner', 'owner', $1), ('ap-mgr@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );

    // 1. Before the postponement: documents uploaded with working (and with offline) storage.
    dir = await mkdtemp(path.join(tmpdir(), 'sb-postponed-'));
    const workingApp = createApp({ config: testConfig(), db, logger: silentLogger, storage: new LocalDocumentStorage(dir) });
    const offlineApp = createApp({ config: testConfig(), db, logger: silentLogger, storage: new OfflineStorage(dir) });
    const before = await signIn(workingApp, 'ap-mgr@example.test');
    const categoryId = (await call(before, 'post', '/categories', { name: `Bills ${Date.now()}` })).category.id as string;
    expenseId = (
      await call(before, 'post', '/expenses', { expenseDate: today, categoryIds: [categoryId], amount: '1200', payments: [{ amount: '1200', paymentMode: 'cash' }] })
    ).expense.id;
    const stored = await upload(before, expenseId, pdf('stored on the PC'));
    expect(stored.status).toBe(201);
    storedDocId = stored.body.document.id;
    const queued = await upload(await signIn(offlineApp, 'ap-mgr@example.test'), expenseId, queuedBytes);
    expect(queued.status).toBe(201);
    expect(queued.body.stored).toBe('queued');
    queuedDocId = queued.body.document.id;

    // 2. The released API: storage disabled, built from configuration exactly like server.ts does.
    disabledApp = createApp({ config: testConfig({ documentStorage: { driver: 'disabled' } }), db, logger: silentLogger });
    owner = await signIn(disabledApp, 'ap-owner@example.test');
    manager = await signIn(disabledApp, 'ap-mgr@example.test');
  });

  afterAll(async () => {
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports storage as disabled and refuses uploads without storing anything (not even in PostgreSQL)', async () => {
    expect(await get(manager, '/document-storage/status')).toEqual({ available: false, driver: 'disabled' });
    const stateBefore = await documentState();
    const variants: Record<string, string>[] = [{}, { 'X-Storage-Mode': 'permanent' }, { 'X-Storage-Mode': 'default' }];
    for (const headers of variants) {
      const res = await upload(manager, expenseId, pdf(`new ${JSON.stringify(headers)}`), headers);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('BILL_ATTACHMENTS_DISABLED');
    }
    // The service refuses too (defence in depth): the "storage offline" path would park bytes in PostgreSQL.
    const data = pdf('service call');
    await expect(
      uploadDocument(db, new DisabledDocumentStorage(), expenseId, { fileName: 'b.pdf', mimeType: 'application/pdf', sizeBytes: data.length, data }, {
        userId: '00000000-0000-4000-8000-000000000000',
        sessionId: 'unused',
      } as unknown as Actor),
    ).rejects.toMatchObject({ status: 503, code: 'BILL_ATTACHMENTS_DISABLED' });
    expect(await documentState()).toEqual(stateBefore);
  });

  it('keeps existing document records accessible: listed, counted, exported; held bytes still served', async () => {
    const docs = (await get(manager, `/expenses/${expenseId}/documents`)).documents as { id: string; pendingDelivery: boolean }[];
    expect(docs.map((d) => [d.id, d.pendingDelivery]).sort()).toEqual([[queuedDocId, true], [storedDocId, false]].sort());
    expect((await get(manager, `/expenses/${expenseId}`)).expense.documentCount).toBe(2);
    expect((await get(owner, `/expenses/${expenseId}/history`)).history.filter((h: { action: string }) => h.action === 'document_add')).toHaveLength(2);

    // Bytes the API holds itself (upload queue): still downloadable, byte-exact.
    const held = await binary(manager, `/expenses/${expenseId}/documents/${queuedDocId}/content`);
    expect(held.status).toBe(200);
    expect(createHash('sha256').update(held.body as Buffer).digest('hex')).toBe(createHash('sha256').update(queuedBytes).digest('hex'));
    // A file that lives in the (unreachable) document storage: an honest 503, not a crash.
    const away = await manager.agent.get(`/api/v1/expenses/${expenseId}/documents/${storedDocId}/content`);
    expect(away.status).toBe(503);
    expect(away.body.error.code).toBe('BILL_ATTACHMENTS_DISABLED');
  });

  it('runs expense, brand, supplier, customer, report and export workflows normally', async () => {
    const stateBefore = await documentState();
    const brand = (await call(manager, 'post', '/brands', { name: `Postponed Brand ${Date.now()}` })).brand.id as string;
    const category = (await call(manager, 'post', '/categories', { name: `Postponed Cat ${Date.now()}` })).category.id as string;
    const supplier = (await call(manager, 'post', '/suppliers', { name: `Postponed Supplier ${Date.now()}`, brandIds: [brand], categoryIds: [category] })).supplier;
    expect(supplier.brands.map((b: { id: string }) => b.id)).toEqual([brand]);

    const created = (
      await call(manager, 'post', '/expenses', {
        expenseDate: today,
        supplierId: supplier.id,
        categoryIds: [category],
        brandIds: [brand],
        amount: '900',
        payments: [
          { amount: '500', paymentMode: 'cash' },
          { amount: '400', paymentMode: 'upi' },
        ],
      })
    ).expense;
    expect(created).toMatchObject({ amount: '900.00', amountPaid: '900.00', documentCount: 0 });
    const edited = (
      await call(manager, 'patch', `/expenses/${created.id}`, {
        expenseDate: today,
        supplierId: supplier.id,
        categoryIds: [category],
        brandIds: [brand],
        description: 'Edited while attachments are postponed',
        amount: '950',
        payments: [{ amount: '950', paymentMode: 'upi' }],
        version: created.version,
      })
    ).expense;
    expect(edited).toMatchObject({ amount: '950.00', description: 'Edited while attachments are postponed', documentCount: 0 });

    const customer = (await call(manager, 'post', '/customers', { name: `Postponed Customer ${Date.now()}` })).customer.id as string;
    await call(manager, 'post', `/customers/${customer}/dues`, { amount: '300', txnDate: today, categoryId: category });
    const settled = await call(
      manager,
      'post',
      `/customers/${customer}/due-payments/settle-all`,
      { amount: '300', txnDate: today, paymentMode: 'upi' },
      { 'Idempotency-Key': `postponed-settle-${Date.now()}`.padEnd(20, 'x') },
    );
    expect(settled.settlement.amount).toBe('300.00');
    expect((await get(owner, `/customers/${customer}`)).customer.dueBalance).toBe('0.00');

    expect((await get(owner, '/reports/dashboard?period=this_month')).dashboard).toBeTruthy();
    const report = await get(owner, `/reports/expenses?period=this_month&categoryId=${category}`);
    expect(report.totals).toBeTruthy();

    const xlsx = await binary(owner, '/exports/expenses');
    expect(xlsx.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    const headers = (wb.worksheets[0]!.getRow(1).values as unknown[]).filter(Boolean);
    expect(headers.length).toBeGreaterThan(0);

    // None of this touched any document data.
    expect(await documentState()).toEqual(stateBefore);
  });

  it('deletes nothing: records, queued bytes and the stored file are all still there', async () => {
    const state = await documentState();
    expect(state.documents.map((d: { id: string }) => d.id).sort()).toEqual([queuedDocId, storedDocId].sort());
    expect(state.queue).toEqual([{ document_id: queuedDocId, sha: createHash('sha256').update(queuedBytes).digest('hex') }]);
    expect(state.audit).toBe(2);
    // The file stored before the postponement is untouched in its storage location.
    const walk = async (d: string): Promise<string[]> =>
      (await readdir(d, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [e.name])).concat(
        ...(await Promise.all((await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => walk(path.join(d, e.name))))),
      );
    expect(await walk(dir)).toHaveLength(1);
  });
});
