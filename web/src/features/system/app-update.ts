import { apiBaseUrl } from '@/lib/api-client';

/**
 * Keeps open copies of Shop-Books (installed PWA on a phone, or a browser tab) on the latest release.
 *
 * Frontend releases: every build has a unique id, compiled into the bundle (__SHOP_BOOKS_BUILD_ID__)
 * AND published as /version.json (never precached, never HTTP-cached). An open app whose id differs
 * from the published one is out of date.
 *
 * Backend releases: GET /api/v1/version reports `clientCompat`, the lowest web-app compatibility
 * level the API works with. Only a raise above API_COMPAT_LEVEL (below) makes an open app refresh;
 * restarts and ordinary backend releases never do.
 *
 * When to look: on start-up, when the app comes back to the foreground or online, and every 30 min
 * while visible (two tiny GETs; nothing while hidden).
 *
 * How to refresh: first make the service worker fetch the new files (otherwise a reload would be
 * answered from the old precache), then reload ONCE, only when it is safe (no unsaved input, no
 * open dialog, no field being edited, no save in flight). Otherwise the user sees a prompt and the
 * refresh waits. A reload that did not reach the new version is not repeated automatically: the
 * user gets a "Refresh" button that also clears the service worker (no infinite reload loops).
 */

/** Raise together with CLIENT_COMPAT_LEVEL in server/src/config/constants.ts (see there). */
export const API_COMPAT_LEVEL = 1;

export const BUILD_ID: string = typeof __SHOP_BOOKS_BUILD_ID__ === 'string' ? __SHOP_BOOKS_BUILD_ID__ : 'dev';

export const MIN_CHECK_INTERVAL_MS = 60_000;
export const PERIODIC_CHECK_MS = 30 * 60_000;
/** An automatic reload for the same target is not repeated within this window. */
export const RELOAD_GUARD_MS = 10 * 60_000;
/** How long "Refreshing to the latest version…" is shown before the reload. */
export const REFRESH_NOTICE_MS = 1500;
const ATTEMPT_KEY = 'shop-books:update-attempt';
const CHUNK_RELOAD_KEY = 'shop-books:chunk-reload';

export type UpdateStatus =
  /** Running the latest version (or nothing detected yet). */
  | 'current'
  /** Update found and it is safe: "Shop-Books has been updated. Refreshing…" then reload. */
  | 'refreshing'
  /** Update found but the user has unsaved work: prompt; refresh once it is safe. */
  | 'waiting'
  /** Automatic refresh failed or already happened once without effect: ask the user. */
  | 'manual';

export interface ServerVersion {
  version: string | null;
  clientCompat: number;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AppUpdaterDeps {
  currentBuild: string;
  compatLevel: number;
  /** The build id currently published (/version.json), or null when it cannot be read. */
  fetchBuild: () => Promise<string | null>;
  /** The API's version info, or null when unreachable / not supported yet. */
  fetchServer: () => Promise<ServerVersion | null>;
  /** Makes the next page load use the new files (service-worker update). False = could not. */
  prepare: () => Promise<boolean>;
  reload: () => void;
  /** Last resort for a stuck service worker: unregister it, drop its caches, reload. */
  hardReload: () => Promise<void>;
  /** True when a reload would not lose anything the user is doing. */
  isSafe: () => boolean;
  onStatus: (status: UpdateStatus) => void;
  storage?: KeyValueStore | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

interface Attempt {
  target: string;
  at: number;
}

export class AppUpdater {
  private status: UpdateStatus = 'current';
  private target: string | null = null;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private checking: Promise<void> | null = null;
  private refreshing = false;
  private stopped = false;
  private lastServerVersion: string | null | undefined = undefined;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: AppUpdaterDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** The backend's last reported release label (for diagnostics / tests). */
  getServerVersion(): string | null | undefined {
    return this.lastServerVersion;
  }

  /** On start-up: forget a reload that worked, then check once. */
  start(): Promise<void> {
    const attempt = this.readAttempt();
    if (attempt && attempt.target === this.deps.currentBuild) this.deps.storage?.removeItem(ATTEMPT_KEY);
    return this.check(true);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Looks for a newer release. Throttled unless `force`; never runs twice at once. */
  check(force = false): Promise<void> {
    if (this.stopped || this.status === 'refreshing') return Promise.resolve();
    if (this.checking) return this.checking;
    if (!force && this.now() - this.lastCheck < MIN_CHECK_INTERVAL_MS) return Promise.resolve();
    this.lastCheck = this.now();
    this.checking = this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    const [build, server] = await Promise.all([
      this.deps.fetchBuild().catch(() => null),
      this.deps.fetchServer().catch(() => null),
    ]);
    if (this.stopped) return;
    if (server) this.lastServerVersion = server.version;

    if (build !== null && build !== this.deps.currentBuild) {
      await this.found(build);
    } else if (server && server.clientCompat > this.deps.compatLevel) {
      // The API needs a newer web app than this one. If no newer build is published yet the
      // reload guard stops after one attempt and the user is asked instead.
      await this.found(`compat-${server.clientCompat}`);
    }
  }

  /** A lazily loaded file of this build is gone (a newer release replaced it): reload safely. */
  async chunkLoadFailed(): Promise<void> {
    await this.check(true);
    if (this.target === null) await this.found(`chunk-${this.deps.currentBuild}`);
  }

  private async found(target: string): Promise<void> {
    this.target = target;
    await this.tryRefresh();
  }

  /** Call when the user may have finished (navigation, dialog closed, save completed…). */
  async safeNow(): Promise<void> {
    if (this.status === 'waiting') await this.tryRefresh();
  }

  /** "Refresh" button. With `manual` status the service worker is reset as well. */
  async refreshNow(): Promise<void> {
    if (this.status === 'manual') {
      await this.deps.hardReload();
      return;
    }
    this.setStatus('refreshing');
    const ready = await this.deps.prepare().catch(() => false);
    if (!ready) {
      await this.deps.hardReload();
      return;
    }
    this.deps.reload();
  }

  private async tryRefresh(): Promise<void> {
    const target = this.target;
    if (target === null || this.refreshing || this.stopped) return;
    if (!this.deps.isSafe()) {
      this.setStatus('waiting');
      return;
    }
    const attempt = this.readAttempt();
    if (attempt && attempt.target === target && this.now() - attempt.at < RELOAD_GUARD_MS) {
      // Already reloaded once for this release and still not on it: never loop.
      this.setStatus('manual');
      return;
    }
    this.refreshing = true;
    this.setStatus('refreshing');
    try {
      const ready = await this.deps.prepare().catch(() => false);
      if (!ready) {
        this.setStatus('manual');
        return;
      }
      await this.wait(REFRESH_NOTICE_MS);
      if (this.stopped) return;
      if (!this.deps.isSafe()) {
        // The user started typing while the notice was showing.
        this.setStatus('waiting');
        return;
      }
      this.writeAttempt({ target, at: this.now() });
      this.deps.reload();
    } finally {
      this.refreshing = false;
    }
  }

  private setStatus(status: UpdateStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatus(status);
  }

  private readAttempt(): Attempt | null {
    try {
      const raw = this.deps.storage?.getItem(ATTEMPT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<Attempt>;
      return typeof parsed.target === 'string' && typeof parsed.at === 'number' ? { target: parsed.target, at: parsed.at } : null;
    } catch {
      return null;
    }
  }

  private writeAttempt(attempt: Attempt): void {
    try {
      this.deps.storage?.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
    } catch {
      // Private mode / storage full: the in-memory `refreshing` flag still prevents a loop now.
    }
  }
}

// --- Browser implementations ----------------------------------------------------------------

/** GET /version.json from the web host (bypassing every cache). */
export async function fetchPublishedBuild(): Promise<string | null> {
  const res = await fetch('/version.json', { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) return null;
  const body = (await res.json()) as { buildId?: unknown };
  return typeof body.buildId === 'string' && body.buildId ? body.buildId : null;
}

/**
 * GET /api/v1/version. Deliberately NOT apiRequest(): an older API answers 401 for this unknown
 * route, and apiRequest would treat that as "signed out".
 */
export async function fetchServerVersion(): Promise<ServerVersion | null> {
  const res = await fetch(`${apiBaseUrl()}/version`, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const body = (await res.json()) as Partial<ServerVersion>;
  if (typeof body.clientCompat !== 'number') return null;
  return { version: typeof body.version === 'string' ? body.version : null, clientCompat: body.clientCompat };
}

/** Registers the service worker (production builds only). Failures are logged, never fatal. */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    console.warn('Service worker registration failed');
  }
}

/**
 * Asks the browser for the new service worker and waits until it controls the app, so the next
 * load is served the new index.html and assets. True when there is nothing to wait for.
 */
export async function prepareServiceWorker(timeoutMs = 15_000): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return true;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return true;
  try {
    await reg.update();
  } catch {
    return false;
  }
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return true;
  if (worker.state === 'activated') return true;
  // Our worker activates itself (skipWaiting); the message covers a worker that waits for it.
  const skipWaiting = () => worker.postMessage({ type: 'SKIP_WAITING' });
  if (worker.state === 'installed') skipWaiting();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') skipWaiting();
      else if (worker.state === 'activated') {
        clearTimeout(timer);
        resolve(true);
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

/** Unregisters the service worker and removes its precache, then reloads from the network. */
export async function hardReload(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('workbox-precache')).map((k) => caches.delete(k)));
    }
  } catch {
    // Reload anyway: the network copy is the newest.
  }
  window.location.reload();
}

/** Error text of a lazily loaded file that no longer exists on the server. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk \S+ failed/i.test(
    message,
  );
}

/**
 * For the error boundary (the updater is unmounted by then): reload once per window for a missing
 * chunk, never in a loop. Returns true when a reload was started.
 */
export function reloadOnceForChunkError(storage: KeyValueStore | null = safeSessionStorage(), now = Date.now(), reload = () => window.location.reload()): boolean {
  try {
    const raw = storage?.getItem(CHUNK_RELOAD_KEY) ?? null;
    if (raw !== null && now - Number(raw) < RELOAD_GUARD_MS) return false;
    storage?.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

export function safeSessionStorage(): KeyValueStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
