import { useEffect, useState } from 'react';

/**
 * On-screen keyboard handling for phones (Android Chrome, the installed PWA, iOS Safari).
 *
 * Mobile browsers open the keyboard over the page by shrinking only the *visual* viewport: the
 * layout viewport, `100dvh` and every `position: fixed` / top-layer element (our bottom-sheet
 * <dialog>) keep their full height, so whatever sits at the bottom of the screen ends up behind
 * the keyboard. `window.visualViewport` reports the part that is really visible; these helpers
 * use it to keep search results above the keyboard. Desktop layouts (md and up) are untouched.
 */

/** Phone layout: below Tailwind's `md` breakpoint (768px), where dialogs are bottom sheets. */
export const PHONE_MEDIA_QUERY = '(max-width: 767.98px)';

/** Covered height above which we treat the bottom of the screen as taken by a keyboard. */
export const KEYBOARD_MIN_PX = 100;

export function isPhoneLayout(win: Window = window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia(PHONE_MEDIA_QUERY).matches;
}

export interface ViewportInset {
  /** CSS px of the layout viewport hidden at the bottom (the keyboard, when open). */
  bottom: number;
  /** CSS px of the visible (visual) viewport height. */
  height: number;
}

export function readViewportInset(win: Window = window): ViewportInset | null {
  const vv = win.visualViewport;
  if (!vv) return null;
  return {
    bottom: Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop)),
    height: Math.round(vv.height),
  };
}

/**
 * Live visual-viewport inset while `enabled` (e.g. while a sheet is open); null when disabled or
 * unsupported. Updates on keyboard open/close, rotation and browser-bar changes, at most once per
 * animation frame.
 */
export function useViewportInset(enabled: boolean): ViewportInset | null {
  const [inset, setInset] = useState<ViewportInset | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readViewportInset();
        setInset((prev) => (prev && next && prev.bottom === next.bottom && prev.height === next.height ? prev : next));
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', update);
      setInset(null);
    };
  }, [enabled]);

  return enabled ? inset : null;
}

/**
 * For an inline search field whose results are listed BELOW it (not in a sheet): on a phone,
 * scroll the field to the top of the visible area once the keyboard has opened, so the results
 * fill the space between the field and the keyboard instead of hiding behind it.
 * Returns a cleanup function (call it on blur).
 */
export function revealAboveKeyboard(element: HTMLElement, win: Window = window): () => void {
  if (!isPhoneLayout(win)) return () => undefined;
  const vv = win.visualViewport;
  let done = false;
  const reveal = () => {
    if (done || !element.isConnected) return;
    done = true;
    element.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const onResize = () => {
    const inset = readViewportInset(win);
    if (inset && inset.bottom >= KEYBOARD_MIN_PX) reveal();
  };
  vv?.addEventListener('resize', onResize);
  // Keyboard already open (moving between fields), or no resize event arrives: reveal anyway.
  const timer = win.setTimeout(reveal, 350);
  return () => {
    done = true;
    win.clearTimeout(timer);
    vv?.removeEventListener('resize', onResize);
  };
}
