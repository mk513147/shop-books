import { isEditableField } from '@/features/system/unsaved-work';

/**
 * Desktop keyboard shortcuts (this release: F2 and F4 only; Esc closes dialogs natively).
 *
 *   F2  Add expense            ignored while typing in a field (protects what is being typed)
 *   F4  Product quick lookup   works even while a normal input has focus: it opens a dialog on
 *                              top of the current screen, so nothing typed is lost
 *
 * Never handled: F1, F5, F11, F12 (browser help, reload, full screen, developer tools) or any key
 * with Ctrl / Alt / Meta / Shift, auto-repeat or IME composition. Only on desktop-class devices
 * (fine pointer, hover, ≥ 1024 px): phones, tablets and touch PWAs get no shortcuts and no hints.
 */

export const DESKTOP_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 1024px)';

export function isDesktop(win: Window = window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia(DESKTOP_QUERY).matches;
}

export type ShortcutAction = 'add-expense' | 'quick-lookup';

export const SHORTCUTS: { key: 'F2' | 'F4'; action: ShortcutAction; label: string; detail: string }[] = [
  { key: 'F2', action: 'add-expense', label: 'Add expense', detail: 'Opens a new expense. Not while you are typing in a field.' },
  { key: 'F4', action: 'quick-lookup', label: 'Product quick lookup', detail: 'Find a product’s price without leaving the current screen. Works while typing too.' },
];

/** Which shortcut (if any) this key press triggers. Pure: easy to test. */
export function shortcutFor(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented'>, doc: Document = document, win: Window = window): ShortcutAction | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (event.key !== 'F2' && event.key !== 'F4') return null;
  if (!isDesktop(win)) return null;
  // Another dialog is open: it owns the keyboard (Esc closes it).
  if (doc.querySelector('dialog[open]')) return null;
  if (event.key === 'F2') return isEditableField(doc.activeElement) ? null : 'add-expense';
  return 'quick-lookup';
}
