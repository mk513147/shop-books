import { z } from 'zod';

/**
 * Money convention: amounts are decimal STRINGS with at most 2 decimal places, matching
 * PostgreSQL NUMERIC(14,2) (at most 12 integer digits). JavaScript numbers are never used for
 * money. Comparisons use integer paise (BigInt); arithmetic for stored values happens in SQL.
 */
const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;

export const moneySchema = z
  .string()
  .trim()
  .regex(MONEY_PATTERN, 'Enter an amount like 1250 or 1250.50 (at most 2 decimal places)');

/** "1250.5" -> 125050n. Input must already match the money pattern. */
export function toPaise(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Normalised NUMERIC(14,2) text form, e.g. "1250.5" -> "1250.50". */
export function normaliseMoney(amount: string): string {
  const paise = toPaise(amount);
  return `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;
}

/** 125050n -> "1250.50" (non-negative amounts). */
export function fromPaise(paise: bigint): string {
  const sign = paise < 0n ? '-' : '';
  const abs = paise < 0n ? -paise : paise;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** "1250.5" -> "₹1250.50" for user-facing messages (no digit grouping). */
export function rupees(amount: string | bigint): string {
  return `₹${typeof amount === 'bigint' ? fromPaise(amount) : normaliseMoney(amount)}`;
}
