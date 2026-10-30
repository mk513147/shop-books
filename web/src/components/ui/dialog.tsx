import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

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

const WIDTHS = { sm: 'md:w-[min(28rem,calc(100vw-2rem))]', md: 'md:w-[min(34rem,calc(100vw-2rem))]', lg: 'md:w-[min(44rem,calc(100vw-2rem))]' };

/**
 * Modal built on native <dialog> (focus trap, Esc and top-layer stacking for free).
 * Phones: a bottom sheet that fits the screen, scrolls internally and respects the safe area.
 * Desktop: a centred panel.
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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Target is the <dialog> itself only on the backdrop. Requiring the press to start there
        // too stops a text selection dragged outside from closing a half-filled form.
        if (e.target === e.currentTarget && pressedBackdrop.current && dismissible) onClose();
      }}
      className={cn(
        'border bg-card p-0 text-card-foreground shadow-raised backdrop:bg-black/40',
        // phone: bottom sheet
        'mx-0 mb-0 mt-auto max-h-[92dvh] w-full max-w-none rounded-t-2xl',
        // desktop: centred panel
        'md:m-auto md:max-h-[85dvh] md:rounded-2xl',
        WIDTHS[size],
        open ? 'flex flex-col' : '',
        className,
      )}
    >
      {open && (
        <>
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3 md:px-5">
            <div className="min-w-0 space-y-0.5">
              <h2 id={`${id}-title`} className="text-base font-semibold">
                {title}
              </h2>
              {description && <div className="text-sm text-muted-foreground">{description}</div>}
            </div>
            {dismissible && (
              <button
                type="button"
                onClick={onClose}
                className="-mr-2 inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Close"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">{children}</div>
          {footer && (
            <div className="border-t px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:px-5 md:pb-3">{footer}</div>
          )}
          {!footer && <div className="pb-[env(safe-area-inset-bottom)] md:pb-0" />}
        </>
      )}
    </dialog>
  );
}

/** Standard button row for dialog footers: stacked full-width on phones, right-aligned on desktop. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">{children}</div>;
}
