import { describe, expect, it } from 'vitest';
import { apiBaseUrlProblem, parseApiBaseUrl } from './api-base-url';

describe('API base URL (VITE_API_BASE_URL)', () => {
  it('builds the API URL from an origin, an explicit /api/v1 path or the same-origin default', () => {
    expect(parseApiBaseUrl(undefined)).toEqual({ ok: true, url: '/api/v1', crossOrigin: false });
    expect(parseApiBaseUrl('  ')).toEqual({ ok: true, url: '/api/v1', crossOrigin: false });
    expect(parseApiBaseUrl('/api/v1/')).toEqual({ ok: true, url: '/api/v1', crossOrigin: false });
    expect(parseApiBaseUrl('https://abc.trycloudflare.com')).toEqual({ ok: true, url: 'https://abc.trycloudflare.com/api/v1', crossOrigin: true });
    expect(parseApiBaseUrl('https://abc.trycloudflare.com/')).toMatchObject({ url: 'https://abc.trycloudflare.com/api/v1' });
    expect(parseApiBaseUrl('https://api.example.com/api/v1/')).toMatchObject({ url: 'https://api.example.com/api/v1' });
    expect(parseApiBaseUrl('http://localhost:3000')).toMatchObject({ ok: true, url: 'http://localhost:3000/api/v1' });
  });

  it('rejects unsafe or ambiguous values', () => {
    for (const bad of [
      'http://abc.trycloudflare.com', // plain http off localhost
      'abc.trycloudflare.com', // no scheme
      'https://user:pw@api.example.com',
      'https://api.example.com/?x=1',
      'https://api.example.com/#x',
      'https://api.example.com/other',
      '/other',
      'javascript:alert(1)',
      'ftp://api.example.com',
    ]) {
      expect(parseApiBaseUrl(bad).ok, bad).toBe(false);
    }
  });

  it('a production build without the setting fails clearly except on localhost', () => {
    expect(apiBaseUrlProblem(undefined, true, 'shop-books.vercel.app')).toMatch(/was not set/);
    expect(apiBaseUrlProblem(undefined, true, 'localhost')).toBeNull(); // local preview / e2e
    expect(apiBaseUrlProblem(undefined, false, '192.168.1.5')).toBeNull(); // dev server
    expect(apiBaseUrlProblem('https://abc.trycloudflare.com', true, 'shop-books.vercel.app')).toBeNull();
    expect(apiBaseUrlProblem('http://abc.example.com', true, 'shop-books.vercel.app')).toMatch(/https/);
  });
});
