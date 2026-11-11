import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { setupUser } from '@/test/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Customer, CustomerTransaction } from '@/types/api';
import { CustomerTxnDialog } from './CustomerTxnDialog';
import { dueTitle, entryDetail, outstandingOf, previewFifo } from './due-helpers';
import { SettleAllDialog } from './SettleAllDialog';

const customer = { id: 'cu1', name: 'Ravi', dueBalance: '1600.00', advanceBalance: '0.00', isActive: true } as Customer;
const due = (id: string, date: string, amount: string, remaining: string, category: string | null, description: string | null = null) =>
  ({
    id,
    type: 'due',
    txnDate: date,
    amount,
    remainingAmount: remaining,
    paidAmount: '0.00',
    category: category ? { id: `cat-${category}`, name: category, isActive: true } : null,
    description,
  }) as CustomerTransaction;
const OPEN = [due('A', '2026-01-01', '500.00', '500.00', 'Goods'), due('B', '2026-02-01', '800.00', '800.00', null, 'Old credit'), due('C', '2026-03-01', '300.00', '300.00', 'Repairs')];

describe('due helpers', () => {
  it('names a due by its category, else its older description', () => {
    expect(dueTitle(OPEN[0]!)).toBe('Goods');
    expect(dueTitle(OPEN[1]!)).toBe('Old credit');
    expect(entryDetail({ type: 'due_payment', settlementId: 's1', due: { id: 'A', txnDate: '', description: null, categoryName: 'Goods', amount: '1' }, category: null, description: null })).toBe(
      'Full outstanding payment · for Goods',
    );
  });

  it('previews FIFO allocation: oldest first, last one partly', () => {
    expect(outstandingOf(OPEN)).toBe('1600.00');
    expect(previewFifo(OPEN, '1600.00').map((l) => [l.due.id, l.pay, l.remainingAfter])).toEqual([
      ['A', '500.00', '0.00'],
      ['B', '800.00', '0.00'],
      ['C', '300.00', '0.00'],
    ]);
    expect(previewFifo(OPEN, '1000.00').map((l) => [l.due.id, l.pay, l.remainingAfter])).toEqual([
      ['A', '500.00', '0.00'],
      ['B', '500.00', '300.00'],
    ]);
  });
});

function setup(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: React.ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
  return { fetchMock, wrap, user: setupUser() };
}
const writes = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([url, init]) => ({ url: String(url), body: JSON.parse((init as RequestInit).body as string), headers: (init as RequestInit).headers as Headers }));

describe('record a due with a category', () => {
  it('requires a category from the active expense categories and sends it (with optional notes, no description)', async () => {
    const { fetchMock, wrap, user } = setup((url, init) => {
      if (url.includes('/categories')) return Response.json({ categories: [{ id: 'c1', name: 'Goods', isActive: true }, { id: 'c2', name: 'Repairs', isActive: true }] });
      if (init?.method === 'POST') return Response.json({ transaction: { id: 't1' } }, { status: 201 });
      return Response.json({}, { status: 404 });
    });
    const onSaved = vi.fn();
    render(wrap(<CustomerTxnDialog customer={customer} type="due" onClose={() => undefined} onSaved={onSaved} />));
    expect(screen.queryByLabelText('What is it for?')).not.toBeInTheDocument(); // no free-text description any more
    await user.type(screen.getByLabelText('Amount owed'), '250');
    await user.click(screen.getByRole('button', { name: 'Record due' }));
    expect(await screen.findByText('Choose a category')).toBeInTheDocument();
    expect(writes(fetchMock)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Category' }));
    await user.type(screen.getByRole('combobox', { name: 'Search category' }), 'rep');
    await user.click(await screen.findByRole('option', { name: 'Repairs' }));
    await user.type(screen.getByLabelText('Notes (optional)'), 'Fan repair');
    await user.click(screen.getByRole('button', { name: 'Record due' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [w] = writes(fetchMock);
    expect(w!.url).toMatch(/\/customers\/cu1\/dues$/);
    expect(w!.body).toMatchObject({ amount: '250', categoryId: 'c2', notes: 'Fan repair', description: null });
  });
});

describe('pay full outstanding amount', () => {
  it('shows the total and the oldest-first allocation, confirms, then sends ONE request for the exact total', async () => {
    const { fetchMock, wrap, user } = setup((url, init) => {
      if (url.includes('/open-dues')) return Response.json({ dues: OPEN });
      if (init?.method === 'POST') return Response.json({ settlement: { id: 's1' }, transactions: [] }, { status: 201 });
      return Response.json({}, { status: 404 });
    });
    const onSaved = vi.fn();
    render(wrap(<SettleAllDialog customer={customer} open onClose={() => undefined} onSaved={onSaved} />));
    expect(await screen.findByTestId('settle-total')).toHaveTextContent('₹1,600.00');
    const lines = within(screen.getByTestId('settle-allocation')).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([expect.stringMatching(/^Goods.*₹500\.00$/), expect.stringMatching(/^Old credit.*₹800\.00$/), expect.stringMatching(/^Repairs.*₹300\.00$/)]);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Choose how the money was paid')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'UPI' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // Confirmation step before anything is sent.
    expect(await screen.findByText(/Their due becomes ₹0.00/)).toBeInTheDocument();
    expect(writes(fetchMock)).toEqual([]);
    const record = screen.getByRole('button', { name: 'Record ₹1,600.00' });
    await user.click(record);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.stringMatching(/settled 3 dues/)));
    const sent = writes(fetchMock);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/customers\/cu1\/due-payments\/settle-all$/);
    expect(sent[0]!.body).toMatchObject({ amount: '1600.00', paymentMode: 'upi' });
    expect(new Headers(sent[0]!.headers).get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('if the outstanding changed meanwhile, nothing is recorded and the new total is shown', async () => {
    let dues = OPEN;
    const { wrap, user } = setup((url, init) => {
      if (url.includes('/open-dues')) return Response.json({ dues });
      if (init?.method === 'POST') {
        dues = [OPEN[2]!];
        return Response.json({ error: { code: 'OUTSTANDING_CHANGED', message: 'The outstanding amount is now ₹300.00 (you confirmed ₹1,600.00).' } }, { status: 409 });
      }
      return Response.json({}, { status: 404 });
    });
    render(wrap(<SettleAllDialog customer={customer} open onClose={() => undefined} onSaved={() => undefined} />));
    await screen.findByTestId('settle-total');
    await user.click(screen.getByRole('radio', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Record ₹1,600.00' }));
    expect(await screen.findByText(/The outstanding amount is now ₹300.00/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('settle-total')).toHaveTextContent('₹300.00'));
  });
});
