import { describe, expect, it } from 'vitest';
import { isPaymentSplitValid, paymentStatusOf, splitPayments } from './payment-split';

const row = (amount: string, paymentMode = 'cash') => ({ amount, paymentMode });

describe('splitPayments', () => {
  it('one row equal to the amount is valid with nothing remaining', () => {
    const s = splitPayments('2500', [row('2500')], false);
    expect(s).toMatchObject({ total: 250000n, allocated: 250000n, remaining: 0n, problem: null });
    expect(isPaymentSplitValid(s)).toBe(true);
  });

  it('two and three rows add up exactly, including decimals floats would get wrong', () => {
    expect(splitPayments('2500', [row('1000', 'upi'), row('1500')], false).remaining).toBe(0n);
    const three = splitPayments('0.30', [row('0.10'), row('0.20', 'upi')], false);
    expect(three.remaining).toBe(0n); // 0.1 + 0.2 !== 0.3 in floating point
    const many = splitPayments('2500', [row('1000.10'), row('1000', 'upi'), row('499.90', 'card')], false);
    expect(many.remaining).toBe(0n);
    expect(isPaymentSplitValid(many)).toBe(true);
  });

  it('reports the remaining amount while the rows are short', () => {
    const s = splitPayments('2500', [row('1000', 'upi')], false);
    expect(s.remaining).toBe(150000n);
    expect(s.problem).toMatch(/₹1,500\.00 is still unallocated/);
    expect(isPaymentSplitValid(s)).toBe(false);
  });

  it('rejects totals above the amount', () => {
    const s = splitPayments('2500', [row('1000', 'upi'), row('1500.01')], false);
    expect(s.remaining).toBe(-1n);
    expect(s.problem).toMatch(/₹0\.01 more than the expense amount ₹2,500\.00/);
    expect(isPaymentSplitValid(s)).toBe(false);
  });

  it('rejects zero, negative and malformed amounts and a missing method', () => {
    expect(splitPayments('100', [row('0')], false).rowErrors[0]!.amount).toBe('Must be more than zero');
    expect(splitPayments('100', [row('-5')], false).rowErrors[0]!.amount).toBeDefined();
    expect(splitPayments('100', [row('1.234')], false).rowErrors[0]!.amount).toBeDefined();
    // A blank row next to others is an amount error.
    expect(splitPayments('100', [row('50'), row('')], false).rowErrors[1]!.amount).toBe('Enter the amount');
    const noMethod = splitPayments('100', [row('100', '')], false);
    expect(noMethod.rowErrors[0]!.paymentMode).toBe('Choose a method');
    expect(isPaymentSplitValid(noMethod)).toBe(false);
  });

  it('has no total (and no remaining) while the expense amount is empty or invalid', () => {
    for (const amount of ['', 'abc', '0']) {
      const s = splitPayments(amount, [row('10')], false);
      expect(s.total).toBeNull();
      expect(s.remaining).toBeNull();
      expect(isPaymentSplitValid(s)).toBe(false);
    }
  });

  it('a supplier bill may be unpaid or part-paid, but never over-allocated', () => {
    const unpaid = splitPayments('500', [row('', '')], true);
    expect(isPaymentSplitValid(unpaid)).toBe(true);
    expect(unpaid.remaining).toBe(50000n);
    const part = splitPayments('500', [row('200', 'upi')], true);
    expect(isPaymentSplitValid(part)).toBe(true);
    expect(splitPayments('500', [row('500.01')], true).problem).not.toBeNull();
    // A blank row next to others is still an error: only a lone blank row means "not paid".
    expect(splitPayments('500', [row('200'), row('')], true).rowErrors[1]!.amount).toBe('Enter the amount');
  });

  it('a supplier-less expense cannot be left unpaid, and says why', () => {
    const s = splitPayments('500', [row('', '')], false);
    expect(isPaymentSplitValid(s)).toBe(false);
    expect(s.rowErrors[0]).toEqual({});
    expect(s.problem).toMatch(/without a supplier must be paid in full/);
  });

  it('derives the payment status from the rows (fully paid / partially paid / not paid yet)', () => {
    expect(paymentStatusOf(splitPayments('', [row('')], true))).toBeNull();
    expect(paymentStatusOf(splitPayments('500', [row('500')], false))).toBe('full');
    expect(paymentStatusOf(splitPayments('500', [row('200'), row('300', 'upi')], true))).toBe('full');
    expect(paymentStatusOf(splitPayments('500', [row('200')], true))).toBe('partial');
    expect(paymentStatusOf(splitPayments('500', [row('', '')], true))).toBe('none');
    expect(paymentStatusOf(splitPayments('500', [row('', '')], false))).toBe('none');
  });
});
