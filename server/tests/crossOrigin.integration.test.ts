/**
 * Staging arrangement: web app on https://<project>.vercel.app, API on another HTTPS origin (a
 * Cloudflare Tunnel). Verifies the server side of that arrangement with the real app: CORS for the
 * exact origin only, credentials, preflight for the custom headers, SameSite=None; Secure cookie,
 * CSRF still enforced, exposed download headers, CORS-mode document fetches.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { LocalDocumentStorage } from '../src/modules/documents/localStorage.js';
import { todayInReportingZone } from '../src/utils/dates.js';
import { connectTestDatabase, silentLogger, testConfig } from './helpers.js';

const pool = await connectTestDatabase();
const WEB = 'https://shop-books-staging.vercel.app';
const EVIL = 'https://evil.example';

describe.skipIf(!pool)('cross-origin staging arrangement (Vercel web + tunnel API)', () => {
  const db = pool!;
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let cookie = '';
  let csrf = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-xo-'));
    app = createApp({
      config: testConfig({
        frontendOrigins: [WEB, 'http://localhost:5173'],
        trustProxy: 1,
        cookie: { name: '__Host-sb_session', secure: true, sameSite: 'none' },
      }),
      db,
      logger: silentLogger,
      storage: new LocalDocumentStorage(dir),
    });
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('xo@example.test', 'Owner', 'owner', $1)`, [
      await hashPassword('test-password-123'),
    ]);
  });

  afterAll(async () => {
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('preflight: allowed only for the exact web origin, with credentials and the app headers', async () => {
    const ok = await request(app)
      .options('/api/v1/expenses/x/documents')
      .set({ Origin: WEB, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token,x-file-name,x-file-type,idempotency-key' });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(WEB);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-headers']).toContain('x-csrf-token');
    expect(ok.headers['access-control-allow-headers']).toContain('x-file-name');
    const evil = await request(app).options('/api/v1/auth/login').set({ Origin: EVIL, 'Access-Control-Request-Method': 'POST' });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(app).options('/api/v1/auth/login').set({ Origin: `${WEB}.evil.example`, 'Access-Control-Request-Method': 'POST' })).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('login from the web origin sets a SameSite=None; Secure; HttpOnly host-only cookie; other origins are refused', async () => {
    const refused = await request(app).post('/api/v1/auth/login').set({ Origin: EVIL, 'Content-Type': 'application/json' }).send({ email: 'xo@example.test', password: 'test-password-123' });
    expect(refused.status).toBe(403);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set({ Origin: WEB, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' })
      .send({ email: 'xo@example.test', password: 'test-password-123' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    const set = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(set).toMatch(/^__Host-sb_session=/);
    expect(set).toMatch(/; Secure/i);
    expect(set).toMatch(/; HttpOnly/i);
    expect(set).toMatch(/SameSite=None/i);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Domain=/i);
    cookie = set.split(';')[0]!;
    csrf = res.body.csrfToken;
    // TRUST_PROXY: the tunnel's X-Forwarded-For is the client address recorded for sign-ins.
    const ev = await db.query(`SELECT host(ip) AS ip FROM auth_events WHERE event_type = 'login_success' ORDER BY id DESC LIMIT 1`);
    expect(ev.rows[0].ip).toBe('203.0.113.7');
  });

  it('cross-site writes still need the CSRF token and an allowed Origin (SameSite=None does not weaken CSRF)', async () => {
    const body = { name: `X-origin ${randomBytes(3).toString('hex')}` };
    const noToken = await request(app).post('/api/v1/categories').set({ Origin: WEB, Cookie: cookie, 'Content-Type': 'application/json' }).send(body);
    expect(noToken.status).toBe(403);
    const evil = await request(app).post('/api/v1/categories').set({ Origin: EVIL, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }).send(body);
    expect(evil.status).toBe(403);
    const form = await request(app).post('/api/v1/categories').set({ Origin: WEB, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf }).send('name=x');
    expect(form.status).toBe(415);
    const ok = await request(app).post('/api/v1/categories').set({ Origin: WEB, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }).send(body);
    expect(ok.status).toBe(201);
    expect(ok.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('uploads and CORS-mode document fetches work cross-origin; downloads expose their file name; documents stay private', async () => {
    const h = { Origin: WEB, Cookie: cookie, 'X-CSRF-Token': csrf };
    const cat = (await request(app).post('/api/v1/categories').set({ ...h, 'Content-Type': 'application/json' }).send({ name: `Docs ${Date.now()}` })).body.category.id;
    const e = (
      await request(app)
        .post('/api/v1/expenses')
        .set({ ...h, 'Content-Type': 'application/json' })
        .send({ expenseDate: todayInReportingZone(), supplierId: null, categoryId: cat, description: 'X', amount: '10', amountPaid: '10', paymentMode: 'cash', invoiceReference: null })
    ).body.expense;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF\n');
    const up = await request(app)
      .post(`/api/v1/expenses/${e.id}/documents`)
      .set({ ...h, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'bill.pdf' })
      .send(pdf);
    expect(up.status).toBe(201);
    const url = `/api/v1/expenses/${e.id}/documents/${up.body.document.id}/content`;
    const img = await request(app).get(url).set({ Origin: WEB, Cookie: cookie });
    expect(img.status).toBe(200);
    expect(img.headers['access-control-allow-origin']).toBe(WEB);
    expect(img.headers['access-control-allow-credentials']).toBe('true');
    expect(img.headers['cache-control']).toContain('no-store');
    expect(img.headers['cross-origin-resource-policy']).toBe('same-origin'); // no-cors embeds by other sites stay blocked
    expect((await request(app).get(url).set({ Origin: WEB })).status).toBe(401); // no cookie, no file
    const exp = await request(app).get('/api/v1/exports/expenses').set({ Origin: WEB, Cookie: cookie });
    expect(exp.status).toBe(200);
    expect(exp.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });
});
