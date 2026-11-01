/**
 * Essential Stage 3B checks (bill documents and private storage) against a real PostgreSQL test
 * database and a temporary storage directory. Compact by design; see docs/testing-plan.md.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { uploadDocument } from '../src/modules/documents/documents.service.js';
import { detectDocumentType, sanitiseFileName } from '../src/modules/documents/documents.validation.js';
import { LocalDocumentStorage } from '../src/modules/documents/localStorage.js';
import { reconcileDocuments } from '../src/modules/documents/reconcile.js';
import { newStorageKey } from '../src/modules/documents/storage.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();

// Minimal but structurally valid files; `nonce` makes each one unique.
const png = (nonce = randomBytes(8)) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(17),
    nonce,
  ]);
const jpeg = (nonce = randomBytes(8)) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), nonce, Buffer.from([0xff, 0xd9])]);
const pdf = (nonce = randomBytes(8)) => Buffer.from(`%PDF-1.4\n% ${nonce.toString('hex')}\ntrailer\n%%EOF\n`);
const webp = (nonce = randomBytes(8)) => {
  const body = Buffer.concat([Buffer.from('WEBPVP8 '), Buffer.alloc(12), nonce]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe('document validation (unit)', () => {
  it('detects real types from content and rejects malformed or disguised files', () => {
    expect(detectDocumentType(png())).toBe('image/png');
    expect(detectDocumentType(jpeg())).toBe('image/jpeg');
    expect(detectDocumentType(pdf())).toBe('application/pdf');
    expect(detectDocumentType(webp())).toBe('image/webp');
    expect(detectDocumentType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(detectDocumentType(Buffer.from('%PDF-1.4 truncated'))).toBeNull();
    expect(detectDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBeNull();
  });

  it('turns any supplied name into a safe display name', () => {
    expect(sanitiseFileName('..%2F..%2Fetc%2Fpasswd.png')).toBe('passwd.png');
    expect(sanitiseFileName('C:\\Users\\me\\bill\u0000 1.jpg')).toBe('bill 1.jpg');
    expect(sanitiseFileName(`${'a'.repeat(300)}.pdf`)).toHaveLength(255);
    expect(sanitiseFileName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf')).toBe(true);
  });
});

describe.skipIf(!pool)('bill documents (critical paths)', () => {
  const db = pool!;
  let dir: string;
  let storage: LocalDocumentStorage;
  let app: ReturnType<typeof createApp>;
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string; userId: string };
  let owner: Session;
  let manager: Session;
  let categoryId: string;

  async function signIn(email: string): Promise<Session> {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken, userId: res.body.user.id };
  }
  const send = (s: Session, p: string, body: object) =>
    s.agent.post(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const upload = (s: Session, expenseId: string, data: Buffer, name: string, extra: Record<string, string> = {}) =>
    s.agent
      .post(`/api/v1/expenses/${expenseId}/documents`)
      .set({
        Origin: BROWSER_HEADERS.Origin,
        'X-CSRF-Token': s.csrf,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name),
        ...extra,
      })
      .send(data);
  const newExpense = async (s: Session) =>
    (
      await send(s, '/expenses', {
        expenseDate: todayInReportingZone(),
        supplierId: null,
        categoryId,
        description: 'Bill test',
        amount: '100',
        amountPaid: '0',
        paymentMode: null,
        invoiceReference: null,
      })
    ).body.expense as { id: string; version: number };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-docs-'));
    storage = new LocalDocumentStorage(dir);
    app = createApp({ config: testConfig(), db, logger: silentLogger, storage });
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('owner3b@example.test', 'Owner', 'owner', $1), ('mgr3b@example.test', 'Manager', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('owner3b@example.test');
    manager = await signIn('mgr3b@example.test');
    categoryId = (await send(owner, '/categories', { name: 'Bills' })).body.category.id;
  });

  afterAll(async () => {
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('an expense works without documents; uploads require a session, CSRF and the binary route', async () => {
    const e = await newExpense(manager);
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}`)).body.expense.documentCount).toBe(0);
    expect((await request(app).get(`/api/v1/expenses/${e.id}/documents`)).status).toBe(401);
    const noCsrf = await manager.agent
      .post(`/api/v1/expenses/${e.id}/documents`)
      .set({ Origin: BROWSER_HEADERS.Origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.png' })
      .send(png());
    expect(noCsrf.status).toBe(403);
    // octet-stream is accepted ONLY on the upload route.
    const elsewhere = await manager.agent
      .post('/api/v1/expenses')
      .set({ Origin: BROWSER_HEADERS.Origin, 'X-CSRF-Token': manager.csrf, 'Content-Type': 'application/octet-stream' })
      .send(png());
    expect(elsewhere.status).toBe(415);
  });

  it('uploads each allowed type, stores metadata (never the key) and streams privately', async () => {
    const e = await newExpense(manager);
    const files: [Buffer, string, string][] = [
      [png(), 'bill.png', 'image/png'],
      [jpeg(), 'photo.JPG', 'image/jpeg'],
      [webp(), 'scan.webp', 'image/webp'],
      [pdf(), 'Invoice №12.pdf', 'application/pdf'],
    ];
    for (const [data, name, mime] of files) {
      const res = await upload(manager, e.id, data, name);
      expect(res.status, name).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.document).toMatchObject({ fileName: name, mimeType: mime, sizeBytes: data.length, status: 'active' });
      expect(JSON.stringify(res.body)).not.toContain('storage');
    }
    const list = await manager.agent.get(`/api/v1/expenses/${e.id}/documents`);
    expect(list.body.documents).toHaveLength(4);
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}`)).body.expense.documentCount).toBe(4);

    const doc = list.body.documents[3];
    const content = await owner.agent.get(`/api/v1/expenses/${e.id}/documents/${doc.id}/content?download=1`).buffer(true);
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['cache-control']).toContain('no-store');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Invoice №12.pdf')}`);
    expect(content.headers['content-disposition']).toMatch(/^attachment/);
    expect(Buffer.from(content.body).equals(files[3]![0])).toBe(true);
  });

  it('rejects disguised, malformed, empty, oversized and mismatched files', async () => {
    const e = await newExpense(manager);
    const cases: [Buffer, string, Record<string, string>, number, string][] = [
      [Buffer.from('<script>alert(1)</script>'), 'evil.png', {}, 400, 'DOCUMENT_INVALID'],
      [png(), 'run.exe', {}, 400, 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [png(), 'noextension', {}, 400, 'DOCUMENT_TYPE_NOT_ALLOWED'],
      [png(), 'looks-like.jpg', {}, 400, 'DOCUMENT_TYPE_MISMATCH'],
      [png(), 'ok.png', { 'X-File-Type': 'application/pdf' }, 400, 'DOCUMENT_TYPE_MISMATCH'],
      [Buffer.alloc(0), 'empty.png', {}, 400, 'DOCUMENT_EMPTY'],
      [Buffer.concat([png(), Buffer.alloc(10 * 1024 * 1024)]), 'big.png', {}, 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [data, name, headers, status, code] of cases) {
      const res = await upload(manager, e.id, data, name, headers);
      expect(res.status, name).toBe(status);
      expect(res.body.error.code, name).toBe(code);
    }
    // Exactly 10 MB is allowed.
    const tenMb = Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024 - pdf().length - 6), Buffer.from('%%EOF\n')]);
    expect(tenMb.length).toBe(10 * 1024 * 1024);
    expect((await upload(manager, e.id, tenMb, 'max.pdf')).status).toBe(201);
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}/documents`)).body.documents).toHaveLength(1);
  });

  it('returns the existing document for an identical re-upload and enforces 10 per expense, also concurrently', async () => {
    const e = await newExpense(manager);
    const same = png();
    expect((await upload(manager, e.id, same, 'a.png')).status).toBe(201);
    const again = await upload(manager, e.id, same, 'a-again.png');
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => upload(manager, e.id, png(), `p${i}.png`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(9);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'DOCUMENT_LIMIT_REACHED')).toBe(true);
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}/documents`)).body.documents).toHaveLength(10);
  });

  it('never serves a document through another expense id (no IDOR)', async () => {
    const a = await newExpense(manager);
    const b = await newExpense(manager);
    const doc = (await upload(manager, a.id, png(), 'a.png')).body.document;
    for (const p of [`/expenses/${b.id}/documents/${doc.id}`, `/expenses/${b.id}/documents/${doc.id}/content`]) {
      expect((await owner.agent.get(`/api/v1${p}`)).status).toBe(404);
    }
    expect((await send(owner, `/expenses/${b.id}/documents/${doc.id}/remove`, { reason: 'x' })).status).toBe(404);
    expect((await owner.agent.get(`/api/v1/expenses/${a.id}/documents/not-a-uuid/content`)).status).toBe(404);
  });

  it('removal needs a reason, keeps the file and history; removed files are owner-only', async () => {
    const e = await newExpense(manager);
    const doc = (await upload(manager, e.id, png(), 'wrong.png')).body.document;
    expect((await send(manager, `/expenses/${e.id}/documents/${doc.id}/remove`, { reason: ' ' })).status).toBe(400);
    const removed = await send(manager, `/expenses/${e.id}/documents/${doc.id}/remove`, { reason: 'Wrong bill' });
    expect(removed.body.document).toMatchObject({ status: 'removed', removeReason: 'Wrong bill', removedBy: { name: 'Manager' } });
    expect((await send(manager, `/expenses/${e.id}/documents/${doc.id}/remove`, { reason: 'again' })).status).toBe(409);

    expect((await manager.agent.get(`/api/v1/expenses/${e.id}/documents`)).body.documents).toHaveLength(0);
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}/documents?status=all`)).body.documents).toHaveLength(1);
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}/documents/${doc.id}/content`)).status).toBe(403);
    expect((await owner.agent.get(`/api/v1/expenses/${e.id}/documents/${doc.id}/content`)).status).toBe(200);

    const history = (await manager.agent.get(`/api/v1/expenses/${e.id}/history`)).body.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(['document_remove', 'document_add', 'create']);
    expect(history[0]).toMatchObject({ reason: 'Wrong bill', after: { fileName: 'wrong.png', attached: false } });
    await expect(db.query('DELETE FROM expense_documents WHERE id = $1', [doc.id])).rejects.toThrow(/never deleted/);
  });

  it('voided expenses accept no uploads or removals until restored', async () => {
    const e = await newExpense(manager);
    const doc = (await upload(manager, e.id, png(), 'keep.png')).body.document;
    await send(owner, `/expenses/${e.id}/void`, { reason: 'Duplicate', version: e.version });
    expect((await upload(manager, e.id, png(), 'late.png')).body.error.code).toBe('EXPENSE_VOIDED');
    expect((await send(manager, `/expenses/${e.id}/documents/${doc.id}/remove`, { reason: 'x' })).body.error.code).toBe(
      'EXPENSE_VOIDED',
    );
    expect((await manager.agent.get(`/api/v1/expenses/${e.id}/documents/${doc.id}/content`)).status).toBe(200);
  });

  it('a failed database write leaves no stored file; reconciliation finds orphans and missing files', async () => {
    const e = await newExpense(manager);
    const before = (await reconcileDocuments(db, storage)).storedObjects;
    // A revoked/unknown session makes the metadata transaction fail AFTER the file was stored.
    await expect(
      uploadDocument(
        db,
        storage,
        e.id,
        { data: png(), fileName: 'x.png', mimeType: 'image/png', sizeBytes: png().length },
        { userId: manager.userId, sessionId: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 401 });
    const after = await reconcileDocuments(db, storage);
    expect(after.storedObjects).toBe(before);
    expect(after.orphanFiles).toHaveLength(0);
    expect(after.missingFiles).toHaveLength(0);

    // Simulate a crash after storing (orphan) and a lost file (missing).
    await storage.put(newStorageKey(), png(), 'image/png');
    const doc = (await upload(manager, e.id, png(), 'lost.png')).body.document;
    const key = (await db.query('SELECT storage_key FROM expense_documents WHERE id = $1', [doc.id])).rows[0].storage_key as string;
    await unlink(path.join(dir, ...key.split('/')));
    const report = await reconcileDocuments(db, storage, true);
    expect(report.orphanFiles).toHaveLength(1);
    expect(report.missingFiles.map((m) => m.documentId)).toEqual([doc.id]);
    expect(report.checksumMismatches).toHaveLength(0);
    expect((await owner.agent.get(`/api/v1/expenses/${e.id}/documents/${doc.id}/content`)).body.error.code).toBe(
      'DOCUMENT_UNAVAILABLE',
    );
    // Nothing in storage is named after user input.
    const top = await readdir(dir);
    expect(top.every((n) => /^[a-f0-9]{2}$/.test(n))).toBe(true);
  });
});
