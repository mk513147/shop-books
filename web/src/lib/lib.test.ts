import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './api-client';
import { isShellPreviewEnabled } from './env';
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

describe('isShellPreviewEnabled', () => {
  it('is true only for development builds with the flag set', () => {
    expect(isShellPreviewEnabled({ DEV: true, VITE_PREVIEW_SHELL: 'true' })).toBe(true);
    expect(isShellPreviewEnabled({ DEV: true })).toBe(false);
    expect(isShellPreviewEnabled({ DEV: false, VITE_PREVIEW_SHELL: 'true' })).toBe(false);
  });
});

describe('apiRequest', () => {
  it('parses successful JSON responses and sends credentials', async () => {
    const fetchMock = vi.fn(async () => Response.json({ hello: 'world' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/ping')).resolves.toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/ping');
    expect(init.credentials).toBe('include');
  });

  it('serialises json bodies with a content type', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/things', { method: 'POST', json: { a: 1 } })).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it("maps the server's error envelope to ApiError", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'NOT_FOUND', message: 'Nope', requestId: 'req-1' } },
          { status: 404 },
        ),
      ),
    );
    const err = await apiRequest('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Nope', requestId: 'req-1' });
  });

  it('handles non-JSON error bodies and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
