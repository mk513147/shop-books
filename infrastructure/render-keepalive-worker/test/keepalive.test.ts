import { describe, expect, it, vi } from 'vitest';
import { MAX_RETRIES, REQUEST_TIMEOUT_MS, runKeepAlive, type KeepAliveOptions } from '../src/keepalive';

const URL_UNDER_TEST = 'https://shop-books-api.onrender.com/api/v1/health';
const SCHEDULED = Date.UTC(2026, 10, 8, 12, 5, 0);

const ok = () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });

function harness(fetchImpl: typeof fetch, extra: Partial<KeepAliveOptions> = {}) {
  const logs: { level: string; entry: Record<string, unknown> }[] = [];
  const sleep = vi.fn(async () => undefined);
  const run = () =>
    runKeepAlive({
      url: URL_UNDER_TEST,
      scheduledTime: SCHEDULED,
      fetchImpl,
      sleep,
      timeoutMs: 40,
      log: (level, entry) => logs.push({ level, entry }),
      ...extra,
    });
  return { run, logs, sleep };
}

describe('keep-alive ping', () => {
  it('constants: 15 s timeout and at most one retry', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(MAX_RETRIES).toBe(1);
  });

  it('succeeds on {"status":"ok"} with one GET and a structured success log', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const { run, logs, sleep } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run();
    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_UNDER_TEST);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe('info');
    expect(logs[0]!.entry).toMatchObject({
      event: 'render_keepalive',
      timestamp: '2026-11-08T12:05:00.000Z',
      target: URL_UNDER_TEST,
      httpStatus: 200,
      success: true,
      attempt: 1,
    });
    expect(typeof logs[0]!.entry.durationMs).toBe('number');
  });

  it('sends no credentials: no Authorization, Cookie or custom secret headers', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await harness(fetchImpl as unknown as typeof fetch).run();
    const headers = ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(names).not.toContain('cookie');
    expect(names.sort()).toEqual(['accept', 'cache-control', 'user-agent']);
  });

  it('HTTP 500: fails, retries once, then reports failure (two requests at most)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const { run, logs, sleep } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run();
    expect(result.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.attempts.map((a) => [a.httpStatus, a.reason])).toEqual([[500, 'http_error'], [500, 'http_error']]);
    expect(logs.map((l) => l.level)).toEqual(['error', 'error']);
    expect(logs[0]!.entry).toMatchObject({ success: false, httpStatus: 500, reason: 'http_error', willRetry: true });
    expect(logs[1]!.entry).toMatchObject({ willRetry: false });
    expect(JSON.stringify(logs)).not.toContain('boom'); // response bodies are never logged
  });

  it('HTTP 404: fails with http_error', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"status":"ok"}', { status: 404 })); // even an "ok" body does not rescue a 404
    const result = await harness(fetchImpl as unknown as typeof fetch).run();
    expect(result.success).toBe(false);
    expect(result.attempts[0]).toMatchObject({ httpStatus: 404, reason: 'http_error' });
  });

  it('HTTP 503 degraded health ({"status":"degraded"}) is a failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"status":"degraded"}', { status: 503 }));
    const result = await harness(fetchImpl as unknown as typeof fetch).run();
    expect(result.success).toBe(false);
    expect(result.attempts[0]).toMatchObject({ httpStatus: 503, reason: 'http_error' });
  });

  it('a redirect is not followed and counts as a failure (the endpoint must answer itself)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }));
    const result = await harness(fetchImpl as unknown as typeof fetch).run();
    expect(result.success).toBe(false);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('invalid JSON: fails with invalid_json (and does not log the body)', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>cold start page SECRET-MARKER</html>', { status: 200 }));
    const { run, logs } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.attempts[0]).toMatchObject({ httpStatus: 200, reason: 'invalid_json' });
    expect(JSON.stringify(logs)).not.toContain('SECRET-MARKER');
  });

  it.each([
    ['status other than ok', '{"status":"degraded"}'],
    ['status missing', '{"database":"up"}'],
    ['status not a string "ok"', '{"status":true}'],
    ['JSON null', 'null'],
    ['JSON array', '["ok"]'],
    ['JSON string', '"ok"'],
  ])('unexpected body (%s): fails with unexpected_body', async (_name, body) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = await harness(fetchImpl as unknown as typeof fetch).run();
    expect(result.success).toBe(false);
    expect(result.attempts[0]).toMatchObject({ httpStatus: 200, reason: 'unexpected_body' });
  });

  it('accepts the real health body shape with extra fields', async () => {
    const body = '{"status":"ok","database":"up","version":"1","timestamp":"2026-11-08T12:00:00.000Z"}';
    const result = await harness((async () => new Response(body, { status: 200 })) as unknown as typeof fetch).run();
    expect(result.success).toBe(true);
  });

  it('network failure: fails with network_error, retries once, never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { run, logs } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run();
    expect(result.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attempts.every((a) => a.reason === 'network_error' && a.httpStatus === null)).toBe(true);
    expect(logs[0]!.entry.error).toContain('fetch failed');
  });

  it('timeout: aborts a request that never answers and reports timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const { run } = harness(fetchImpl as unknown as typeof fetch, { timeoutMs: 30 });
    const result = await run();
    expect(result.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attempts.map((a) => a.reason)).toEqual(['timeout', 'timeout']);
    expect(result.attempts[0]!.durationMs).toBeGreaterThanOrEqual(25);
  });

  it('timeout also covers a response whose body never finishes', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const result = await harness(fetchImpl as unknown as typeof fetch, { timeoutMs: 30 }).run();
    expect(result.success).toBe(false);
    expect(result.attempts[0]).toMatchObject({ reason: 'timeout', httpStatus: 200 });
  });

  it('one failed request followed by a successful retry succeeds, with exactly two requests', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(ok());
    const { run, logs, sleep } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run();
    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.attempts.map((a) => a.success)).toEqual([false, true]);
    expect(logs.map((l) => [l.level, l.entry.attempt, l.entry.success])).toEqual([['error', 1, false], ['info', 2, true]]);
  });

  it('never retries more than once, even if every response is bad', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 500 }));
    await harness(fetchImpl as unknown as typeof fetch).run();
    expect(fetchImpl).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it('survives a throwing logger', async () => {
    const result = await runKeepAlive({
      url: URL_UNDER_TEST,
      scheduledTime: SCHEDULED,
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
      log: () => {
        throw new Error('log sink down');
      },
    });
    expect(result.success).toBe(true);
  });
});
