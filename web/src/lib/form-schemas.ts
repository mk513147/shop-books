import { z } from 'zod';
import { todayInKolkata } from './dates';
import { MONEY_INPUT, toPaise } from './money';

/** Required INR amount > 0 as a decimal string (mirrors the server; the server re-validates). */
export const positiveMoney = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}`)
    .regex(MONEY_INPUT, 'Use digits only, e.g. 1250 or 1250.50')
    .refine((v) => toPaise(v) > 0n, 'Must be more than zero');

/** A calendar date that is not in the future (Asia/Kolkata). */
export const pastOrTodayDate = z
  .string()
  .min(1, 'Choose a date')
  .refine((v) => v <= todayInKolkata(), 'The date cannot be in the future');

export const optionalText = (max: number) => z.string().trim().max(max, `At most ${max} characters`);
