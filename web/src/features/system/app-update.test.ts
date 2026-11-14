import { describe, expect, it, vi } from 'vitest';
import { AppUpdater, isChunkLoadError, MIN_CHECK_INTERVAL_MS, RELOAD_GUARD_MS, reloadOnceForChunkError, type AppUpdaterDeps, type ServerVersion, type UpdateStatus } from './app-update';

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
  state: { build: string | null; server: ServerVersion | null; safe: boolean; time: number };
}

/** One "page load" of the app. Pass the same storage to simulate the page after a reload. */
function load(opts: { currentBuild?: string; build?: string | null; server?: ServerVersion | null; safe?: boolean; storage?: MemoryStorage; prepareOk?: boolean } = {}): Harness {
  const state = {
    build: opts.build === undefined ? 'build-A' : opts.build,
    server: opts.server === undefined ? { version: '1.0', clientCompat: 1 } : opts.server,
    safe: opts.safe ?? true,
    time: 1_000_000,
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

  it('refreshes once, after preparing the service worker, when a new build is published and nothing is unsaved', async () => {
    const h = load({ build: 'build-B' });
    await h.updater.start();
    expect(h.statuses).toEqual(['refreshing']);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.prepare.mock.invocationCallOrder[0]!).toBeLessThan(h.reload.mock.invocationCallOrder[0]!);
    expect(h.reload).toHaveBeenCalledTimes(1);
    // Further triggers while refreshing do nothing.
    h.state.time += MIN_CHECK_INTERVAL_MS * 2;
    await h.updater.check(true);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('after a successful reload the new page forgets the attempt (a later release refreshes again)', async () => {
    const storage = new MemoryStorage();
    const first = load({ build: 'build-B', storage });
    await first.updater.start();
    expect(first.reload).toHaveBeenCalledTimes(1);

    const second = load({ currentBuild: 'build-B', build: 'build-B', storage });
    await second.updater.start();
    expect(second.updater.getStatus()).toBe('current');

    const third = load({ currentBuild: 'build-B', build: 'build-C', storage });
    await third.updater.start();
    expect(third.reload).toHaveBeenCalledTimes(1);
  });

  it('never loops: if the reload did not reach the new build, the user is asked instead', async () => {
    const storage = new MemoryStorage();
    const first = load({ build: 'build-B', storage });
    await first.updater.start();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // Same old build came back (stale cache): no second automatic reload.
    const second = load({ currentBuild: 'build-A', build: 'build-B', storage });
    await second.updater.start();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.updater.getStatus()).toBe('manual');
    // The Refresh button resets the service worker instead of reloading into the same cache.
    await second.updater.refreshNow();
    expect(second.hardReload).toHaveBeenCalledTimes(1);
  });

  it('a failed service-worker update asks the user instead of reloading into old files', async () => {
    const h = load({ build: 'build-B', prepareOk: false });
    await h.updater.start();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.updater.getStatus()).toBe('manual');
  });

  it('cannot reach /version.json or the API: no change, no reload', async () => {
    const h = load({ build: null, server: null });
    h.fetchBuild.mockRejectedValueOnce(new TypeError('offline'));
    await h.updater.start();
    expect(h.updater.getStatus()).toBe('current');
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe('unsaved work', () => {
  it('defers the refresh with a prompt while the user has unsaved input, then refreshes once it is safe', async () => {
    const h = load({ build: 'build-B', safe: false });
    await h.updater.start();
    expect(h.updater.getStatus()).toBe('waiting');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();

    await h.updater.safeNow(); // still unsafe
    expect(h.reload).not.toHaveBeenCalled();

    h.state.safe = true; // saved / left the form
    await h.updater.safeNow();
    expect(h.statuses).toEqual(['waiting', 'refreshing']);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('goes back to waiting if the user starts typing while "Refreshing…" is shown', async () => {
    const h = load({ build: 'build-B' });
    let calls = 0;
    h.deps.isSafe = () => ++calls === 1; // safe at first, not after the notice delay
    await h.updater.start();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.updater.getStatus()).toBe('waiting');
  });
});

describe('backend releases', () => {
  it('a backend restart or a new release label alone never reloads the app', async () => {
    const h = load({ server: { version: '1.0', clientCompat: 1 } });
    await h.updater.start();
    h.state.server = { version: '1.1', clientCompat: 1 };
    h.state.time += MIN_CHECK_INTERVAL_MS + 1;
    await h.updater.check();
    expect(h.updater.getServerVersion()).toBe('1.1');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.updater.getStatus()).toBe('current');
  });

  it('a backend that needs a newer web app (compat raised) refreshes once, then asks', async () => {
    const storage = new MemoryStorage();
    const first = load({ server: { version: '2.0', clientCompat: 2 }, storage });
    await first.updater.start();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // No newer frontend was published yet: same build after the reload -> ask, do not loop.
    const second = load({ server: { version: '2.0', clientCompat: 2 }, storage });
    await second.updater.start();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.updater.getStatus()).toBe('manual');
  });

  it('allows another automatic attempt only after the guard window', async () => {
    const storage = new MemoryStorage();
    const first = load({ server: { version: '2.0', clientCompat: 2 }, storage });
    await first.updater.start();
    const later = load({ server: { version: '2.0', clientCompat: 2 }, storage });
    later.state.time += RELOAD_GUARD_MS + 1;
    await later.updater.start();
    expect(later.reload).toHaveBeenCalledTimes(1);
  });
});

describe('checks are cheap', () => {
  it('throttles foreground checks and never runs two at once', async () => {
    const h = load();
    await h.updater.start();
    expect(h.fetchBuild).toHaveBeenCalledTimes(1);
    await h.updater.check(); // within the interval: skipped
    expect(h.fetchBuild).toHaveBeenCalledTimes(1);
    h.state.time += MIN_CHECK_INTERVAL_MS + 1;
    await Promise.all([h.updater.check(), h.updater.check(), h.updater.check()]);
    expect(h.fetchBuild).toHaveBeenCalledTimes(2);
    expect(h.fetchServer).toHaveBeenCalledTimes(2);
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
