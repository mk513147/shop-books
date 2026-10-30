/** Reporting timezone for the whole app (matches the server). */
export const TIME_ZONE = 'Asia/Kolkata';

/** Today's date in Asia/Kolkata as 'YYYY-MM-DD' (independent of the device's timezone). */
export function todayInKolkata(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** '2026-10-30' -> '30 Oct 2026'. Calendar dates are formatted without any timezone shift. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** An instant (ISO timestamp) shown in Asia/Kolkata, e.g. '30 Oct 2026, 7:05 pm'. */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }).format(
    new Date(iso),
  );
}
