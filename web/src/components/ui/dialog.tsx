import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { EXIT_MS, motionAllowed } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { KEYBOARD_MIN_PX, useViewportInset } from '@/lib/visual-viewport';

interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** Called on Esc, the close button or a backdrop tap (unless `dismissible` is false). */
  onClose: () => void;
  dismissible?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Rendered in a non-scrolling footer (e.g. the dialog's buttons). */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * For searchable pickers: a steady height (centred panel on desktop; on a phone with the keyboard
 * open, the whole visible area above the keyboard), so the list does not jump while filtering.
 */
export const SEARCH_SHEET_CLASS = 'md:h-[min(36rem,85dvh)] max-md:data-[keyboard=open]:h-[calc(var(--vv-height)-0.5rem)]';

const WIDTHS = { sm: 'md:w-[min(28rem,calc(100vw-2rem))]', md: 'md:w-[min(34rem,calc(100vw-2rem))]', lg: 'md:w-[min(44rem,calc(100vw-2rem))]' };

/**
 * Modal built on native <dialog> (focus trap, Esc and top-layer stacking for free).
 * Phones: a bottom sheet that slides up, fits the screen, scrolls internally and respects the safe
 * area. With the on-screen keyboard open it sits on top of the keyboard and shrinks to the visible
 * area (see lib/visual-viewport.ts), so inputs and search results are never hidden behind it.
 * Desktop: a centred panel that eases in. Closing plays a short exit (skipped with reduced motion);
 * the last content stays on screen during it, so nothing flickers or reads cleared state.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  dismissible = true,
  size = 'md',
  footer,
  className,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const id = useId();
  const [closing, setClosing] = useState(false);
  // What was on screen while open: shown during the exit animation.
  const shown = useRef({ title, description, footer, children });
  if (open) shown.current = { title, description, footer, children };
  const visible = open || closing;
  const content = open ? { title, description, footer, children } : shown.current;

  const inset = useViewportInset(visible);
  const keyboardOpen = inset !== null && inset.bottom >= KEYBOARD_MIN_PX;
  const viewportStyle = inset
    ? ({ '--kb-bottom': `${inset.bottom}px`, '--vv-height': `${inset.height}px` } as CSSProperties)
    : undefined;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const close = () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
    if (open) {
      setClosing(false);
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      return;
    }
    if (!dialog.open) return;
    if (!motionAllowed()) {
      close();
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      close();
      setClosing(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      data-keyboard={keyboardOpen ? 'open' : undefined}
      data-state={closing ? 'closing' : undefined}
      style={viewportStyle}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible && open) onClose();
      }}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Target is the <dialog> itself only on the backdrop. Requiring the press to start there
        // too stops a text selection dragged outside from closing a half-filled form.
        if (e.target === e.currentTarget && pressedBackdrop.current && dismissible && open) onClose();
      }}
      className={cn(
        'border bg-card p-0 text-card-foreground shadow-raised backdrop:bg-[oklch(0.2_0.02_250/0.45)] backdrop:backdrop-blur-[2px]',
        // phone: bottom sheet, lifted above the on-screen keyboard and never taller than what is visible
        'mx-0 mt-auto mb-[var(--kb-bottom,0px)] max-h-[min(92dvh,calc(var(--vv-height,100dvh)-0.5rem))] w-full max-w-none rounded-t-2xl',
        // desktop: centred panel
        'md:m-auto md:max-h-[85dvh] md:rounded-2xl',
        WIDTHS[size],
        visible ? 'flex flex-col' : '',
        closing && 'pointer-events-none',
        className,
      )}
    >
      {visible && (
        <>
          {/* Grab handle: tells phone users this is a sheet over the page. */}
          <div aria-hidden="true" className="flex justify-center pt-2 md:hidden">
            <span className="h-1 w-9 rounded-full bg-surface-strong" />
          </div>
          <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-2 md:px-6 md:pt-5">
            <div className="min-w-0 space-y-1">
              <h2 id={`${id}-title`} className="text-[1.0625rem] font-semibold tracking-[-0.01em]">
                {content.title}
              </h2>
              {content.description && <div className="text-sm text-muted-foreground">{content.description}</div>}
            </div>
            {dismissible && (
              <button
                type="button"
                onClick={() => open && onClose()}
                className="-mr-2 -mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Close"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-4 py-4 md:px-6">{content.children}</div>
          {content.footer && (
            <div className="border-t bg-surface-muted/60 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:rounded-b-2xl md:px-6 md:pb-4 md:pt-4">
              {content.footer}
            </div>
          )}
          {!content.footer && !keyboardOpen && <div className="pb-[env(safe-area-inset-bottom)] md:pb-0" />}
        </>
      )}
    </dialog>
  );
}

/** Standard button row for dialog footers: stacked full-width on phones, right-aligned on desktop. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">{children}</div>;
}
