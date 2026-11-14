import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdater, fetchPublishedBuild, isChunkLoadError, MIN_CHECK_INTERVAL_MS, RELOAD_GUARD_MS, reloadOnceForChunkError, type AppUpdaterDeps, type ServerVersion, type UpdateStatus } from './app-update';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

interface Harness {
  updater: AppUpdater;
  deps: AppUpdaterDeps;
  statuses: UpdateStatus[];
  reload: ReturnType<typeof vi.fn>;
  hardReload: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  fetchBuild: ReturnType<typeof vi.fn>;
  fetchServer: ReturnType<typeof vi.fn>;
  state: { build: string | null; server: ServerVersion | null; safe: boolean; time: number; online: boolean };
}

/** One "page load" of the app. Pass the same storage to simulate the page after a reload. */
function load(opts: { currentBuild?: string; build?: string | null; server?: ServerVersion | null; safe?: boolean; storage?: MemoryStorage; prepareOk?: boolean } = {}): Harness {
  const state = {
    build: opts.build === undefined ? 'build-A' : opts.build,
    server: opts.server === undefined ? { version: '1.0', clientCompat: 1 } : opts.server,
    safe: opts.safe ?? true,
    time: 1_000_000,
    online: true,
  };
  const statuses: UpdateStatus[] = [];
  const reload = vi.fn();
  const hardReload = vi.fn(async () => undefined);
  const prepare = vi.fn(async () => opts.prepareOk ?? true);
  const fetchBuild = vi.fn(async () => state.build);
  const fetchServer = vi.fn(async () => state.server);
  const deps: AppUpdaterDeps = {
    currentBuild: opts.currentBuild ?? 'build-A',
    compatLevel: 1,
    fetchBuild,
    fetchServer,
    prepare,
    reload,
    hardReload,
    isSafe: () => state.safe,
    onStatus: (s) => statuses.push(s),
    storage: opts.storage ?? new MemoryStorage(),
    now: () => state.time,
    wait: async () => undefined,
    isOnline: () => state.online,
    timeoutMs: 50,
  };
  return { updater: new AppUpdater(deps), deps, statuses, reload, hardReload, prepare, fetchBuild, fetchServer, state };
}

describe('frontend releases', () => {
  it('stays put while the published build is this build', async () => {
    const h = load();
    await h.updater.start();
    expect(h.updater.getStatus()).toBe('current');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('on start-up a new build is applied at once when nothing is unsaved: service worker first, one reload', async () => {
    const h = load({ build: 'build-B' });
    await h.updater.start();
    expect(h.statuses).toEqual(['updating']);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.prepare.mock.invocationCallOrder[0]!).toBeLessThan(h.reload.mock.invocationCallOrder[0]!);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('while the app is open (foreground / periodic check) the update is offered, not forced: "Update now" applies it', async () => {
    const h = load();
    await h.updater.start();
    h.state.build = 'build-B';
    h.state.time += MIN_CHECK_INTERVAL_MS;
    await h.updater.check();
    expect(h.updater.getStatus()).toBe('available');
    expect(h.updater.getTarget()).toBe('build-B');
    expect(h.reload).not.toHaveBeenCalled();

    await h.updater.updateNow();
    expect(h.statuses).toEqual(['available', 'updating']);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('an offered update is applied by itself at the next safe moment (another screen)', async () => {
    const h = load();
    await h.updater.start();
    h.state.build = 'build-B';
    await h.updater.check(true);
    h.state.safe = false;
    await h.updater.atSafeMoment();
    expect(h.reload).not.toHaveBeenCalled();
    h.state.safe = true;
    await h.updater.atSafeMoment();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('after a successful reload the new page forgets the attempt (a later release updates again)', async () => {
    const storage = new MemoryStorage();
    const a = load({ build: 'build-B', storage });
    await a.updater.start();
    expect(a.reload).toHaveBeenCalledTimes(1);

    const b = load({ currentBuild: 'build-B', build: 'build-B', storage });
    await b.updater.start();
    expect(b.updater.getStatus()).toBe('current');
    b.state.build = 'build-C';
    await b.updater.check(true);
    await b.updater.updateNow();
    expect(b.reload).toHaveBeenCalledTimes(1);
  });

  it('never loops: if the reload did not reach the new build, the user is told and "Update now" resets the service worker', async () => {
    const storage = new MemoryStorage();
    const a = load({ build: 'build-B', storage });
    await a.updater.start();
    expect(a.reload).toHaveBeenCalledTimes(1);

    // Same old build again (e.g. the service worker served the old files).
    const b = load({ build: 'build-B', storage });
    await b.updater.start();
    expect(b.reload).not.toHaveBeenCalled();
    expect(b.updater.getStatus()).toBe('failed');
    await b.updater.updateNow();
    expect(b.hardReload).toHaveBeenCalledTimes(1);
  });

  it('a failed service-worker update is reported instead of reloading into old files', async () => {
    const h = load({ build: 'build-B', prepareOk: false });
    await h.updater.start();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.updater.getStatus()).toBe('failed');
  });

  it('a newer version that is already installed (waiting) is used: prepare succeeds and one reload follows', async () => {
    const h = load();
    await h.updater.start();
    h.state.build = 'build-B';
    await h.updater.check(true);
    await h.updater.updateNow();
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe('network problems', () => {
  it('cannot reach /version.json or the API: no change, no reload, and the next trigger checks again at once', async () => {
    const h = load({ build: null, server: null });
    await h.updater.start();
    expect(h.updater.getStatus()).toBe('current');
    expect(h.reload).not.toHaveBeenCalled();
    h.state.build = 'build-B';
    await h.updater.check(); // not throttled: the last check did not get an answer
    expect(h.updater.getStatus()).toBe('available');
  });

  it('a request that never answers times out instead of blocking every later check', async () => {
    const h = load();
    h.fetchBuild.mockImplementationOnce(() => new Promise(() => undefined));
    h.fetchServer.mockImplementationOnce(() => new Promise(() => undefined));
    await h.updater.start(); // resolves after the 50 ms test timeout
    expect(h.updater.getStatus()).toBe('current');
    h.state.build = 'build-B';
    await h.updater.check();
    expect(h.updater.getStatus()).toBe('available');
  });

  it('a slow or sleeping API never delays detecting a new frontend build', async () => {
    const h = load();
    await h.updater.start();
    h.fetchServer.mockImplementationOnce(() => new Promise(() => undefined));
    h.state.build = 'build-B';
    const started = Date.now();
    await h.updater.check(true);
    expect(h.updater.getStatus()).toBe('available');
    expect(Date.now() - started).toBeLessThan(45);
  });

  it('offline: the update is kept on offer and never started', async () => {
    const h = load();
    await h.updater.start();
    h.state.build = 'build-B';
    await h.updater.check(true);
    h.state.online = false;
    await h.updater.updateNow();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.updater.getStatus()).toBe('available');
  });
});

describe('unsaved work', () => {
  it('on start-up with unsaved input (restored form) the update is only offered, then applied once it is safe', async () => {
    const h = load({ build: 'build-B', safe: false });
    await h.updater.start();
    expect(h.updater.getStatus()).toBe('available');
    expect(h.reload).not.toHaveBeenCalled();
    h.state.safe = true;
    await h.updater.atSafeMoment();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('goes back to "available" if the user starts typing while "Updating..." is shown', async () => {
    const h = load({ build: 'build-B' });
    const updater = new AppUpdater({
      ...h.deps,
      wait: async () => {
        h.state.safe = false;
      },
    });
    await updater.start();
    expect(h.reload).not.toHaveBeenCalled();
    expect(updater.getStatus()).toBe('available');
  });
});

describe('backend releases', () => {
  it('a backend restart or a new release label alone never reloads the app', async () => {
    const h = load();
    await h.updater.start();
    h.state.server = { version: '2.0', clientCompat: 1 };
    await h.updater.check(true);
    h.state.server = null; // restarting
    await h.updater.check(true);
    expect(h.updater.getStatus()).toBe('current');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a backend that needs a newer web app (compat raised) is offered as an update; it never loops', async () => {
    const storage = new MemoryStorage();
    const a = load({ server: { version: '2', clientCompat: 2 }, storage });
    await a.updater.start();
    expect(a.reload).toHaveBeenCalledTimes(1);
    const b = load({ server: { version: '2', clientCompat: 2 }, storage });
    await b.updater.start();
    expect(b.reload).not.toHaveBeenCalled();
    expect(b.updater.getStatus()).toBe('failed');
  });

  it('allows another automatic attempt only after the guard window', async () => {
    const storage = new MemoryStorage();
    const a = load({ build: 'build-B', storage });
    await a.updater.start();
    const b = load({ build: 'build-B', storage });
    b.state.time += RELOAD_GUARD_MS + 1;
    await b.updater.start();
    expect(b.reload).toHaveBeenCalledTimes(1);
  });
});

describe('checks are cheap', () => {
  it('throttles foreground checks and never runs two at once', async () => {
    const h = load();
    await h.updater.start();
    await h.updater.check();
    expect(h.fetchBuild).toHaveBeenCalledTimes(1);
    h.state.time += MIN_CHECK_INTERVAL_MS;
    await Promise.all([h.updater.check(), h.updater.check()]);
    expect(h.fetchBuild).toHaveBeenCalledTimes(2);
  });
});

describe('the published version file', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is fetched with caching disabled and a unique query, and only a real version file counts', async () => {
    const fetchMock = vi.fn(async () => Response.json({ buildId: '20261114-abc' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchPublishedBuild()).toBe('20261114-abc');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/version\.json\?t=\d+$/);
    expect(init.cache).toBe('no-store');

    // The SPA fallback (index.html) or an error page is "unknown", never a version.
    fetchMock.mockImplementationOnce(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    expect(await fetchPublishedBuild()).toBeNull();
    fetchMock.mockImplementationOnce(async () => Response.json({}, { status: 503 }));
    expect(await fetchPublishedBuild()).toBeNull();
    fetchMock.mockImplementationOnce(async () => Response.json({ buildId: '<script>' }));
    expect(await fetchPublishedBuild()).toBeNull();
  });
});

describe('missing chunks after a deployment', () => {
  it('reloads once to the new release', async () => {
    const h = load();
    await h.updater.start();
    await h.updater.chunkLoadFailed();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('recognises chunk errors from all browsers', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Rendered more hooks than during the previous render.'))).toBe(false);
  });

  it('the error boundary reloads at most once per guard window', () => {
    const storage = new MemoryStorage();
    const reload = vi.fn();
    expect(reloadOnceForChunkError(storage, 1000, reload)).toBe(true);
    expect(reloadOnceForChunkError(storage, 2000, reload)).toBe(false);
    expect(reloadOnceForChunkError(storage, 1000 + RELOAD_GUARD_MS + 1, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
