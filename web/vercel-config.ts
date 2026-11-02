/**
 * Vercel proxy rule for the same-origin API (VITE_API_BASE_URL=/api/v1): the browser only ever
 * talks to the Vercel domain, and Vercel forwards /api/* to the Render backend. Session cookies
 * are then first-party (SameSite=Lax works, nothing depends on third-party cookies) and no CORS is
 * involved. Used by vite.config.ts so a deployed build fails instead of shipping a broken proxy.
 */
export const API_PROXY_SOURCE = '/api/:path*';

interface Rewrite {
  source: string;
  destination: string;
}

/** Returns a problem with web/vercel.json's API proxy, or null when it is usable. */
export function vercelApiProxyProblem(vercelJson: { rewrites?: Rewrite[] }): string | null {
  const rewrites = vercelJson.rewrites ?? [];
  const index = rewrites.findIndex((r) => r.source === API_PROXY_SOURCE);
  if (index === -1) return `web/vercel.json has no rewrite with source "${API_PROXY_SOURCE}" to the backend.`;
  // Rewrites apply in order: the SPA fallback must not swallow /api requests first.
  const fallback = rewrites.findIndex((r) => r.destination === '/index.html');
  if (fallback !== -1 && fallback < index) return 'web/vercel.json: the /api rewrite must come before the /index.html fallback.';
  let url: URL;
  try {
    url = new URL(rewrites[index]!.destination);
  } catch {
    return 'web/vercel.json: the /api rewrite destination must be an absolute https:// URL.';
  }
  if (url.protocol !== 'https:') return 'web/vercel.json: the /api rewrite destination must use https://.';
  if (/replace|example|your-/i.test(url.hostname)) {
    return `web/vercel.json: replace the placeholder backend host "${url.hostname}" with your Render service URL.`;
  }
  if (url.pathname !== '/api/:path*' || url.search || url.username || url.password) {
    return 'web/vercel.json: the /api rewrite destination must be https://<backend-host>/api/:path* (same path, nothing else).';
  }
  return null;
}
