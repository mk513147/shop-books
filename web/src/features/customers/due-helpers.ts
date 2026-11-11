import { fromPaise, toPaise } from '@/lib/money';
import type { CustomerTransaction } from '@/types/api';

/**
 * What a due is for: its category (dues recorded with a category), else the free-text description
 * of older dues. Notes are extra details, never the title.
 */
export function dueTitle(t: Pick<CustomerTransaction, 'category' | 'description'>): string {
  return t.category?.name ?? t.description ?? 'Due';
}

/** A ledger entry's short description line: dues by category, settlement payments labelled. */
export function entryDetail(t: Pick<CustomerTransaction, 'type' | 'category' | 'description' | 'settlementId' | 'due'>): string | null {
  if (t.type === 'due') return dueTitle(t);
  if (t.type === 'due_payment') {
    const target = t.due ? (t.due.categoryName ?? t.due.description) : null;
    const parts = [t.settlementId ? 'Full outstanding payment' : null, target ? `for ${target}` : null, t.description].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  return t.description;
}

export interface FifoLine {
  due: CustomerTransaction;
  pay: string;
  remainingAfter: string;
}

/**
 * Preview of how a payment is split over the open dues, oldest first (the server does the real
 * allocation in one transaction; this only shows the user what will happen).
 */
export function previewFifo(openDues: CustomerTransaction[], amount: string): FifoLine[] {
  let left = toPaise(amount);
  const lines: FifoLine[] = [];
  for (const due of openDues) {
    if (left <= 0n) break;
    const remaining = toPaise(due.remainingAmount ?? due.amount);
    if (remaining <= 0n) continue;
    const pay = remaining < left ? remaining : left;
    lines.push({ due, pay: fromPaise(pay), remainingAfter: fromPaise(remaining - pay) });
    left -= pay;
  }
  return lines;
}

/** Total still owed over the open dues. */
export function outstandingOf(openDues: CustomerTransaction[]): string {
  return fromPaise(openDues.reduce((sum, d) => sum + toPaise(d.remainingAmount ?? d.amount), 0n));
}
