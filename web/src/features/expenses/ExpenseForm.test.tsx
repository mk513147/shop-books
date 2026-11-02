import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Category, Expense, ExpenseInput } from '@/types/api';
import { ExpenseForm } from './ExpenseForm';

const category: Category = {
  id: 'c1',
  name: 'Packaging',
  description: null,
  isActive: true,
  expenseCount: 0,
  createdAt: '',
  updatedAt: '',
};

function renderForm(props: { initial?: Expense } = {}) {
  const onSubmit = vi.fn<(input: ExpenseInput, baseVersion: number | undefined) => Promise<Expense>>(async () => ({}) as Expense);
  const onDone = vi.fn();
  vi.stubGlobal('fetch', vi.fn(fakeApi));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ExpenseForm
          {...(props.initial ? { initial: props.initial } : {})}
          categories={[category]}
          submitLabel="Save expense"
          cancelTo="/expenses"
          onSubmit={onSubmit}
          onDone={onDone}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSubmit, onDone, user: userEvent.setup() };
}

const summary = () => within(screen.getByTestId('payment-summary'));

const SUPPLIER = {
  id: 's1',
  name: 'Sharma Traders',
  phone: null,
  address: null,
  notes: null,
  isActive: true,
  version: 1,
  categories: [],
  expenseCount: 0,
  payable: '0.00',
  unallocated: '0.00',
};
/** Supplier search and detail are answered; everything else is 404 (the form needs nothing else). */
async function fakeApi(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (/\/suppliers\?/.test(url)) return Response.json({ items: [SUPPLIER], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
  if (url.endsWith('/suppliers/s1')) return Response.json({ supplier: SUPPLIER });
  return Response.json({}, { status: 404 });
}
async function chooseSupplier(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Supplier' }));
  await user.click(await screen.findByRole('option', { name: /Sharma Traders/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier' })).toHaveTextContent('Sharma Traders'));
}
const removeSupplier = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Remove supplier' }));

describe('ExpenseForm: optional description', () => {
  it('saves without a description and sends null', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '90');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    expect(screen.getByLabelText(/Description \(optional\)/)).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ description: null, categoryId: 'c1', amount: '90', payments: [{ amount: '90', paymentMode: 'cash' }] }),
      undefined,
    );
  });

  it('still requires a category', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '90');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Choose a category')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ExpenseForm: payment breakdown', () => {
  it('starts with one payment row that cannot be removed, and follows the expense amount', async () => {
    const { user } = renderForm();
    expect(screen.getAllByTestId('payment-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Remove payment/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('2500');
    expect(summary().getByText('Total allocated').nextSibling).toHaveTextContent('₹2,500.00');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');
  });

  it('adds and removes rows (three or more) and updates the totals immediately', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');

    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    // The new row is pre-filled with what is still unallocated.
    expect(screen.getByLabelText('Payment 2 amount')).toHaveValue('1500.00');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');

    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(3);
    await user.type(screen.getByLabelText('Payment 3 amount'), '100');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('-₹100.00');

    await user.click(screen.getByRole('button', { name: 'Remove payment 3' }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');
    await user.click(screen.getByRole('button', { name: 'Remove payment 2' }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(1);
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');
    expect(screen.queryByRole('button', { name: /Remove payment/ })).not.toBeInTheDocument();
  });

  it('moves focus to the amount of a newly added row, keeping its pre-filled value', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    await waitFor(() => expect(screen.getByLabelText('Payment 2 amount')).toHaveFocus());
    expect(screen.getByLabelText('Payment 2 amount')).toHaveValue('1500.00');
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    await waitFor(() => expect(screen.getByLabelText('Payment 3 amount')).toHaveFocus());
    // Typing goes straight into the focused row and the totals follow.
    await user.keyboard('5');
    expect(screen.getByLabelText('Payment 3 amount')).toHaveValue('5');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('-₹5.00');
  });

  it('blocks saving while the allocations do not match the amount, with a clear message', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    expect(screen.getByRole('alert')).toHaveTextContent(/₹1,500\.00 is still unallocated/);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '3000');
    expect(screen.getByRole('alert')).toHaveTextContent(/₹500\.00 more than the expense amount ₹2,500\.00/);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects zero amounts and missing methods', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '100');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '0');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Payment 1 amount: Must be more than zero')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '100');
    await user.selectOptions(screen.getByLabelText('Payment 1 method'), '');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Payment 1 method: Choose a method')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits every allocation when they equal the amount', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    await user.selectOptions(screen.getByLabelText('Payment 1 method'), 'upi');
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    await user.selectOptions(screen.getByLabelText('Payment 2 method'), 'cash');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].payments).toEqual([
      { amount: '1000', paymentMode: 'upi' },
      { amount: '1500.00', paymentMode: 'cash' },
    ]);
  });
});

describe('ExpenseForm: editing', () => {
  const existing = {
    id: 'e1',
    expenseDate: '2026-10-01',
    supplier: null,
    legacySupplierName: null,
    category: { id: 'c1', name: 'Packaging', isActive: true },
    description: null,
    amount: '2500.00',
    amountPaid: '2500.00',
    payments: [
      { paymentMode: 'upi', amount: '1000.00' },
      { paymentMode: 'cash', amount: '1500.00' },
    ],
    allocatedPayments: '0.00',
    outstanding: '0.00',
    paymentMode: 'upi',
    invoiceReference: null,
    status: 'active',
    version: 3,
    documentCount: 0,
  } as unknown as Expense;

  it('loads the saved allocations and an empty description; removing the description is allowed', async () => {
    const { onSubmit, user } = renderForm({ initial: { ...existing, description: 'Tape rolls' } });
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    expect(screen.getByLabelText('Payment 1 method')).toHaveValue('upi');
    expect(screen.getByLabelText('Payment 2 amount')).toHaveValue('1500.00');
    expect(screen.getByLabelText(/Description/)).toHaveValue('Tape rolls');
    await user.clear(screen.getByLabelText(/Description/));
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ description: null });
    expect(onSubmit.mock.calls[0]![1]).toBe(3);
  });
});

describe('ExpenseForm: supplier bills default to unpaid (M1)', () => {
  it('1. a new supplier bill defaults to unpaid, with no method chosen for the user', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('2500'); // no supplier yet: paid in full
    await chooseSupplier(user);
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('');
    expect(screen.getByLabelText('Payment 1 method')).toHaveValue('');
    expect(screen.getByText(/Supplier bills start as not paid yet/)).toBeInTheDocument();
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹2,500.00');
    // Changing the amount afterwards does not re-allocate anything.
    await user.type(screen.getByLabelText('Total expense amount'), '0');
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's1', amount: '25000', payments: [] });
  });

  it('2. a supplier bill can be explicitly marked fully paid (the method is still chosen by the user)', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await chooseSupplier(user);
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Paid in full' }));
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('2500');
    expect(screen.getByLabelText('Payment 1 method')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Payment 1 method: Choose a method')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('Payment 1 method'), 'upi');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].payments).toEqual([{ amount: '2500', paymentMode: 'upi' }]);
  });

  it('3. a supplier bill can be partly paid', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await chooseSupplier(user);
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    await user.selectOptions(screen.getByLabelText('Payment 1 method'), 'cash');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].payments).toEqual([{ amount: '1000', paymentMode: 'cash' }]);
  });

  it('4. without a supplier the expense must still be paid in full', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/must add up to the full amount/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('5. choosing or removing a supplier never changes payments the user entered, and never creates one', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '1000');
    await user.selectOptions(screen.getByLabelText('Payment 1 method'), 'upi');
    await chooseSupplier(user);
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('1000'); // kept
    expect(screen.getByLabelText('Payment 1 method')).toHaveValue('upi');
    expect(screen.queryByText(/Supplier bills start as not paid yet/)).not.toBeInTheDocument();
    await removeSupplier(user);
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('1000'); // still kept
    expect(screen.getAllByTestId('payment-row')).toHaveLength(1);

    // Removing a supplier from an unpaid bill does not invent a payment: the user must enter it.
    await chooseSupplier(user);
    await user.click(screen.getByRole('button', { name: 'Not paid yet' }));
    await removeSupplier(user);
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Category'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText('Payment 1 amount: Enter the amount')).toBeInTheDocument();
  });

  it('editing keeps the saved allocations of a supplier bill', async () => {
    const { user } = renderForm({
      initial: {
        id: 'e2', expenseDate: '2026-10-01', supplier: { id: 's1', name: 'Sharma Traders', isActive: true }, legacySupplierName: null,
        category: { id: 'c1', name: 'Packaging', isActive: true }, description: null, amount: '2500.00', amountPaid: '1000.00',
        payments: [{ paymentMode: 'upi', amount: '1000.00' }], allocatedPayments: '0.00', outstanding: '1500.00', paymentMode: 'upi',
        invoiceReference: null, status: 'active', version: 2, documentCount: 0,
      } as unknown as Expense,
    });
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('1000.00');
    await user.type(screen.getByLabelText('Total expense amount'), '0');
    expect(screen.getByLabelText('Payment 1 amount')).toHaveValue('1000.00');
  });
});

describe('ExpenseForm: payment row accessibility (L3)', () => {
  it('links amount and method errors to their own inputs and shows both', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '100');
    await user.clear(screen.getByLabelText('Payment 1 amount'));
    await user.type(screen.getByLabelText('Payment 1 amount'), '0');
    await user.selectOptions(screen.getByLabelText('Payment 1 method'), '');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    const amount = screen.getByLabelText('Payment 1 amount');
    const method = screen.getByLabelText('Payment 1 method');
    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    expect(amount).toHaveAccessibleDescription('Payment 1 amount: Must be more than zero');
    expect(method).toHaveAttribute('aria-invalid', 'true');
    expect(method).toHaveAccessibleDescription('Payment 1 method: Choose a method');
  });

  it('moves focus to the row above when a row is removed', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '300');
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    await user.click(screen.getByRole('button', { name: 'Remove payment 3' }));
    expect(screen.getByLabelText('Payment 2 amount')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove payment 2' }));
    expect(screen.getByLabelText('Payment 1 amount')).toHaveFocus();
  });
});
