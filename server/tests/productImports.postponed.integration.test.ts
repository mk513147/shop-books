/**
 * Excel import of products is POSTPONED: every /product-imports route answers
 * 503 PRODUCT_IMPORT_UNAVAILABLE for everyone (owner included, signed in or not), whatever the
 * method, path or body, and nothing reaches the workbook parser or the database.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/database/migrator.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { BROWSER_HEADERS, connectTestDatabase, silentLogger, testConfig } from './helpers.js';
import { buildZip, WORKBOOK_PARTS } from './productImportFixtures.js';

const pool = await connectTestDatabase();

describe.skipIf(!pool)('product import is postponed (routes disabled)', () => {
  const db = pool!;
  const app = createApp({ config: testConfig(), db, logger: silentLogger });
  let owner: { agent: ReturnType<typeof request.agent>; csrf: string };
  const id = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await runMigrations(db);
    await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('owner@import.test', 'Owner', 'owner', $1)`, [await hashPassword('test-password-123')]);
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/auth/login').set(BROWSER_HEADERS).send({ email: 'owner@import.test', password: 'test-password-123' });
    owner = { agent, csrf: res.body.csrfToken };
  });

  afterAll(async () => {
    await db.end();
  });

  it('every route answers 503 for the owner: upload, inspect, read, edit, commit, discard, report', async () => {
    const before = (await db.query(`SELECT (SELECT count(*) FROM product_import_batches)::int b, (SELECT count(*) FROM product_import_rows)::int r`)).rows[0];
    const workbook = buildZip(WORKBOOK_PARTS);
    const upload = (path: string) =>
      owner.agent
        .post(`/api/v1${path}`)
        .set({ Origin: BROWSER_HEADERS.Origin, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': owner.csrf, 'X-File-Name': 'products.xlsx' })
        .send(workbook);
    const json = (method: 'post' | 'patch' | 'delete', path: string, body: object = {}) =>
      owner.agent[method](`/api/v1${path}`).set({ ...BROWSER_HEADERS, 'X-CSRF-Token': owner.csrf }).send(body);
    const attempts: [string, () => request.Test][] = [
      ['upload', () => upload('/product-imports?sheet=Sheet1&range=A1:E10')],
      ['inspect', () => upload('/product-imports/inspect')],
      ['list', () => owner.agent.get('/api/v1/product-imports')],
      ['batch', () => owner.agent.get(`/api/v1/product-imports/${id}`)],
      ['rows', () => owner.agent.get(`/api/v1/product-imports/${id}/rows`)],
      ['report', () => owner.agent.get(`/api/v1/product-imports/${id}/report`)],
      ['settings', () => json('patch', `/product-imports/${id}`, { version: 1 })],
      ['row edit', () => json('patch', `/product-imports/${id}/rows`, { version: 1, rows: [] })],
      ['split', () => json('post', `/product-imports/${id}/rows/2/split`, { version: 1 })],
      ['commit', () => json('post', `/product-imports/${id}/commit`, { version: 1 })],
      ['discard', () => json('post', `/product-imports/${id}/discard`, { version: 1 })],
      ['delete', () => json('delete', `/product-imports/${id}`)],
      ['unknown path', () => owner.agent.get('/api/v1/product-imports/anything/else')],
    ];
    for (const [label, attempt] of attempts) {
      const res = await attempt();
      expect(res.status, label).toBe(503);
      expect(res.body.error.code, label).toBe('PRODUCT_IMPORT_UNAVAILABLE');
    }
    const after = (await db.query(`SELECT (SELECT count(*) FROM product_import_batches)::int b, (SELECT count(*) FROM product_import_rows)::int r`)).rows[0];
    expect(after).toEqual(before);
  });

  it('answers the same without a session (no auth detail, no parsing)', async () => {
    const res = await request(app)
      .post('/api/v1/product-imports/inspect')
      .set({ Origin: BROWSER_HEADERS.Origin, 'Content-Type': 'application/octet-stream' })
      .send(Buffer.from('PK\u0003\u0004 not a workbook'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PRODUCT_IMPORT_UNAVAILABLE');
  });

  it('binary uploads are no longer accepted anywhere else under the products API', async () => {
    const res = await owner.agent
      .post('/api/v1/products')
      .set({ Origin: BROWSER_HEADERS.Origin, 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': owner.csrf })
      .send(Buffer.from('PK'));
    expect(res.status).toBe(415);
  });
});
