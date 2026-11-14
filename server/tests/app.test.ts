import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createErrorHandler } from '../src/middleware/errorHandler.js';
import { requestId } from '../src/middleware/requestId.js';
import { AppError } from '../src/utils/errors.js';
import { fakeDb, silentLogger, testConfig } from './helpers.js';

function appWith(behaviour: 'up' | 'down') {
  return createApp({ config: testConfig(), db: fakeDb(behaviour), logger: silentLogger });
}

describe('GET /api/v1/health', () => {
  it('reports ok when the database responds', async () => {
    const res = await request(appWith('up')).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up', version: '1.2.3-test' });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('reports degraded (503) when the database is unreachable, without leaking details', async () => {
    const res = await request(appWith('down')).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'down' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|ECONNREFUSED|postgres/i);
  });
});

describe('GET /api/v1/version', () => {
  it('is public, never touches the database and reports only the release label and compatibility level', async () => {
    const res = await request(appWith('down')).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1.2.3-test', clientCompat: 1 });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports a null version when APP_VERSION is not set, and exposes no configuration', async () => {
    const app = createApp({ config: { ...testConfig(), appVersion: undefined }, db: fakeDb('up'), logger: silentLogger });
    const res = await request(app).get('/api/v1/version');
    expect(res.body).toEqual({ version: null, clientCompat: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|postgres|localhost|database|env/i);
  });
});

describe('unknown routes', () => {
  it('under /api are denied by default (401) before any 404 can reveal what exists', async () => {
    const res = await request(appWith('up')).get('/api/v1/does-not-exist');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('use the same shape outside /api', async () => {
    const res = await request(appWith('up')).post('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('security and platform middleware', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await request(appWith('up')).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('echoes a well-formed inbound request id and replaces a malformed one', async () => {
    const good = await request(appWith('up')).get('/api/v1/health').set('X-Request-Id', 'abc-12345678');
    expect(good.headers['x-request-id']).toBe('abc-12345678');
    const bad = await request(appWith('up')).get('/api/v1/health').set('X-Request-Id', 'x y<script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows only configured CORS origins', async () => {
    const allowed = await request(appWith('up')).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(appWith('up')).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects malformed JSON with 400 and oversized bodies with 413', async () => {
    const malformed = await request(appWith('up'))
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');

    const huge = await request(appWith('up'))
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('centralized error handler', () => {
  function appThatThrows(error: unknown) {
    const app = express();
    app.use(requestId);
    app.get('/boom', () => {
      throw error;
    });
    app.use(createErrorHandler(silentLogger));
    return app;
  }

  it('hides internal error details behind a generic 500', async () => {
    const res = await request(appThatThrows(new Error('db password is hunter2'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toMatch(/\bat\s.+\(.+:\d+:\d+\)/);
  });

  it('passes through AppError status, code, message and details', async () => {
    const err = new AppError(409, 'CONFLICT', 'Already exists', [{ path: 'name', message: 'taken' }]);
    const res = await request(appThatThrows(err)).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Already exists',
      details: [{ path: 'name', message: 'taken' }],
    });
  });
});
