// Local stand-in for two real Vercel deployments of the frontend (plus a tiny fake API), used by
// e2e/deploy-sim/*.deploy.ts. It serves one of two production builds (.deploy-sim/a or /b) at the
// same origin, the way Vercel swaps the production deployment: same URL, new immutable files.
//
// Mirrors web/vercel.json: the same Cache-Control headers, and the catch-all rewrite to
// /index.html for any path that is not a file (including a missing /assets/*.js, as on Vercel).
//
// Control (tests only): GET /__sim?live=b&compat=2&apiVersion=2&apiDown=1&swBroken=1
// No database, no network access, nothing outside this process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../.deploy-sim');
const port = Number(process.env.PORT || 4180);
const initial = { live: 'a', compat: 1, apiVersion: '1', apiDown: false, swBroken: false };
let state = { ...initial };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Same rules as web/vercel.json "headers" (matched on the requested path, as Vercel does). */
function cacheControl(pathname) {
  if (pathname === '/sw.js' || pathname === '/version.json') return 'no-cache, no-store, must-revalidate';
  if (pathname === '/manifest.webmanifest' || pathname === '/index.html') return 'no-cache';
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate'; // Vercel's default for everything else
}

const USER = { id: 'u1', email: 'manager@example.com', name: 'Manager', role: 'manager', mustChangePassword: false };
const SUPPLIERS = Array.from({ length: 6 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: `Supplier ${i + 1}`,
  phone: null,
  address: null,
  notes: null,
  isActive: true,
  version: 1,
  categories: [],
  brands: [],
  expenseCount: 1,
  payable: `${(i + 1) * 100}.00`,
  unallocated: '0.00',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}));
const CATEGORIES = [{ id: '10000000-0000-4000-8000-000000000001', name: 'Purchase', isActive: true, expenseCount: 0, createdAt: '', updatedAt: '' }];

function api(pathname, res) {
  const json = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (state.apiDown) return json({ error: { code: 'UNAVAILABLE', message: 'Restarting' } }, 503);
  const p = pathname.replace('/api/v1', '');
  if (p === '/auth/me') return json({ user: USER, csrfToken: 'csrf' });
  if (p === '/version') return json({ version: state.apiVersion, clientCompat: state.compat });
  if (p === '/health') return json({ status: 'ok' });
  if (p === '/sync/changes') return json({ cursor: '1', events: [], truncated: false });
  if (p === '/suppliers') return json({ items: SUPPLIERS, pagination: { page: 1, pageSize: 20, total: SUPPLIERS.length, totalPages: 1 } });
  if (/^\/suppliers\/[^/]+\/balance$/.test(p)) {
    return json({ balance: { supplierId: 'x', totalBills: '100.00', paidAtPurchase: '0.00', totalPayments: '0.00', allocated: '0.00', payable: '100.00', unallocated: '0.00', netBalance: '100.00', billCount: 1, paymentCount: 0 } });
  }
  if (/^\/suppliers\/[^/]+\/open-bills$/.test(p)) return json({ bills: [] });
  if (p === '/categories') return json({ categories: CATEGORIES });
  if (p === '/brands') return json({ brands: [] });
  const empty = { items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
  if (p === '/expenses') return json({ ...empty, totals: { count: 0, amount: '0.00', amountPaid: '0.00', outstanding: '0.00' } });
  if (p === '/expenses/recorders') return json({ users: [] });
  if (p === '/supplier-payments') return json({ ...empty, totals: { count: 0, amount: '0.00', allocated: '0.00', unallocated: '0.00' } });
  return json({ error: { code: 'NOT_FOUND', message: 'Not simulated' } }, 404);
}

function control(url, res) {
  const q = url.searchParams;
  if (q.has('reset')) state = { ...initial };
  if (q.has('live')) state.live = q.get('live') === 'b' ? 'b' : 'a';
  if (q.has('compat')) state.compat = Number(q.get('compat'));
  if (q.has('apiVersion')) state.apiVersion = q.get('apiVersion');
  if (q.has('apiDown')) state.apiDown = q.get('apiDown') === '1';
  if (q.has('swBroken')) state.swBroken = q.get('swBroken') === '1';
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(state));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/__sim') return control(url, res);
    if (pathname.startsWith('/api/')) return api(pathname, res);
    if (pathname === '/sw.js' && state.swBroken) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('Service worker unavailable');
    }
    const dir = path.join(root, state.live);
    let file = path.join(dir, pathname);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html'); // rewrite "/(.*)" -> /index.html
    const headers = {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': cacheControl(pathname),
      'x-content-type-options': 'nosniff',
    };
    if (pathname === '/sw.js') headers['service-worker-allowed'] = '/';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`deploy simulation on http://localhost:${port} (serving ${state.live})`));
