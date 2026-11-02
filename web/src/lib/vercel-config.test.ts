import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vercelApiProxyProblem } from '../../vercel-config';

const spa = { source: '/(.*)', destination: '/index.html' };
const api = (destination: string) => ({ source: '/api/:path*', destination });

describe('Vercel API proxy (web/vercel.json)', () => {
  it('accepts an https proxy to the backend placed before the SPA fallback', () => {
    expect(vercelApiProxyProblem({ rewrites: [api('https://shop-books-api.onrender.com/api/:path*'), spa] })).toBeNull();
  });

  it('rejects a missing proxy, wrong order, http, placeholders and changed paths', () => {
    expect(vercelApiProxyProblem({ rewrites: [spa] })).toMatch(/no rewrite with source/);
    expect(vercelApiProxyProblem({ rewrites: [spa, api('https://shop-books-api.onrender.com/api/:path*')] })).toMatch(/must come before/);
    expect(vercelApiProxyProblem({ rewrites: [api('http://shop-books-api.onrender.com/api/:path*'), spa] })).toMatch(/https/);
    expect(vercelApiProxyProblem({ rewrites: [api('https://REPLACE-WITH-RENDER-SERVICE.onrender.com/api/:path*'), spa] })).toMatch(/placeholder/);
    expect(vercelApiProxyProblem({ rewrites: [api('https://shop-books-api.onrender.com/:path*'), spa] })).toMatch(/same path/);
    expect(vercelApiProxyProblem({ rewrites: [api('/api/:path*'), spa] })).toMatch(/absolute https/);
  });

  it('the committed vercel.json has the proxy first; only the backend host is left to fill in', () => {
    const config = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../vercel.json'), 'utf8')) as {
      rewrites: { source: string; destination: string }[];
    };
    expect(config.rewrites.map((r) => r.source)).toEqual(['/api/:path*', '/(.*)']);
    expect(vercelApiProxyProblem(config)).toMatch(/replace the placeholder backend host/);
  });
});
