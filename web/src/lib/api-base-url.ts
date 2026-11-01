/**
 * API base URL rules (pure: used by the app at runtime AND by vite.config.ts at build time).
 *
 * VITE_API_BASE_URL may be:
 *   - empty            -> same-origin "/api/v1" (local development via the Vite proxy, local preview,
 *                         e2e tests). Refused in a production build served from a non-local host,
 *                         so a missing staging setting fails loudly instead of calling the wrong server.
 *   - "/api/v1"        -> explicit same-origin path (e.g. behind a reverse proxy).
 *   - "https://host"   -> cross-origin API (e.g. a Cloudflare Tunnel); "/api/v1" is appended.
 *   - "https://host/api/v1" -> used as is.
 * http:// is accepted only for localhost/127.0.0.1. Query strings, fragments, credentials and any
 * other path are rejected.
 */
export const DEFAULT_API_PATH = '/api/v1';

export type ApiBaseUrlResult = { ok: true; url: string; crossOrigin: boolean } | { ok: false; error: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseApiBaseUrl(raw: string | undefined): ApiBaseUrlResult {
  const value = (raw ?? '').trim();
  if (value === '') return { ok: true, url: DEFAULT_API_PATH, crossOrigin: false };
  if (value.startsWith('/')) {
    const path = value.replace(/\/+$/, '');
    return path === DEFAULT_API_PATH
      ? { ok: true, url: path, crossOrigin: false }
      : { ok: false, error: `VITE_API_BASE_URL path must be "${DEFAULT_API_PATH}" (got "${value}").` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: `VITE_API_BASE_URL is not a valid URL ("${value}").` };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    return { ok: false, error: 'VITE_API_BASE_URL must use https:// (http:// only for localhost).' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, error: 'VITE_API_BASE_URL must not contain credentials, a query string or a fragment.' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== DEFAULT_API_PATH) {
    return { ok: false, error: `VITE_API_BASE_URL may only be the server address or end with "${DEFAULT_API_PATH}".` };
  }
  return { ok: true, url: `${url.origin}${DEFAULT_API_PATH}`, crossOrigin: true };
}

/**
 * The same-origin default is only acceptable where a local proxy can serve /api (development,
 * local preview/e2e). A production build opened from any other host must be given the setting.
 */
export function apiBaseUrlProblem(raw: string | undefined, isProductionBuild: boolean, hostname: string): string | null {
  const parsed = parseApiBaseUrl(raw);
  if (!parsed.ok) return parsed.error;
  if (isProductionBuild && (raw ?? '').trim() === '' && !LOCAL_HOSTS.has(hostname)) {
    return 'VITE_API_BASE_URL was not set when this site was built, so it does not know where the Shop-Books server is.';
  }
  return null;
}
