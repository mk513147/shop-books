import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hideRedundantChange } from '@/routes/ExpenseDetailPage';
import type { AuditHistoryEntry } from '@/types/api';
import { AuditHistory } from './AuditHistory';

const LABELS = { paymentMode: 'Payment mode', payments: 'Payments', amount: 'Amount' };
const display = (_field: string, value: unknown) => (value === null || value === undefined ? '—' : String(value));
const entry = (id: string, changes: AuditHistoryEntry['changes']): AuditHistoryEntry => ({
  id,
  occurredAt: '2026-11-02T10:00:00Z',
  action: 'update',
  actor: { id: 'u1', name: 'Owner' },
  reason: null,
  changes,
  after: {},
});
const query = (data: AuditHistoryEntry[]) => ({ isPending: false, isError: false, data }) as unknown as UseQueryResult<AuditHistoryEntry[]>;

describe('AuditHistory: redundant expense payment lines', () => {
  const history = query([
    // After 0010: the payments change and the summary payment mode change in one entry.
    entry('2', [
      { field: 'payments', before: 'upi:1000.00,cash:1500.00', after: 'cash:2500.00' },
      { field: 'paymentMode', before: 'upi', after: 'cash' },
    ]),
    // Before 0010: only the payment mode was recorded.
    entry('1', [
      { field: 'amount', before: '100.00', after: '120.00' },
      { field: 'paymentMode', before: 'cash', after: 'upi' },
    ]),
  ]);

  it('hides "Payment mode" only where the same entry shows the full "Payments" change', () => {
    render(<AuditHistory history={history} fieldLabels={LABELS} display={display} hideChange={hideRedundantChange} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Payments: upi:1000.00,cash:1500.00 → cash:2500.00');
    expect(items[0]).not.toHaveTextContent('Payment mode:');
    // The historical entry keeps its payment mode line (nothing is lost or invented).
    expect(items[2]).toHaveTextContent('Payment mode: cash → upi');
  });

  it('shows every line on pages that do not opt in', () => {
    render(<AuditHistory history={history} fieldLabels={LABELS} display={display} />);
    expect(screen.getAllByText(/Payment mode:/)).toHaveLength(2);
  });
});
