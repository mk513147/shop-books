import { apiBaseUrl } from '@/lib/api-client';

/**
 * Keeps open copies of Shop-Books (installed PWA on a phone, or a browser tab) on the latest release.
 *
 * Frontend releases: every build has a unique id, compiled into the bundle (__SHOP_BOOKS_BUILD_ID__)
 * AND published as /version.json (never precached, never HTTP-cached, fetched with no-store and a
 * cache-busting query). An open app whose id differs from the published one is out of date. This is
 * decided from /version.json alone: it never waits for the API (which may be waking up).
 *
 * Backend releases: GET /api/v1/version reports `clientCompat`, the lowest web-app compatibility
 * level the API works with. Only a raise above API_COMPAT_LEVEL (below) asks the app to update;
 * restarts and ordinary backend releases never do.
 *
 * When to look: on start-up, when the app comes back to the foreground / is resumed / comes back
 * online, and every 30 min while visible. Every request has a timeout, so one stalled request (a
 * phone put in the background mid-request) can never block later checks.
 *
 * What happens: on start-up (nothing to lose yet) the update is applied at once when it is safe.
 * Otherwise the user sees "Shop-Books has a new update available." with "Update now" / "Later";
 * the update is also applied by itself at the next safe moment (moving to another screen with
 * nothing unsaved). Applying = tell the waiting service worker to take over (it never does so on
 * its own, so files are never swapped under a running page), wait until it is active, show
 * "Updating Shop-Books...", reload ONCE. A reload that did not reach the new version is never
 * repeated automatically: the user is told and "Update now" then also resets the service worker.
 */

/** Raise together with CLIENT_COMPAT_LEVEL in server/src/config/constants.ts (see there). */
export const API_COMPAT_LEVEL = 1;

export const BUILD_ID: string = typeof __SHOP_BOOKS_BUILD_ID__ === 'string' ? __SHOP_BOOKS_BUILD_ID__ : 'dev';

export const MIN_CHECK_INTERVAL_MS = 60_000;
export const PERIODIC_CHECK_MS = 30 * 60_000;
/** A version request that has not answered by then counts as failed (never as "up to date"). */
export const CHECK_TIMEOUT_MS = 10_000;
/** An automatic reload for the same target is not repeated within this window. */
export const RELOAD_GUARD_MS = 10 * 60_000;
/** How long "Updating Shop-Books..." is shown before the reload. */
export const REFRESH_NOTICE_MS = 800;
const ATTEMPT_KEY = 'shop-books:update-attempt';
const CHUNK_RELOAD_KEY = 'shop-books:chunk-reload';

export type UpdateStatus =
  /** Running the latest version (or nothing detected yet). */
  | 'current'
  /** A newer version is published: "Update now" / "Later". Applied by itself when safe. */
  | 'available'
  /** Being applied: "Updating Shop-Books..." then one reload. */
  | 'updating'
  /** Could not be applied (service worker failed, or a reload did not reach it): ask the user. */
  | 'failed';

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
  /** Makes the next page load use the new files (service-worker takeover). False = could not. */
  prepare: () => Promise<boolean>;
  reload: () => void;
  /** Last resort for a stuck service worker: unregister it, drop its caches, reload. */
  hardReload: () => Promise<void>;
  /** True when a reload would not lose anything the user is doing. */
  isSafe: () => boolean;
  onStatus: (status: UpdateStatus) => void;
  /** False while offline: an update is never started without a network. */
  isOnline?: () => boolean;
  storage?: KeyValueStore | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Per-request timeout (CHECK_TIMEOUT_MS). */
  timeoutMs?: number;
}

interface Attempt {
  target: string;
  at: number;
}

/** Resolves to the value, or null on error or when `ms` passes first. */
function settleWithin<T>(promise: () => Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export class AppUpdater {
  private status: UpdateStatus = 'current';
  private target: string | null = null;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private checking: Promise<void> | null = null;
  private applying = false;
  private stopped = false;
  private lastServerVersion: string | null | undefined = undefined;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly isOnline: () => boolean;

  constructor(private readonly deps: AppUpdaterDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.isOnline = deps.isOnline ?? (() => true);
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** The version that is waiting to be applied (null when none). */
  getTarget(): string | null {
    return this.target;
  }

  /** The backend's last reported release label (for diagnostics / tests). */
  getServerVersion(): string | null | undefined {
    return this.lastServerVersion;
  }

  /** On start-up: forget a reload that worked, then check once; an update found now is applied when safe. */
  start(): Promise<void> {
    const attempt = this.readAttempt();
    if (attempt && attempt.target === this.deps.currentBuild) this.deps.storage?.removeItem(ATTEMPT_KEY);
    return this.check(true, true);
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Looks for a newer release. Throttled unless `force`; never runs twice at once. `applyIfSafe`:
   * apply a found update at once when nothing would be lost (start-up), instead of offering it.
   */
  check(force = false, applyIfSafe = false): Promise<void> {
    if (this.stopped || this.status === 'updating') return Promise.resolve();
    if (this.checking) return this.checking;
    if (!force && this.now() - this.lastCheck < MIN_CHECK_INTERVAL_MS) return Promise.resolve();
    this.lastCheck = this.now();
    this.checking = this.runCheck(applyIfSafe).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(applyIfSafe: boolean): Promise<void> {
    const timeout = this.deps.timeoutMs ?? CHECK_TIMEOUT_MS;
    // Both start together; the frontend answer is acted on without waiting for the API.
    const buildRequest = settleWithin(this.deps.fetchBuild, timeout);
    const serverRequest = settleWithin(this.deps.fetchServer, timeout);
    const build = await buildRequest;
    if (this.stopped) return;
    // Unknown is not "up to date": the next trigger (foreground, online…) may check again at once.
    if (build === null) this.lastCheck = Number.NEGATIVE_INFINITY;
    if (build !== null && build !== this.deps.currentBuild) {
      await this.found(build, applyIfSafe);
      return;
    }
    const server = await serverRequest;
    if (this.stopped || !server) return;
    this.lastServerVersion = server.version;
    if (server.clientCompat > this.deps.compatLevel) {
      // The API needs a newer web app than this one. If no newer build is published yet the
      // reload guard stops after one attempt and the user is told instead.
      await this.found(`compat-${server.clientCompat}`, applyIfSafe);
    }
  }

  /** A lazily loaded file of this build is gone (a newer release replaced it): update when safe. */
  async chunkLoadFailed(): Promise<void> {
    await this.check(true, true);
    if (this.target === null) await this.found(`chunk-${this.deps.currentBuild}`, true);
    else if (this.status === 'available') await this.atSafeMoment();
  }

  private async found(target: string, applyIfSafe: boolean): Promise<void> {
    // A newer release than the one already on offer is announced again (even with the same status).
    const changed = this.target !== target;
    this.target = target;
    if (this.recentlyAttempted(target)) {
      // Already reloaded once for this release and still not on it: never loop.
      this.setStatus('failed', changed);
      return;
    }
    if (applyIfSafe && this.deps.isSafe()) await this.apply(true);
    else this.setStatus('available', changed);
  }

  /** Call when the user may have finished (moved to another screen): applies a waiting update if safe. */
  async atSafeMoment(): Promise<void> {
    if (this.status === 'available' && this.deps.isSafe()) await this.apply(true);
  }

  /** "Update now". After a failure the service worker is reset as well. */
  async updateNow(): Promise<void> {
    if (this.status === 'failed') {
      if (this.isOnline()) await this.deps.hardReload();
      return;
    }
    await this.apply(false);
  }

  private async apply(automatic: boolean): Promise<void> {
    const target = this.target;
    if (target === null || this.applying || this.stopped) return;
    if (!this.isOnline()) {
      // The new files cannot be fetched offline: keep offering it; `online` checks again.
      this.setStatus('available');
      return;
    }
    if (automatic && this.recentlyAttempted(target)) {
      this.setStatus('failed');
      return;
    }
    this.applying = true;
    this.setStatus('updating');
    try {
      const ready = await this.deps.prepare().catch(() => false);
      if (this.stopped) return;
      if (!ready) {
        this.setStatus('failed');
        return;
      }
      await this.wait(REFRESH_NOTICE_MS);
      if (this.stopped) return;
      if (automatic && !this.deps.isSafe()) {
        // The user started typing while the notice was showing.
        this.setStatus('available');
        return;
      }
      this.writeAttempt({ target, at: this.now() });
      this.deps.reload();
    } finally {
      this.applying = false;
    }
  }

  private recentlyAttempted(target: string): boolean {
    const attempt = this.readAttempt();
    return attempt !== null && attempt.target === target && this.now() - attempt.at < RELOAD_GUARD_MS;
  }

  private setStatus(status: UpdateStatus, announce = false): void {
    if (this.status === status && !announce) return;
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
      // Private mode / storage full: the in-memory `applying` flag still prevents a loop now.
    }
  }
}

// --- Browser implementations ----------------------------------------------------------------

/**
 * GET /version.json from the web host, bypassing every cache: `no-store` for the browser, a unique
 * query so no proxy/CDN copy can match, and the service worker never caches it. Anything that is
 * not this app's version file (an HTML fallback page, an error, a captive portal) counts as unknown.
 */
export async function fetchPublishedBuild(): Promise<string | null> {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  const body = (await res.json()) as { buildId?: unknown };
  return typeof body.buildId === 'string' && /^[\w.-]{1,100}$/.test(body.buildId) ? body.buildId : null;
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

/**
 * Registers the service worker (production builds only). `updateViaCache: 'none'`: the browser's
 * own update checks always fetch sw.js and its imports from the network. Failures are never fatal.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  } catch {
    console.warn('Service worker registration failed');
  }
}

/**
 * Fetches the newest service worker and makes it take over, so the next load is served the new
 * index.html and assets. The worker never takes over by itself (no automatic skipWaiting): it
 * installs next to the running page and waits for this message. True when there is nothing to wait for.
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
  if (!worker) return true; // the active worker is already the newest
  if (worker.state === 'activated') return true;
  const takeOver = () => worker.postMessage({ type: 'SKIP_WAITING' });
  if (worker.state === 'installed') takeOver();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') takeOver();
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
  // Offline, the precache is the only copy of the app: never throw it away then.
  if (navigator.onLine === false) return;
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
