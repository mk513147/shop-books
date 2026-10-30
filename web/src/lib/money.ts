/**
 * Money convention: amounts travel as DECIMAL STRINGS ("1234.50"), never as JS numbers, and are
 * only ever formatted for display here. No arithmetic is performed on them in the browser;
 * totals and balances are computed by PostgreSQL (NUMERIC) on the server.
 */
const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** Formats a decimal string as INR with Indian digit grouping, e.g. "1234567.5" -> "₹12,34,567.50". */
export function formatInr(amount: string): string {
  const match = DECIMAL.exec(amount.trim());
  if (!match) throw new Error('Invalid monetary amount');
  const [, sign = '', whole = '0', fraction = ''] = match;
  const digits = whole.replace(/^0+(?=\d)/, '');
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${sign}₹${grouped}.${fraction.padEnd(2, '0')}`;
}
