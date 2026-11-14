/**
 * "Would a reload lose something?" for the app updater (app-update.ts).
 *
 * Generic on purpose, so every form is covered without wiring each one (expenses, supplier payments,
 * customer entries, dialogs, sign-in): typing or choosing anything inside a <form> or a <dialog>
 * marks the screen as having unsaved work until the user moves to another screen (a successful
 * save navigates away, and so does Cancel). In addition, a reload is never safe while a dialog is
 * open, a text field has focus, or a save is still in flight.
 */

let dirty = false;

const IGNORED_INPUT_TYPES = new Set(['search']);

function marksUnsavedWork(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-no-unsaved]')) return false;
  if (target instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(target.type) && !target.closest('dialog')) return false;
  return target.closest('form, dialog') !== null;
}

function onUserInput(event: Event): void {
  if (marksUnsavedWork(event.target)) dirty = true;
}

/** Starts listening (idempotent per document). Returns a function that stops it. */
export function trackUnsavedWork(doc: Document = document): () => void {
  doc.addEventListener('input', onUserInput, true);
  doc.addEventListener('change', onUserInput, true);
  return () => {
    doc.removeEventListener('input', onUserInput, true);
    doc.removeEventListener('change', onUserInput, true);
  };
}

/** A new screen: whatever was typed on the previous one was saved or deliberately left. */
export function resetUnsavedWork(): void {
  dirty = false;
}

export function hasUnsavedInput(): boolean {
  return dirty;
}

function isEditableField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color'].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/** True when nothing would be lost by reloading the page right now. */
export function isSafeToReload(options: { mutationsInFlight: number; doc?: Document }): boolean {
  const doc = options.doc ?? document;
  if (dirty) return false;
  if (options.mutationsInFlight > 0) return false;
  if (doc.querySelector('dialog[open]')) return false;
  if (isEditableField(doc.activeElement)) return false;
  return true;
}
