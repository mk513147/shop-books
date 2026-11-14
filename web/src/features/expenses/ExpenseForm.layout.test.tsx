import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupUser } from '@/test/user-event';
import type { Category, Expense, ExpenseInput } from '@/types/api';
import { ExpenseForm } from './ExpenseForm';

vi.setConfig({ testTimeout: 15_000 });

const cat = (id: string, name: string): Category => ({ id, name, description: null, isActive: true, expenseCount: 0, createdAt: '', updatedAt: '' });
const CATEGORIES = [cat('c1', 'Packaging'), cat('c2', 'Transport')];

async function fakeApi(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes('/suppliers?')) return Response.json({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
  if (url.includes('/brands')) return Response.json({ brands: [] });
  if (url.includes('/categories')) return Response.json({ categories: CATEGORIES });
  return Response.json({}, { status: 404 });
}

function renderForm(initial?: Expense) {
  const onSubmit = vi.fn<(input: ExpenseInput, v: number | undefined) => Promise<Expense>>(async () => ({ id: 'e1' }) as Expense);
  vi.stubGlobal('fetch', vi.fn(fakeApi));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ExpenseForm
          {...(initial ? { initial } : {})}
          categories={CATEGORIES}
          submitLabel="Save expense"
          cancelTo="/expenses"
          onSubmit={onSubmit}
          onDone={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSubmit, user: setupUser() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Add expense layout', () => {
  it('amount comes first, then plain groups in order, then the summary with Save at the end', () => {
    renderForm();
    const amount = screen.getByLabelText('Total expense amount');
    expect(amount).toHaveFocus();
    expect(amount).toHaveAttribute('inputmode', 'decimal');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Supplier', 'What was it for?', 'Payment', 'Date and bill number']);
    // No numbered steps.
    expect(screen.queryByText(/^[1-9]$/)).not.toBeInTheDocument();
    // Reading order: amount -> every field -> summary -> Save.
    const save = screen.getByRole('button', { name: 'Save expense' });
    const lastField = screen.getByLabelText('Bill number (optional)');
    const summary = screen.getByTestId('payment-summary');
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(amount, screen.getAllByTestId('expense-group')[0]!)).toBe(true);
    expect(follows(lastField, summary)).toBe(true);
    expect(follows(summary, save)).toBe(true);
  });

  it('every field has a visible label that says whether it is optional', () => {
    renderForm();
    for (const label of ['Total expense amount', 'Description (optional)', 'Amount paid', 'Payment method', 'Expense date', 'Bill number (optional)']) {
      const field = screen.getByLabelText(label);
      const visible = document.querySelector(`label[for="${field.id}"]`);
      expect(visible, label).not.toBeNull();
      expect(visible).toHaveTextContent(label);
    }
    expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Brand (optional)' })).toBeInTheDocument();
    expect(screen.getByTestId('no-supplier-note')).toHaveTextContent('No supplier chosen');
  });

  it('shows Total, Paid and Remaining due with "Fully paid" or "Payment pending" in words', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    const summary = within(screen.getByTestId('payment-summary'));
    expect(summary.getByText('Total expense').nextSibling).toHaveTextContent('₹2,500.00');
    expect(summary.getByText('Paid').nextSibling).toHaveTextContent('₹2,500.00');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');
    expect(screen.getByTestId('payment-badge')).toHaveTextContent('Fully paid');

    await user.click(screen.getByRole('radio', { name: 'Part paid' }));
    await user.type(screen.getByLabelText('Amount paid'), '1000');
    expect(summary.getByText('Paid').nextSibling).toHaveTextContent('₹1,000.00');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');
    expect(screen.getByTestId('payment-badge')).toHaveTextContent('Payment pending');
  });

  it('a second payment method gets its own visible labels', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '900');
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    expect(screen.getByLabelText('Amount paid (payment 2)')).toBeInTheDocument();
    expect(screen.getByLabelText('Payment method (payment 2)')).toBeInTheDocument();
  });

  it('"Clear amount" empties the amount and puts the cursor back in it', async () => {
    const { user } = renderForm();
    const amount = screen.getByLabelText('Total expense amount');
    expect(screen.queryByRole('button', { name: 'Clear amount' })).not.toBeInTheDocument();
    await user.type(amount, '450');
    await user.click(screen.getByRole('button', { name: 'Clear amount' }));
    expect(amount).toHaveValue('');
    expect(amount).toHaveFocus();
  });

  it('Enter on the keyboard moves to the next field and never saves the form', async () => {
    const { user, onSubmit } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500{Enter}');
    expect(screen.getByLabelText('Total expense amount')).not.toHaveFocus();
    await user.type(screen.getByLabelText('Description (optional)'), 'Tea{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a clear validation message for a zero amount next to the field', async () => {
    const { user, onSubmit } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '0');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Must be more than zero')).toHaveAttribute('id', 'amount-error');
    expect(screen.getByLabelText('Total expense amount')).toHaveAccessibleDescription('Must be more than zero');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('editing an existing part-paid expense keeps its values and shows what is still due', () => {
    renderForm({
      id: 'e1',
      version: 3,
      amount: '1200.00',
      payments: [{ amount: '200.00', paymentMode: 'upi' }],
      allocatedPayments: '300.00',
      supplier: { id: 's1', name: 'ABC Distributors', isActive: true },
      brands: [],
      categories: [{ id: 'c1', name: 'Packaging', isActive: true }],
      category: { id: 'c1', name: 'Packaging', isActive: true },
      description: 'Boxes',
      expenseDate: '2026-11-01',
      invoiceReference: 'B-17',
      documentCount: 0,
    } as unknown as Expense);
    expect(screen.getByLabelText('Total expense amount')).toHaveValue('1200.00');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('200.00');
    expect(screen.getByLabelText('Payment method')).toHaveValue('upi');
    expect(screen.getByLabelText('Bill number (optional)')).toHaveValue('B-17');
    // 1200 - 200 paid now - 300 of supplier payments already allocated to this bill.
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹700.00');
    expect(screen.getByTestId('payment-badge')).toHaveTextContent('Payment pending');
    expect(screen.getByRole('button', { name: 'Save expense' })).toBeInTheDocument();
  });
});

describe('Add expense on phones', () => {
  function fakePhoneKeyboard() {
    const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, width: 400 });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    return (keyboardPx: number) =>
      act(() => {
        vv.height = 800 - keyboardPx;
        vv.dispatchEvent(new Event('resize'));
      });
  }

  it('Save and Cancel sit in the summary panel at the end of the form: nothing floats over the fields or the keyboard', () => {
    const keyboard = fakePhoneKeyboard();
    renderForm();
    const panel = screen.getByTestId('expense-actions');
    const save = within(panel).getByRole('button', { name: 'Save expense' });
    const cancel = within(panel).getByRole('link', { name: 'Cancel' });
    expect(cancel).toHaveAttribute('href', '/expenses');
    expect(within(panel).getByTestId('payment-summary')).toBeInTheDocument();
    // In the page flow on phones (sticky only from the desktop breakpoint), with or without the keyboard.
    for (const covered of [0, 320]) {
      keyboard(covered);
      expect(panel.className).not.toMatch(/(^|\s)(sticky|fixed)(\s|$)/);
      expect(panel.className).toContain('lg:sticky');
    }
    expect(save).toHaveAttribute('type', 'submit');
  });

  it('saving shows a loading state and a second tap does not send twice', async () => {
    fakePhoneKeyboard();
    let finish: (e: Expense) => void = () => undefined;
    const { user, onSubmit } = renderForm();
    onSubmit.mockImplementation(() => new Promise<Expense>((resolve) => (finish = resolve)));
    await user.type(screen.getByLabelText('Total expense amount'), '100');
    await user.click(screen.getByRole('button', { name: 'Supplier (optional)' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Packaging' }));
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    const saving = await screen.findByRole('button', { name: /Saving/ });
    await user.click(saving);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => finish({ id: 'e1' } as Expense));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save expense' })).toBeInTheDocument());
  });
});
