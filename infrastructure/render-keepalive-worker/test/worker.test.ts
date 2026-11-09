import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import wranglerConfigText from '../wrangler.jsonc?raw';

const env: Env = { TARGET_URL: 'https://shop-books-api.onrender.com/api/v1/health' };

afterEach(() => vi.unstubAllGlobals());

function scheduledArgs(scheduledTime = Date.UTC(2026, 10, 8, 12, 5)) {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const controller = { scheduledTime, cron: '*/5 * * * *', noRetry: () => undefined } as unknown as ScheduledController;
  return { controller, ctx, waits };
}

describe('GET /health endpoint', () => {
  it('answers ok WITHOUT contacting Render', async () => {
    const fetchSpy = vi.fn(async () => new Response('should not be called'));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await worker.fetch(new Request('https://keepalive.example/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', worker: 'shop-books-render-keepalive' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is the only route: everything else is 404, other methods 405, and none of them pings Render', async () => {
    const fetchSpy = vi.fn(async () => new Response('nope'));
    vi.stubGlobal('fetch', fetchSpy);
    for (const path of ['/', '/ping', '/trigger', '/__scheduled', '/health/extra', '/api/v1/health']) {
      expect((await worker.fetch(new Request(`https://keepalive.example${path}`))).status, path).toBe(404);
    }
    const post = await worker.fetch(new Request('https://keepalive.example/health', { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not reveal the target URL', async () => {
    const res = await worker.fetch(new Request('https://keepalive.example/health'));
    expect(await res.text()).not.toContain('onrender');
  });
});

describe('scheduled handler', () => {
  it('runs one ping against the configured target', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { controller, ctx, waits } = scheduledArgs();
    await worker.scheduled(controller, env, ctx);
    await Promise.all(waits);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe(env.TARGET_URL);
    const line = JSON.parse(String(log.mock.calls[0]![0]));
    expect(line).toMatchObject({ event: 'render_keepalive', timestamp: '2026-11-08T12:05:00.000Z', target: env.TARGET_URL, success: true, httpStatus: 200 });
    log.mockRestore();
  });

  it('a failing run completes cleanly (no rejection) so future runs are unaffected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { controller, ctx, waits } = scheduledArgs();
    await expect(worker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
    await expect(Promise.all(waits)).resolves.toBeDefined();
    err.mockRestore();
  }, 15_000);

  it.each([['missing', undefined], ['not a URL', 'nonsense'], ['plain http to a remote host', 'http://shop-books-api.onrender.com/api/v1/health']])(
    'refuses an unusable TARGET_URL (%s) without sending any request',
    async (_name, value) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { controller, ctx, waits } = scheduledArgs();
      await worker.scheduled(controller, { TARGET_URL: value as unknown as string }, ctx);
      expect(waits).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      err.mockRestore();
    },
  );
});

describe('configuration', () => {
  const raw: string = wranglerConfigText;
  // wrangler.jsonc allows // comment lines; strip only whole-line comments (URLs contain "//").
  const config = JSON.parse(raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) as {
    triggers: { crons: string[] };
    vars: Record<string, string>;
    main: string;
    name: string;
  };

  it('has exactly one Cron Trigger and it is exactly "*/5 * * * *"', () => {
    expect(config.triggers.crons).toEqual(['*/5 * * * *']);
  });

  it('that expression means every five minutes: 12 runs/hour, 288/day, 8,640 per 30 days', () => {
    const [minute, hour, dom, month, dow] = config.triggers.crons[0]!.split(' ');
    expect([hour, dom, month, dow]).toEqual(['*', '*', '*', '*']);
    const step = Number(/^\*\/(\d+)$/.exec(minute!)![1]);
    const minutes = Array.from({ length: 60 }, (_, m) => m).filter((m) => m % step === 0);
    expect(minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(minutes.length).toBe(12);
    expect(minutes.length * 24).toBe(288);
    expect(minutes.length * 24 * 30).toBe(8640);
  });

  it('targets the Render health endpoint and needs no secrets or bindings', () => {
    expect(config.vars).toEqual({ TARGET_URL: 'https://shop-books-api.onrender.com/api/v1/health' });
    const keys = Object.keys(config);
    for (const forbidden of ['hyperdrive', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'services', 'queues', 'durable_objects']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
