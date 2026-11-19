import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EXIT_MS, motionAllowed } from '@/lib/motion';
import { cn } from '@/lib/utils';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /**
   * Stable identity: a toast with an id that is already showing (or was shown recently) is not
   * shown again. Used for update notifications, so a replayed change never notifies twice.
   */
  id?: string;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  key: string;
  description: string | undefined;
  /** Playing its exit animation; removed right after. */
  leaving?: boolean;
}

type ToastFn = (toast: ToastInput) => void;

const ToastContext = createContext<ToastFn | null>(null);

/** Most toasts shown at once; older ones are dropped first. */
const MAX_VISIBLE = 3;
const DURATION_MS: Record<ToastTone, number> = { success: 4000, info: 6000, error: 8000 };
/** Ids remembered for de-duplication (bounded). */
const SEEN_LIMIT = 500;

const TONE_ICON = { success: CheckCircle2, error: TriangleAlert, info: Info } as const;

/**
 * Small, non-blocking in-app notifications. They never take focus, never cover the main action
 * (bottom-right on desktop; above the bottom bar on phones) and dismiss themselves.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seen = useRef(new Set<string>());
  const counter = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    if (!motionAllowed()) {
      setItems((list) => list.filter((t) => t.key !== key));
      return;
    }
    setItems((list) => list.map((t) => (t.key === key ? { ...t, leaving: true } : t)));
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        setItems((list) => list.filter((t) => t.key !== key || !t.leaving));
      }, EXIT_MS),
    );
  }, []);

  const show = useCallback<ToastFn>(
    ({ title, description, tone = 'info', id }) => {
      if (id !== undefined) {
        if (seen.current.has(id)) return;
        seen.current.add(id);
        if (seen.current.size > SEEN_LIMIT) seen.current.delete(seen.current.values().next().value!);
      }
      counter.current += 1;
      const key = id ?? `toast-${counter.current}`;
      const previous = timers.current.get(key);
      if (previous) clearTimeout(previous);
      setItems((list) => [...list.filter((t) => t.key !== key), { key, title, description, tone }].slice(-MAX_VISIBLE));
      timers.current.set(
        key,
        setTimeout(() => dismiss(key), DURATION_MS[tone]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom)+0.75rem)] z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-4 md:right-4 md:items-end"
        data-testid="toast-region"
      >
        {items.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div
              key={t.key}
              role={t.tone === 'error' ? 'alert' : 'status'}
              data-state={t.leaving ? 'leaving' : 'open'}
              className={cn(
                'pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-xl border bg-card py-3 pl-4 pr-3 text-sm shadow-raised',
                'animate-[toast-in_var(--dur-slow)_var(--ease-out)_backwards] data-[state=leaving]:animate-[toast-out_var(--dur-base)_ease-in_forwards]',
              )}
            >
              {/* Tone rail: colour supports the icon and the words, never replaces them. */}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute inset-y-0 left-0 w-1',
                  t.tone === 'success' && 'bg-primary',
                  t.tone === 'error' && 'bg-destructive',
                  t.tone === 'info' && 'bg-info',
                )}
              />
              <span
                className={cn(
                  'mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full',
                  t.tone === 'success' && 'bg-primary-soft text-primary',
                  t.tone === 'error' && 'bg-destructive-soft text-destructive',
                  t.tone === 'info' && 'bg-info-soft text-info',
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="font-semibold leading-5">{t.title}</p>
                {t.description && <p className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground">{t.description}</p>}
              </div>
              <button
                type="button"
                className="-my-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.key)}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a toast. Outside a ToastProvider (isolated component tests) it does nothing. */
export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  return useMemo(() => ctx ?? (() => undefined), [ctx]);
}
