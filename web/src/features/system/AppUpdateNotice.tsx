import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert } from 'lucide-react';
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

/** "Later" hides the notice for that one version only (a newer release is shown again). */
const DISMISSED_KEY = 'shop-books:update-dismissed';

export const UPDATE_TEXT = {
  available: 'Shop-Books has a new update available.',
  availableDetail: 'A newer version is ready with improvements and fixes.',
  availableBusy: 'Finish and save what you are doing first. It updates by itself when you leave this screen.',
  updating: 'Updating Shop-Books...',
  updatingDetail: 'Installing the latest version. This takes a few seconds.',
  failed: 'Shop-Books could not update by itself.',
  failedDetail: 'Tap Update now to try again.',
} as const;

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
    isOnline: () => navigator.onLine !== false,
    storage: safeSessionStorage(),
  });
}

function readDismissed(): string | null {
  try {
    return safeSessionStorage()?.getItem(DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

interface AppUpdateNoticeProps {
  /** Off in development and unit tests (there is no published build to compare with). */
  enabled?: boolean;
  /** Test seam. */
  createUpdater?: (hooks: UpdaterHooks) => AppUpdater;
}

/**
 * Detects new releases (see app-update.ts) and shows a small notice: "new update available" with
 * Update now / Later, "Updating Shop-Books...", or "could not update". Mounted once, inside the router
 * (moving to another screen is a safe moment to update) and the query client (saves in flight).
 */
export function AppUpdateNotice({ enabled = import.meta.env.PROD && BUILD_ID !== 'dev', createUpdater = createBrowserUpdater }: AppUpdateNoticeProps) {
  const queryClient = useQueryClient();
  const location = useLocation();
  // The target is part of the state so that a newer release re-renders (and is shown after "Later").
  const [{ status, target }, setState] = useState<{ status: UpdateStatus; target: string | null }>({ status: 'current', target: null });
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const updaterRef = useRef<AppUpdater | null>(null);
  const isSafe = () => isSafeToReload({ mutationsInFlight: queryClient.isMutating() });

  useEffect(() => {
    if (!enabled) return;
    const stopTracking = trackUnsavedWork();
    const updater: AppUpdater = createUpdater({
      isSafe: () => isSafeToReload({ mutationsInFlight: queryClient.isMutating() }),
      onStatus: (next) => setState({ status: next, target: updater.getTarget() }),
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
    // Android may freeze a backgrounded PWA instead of hiding it; `resume` is its way back.
    document.addEventListener('resume', check);
    window.addEventListener('online', check);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('vite:preloadError', onPreloadError);
    const periodic = window.setInterval(check, PERIODIC_CHECK_MS);
    return () => {
      updater.stop();
      updaterRef.current = null;
      stopTracking();
      document.removeEventListener('visibilitychange', check);
      document.removeEventListener('resume', check);
      window.removeEventListener('online', check);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('vite:preloadError', onPreloadError);
      window.clearInterval(periodic);
    };
  }, [enabled, createUpdater, queryClient]);

  // A new screen: what was typed on the previous one was saved or left on purpose. A safe moment.
  useEffect(() => {
    resetUnsavedWork();
    void updaterRef.current?.atSafeMoment();
  }, [location.pathname, location.search]);

  if (status === 'current') return null;
  if ((status === 'available' || status === 'failed') && target !== null && dismissed === target) return null;

  const updateNow = () => {
    if (hasUnsavedInput() && !window.confirm('Update now? Anything you have not saved on this screen will be lost.')) return;
    void updaterRef.current?.updateNow();
  };
  const later = () => {
    setDismissed(target);
    try {
      if (target) safeSessionStorage()?.setItem(DISMISSED_KEY, target);
    } catch {
      // Not remembered after a reload; still hidden now.
    }
  };

  const title = status === 'updating' ? UPDATE_TEXT.updating : status === 'failed' ? UPDATE_TEXT.failed : UPDATE_TEXT.available;
  const detail =
    status === 'updating'
      ? UPDATE_TEXT.updatingDetail
      : status === 'failed'
        ? UPDATE_TEXT.failedDetail
        : isSafe()
          ? UPDATE_TEXT.availableDetail
          : UPDATE_TEXT.availableBusy;
  const Icon = status === 'failed' ? TriangleAlert : RefreshCw;

  return (
    // In the page flow (above the app frame) and sticky: it takes its own space instead of covering
    // the header's back links or a form's fields and buttons, and stays visible while scrolling.
    <div className="sticky top-0 z-30 flex justify-center bg-background/95 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur">
      <section
        aria-labelledby="app-update-title"
        data-testid="app-update-notice"
        data-status={status}
        className="w-full max-w-xl rounded-2xl border border-primary/25 bg-card p-4 shadow-raised"
      >
        <div className="flex items-start gap-3" role="status" aria-live="polite">
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-10 shrink-0 items-center justify-center rounded-full',
              status === 'failed' ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary',
            )}
          >
            <Icon className={cn('size-5', status === 'updating' && 'animate-spin')} />
          </span>
          <div className="min-w-0 flex-1">
            <p id="app-update-title" className="text-base font-semibold leading-snug">
              {title}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>
          </div>
        </div>
        {status !== 'updating' && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button size="lg" className="h-11 text-base sm:min-w-36" onClick={updateNow}>
              Update now
            </Button>
            <Button size="lg" variant="outline" className="h-11 text-base sm:min-w-28" onClick={later}>
              Later
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
