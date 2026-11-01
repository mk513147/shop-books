import { z } from 'zod';
import { calendarDateSchema, todayInReportingZone } from '../../utils/dates.js';
import { ValidationError } from '../../utils/errors.js';

/**
 * Reporting periods. Every period is an explicit, INCLUSIVE range of calendar dates
 * ('YYYY-MM-DD') in Asia/Kolkata. Transactions are matched on their business date
 * (expense_date, payment_date, txn_date), which is already a DATE, so no UTC/local-time
 * conversion happens in SQL. "Today" is computed in Asia/Kolkata (todayInReportingZone).
 */
export const PERIOD_PRESETS = ['today', 'this_week', 'this_month', 'previous_month', 'this_quarter', 'this_year', 'all_time', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface Period {
  preset: PeriodPreset;
  from: string;
  to: string;
  /** The previous equivalent period (same length, immediately before); null for all_time. */
  previous: { from: string; to: string } | null;
  label: string;
}

/** Query fields accepted by every period-based report. */
export const periodQueryShape = {
  period: z.enum(PERIOD_PRESETS).default('this_month'),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
};

const MAX_RANGE_DAYS = 366 * 5;

// --- calendar helpers (UTC Date objects used purely as calendar arithmetic) -------------------

function parse(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}
function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}
function monthStart(year: number, month: number): string {
  return format(new Date(Date.UTC(year, month - 1, 1)));
}
function monthEnd(year: number, month: number): string {
  return format(new Date(Date.UTC(year, month, 0)));
}
/** First and last day of a calendar month (month 1–12; out-of-range months roll over). */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  return { from: monthStart(start.getUTCFullYear(), start.getUTCMonth() + 1), to: monthEnd(start.getUTCFullYear(), start.getUTCMonth() + 1) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}
function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Resolves a preset (or a custom range) to explicit dates. `today` defaults to the current date
 * in Asia/Kolkata; tests pass a fixed date.
 *  - this_week: Monday–Sunday; previous = the week before.
 *  - this_month / previous_month / this_quarter / this_year: whole calendar units (Jan–Dec
 *    financial year); previous = the preceding unit of the same kind.
 *  - today: previous = yesterday. custom: previous = the same number of days just before.
 */
export function resolvePeriod(
  input: { period: PeriodPreset; from?: string | undefined; to?: string | undefined },
  today: string = todayInReportingZone(),
): Period {
  const t = parse(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  switch (input.period) {
    case 'today':
      return { preset: 'today', from: today, to: today, previous: { from: addDays(today, -1), to: addDays(today, -1) }, label: dateLabel(today) };
    case 'this_week': {
      const weekday = (t.getUTCDay() + 6) % 7; // Monday = 0
      const from = addDays(today, -weekday);
      const to = addDays(from, 6);
      return { preset: 'this_week', from, to, previous: { from: addDays(from, -7), to: addDays(from, -1) }, label: `Week of ${dateLabel(from)}` };
    }
    case 'this_month':
      return { preset: 'this_month', ...monthRange(y, m), previous: monthRange(y, m - 1), label: monthLabel(y, m) };
    case 'previous_month': {
      const r = monthRange(y, m - 1);
      const [py, pm] = r.from.split('-').map(Number) as [number, number];
      return { preset: 'previous_month', ...r, previous: monthRange(py, pm - 1), label: monthLabel(py, pm) };
    }
    case 'this_quarter': {
      const q = Math.floor((m - 1) / 3);
      const from = monthStart(y, q * 3 + 1);
      const to = monthEnd(y, q * 3 + 3);
      const prevFrom = monthRange(y, q * 3 - 2).from;
      return { preset: 'this_quarter', from, to, previous: { from: prevFrom, to: addDays(from, -1) }, label: `Q${q + 1} ${y}` };
    }
    case 'this_year':
      return {
        preset: 'this_year',
        from: `${y}-01-01`,
        to: `${y}-12-31`,
        previous: { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
        label: `Year ${y}`,
      };
    case 'all_time':
      return { preset: 'all_time', from: '2000-01-01', to: today, previous: null, label: 'All time' };
    case 'custom': {
      if (!input.from || !input.to) {
        throw new ValidationError([{ path: 'from', message: 'Choose both a start and an end date' }]);
      }
      if (input.from > input.to) throw new ValidationError([{ path: 'to', message: 'The end date must not be before the start date' }]);
      const length = daysBetween(input.from, input.to);
      if (length > MAX_RANGE_DAYS) throw new ValidationError([{ path: 'from', message: 'The range can be at most 5 years' }]);
      return {
        preset: 'custom',
        from: input.from,
        to: input.to,
        previous: { from: addDays(input.from, -(length + 1)), to: addDays(input.from, -1) },
        label: `${dateLabel(input.from)} – ${dateLabel(input.to)}`,
      };
    }
  }
}
