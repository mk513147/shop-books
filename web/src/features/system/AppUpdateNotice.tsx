import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  API_COMPAT_LEVEL,
  AppUpdater,
  BUILD_ID,
  fetchPublishedBuild,
  fetchServerVersion,
  hardReload,
  PERIODIC_CHECK_MS,
  prepareServiceWorker,
  safeSessionStorage,
  type UpdateStatus,
} from './app-update';
import { hasUnsavedInput, isSafeToReload, resetUnsavedWork, trackUnsavedWork } from './unsaved-work';

/** While an update waits for unsaved work, how often "is it safe now?" is re-checked (local only). */
const SAFE_RECHECK_MS = 3000;

export const UPDATE_MESSAGES: Record<Exclude<UpdateStatus, 'current'>, string> = {
  refreshing: 'Shop-Books has been updated. Refreshing to the latest version…',
  waiting: 'Shop-Books has been updated. It will refresh after you save or leave this screen.',
  manual: 'Shop-Books has been updated. Tap Refresh to load the latest version.',
};

export interface UpdaterHooks {
  isSafe: () => boolean;
  onStatus: (status: UpdateStatus) => void;
}

function createBrowserUpdater({ isSafe, onStatus }: UpdaterHooks): AppUpdater {
  return new AppUpdater({
    currentBuild: BUILD_ID,
    compatLevel: API_COMPAT_LEVEL,
    fetchBuild: fetchPublishedBuild,
    fetchServer: fetchServerVersion,
    prepare: () => prepareServiceWorker(),
    reload: () => window.location.reload(),
    hardReload,
    isSafe,
    onStatus,
    storage: safeSessionStorage(),
  });
}

interface AppUpdateNoticeProps {
  /** Off in development and unit tests (there is no published build to compare with). */
  enabled?: boolean;
  /** Test seam. */
  createUpdater?: (hooks: UpdaterHooks) => AppUpdater;
}

/**
 * Detects new releases and refreshes the app when it is safe (see app-update.ts), with a small
 * banner: "refreshing…", "will refresh after you save", or a Refresh button. Mounted once, inside
 * the router (navigation is when unsaved work ends) and the query client (saves in flight).
 */
export function AppUpdateNotice({ enabled = import.meta.env.PROD && BUILD_ID !== 'dev', createUpdater = createBrowserUpdater }: AppUpdateNoticeProps) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [status, setStatus] = useState<UpdateStatus>('current');
  const updaterRef = useRef<AppUpdater | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const stopTracking = trackUnsavedWork();
    const updater = createUpdater({
      isSafe: () => isSafeToReload({ mutationsInFlight: queryClient.isMutating() }),
      onStatus: setStatus,
    });
    updaterRef.current = updater;
    void updater.start();

    const check = () => {
      if (document.visibilityState === 'visible') void updater.check();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void updater.check(true);
    };
    const onPreloadError = (e: Event) => {
      // A lazily loaded file from this (now replaced) build is gone: do not show a blank page.
      e.preventDefault();
      void updater.chunkLoadFailed();
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('vite:preloadError', onPreloadError);
    const periodic = window.setInterval(check, PERIODIC_CHECK_MS);
    const safety = window.setInterval(() => void updater.safeNow(), SAFE_RECHECK_MS);
    return () => {
      updater.stop();
      updaterRef.current = null;
      stopTracking();
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('vite:preloadError', onPreloadError);
      window.clearInterval(periodic);
      window.clearInterval(safety);
    };
  }, [enabled, createUpdater, queryClient]);

  // A new screen: what was typed on the previous one was saved or left on purpose.
  useEffect(() => {
    resetUnsavedWork();
    void updaterRef.current?.safeNow();
  }, [location.pathname, location.search]);

  if (status === 'current') return null;

  const refresh = () => {
    if (status === 'waiting' && hasUnsavedInput() && !window.confirm('Refresh now? Anything you have not saved on this screen will be lost.')) return;
    void updaterRef.current?.refreshNow();
  };

  return (
    // In the page flow (above the app frame) and sticky: it takes its own space instead of covering
    // the header's back links or a form's buttons, and stays visible while scrolling.
    <div className="sticky top-0 z-30 flex justify-center bg-background/95 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur">
      <div
        role="status"
        aria-live="polite"
        data-testid="app-update-notice"
        className="flex w-full max-w-lg items-center gap-3 rounded-xl border border-primary/25 bg-card p-3 text-sm shadow-raised"
      >
        <RefreshCw className={cn('size-4 shrink-0 text-primary', status === 'refreshing' && 'animate-spin')} aria-hidden="true" />
        <p className="min-w-0 flex-1">{UPDATE_MESSAGES[status]}</p>
        {status !== 'refreshing' && (
          <Button size="sm" onClick={refresh}>
            Refresh
          </Button>
        )}
      </div>
    </div>
  );
}
