import { formatInr, fromPaise, MONEY_INPUT, toPaise } from '@/lib/money';

/**
 * Live arithmetic for the payment breakdown of the expense form. Everything is exact integer
 * paise (BigInt); no floating-point number ever touches a money value. This mirrors the server's
 * rules for instant feedback only: the server re-validates and is the authority.
 */
export interface PaymentRowInput {
  amount: string;
  paymentMode: string;
}

export interface PaymentSplit {
  /** Expense amount in paise, or null while it is empty/invalid. */
  total: bigint | null;
  /** Sum of the valid row amounts. */
  allocated: bigint;
  /** total - allocated (negative when over-allocated); null while the total is unknown. */
  remaining: bigint | null;
  /** True once at least one row has an amount typed in. */
  anyEntered: boolean;
  /** Per-row problems, by row index. */
  rowErrors: { amount?: string; paymentMode?: string }[];
  /** Message about the whole breakdown, or null when it is consistent. */
  problem: string | null;
}

const inr = (paise: bigint) => formatInr(fromPaise(paise));

/**
 * @param amount          the expense amount as typed
 * @param rows            the payment rows as typed
 * @param supplierCredit  true when a supplier is chosen: the bill may then be left unpaid or
 *                        part-paid (the remainder stays payable); otherwise it must be paid in full
 */
export function splitPayments(amount: string, rows: PaymentRowInput[], supplierCredit: boolean): PaymentSplit {
  const trimmed = amount.trim();
  const total = MONEY_INPUT.test(trimmed) && toPaise(trimmed) > 0n ? toPaise(trimmed) : null;
  const rowErrors: PaymentSplit['rowErrors'] = rows.map(() => ({}));
  let allocated = 0n;
  let anyEntered = false;

  // A lone blank row on a supplier bill means "not paid yet" (credit) and is ignored.
  const ignoreBlankOnly = supplierCredit && rows.length === 1 && rows[0]!.amount.trim() === '';

  rows.forEach((row, i) => {
    const value = row.amount.trim();
    if (value === '') {
      if (!ignoreBlankOnly) rowErrors[i]!.amount = 'Enter the amount';
    } else {
      anyEntered = true;
      if (!MONEY_INPUT.test(value)) rowErrors[i]!.amount = 'Use digits only, e.g. 1250 or 1250.50';
      else if (toPaise(value) <= 0n) rowErrors[i]!.amount = 'Must be more than zero';
      else allocated += toPaise(value);
    }
    if (!row.paymentMode && !(ignoreBlankOnly && value === '')) rowErrors[i]!.paymentMode = 'Choose a method';
  });

  const remaining = total === null ? null : total - allocated;
  let problem: string | null = null;
  if (total !== null && !rowErrors.some((e) => e.amount || e.paymentMode)) {
    if (remaining! < 0n) {
      problem = `The payments total ${inr(allocated)}, which is ${inr(-remaining!)} more than the expense amount ${inr(total)}.`;
    } else if (remaining! > 0n && !supplierCredit) {
      problem = `The payments total ${inr(allocated)}, but the expense amount is ${inr(total)}. ${inr(remaining!)} is still unallocated; the payments must add up to the full amount.`;
    }
  }
  return { total, allocated, remaining, anyEntered, rowErrors, problem };
}

/** True when every row is valid and the totals are consistent: the form may be submitted. */
export function isPaymentSplitValid(split: PaymentSplit): boolean {
  return split.total !== null && split.problem === null && !split.rowErrors.some((e) => e.amount || e.paymentMode);
}
