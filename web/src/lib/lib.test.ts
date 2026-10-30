import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, setCsrfToken, setUnauthorizedHandler } from './api-client';
import { newIdempotencyKey } from './ids';
import { formatInr } from './money';

describe('formatInr', () => {
  it.each([
    ['0', '₹0.00'],
    ['5', '₹5.00'],
    ['999.5', '₹999.50'],
    ['1000', '₹1,000.00'],
    ['123456.78', '₹1,23,456.78'],
    ['12345678.9', '₹1,23,45,678.90'],
    ['-2500.00', '-₹2,500.00'],
    ['007', '₹7.00'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatInr(input)).toBe(expected);
  });

  it('rejects anything that is not a decimal string with at most 2 places', () => {
    for (const bad of ['', 'abc', '1.234', '1e5', '1,000', ' ']) {
      expect(() => formatInr(bad)).toThrow('Invalid monetary amount');
    }
  });
});

describe('apiRequest', () => {
  function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  }

  it('parses successful JSON responses and sends credentials', async () => {
    const fetchMock = vi.fn(async () => Response.json({ hello: 'world' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/ping')).resolves.toEqual({ hello: 'world' });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe('/api/v1/ping');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();
  });

  it('sends a JSON body and the CSRF header on state-changing requests only', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('csrf-123');

    await apiRequest('/auth/logout', { method: 'POST' });
    let [, init] = lastCall(fetchMock);
    expect(init.body).toBe('{}');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('X-CSRF-Token')).toBe('csrf-123');

    await apiRequest('/things', { method: 'PATCH', json: { a: 1 } });
    [, init] = lastCall(fetchMock);
    expect(init.body).toBe('{"a":1}');

    await apiRequest('/things');
    [, init] = lastCall(fetchMock);
    expect((init.headers as Headers).get('X-CSRF-Token')).toBeNull();
    setCsrfToken(null);
  });

  it("maps the server's error envelope to ApiError", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { code: 'NOT_FOUND', message: 'Nope', requestId: 'req-1' } }, { status: 404 }),
      ),
    );
    const err = await apiRequest('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Nope', requestId: 'req-1' });
  });

  it('reports an ended session on 401, except for the sign-in request itself', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })));
    await expect(apiRequest('/users')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(apiRequest('/auth/login', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(null);
  });

  it('handles non-JSON error bodies and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});

describe('newIdempotencyKey', () => {
  const SERVER_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

  it('produces distinct keys the server accepts', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(SERVER_PATTERN);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it('works without crypto.randomUUID (plain-HTTP LAN testing)', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
