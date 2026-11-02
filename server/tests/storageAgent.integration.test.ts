/**
 * Desktop document storage: the storage agent (real HTTP server on a random local port, real
 * folder) driven by the `agent` storage driver, and the PostgreSQL upload queue that keeps
 * uploads safe while the agent is offline. Cloudflare Tunnel itself is not part of these tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { AGENT_HEADERS, signAgentRequest } from '../src/modules/documents/agentProtocol.js';
import { AgentDocumentStorage } from '../src/modules/documents/agentStorage.js';
import { deliverQueuedDocuments } from '../src/modules/documents/documentQueue.js';
import { LocalDocumentStorage } from '../src/modules/documents/localStorage.js';
import { reconcileDocuments } from '../src/modules/documents/reconcile.js';
import { newStorageKey, StorageAgentRejected, StorageUnavailable } from '../src/modules/documents/storage.js';
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
  /** Every request the agent answered (method, path, status). */
  requests: { method: string; path: string; status: number }[] = [];
  constructor(readonly dir: string) {}
  async start(): Promise<void> {
    this.server = createStorageAgent({
      storage: new LocalDocumentStorage(this.dir),
      secret: SECRET,
      log: (e) => this.requests.push({ method: e.method, path: e.path, status: e.status }),
    });
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

/** Raw signed request, to test the agent's checks directly. */
function signedFetch(base: string, method: string, pathAndQuery: string, opts: { body?: Buffer; hash?: string; secret?: string; timestamp?: string } = {}) {
  const timestamp = opts.timestamp ?? String(Date.now());
  const hash = opts.hash ?? (opts.body ? sha(opts.body) : '');
  const headers: Record<string, string> = {
    [AGENT_HEADERS.timestamp]: timestamp,
    [AGENT_HEADERS.signature]: signAgentRequest(opts.secret ?? SECRET, method, pathAndQuery, timestamp, hash),
  };
  if (hash) headers[AGENT_HEADERS.contentSha256] = hash;
  return fetch(`${base}${pathAndQuery}`, { method, headers, ...(opts.body ? { body: opts.body } : {}) });
}

describe('storage agent and the agent driver (no database)', () => {
  let dir: string;
  const agent = { current: null as TestAgent | null };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-agent-'));
    agent.current = new TestAgent(dir);
    await agent.current.start();
  });
  afterAll(async () => {
    await agent.current?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('stores, lists, reads and deletes objects; bytes and hashes are preserved', async () => {
    const storage = new AgentDocumentStorage(agent.current!.url, SECRET);
    const key = newStorageKey();
    const data = png();
    await storage.put(key, data, 'image/png');
    expect(await readFile(path.join(dir, ...key.split('/')))).toEqual(data);
    expect(await storage.exists(key)).toBe(true);
    const opened = await storage.open(key);
    expect(opened.sizeBytes).toBe(data.length);
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(data);
    const listed: string[] = [];
    for await (const o of storage.list()) listed.push(o.key);
    expect(listed).toContain(key);
    expect(await storage.createAccessUrl()).toBeNull(); // never a public URL
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await storage.delete(key); // deleting again is not an error
    await expect(storage.open(key)).rejects.toThrow(/not found/);
  });

  it('never overwrites: identical bytes are an idempotent retry, different bytes a conflict', async () => {
    const storage = new AgentDocumentStorage(agent.current!.url, SECRET);
    const key = newStorageKey();
    const data = png();
    await storage.put(key, data, 'image/png');
    await expect(storage.put(key, data, 'image/png')).resolves.toBeUndefined();
    await expect(storage.put(key, png(), 'image/png')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(dir, ...key.split('/')))).toEqual(data);
  });

  it('refuses unsigned, wrongly signed, expired or tampered requests and oversized bodies', async () => {
    const base = agent.current!.url;
    const key = newStorageKey();
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    expect((await signedFetch(base, 'GET', '/v1/health', { secret: 'x'.repeat(64) })).status).toBe(401);
    expect((await signedFetch(base, 'GET', '/v1/health', { timestamp: String(Date.now() - 10 * 60 * 1000) })).status).toBe(401);
    expect((await signedFetch(base, 'GET', '/v1/health')).status).toBe(200);
    // A signature for one path does not authorise another.
    const ts = String(Date.now());
    const replay = await fetch(`${base}/v1/objects`, {
      headers: { [AGENT_HEADERS.timestamp]: ts, [AGENT_HEADERS.signature]: signAgentRequest(SECRET, 'GET', '/v1/health', ts) },
    });
    expect(replay.status).toBe(401);
    // Body that does not match its signed hash.
    const body = png();
    expect((await signedFetch(base, 'PUT', `/v1/objects/${key}`, { body, hash: sha(png()) })).status).toBe(400);
    // More than 10 MB.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    expect((await signedFetch(base, 'PUT', `/v1/objects/${newStorageKey()}`, { body: big })).status).toBe(413);
    // Keys that are not storage keys, traversal and query strings never reach the folder.
    for (const p of ['/v1/objects/..%2F..%2Fsecret', '/v1/objects/A/B', '/v1/objects/x.part', '/etc/passwd']) {
      expect((await signedFetch(base, 'GET', p)).status, p).toBe(404);
    }
    expect((await signedFetch(base, 'GET', `/v1/objects/${key}?x=1`)).status).toBe(400);
    expect(await new AgentDocumentStorage(base, SECRET).exists(key)).toBe(false);
  });

  it('reports an unreachable, misconfigured or failing agent as StorageUnavailable', async () => {
    const key = newStorageKey();
    await expect(new AgentDocumentStorage('http://127.0.0.1:1', SECRET).put(key, png(), 'image/png')).rejects.toBeInstanceOf(StorageUnavailable);
    // A refused signature is a configuration problem: still "unavailable" (uploads queue), but recognisable and reported.
    const rejected: { status: number; method: string }[] = [];
    const wrongSecret = new AgentDocumentStorage(agent.current!.url, 'y'.repeat(64), { onRejected: (d) => rejected.push(d) });
    const err = await wrongSecret.put(key, png(), 'image/png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageUnavailable);
    expect(err).toBeInstanceOf(StorageAgentRejected);
    expect((err as Error).message).toMatch(/DOCUMENT_STORAGE_AGENT_SECRET/);
    expect((err as Error).message).not.toContain('y'.repeat(16)); // never the secret
    expect(rejected).toEqual([{ status: 401, method: 'PUT' }]);
    // A genuinely unreachable agent is not reported as rejected.
    const down = await new AgentDocumentStorage('http://127.0.0.1:1', SECRET).put(key, png(), 'image/png').catch((e: unknown) => e);
    expect(down).toBeInstanceOf(StorageUnavailable);
    expect(down).not.toBeInstanceOf(StorageAgentRejected);
    expect(await new AgentDocumentStorage(agent.current!.url, SECRET).ping()).toBe(true);
    expect(await new AgentDocumentStorage('http://127.0.0.1:1', SECRET).ping()).toBe(false);
  });
});

describe('agent driver downloads: timeouts never cut a transfer short by its total duration', () => {
  /** A fake agent that sends the headers at once, then `chunks` pieces `gapMs` apart (or stalls after one). */
  async function slowAgent(chunks: number, gapMs: number, stallAfterFirst = false) {
    const piece = Buffer.alloc(1024, 7);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(piece.length * chunks) });
      let sent = 0;
      const tick = () => {
        res.write(piece);
        sent += 1;
        if (sent === chunks) res.end();
        else if (!(stallAfterFirst && sent === 1)) setTimeout(tick, gapMs);
      };
      tick();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      url,
      expected: piece.length * chunks,
      close: () => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  const drain = async (stream: NodeJS.ReadableStream, pauseMs = 0) => {
    let size = 0;
    for await (const c of stream) {
      size += (c as Buffer).length;
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    return size;
  };

  it('a download that keeps flowing completes even when it lasts far longer than the header timeout', async () => {
    // Scaled down: header timeout 150 ms, the transfer takes ~1.2 s (8x) — the same rule as 30 s vs. minutes.
    const agent = await slowAgent(12, 100);
    try {
      const storage = new AgentDocumentStorage(agent.url, SECRET, { headerTimeoutMs: 150, idleTimeoutMs: 400 });
      const started = Date.now();
      const { stream, sizeBytes } = await storage.open('ab/cd');
      expect(await drain(stream)).toBe(agent.expected);
      expect(sizeBytes).toBe(agent.expected);
      expect(Date.now() - started).toBeGreaterThan(1000);
    } finally {
      await agent.close();
    }
  });

  it('a slow client (backpressure) does not count as agent inactivity', async () => {
    const agent = await slowAgent(6, 10);
    try {
      // The consumer waits 300 ms per chunk, longer than the 150 ms idle timeout.
      const storage = new AgentDocumentStorage(agent.url, SECRET, { headerTimeoutMs: 150, idleTimeoutMs: 150 });
      const { stream } = await storage.open('ab/cd');
      expect(await drain(stream, 300)).toBe(agent.expected);
    } finally {
      await agent.close();
    }
  });

  it('an agent that stops sending mid-download fails after the inactivity timeout instead of hanging', async () => {
    const agent = await slowAgent(5, 10, true);
    try {
      const storage = new AgentDocumentStorage(agent.url, SECRET, { headerTimeoutMs: 150, idleTimeoutMs: 200 });
      const { stream } = await storage.open('ab/cd');
      await expect(drain(stream)).rejects.toThrow(/stopped sending data/);
    } finally {
      await agent.close();
    }
  });

  it('the header timeout still applies when the agent never answers', async () => {
    const server = createServer(() => undefined); // accepts, never responds
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const storage = new AgentDocumentStorage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, SECRET, { headerTimeoutMs: 150 });
      await expect(storage.open('ab/cd')).rejects.toBeInstanceOf(StorageUnavailable);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const pool = await connectTestDatabase();

describe.skipIf(!pool)('desktop storage offline: uploads are queued in PostgreSQL and delivered later', () => {
  const db = pool!;
  let dir: string;
  let agent: TestAgent;
  let storage: AgentDocumentStorage;
  let app: ReturnType<typeof createApp>;
  type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
  let owner: Session;
  let categoryId: string;

  const send = (s: Session, p: string, body: object) => s.agent.post(`/api/v1${p}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': s.csrf }).send(body);
  const upload = (s: Session, expenseId: string, data: Buffer, name: string) =>
    s.agent
      .post(`/api/v1/expenses/${expenseId}/documents`)
      .set({ Origin: BROWSER_HEADERS.Origin, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/octet-stream', 'X-File-Name': name })
      .send(data);
  const content = (s: Session, expenseId: string, documentId: string) =>
    s.agent
      .get(`/api/v1/expenses/${expenseId}/documents/${documentId}/content`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const newExpense = async () =>
    (
      await send(owner, '/expenses', {
        expenseDate: todayInReportingZone(),
        supplierId: null,
        categoryId,
        description: 'Desktop storage test',
        amount: '100',
        payments: [{ paymentMode: 'cash', amount: '100' }],
        invoiceReference: null,
      })
    ).body.expense as { id: string };
  const queueRows = async () => (await db.query<{ document_id: string; attempts: number; last_error: string | null }>('SELECT document_id, attempts, last_error FROM document_upload_queue')).rows;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-agent-db-'));
    agent = new TestAgent(dir);
    await agent.start();
    storage = new AgentDocumentStorage(agent.url, SECRET);
    app = createApp({ config: testConfig(), db, logger: silentLogger, storage });
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('agent-owner@example.test', 'Owner', 'owner', $1)`, [
      await hashPassword('test-password-123'),
    ]);
    const a = request.agent(app);
    const login = await a.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email: 'agent-owner@example.test', password: 'test-password-123' });
    owner = { agent: a, csrf: login.body.csrfToken };
    categoryId = (await send(owner, '/categories', { name: 'Bills' })).body.category.id;
  });

  afterAll(async () => {
    await agent.stop();
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('with the agent online, an upload goes straight to the desktop folder', async () => {
    const expense = await newExpense();
    const data = png();
    const res = await upload(owner, expense.id, data, 'online.png');
    expect(res.status).toBe(201);
    expect(res.body.document.pendingDelivery).toBe(false);
    expect(await queueRows()).toEqual([]);
    expect((await content(owner, expense.id, res.body.document.id)).body).toEqual(data);
  });

  it('offline: expenses still save, uploads are accepted and kept, queued files can be opened, stored ones give 503', async () => {
    const stored = await newExpense();
    const storedDoc = (await upload(owner, stored.id, png(), 'before.png')).body.document;
    await agent.stop();

    const expense = await newExpense(); // expense creation does not need document storage
    expect(expense.id).toBeTruthy();
    const data = png();
    const res = await upload(owner, expense.id, data, 'offline.png');
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({ pendingDelivery: true, sizeBytes: data.length, sha256: sha(data) });
    expect((await queueRows()).map((r) => r.document_id)).toEqual([res.body.document.id]);
    const listed = (await owner.agent.get(`/api/v1/expenses/${expense.id}/documents`)).body.documents;
    expect(listed[0]).toMatchObject({ id: res.body.document.id, pendingDelivery: true });

    const queued = await content(owner, expense.id, res.body.document.id);
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual(data);
    expect(queued.headers['cache-control']).toContain('no-store');

    const offline = await owner.agent.get(`/api/v1/expenses/${stored.id}/documents/${storedDoc.id}/content`);
    expect(offline.status).toBe(503);
    expect(offline.body.error.code).toBe('DOCUMENT_STORAGE_OFFLINE');

    // Delivery while still offline: nothing lost, the attempt is recorded.
    const attempt = await deliverQueuedDocuments(db, storage);
    expect(attempt).toEqual({ delivered: 0, failed: 0, storageUnavailable: true, agentRejected: false });
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1 });
    expect(rows[0]!.last_error).toMatch(/unreachable/);

    // Reconciliation reports it as pending, not as missing.
    const report = await reconcileDocuments(db, new LocalDocumentStorage(dir));
    expect(report.pendingUploads.map((p) => p.documentId)).toEqual([res.body.document.id]);
    expect(report.missingFiles).toEqual([]);

    // Back online: delivered exactly once, verified, queue emptied, served from the desktop.
    await agent.start();
    expect(await deliverQueuedDocuments(db, storage)).toEqual({ delivered: 1, failed: 0, storageUnavailable: false, agentRejected: false });
    expect(await queueRows()).toEqual([]);
    const key = (await db.query<{ storage_key: string }>('SELECT storage_key FROM expense_documents WHERE id = $1', [res.body.document.id])).rows[0]!.storage_key;
    expect(sha(await readFile(path.join(dir, ...key.split('/'))))).toBe(sha(data));
    expect((await content(owner, expense.id, res.body.document.id)).body).toEqual(data);
    expect((await owner.agent.get(`/api/v1/expenses/${expense.id}/documents`)).body.documents[0].pendingDelivery).toBe(false);
    expect(await deliverQueuedDocuments(db, storage)).toEqual({ delivered: 0, failed: 0, storageUnavailable: false, agentRejected: false });
    expect((await reconcileDocuments(db, storage, true)).checksumMismatches).toEqual([]);
  });

  it('a delivery whose response was lost is retried harmlessly (the agent sees identical bytes)', async () => {
    await agent.stop();
    const expense = await newExpense();
    const data = png();
    const doc = (await upload(owner, expense.id, data, 'retry.png')).body.document;
    await agent.start();
    // The file reaches the desktop, but the queue row survives (as if the reply had been lost).
    const key = (await db.query<{ storage_key: string }>('SELECT storage_key FROM expense_documents WHERE id = $1', [doc.id])).rows[0]!.storage_key;
    await storage.put(key, data, 'image/png');
    expect(await deliverQueuedDocuments(db, storage)).toEqual({ delivered: 1, failed: 0, storageUnavailable: false, agentRejected: false });
    expect(await queueRows()).toEqual([]);
  });

  it('the database only accepts queued bytes that match the recorded document, and never changes them', async () => {
    await agent.stop();
    const expense = await newExpense();
    const doc = (await upload(owner, expense.id, png(), 'guard.png')).body.document;
    await expect(db.query('UPDATE document_upload_queue SET content = $2 WHERE document_id = $1', [doc.id, png()])).rejects.toThrow(/cannot be changed/);
    const other = await newExpense();
    await agent.start();
    const otherDoc = (await upload(owner, other.id, png(), 'online.png')).body.document;
    await expect(db.query('INSERT INTO document_upload_queue (document_id, content) VALUES ($1, $2)', [otherDoc.id, png()])).rejects.toThrow(
      /does not match its recorded size and SHA-256/,
    );
    expect(await deliverQueuedDocuments(db, storage)).toMatchObject({ delivered: 1 });
  });

  it('two delivery workers on the same queue deliver and delete every row exactly once', async () => {
    await agent.stop();
    const docs: { id: string; data: Buffer }[] = [];
    for (let i = 0; i < 6; i++) {
      const expense = await newExpense();
      const data = png();
      docs.push({ id: (await upload(owner, expense.id, data, `c${i}.png`)).body.document.id, data });
    }
    expect(await queueRows()).toHaveLength(6);
    await agent.start();
    agent.requests = [];
    const [a, b] = await Promise.all([deliverQueuedDocuments(db, storage), deliverQueuedDocuments(db, new AgentDocumentStorage(agent.url, SECRET))]);
    expect(a.delivered + b.delivered).toBe(6);
    expect(a.failed + b.failed).toBe(0);
    expect(await queueRows()).toEqual([]);
    // Each file reached the desktop once (one PUT per document) with the recorded bytes.
    const puts = agent.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(6);
    expect(new Set(puts.map((r) => r.path)).size).toBe(6);
    for (const d of docs) {
      const key = (await db.query<{ storage_key: string }>('SELECT storage_key FROM expense_documents WHERE id = $1', [d.id])).rows[0]!.storage_key;
      expect(sha(await readFile(path.join(dir, ...key.split('/'))))).toBe(sha(d.data));
    }
  });

  it('a 409 conflict keeps that queued row (and its bytes) and does not stop later rows', async () => {
    await agent.stop();
    const first = await newExpense();
    const conflicting = png();
    const conflictDoc = (await upload(owner, first.id, conflicting, 'conflict.png')).body.document;
    const second = await newExpense();
    const fine = png();
    const fineDoc = (await upload(owner, second.id, fine, 'fine.png')).body.document;
    await agent.start();
    // Different bytes already sit under the first document's key on the desktop.
    const key = (await db.query<{ storage_key: string }>('SELECT storage_key FROM expense_documents WHERE id = $1', [conflictDoc.id])).rows[0]!.storage_key;
    await new LocalDocumentStorage(dir).put(key, png());

    const result = await deliverQueuedDocuments(db, storage);
    expect(result).toEqual({ delivered: 1, failed: 1, storageUnavailable: false, agentRejected: false });
    const rows = await queueRows();
    expect(rows.map((r) => r.document_id)).toEqual([conflictDoc.id]);
    expect(rows[0]).toMatchObject({ attempts: 1 });
    expect(rows[0]!.last_error).toMatch(/different content/);
    // The queued bytes are intact (still served), the desktop file was not overwritten, the other row went through.
    expect((await content(owner, first.id, conflictDoc.id)).body).toEqual(conflicting);
    expect(sha(await readFile(path.join(dir, ...key.split('/'))))).not.toBe(sha(conflicting));
    expect((await content(owner, second.id, fineDoc.id)).body).toEqual(fine);
    // Clean up for later tests: the conflict needs a person; here we drop the test row directly.
    await db.query('DELETE FROM document_upload_queue WHERE document_id = $1', [conflictDoc.id]);
  });

  it('a refused signature during delivery is reported as configuration, and the queue is kept', async () => {
    await agent.stop();
    const expense = await newExpense();
    await upload(owner, expense.id, png(), 'reject.png');
    await agent.start();
    const result = await deliverQueuedDocuments(db, new AgentDocumentStorage(agent.url, 'z'.repeat(64)));
    expect(result).toEqual({ delivered: 0, failed: 0, storageUnavailable: true, agentRejected: true });
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_error).toMatch(/rejected the request \(HTTP 401\)/);
    expect(await deliverQueuedDocuments(db, storage)).toMatchObject({ delivered: 1 });
  });
});
