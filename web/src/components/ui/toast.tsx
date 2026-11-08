import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
    setItems((list) => list.filter((t) => t.key !== key));
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
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
        className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-4 md:right-4 md:items-end"
        data-testid="toast-region"
      >
        {items.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div
              key={t.key}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-card p-3 text-sm shadow-raised',
                t.tone === 'error' && 'border-destructive/30',
              )}
            >
              <Icon
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  t.tone === 'success' && 'text-primary',
                  t.tone === 'error' && 'text-destructive',
                  t.tone === 'info' && 'text-muted-foreground',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
              </div>
              <button
                type="button"
                className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
