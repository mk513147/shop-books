/**
 * Offline-first attachment queue, server side: the "permanent" upload mode used by the browser's
 * IndexedDB queue (store on the PC, verify there, never park in PostgreSQL), client attachment ids
 * (idempotent retries), the checksum header, the storage-status endpoint, the agent digest route,
 * and who may see documents that are not yet on the PC.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { AgentDocumentStorage } from '../src/modules/documents/agentStorage.js';
import { deliverQueuedDocuments } from '../src/modules/documents/documentQueue.js';
import { createDocumentStorageStatusRouter } from '../src/modules/documents/documents.routes.js';
import { LocalDocumentStorage } from '../src/modules/documents/localStorage.js';
import { newStorageKey, StorageObjectMissing, type DocumentStorage } from '../src/modules/documents/storage.js';
import { createStorageAgent } from '../src/storageAgent/agentServer.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const SECRET = randomBytes(32).toString('hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const png = (nonce = randomBytes(8)) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17), nonce]);

/** A storage agent that can be stopped and restarted on the same port and folder. */
class TestAgent {
  server: Server | null = null;
  port = 0;
  requests: { method: string; path: string; status: number }[] = [];
  constructor(
    readonly dir: string,
    /** Simulates an agent from before the digest route existed. */
    readonly withoutDigests = false,
  ) {}
  async start(): Promise<void> {
    const inner = createStorageAgent({
      storage: new LocalDocumentStorage(this.dir),
      secret: SECRET,
      log: (e) => this.requests.push({ method: e.method, path: e.path, status: e.status }),
    });
    this.server = this.withoutDigests
      ? createServer((req, res) => {
          if ((req.url ?? '').startsWith('/v1/digests/')) {
            res.statusCode = 404;
            res.end('{"error":"not found"}');
            return;
          }
          inner.emit('request', req, res);
        })
      : inner;
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

describe('agent digest route and availability (no database)', () => {
  let dir: string;
  let agent: TestAgent;
  let legacy: TestAgent;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-digest-'));
    agent = new TestAgent(dir);
    legacy = new TestAgent(dir, true);
    await agent.start();
    await legacy.start();
  });
  afterAll(async () => {
    await agent.stop();
    await legacy.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('the agent hashes a stored object on the PC; a missing object is reported as missing', async () => {
    const storage = new AgentDocumentStorage(agent.url, SECRET);
    const key = newStorageKey();
    const data = png();
    await storage.put(key, data, 'image/png');
    expect(await storage.digest(key)).toEqual({ sizeBytes: data.length, sha256Hex: sha(data) });
    expect(agent.requests.some((r) => r.path.startsWith('/v1/digests/') && r.status === 200)).toBe(true);
    await expect(storage.digest(newStorageKey())).rejects.toBeInstanceOf(StorageObjectMissing);
  });

  it('an older agent without the digest route still verifies (download + hash in the API)', async () => {
    const storage = new AgentDocumentStorage(legacy.url, SECRET);
    const key = newStorageKey();
    const data = png();
    await storage.put(key, data, 'image/png');
    expect(await storage.digest(key)).toEqual({ sizeBytes: data.length, sha256Hex: sha(data) });
    await expect(storage.digest(newStorageKey())).rejects.toBeInstanceOf(StorageObjectMissing);
  });

  it('isAvailable follows the agent', async () => {
    expect(await new AgentDocumentStorage(agent.url, SECRET).isAvailable()).toBe(true);
    expect(await new AgentDocumentStorage('http://127.0.0.1:1', SECRET).isAvailable()).toBe(false);
    expect(await new LocalDocumentStorage(dir).isAvailable()).toBe(true);
  });

  it('the status router answers and caches briefly', async () => {
    let calls = 0;
    const fake = { driver: 'agent', isAvailable: async () => (++calls, true) } as unknown as DocumentStorage;
    const app = express().use(createDocumentStorageStatusRouter({ storage: fake, cacheMs: 60_000 }));
    expect((await request(app).get('/status')).body).toEqual({ available: true, driver: 'agent' });
    await request(app).get('/status');
    expect(calls).toBe(1);
    const uncached = express().use(createDocumentStorageStatusRouter({ storage: fake, cacheMs: -1 }));
    await request(uncached).get('/status');
    await request(uncached).get('/status');
    expect(calls).toBe(3);
  });
});

const pool = await connectTestDatabase();

describe.skipIf(!pool)('permanent uploads from the offline attachment queue', () => {
  const db = pool!;
  let dir: string;
  let agent: TestAgent;
  let storage: AgentDocumentStorage;
  let app: ReturnType<typeof createApp>;
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let managerA: Session;
  let managerB: Session;
  let categoryId: string;

  async function signIn(email: string): Promise<Session> {
    const a = request.agent(app);
    const res = await a.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email, password: 'test-password-123' });
    expect(res.status).toBe(200);
    return { agent: a, csrf: res.body.csrfToken };
  }
  const send = (s: Session, p: string, body: object) => s.agent.post(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const upload = (s: Session, expenseId: string, data: Buffer, name: string, headers: Record<string, string> = {}) =>
    s.agent
      .post(`/api/v1/expenses/${expenseId}/documents`)
      .set({
        Origin: BROWSER_HEADERS.Origin,
        'X-CSRF-Token': s.csrf,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': name,
        ...headers,
      })
      .send(data);
  const permanent = (s: Session, expenseId: string, data: Buffer, id = randomUUID(), extra: Record<string, string> = {}) =>
    upload(s, expenseId, data, 'bill.png', { 'X-Storage-Mode': 'permanent', 'X-Attachment-Id': id, 'X-Content-SHA256': sha(data), ...extra });
  const newExpense = async () =>
    (
      await send(managerA, '/expenses', {
        expenseDate: todayInReportingZone(),
        supplierId: null,
        categoryId,
        description: 'Attachment queue test',
        amount: '100',
        payments: [{ paymentMode: 'cash', amount: '100' }],
        invoiceReference: null,
      })
    ).body.expense as { id: string };
  const docRows = async (expenseId: string) =>
    (await db.query<{ id: string }>('SELECT id FROM expense_documents WHERE expense_id = $1', [expenseId])).rows;
  const queueCount = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_upload_queue')).rows[0]!.n;
  const list = async (s: Session, expenseId: string) => (await s.agent.get(`/api/v1/expenses/${expenseId}/documents`)).body.documents as { id: string }[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-attach-'));
    agent = new TestAgent(dir);
    await agent.start();
    storage = new AgentDocumentStorage(agent.url, SECRET);
    app = createApp({ config: testConfig(), db, logger: silentLogger, storage });
    await runMigrations(db);
    await db.query('DELETE FROM document_upload_queue');
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    const hash = await hashPassword('test-password-123');
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES
         ('aq-owner@example.test', 'Owner', 'owner', $1),
         ('aq-a@example.test', 'Manager A', 'manager', $1),
         ('aq-b@example.test', 'Manager B', 'manager', $1)`,
      [hash],
    );
    owner = await signIn('aq-owner@example.test');
    managerA = await signIn('aq-a@example.test');
    managerB = await signIn('aq-b@example.test');
    categoryId = (await send(owner, '/categories', { name: 'Attachment bills' })).body.category.id;
  });

  afterAll(async () => {
    await agent.stop();
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('storage status: signed-in users only; reports the PC as reachable', async () => {
    expect((await request(app).get('/api/v1/document-storage/status')).status).toBe(401);
    const res = await managerA.agent.get('/api/v1/document-storage/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, driver: 'agent' });
  });

  it('PC online: stored on the PC, verified there, recorded under the attachment id, and shared with other managers', async () => {
    const expense = await newExpense();
    const data = png();
    const id = randomUUID();
    agent.requests = [];
    const res = await permanent(managerA, expense.id, data, id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, stored: 'permanent' });
    expect(res.body.document).toMatchObject({ id, sha256: sha(data), pendingDelivery: false });
    // Stored, then re-read and hashed on the PC before the row was written.
    expect(agent.requests.map((r) => r.method + ' ' + r.path.split('/').slice(0, 3).join('/'))).toEqual(['PUT /v1/objects', 'GET /v1/digests']);
    expect(await queueCount()).toBe(0);
    const key = (await db.query<{ storage_key: string }>('SELECT storage_key FROM expense_documents WHERE id = $1', [id])).rows[0]!.storage_key;
    expect(sha(await readFile(path.join(dir, ...key.split('/'))))).toBe(sha(data));
    // Other managers see and can open it at once.
    expect((await list(managerB, expense.id)).map((d) => d.id)).toEqual([id]);
    const opened = await managerB.agent.get(`/api/v1/expenses/${expense.id}/documents/${id}/content`).buffer(true);
    expect(opened.status).toBe(200);
  });

  it('PC offline: 503, nothing recorded or queued on the server; the browser keeps the file', async () => {
    const expense = await newExpense();
    await agent.stop();
    try {
      const res = await permanent(managerA, expense.id, png());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('DOCUMENT_STORAGE_OFFLINE');
      expect(await docRows(expense.id)).toEqual([]);
      expect(await queueCount()).toBe(0);
      expect(await list(managerB, expense.id)).toEqual([]);
    } finally {
      await agent.start();
    }
  });

  it('a retry with the same attachment id (lost response, refresh, second tab) never creates a second document', async () => {
    const expense = await newExpense();
    const data = png();
    const id = randomUUID();
    expect((await permanent(managerA, expense.id, data, id)).status).toBe(201);
    agent.requests = [];
    const again = await permanent(managerA, expense.id, data, id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, stored: 'permanent', document: { id } });
    expect(agent.requests.filter((r) => r.method === 'PUT')).toEqual([]);
    // Two attempts racing with the same id: still exactly one document.
    const raceId = randomUUID();
    const raceData = png();
    const [r1, r2] = await Promise.all([permanent(managerA, expense.id, raceData, raceId), permanent(managerA, expense.id, raceData, raceId)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.body.document.id).toBe(raceId);
    expect(r2.body.document.id).toBe(raceId);
    expect((await docRows(expense.id)).length).toBe(2);
  });

  it('an attachment id already used for other bytes or another expense is a conflict', async () => {
    const expense = await newExpense();
    const id = randomUUID();
    expect((await permanent(managerA, expense.id, png(), id)).status).toBe(201);
    const otherBytes = await permanent(managerA, expense.id, png(), id);
    expect(otherBytes.status).toBe(409);
    expect(otherBytes.body.error.code).toBe('DOCUMENT_ID_CONFLICT');
    const other = await newExpense();
    const data = png();
    expect((await permanent(managerA, other.id, data, randomUUID())).status).toBe(201);
    const otherExpense = await permanent(managerA, (await newExpense()).id, data, id);
    expect(otherExpense.status).toBe(409);
  });

  it('bytes that do not match the browser checksum are refused before anything is stored', async () => {
    const expense = await newExpense();
    agent.requests = [];
    const res = await permanent(managerA, expense.id, png(), randomUUID(), { 'X-Content-SHA256': sha(png()) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOCUMENT_CHECKSUM_MISMATCH');
    expect(agent.requests).toEqual([]);
    expect(await docRows(expense.id)).toEqual([]);
    const bad = await upload(managerA, expense.id, png(), 'x.png', { 'X-Attachment-Id': 'nope' });
    expect(bad.body.error.code).toBe('INVALID_ATTACHMENT_ID');
  });

  it('when the PC does not confirm the stored bytes, nothing is recorded and the stray copy is removed', async () => {
    class LyingStorage extends LocalDocumentStorage {
      override async digest(key: string) {
        const real = await super.digest(key);
        return { ...real, sha256Hex: '0'.repeat(64) };
      }
    }
    const lyingDir = await mkdtemp(path.join(tmpdir(), 'sb-lying-'));
    try {
      const lyingApp = createApp({ config: testConfig(), db, logger: silentLogger, storage: new LyingStorage(lyingDir) });
      const s = request.agent(lyingApp);
      const login = await s.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email: 'aq-a@example.test', password: 'test-password-123' });
      const session = { agent: s, csrf: login.body.csrfToken as string };
      const expense = await newExpense();
      const res = await permanent(session, expense.id, png());
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('DOCUMENT_STORAGE_VERIFY_FAILED');
      expect(await docRows(expense.id)).toEqual([]);
      const leftovers: string[] = [];
      for await (const o of new LocalDocumentStorage(lyingDir).list()) leftovers.push(o.key);
      expect(leftovers).toEqual([]);
    } finally {
      await rm(lyingDir, { recursive: true, force: true });
    }
  });

  it('keeps the limit of 10 documents per expense', async () => {
    const expense = await newExpense();
    const results = await Promise.all(Array.from({ length: 11 }, () => permanent(managerA, expense.id, png())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    const refused = results.filter((r) => r.status !== 201);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body.error.code).toBe('DOCUMENT_LIMIT_REACHED');
  });

  it('a file waiting in the server queue (older clients) is visible to its uploader and the owner only, until it reaches the PC', async () => {
    const expense = await newExpense();
    await agent.stop();
    let id: string;
    try {
      const res = await upload(managerA, expense.id, png(), 'legacy.png');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ stored: 'queued', document: { pendingDelivery: true } });
      id = res.body.document.id;
      expect((await list(managerA, expense.id)).map((d) => d.id)).toEqual([id]);
      expect((await list(owner, expense.id)).map((d) => d.id)).toEqual([id]);
      expect(await list(managerB, expense.id)).toEqual([]);
      expect((await managerB.agent.get(`/api/v1/expenses/${expense.id}/documents/${id}`)).status).toBe(404);
      expect((await managerB.agent.get(`/api/v1/expenses/${expense.id}/documents/${id}/content`)).status).toBe(404);
    } finally {
      await agent.start();
    }
    expect(await deliverQueuedDocuments(db, storage)).toMatchObject({ delivered: 1 });
    expect((await list(managerB, expense.id)).map((d) => d.id)).toEqual([id]);
    expect((await managerB.agent.get(`/api/v1/expenses/${expense.id}/documents/${id}/content`).buffer(true)).status).toBe(200);
  });
});
