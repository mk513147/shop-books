import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { hasUnsavedInput, trackUnsavedWork } from '@/features/system/unsaved-work';
import { QuickLookupDialog } from './QuickLookupDialog';
import { isDesktop, SHORTCUTS, shortcutFor } from './shortcuts';

interface ShortcutsApi {
  openQuickLookup: () => void;
  openHelp: () => void;
  /** Desktop-class device (shortcut hints are shown only there). */
  desktop: boolean;
}

const ShortcutsContext = createContext<ShortcutsApi | null>(null);

export function useShortcuts(): ShortcutsApi {
  const api = useContext(ShortcutsContext);
  if (!api) throw new Error('useShortcuts() must be used inside <ShortcutsProvider>');
  return api;
}

/** Where focus was before a dialog opened, including a text field's caret / selection. */
interface SavedFocus {
  element: HTMLElement;
  selection: [number | null, number | null] | null;
}

function saveFocus(): SavedFocus | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  let selection: SavedFocus['selection'] = null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      selection = [el.selectionStart, el.selectionEnd];
    } catch {
      // Some input types (e.g. number, email) do not expose a selection.
    }
  }
  return { element: el, selection };
}

function restoreFocus(saved: SavedFocus | null): void {
  if (!saved || !saved.element.isConnected) return;
  // After the dialog's own focus handling has finished.
  window.setTimeout(() => {
    saved.element.focus({ preventScroll: true });
    const el = saved.element;
    if (saved.selection && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && saved.selection[0] !== null) {
      try {
        el.setSelectionRange(saved.selection[0], saved.selection[1] ?? saved.selection[0]);
      } catch {
        // Not supported by this input type.
      }
    }
  }, 0);
}

/**
 * Desktop keyboard shortcuts (F2, F4), the product quick lookup and the shortcuts help panel.
 * Mounted once in the app shell. On phones and touch devices the listener does nothing.
 */
export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [lookupOpen, setLookupOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(() => isDesktop());
  const savedFocus = useRef<SavedFocus | null>(null);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  // Unsaved-work tracking also runs in development builds (the updater starts it in production).
  useEffect(() => trackUnsavedWork(), []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1024px)');
    const onChange = () => setDesktop(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  const openQuickLookup = useCallback(() => {
    savedFocus.current = saveFocus();
    setLookupOpen(true);
  }, []);

  const closeQuickLookup = useCallback(() => {
    setLookupOpen(false);
    restoreFocus(savedFocus.current);
    savedFocus.current = null;
  }, []);

  /** Navigates, but asks first when the current screen has unsaved typing. */
  const go = useCallback(
    (to: string) => {
      if (hasUnsavedInput()) setLeaveTo(to);
      else navigate(to);
    },
    [navigate],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = shortcutFor(event);
      if (!action) return;
      event.preventDefault();
      if (action === 'quick-lookup') openQuickLookup();
      else if (pathRef.current !== '/expenses/new') go('/expenses/new');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go, openQuickLookup]);

  const api = useMemo(() => ({ openQuickLookup, openHelp: () => setHelpOpen(true), desktop }), [openQuickLookup, desktop]);

  return (
    <ShortcutsContext.Provider value={api}>
      {children}
      <QuickLookupDialog
        open={lookupOpen}
        onClose={closeQuickLookup}
        onOpenProduct={(id) => {
          setLookupOpen(false);
          savedFocus.current = null;
          go(`/products/${id}`);
        }}
      />
      <Dialog open={helpOpen} title="Keyboard shortcuts" size="sm" onClose={() => setHelpOpen(false)}>
        <dl className="space-y-3 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="flex items-start gap-3">
              <dt>
                <kbd className="inline-flex min-w-9 justify-center rounded-md border bg-surface-muted px-1.5 py-0.5 font-mono text-xs">{s.key}</kbd>
              </dt>
              <dd>
                <p className="font-medium">{s.label}</p>
                <p className="text-muted-foreground">{s.detail}</p>
              </dd>
            </div>
          ))}
          <div className="flex items-start gap-3">
            <dt>
              <kbd className="inline-flex min-w-9 justify-center rounded-md border bg-surface-muted px-1.5 py-0.5 font-mono text-xs">Esc</kbd>
            </dt>
            <dd>
              <p className="font-medium">Close a dialog</p>
              <p className="text-muted-foreground">Returns to where you were, with what you typed kept.</p>
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">Shortcuts work on computers with a keyboard. They do nothing on phones and tablets.</p>
      </Dialog>
      <Dialog
        open={leaveTo !== null}
        title="Leave this screen?"
        size="sm"
        onClose={() => setLeaveTo(null)}
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setLeaveTo(null)}>
              Stay here
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const to = leaveTo;
                setLeaveTo(null);
                if (to) navigate(to);
              }}
            >
              Leave without saving
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">What you typed on this screen has not been saved and will be lost.</p>
      </Dialog>
    </ShortcutsContext.Provider>
  );
}
