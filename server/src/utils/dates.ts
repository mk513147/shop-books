import { z } from 'zod';
import { REPORTING_TIME_ZONE } from '../config/constants.js';

/** Today's calendar date in the reporting timezone (Asia/Kolkata), as 'YYYY-MM-DD'. */
export function todayInReportingZone(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORTING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A real calendar date 'YYYY-MM-DD' (no time, no timezone). */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine(isRealDate, 'Not a valid date');
