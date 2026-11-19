/**
 * Exit animations (dialogs, toasts) delay removal by a few frames. They run only when the device
 * explicitly allows motion; with reduced motion, or where it cannot be detected (tests, very old
 * browsers), everything closes at once.
 */
export function motionAllowed(win: Window = window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: no-preference)').matches;
}

/** Duration of exit animations; matches --dur-base in styles/index.css. */
export const EXIT_MS = 180;
