import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { setupUser, type TestUser } from '@/test/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import type { Category, Expense, ExpenseInput } from '@/types/api';
import { ExpenseForm } from './ExpenseForm';

// Targeted timeout (this file only): each test is a whole user scenario (often 15–30 typed and
// clicked steps) on the full expense form, rendered by React's development build in jsdom. Measured
// 0.3–3.8 s per test while the full suite runs in parallel, too close to Vitest's 5 s default to
// survive a busy machine. 15 s is about 4x the slowest measured test and still catches a real hang.
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => vi.unstubAllEnvs());

const cat = (id: string, name: string, isActive = true): Category => ({
  id,
  name,
  description: null,
  isActive,
  expenseCount: 0,
  createdAt: '',
  updatedAt: '',
});
const CATEGORIES = [cat('c1', 'Packaging'), cat('c2', 'Electronics'), cat('c3', 'Maintenance'), cat('c4', 'Transport')];
const brand = (id: string, name: string, isActive = true) => ({ id, name, isActive, expenseCount: 0, supplierCount: 0, createdAt: '', updatedAt: '' });
const BRANDS = [brand('b1', 'Samsung'), brand('b2', 'LG'), brand('b3', 'Sony'), brand('b4', 'HP')];

const supplier = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  phone: null,
  address: null,
  notes: null,
  isActive: true,
  version: 1,
  categories: [],
  brands: [],
  expenseCount: 0,
  payable: '0.00',
  unallocated: '0.00',
  ...extra,
});
const ref = (id: string, name: string, isActive = true) => ({ id, name, isActive });
/** ABC: three brands and two categories (+ an archived brand and category that must never be auto-selected). */
const ABC = supplier('s1', 'ABC Distributors', {
  brands: [ref('b1', 'Samsung'), ref('b2', 'LG'), ref('b3', 'Sony'), ref('b9', 'Retired brand', false)],
  categories: [ref('c2', 'Electronics'), ref('c1', 'Packaging'), ref('c9', 'Retired category', false)],
});
const XYZ = supplier('s2', 'XYZ Traders', { brands: [ref('b4', 'HP')], categories: [ref('c4', 'Transport')] });
/** Not linked to any brand: must never be offered once a brand is chosen. */
const OTHER = supplier('s3', 'Other Co');
const option = (s: typeof ABC) => ({ id: s.id, name: s.name, phone: null, isActive: true, categories: s.categories.filter((c: { isActive: boolean }) => c.isActive) });
/** Brand -> its active suppliers (GET /brands/:id/suppliers): Samsung one, LG two, Sony none, HP one. */
const BRAND_SUPPLIERS: Record<string, ReturnType<typeof option>[]> = {
  b1: [option(ABC)],
  b2: [option(ABC), option(XYZ)],
  b3: [],
  b4: [option(XYZ)],
};

let fetchMock: ReturnType<typeof vi.fn>;
/** Supplier ids whose detail request currently fails (the defaults then cannot be loaded). */
let failDetailFor = new Set<string>();
/** Brand ids whose supplier list currently fails to load. */
let failBrandFor = new Set<string>();
/** Supplier search/detail, active categories and brands are answered; everything else is 404. */
async function fakeApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if ((init?.method ?? 'GET') !== 'GET') return Response.json({}, { status: 404 });
  if (/\/suppliers\?/.test(url)) return Response.json({ items: [ABC, XYZ, OTHER], pagination: { page: 1, pageSize: 20, total: 3, totalPages: 1 } });
  const brandId = /\/brands\/(b\d)\/suppliers$/.exec(url)?.[1];
  if (brandId) {
    if (failBrandFor.has(brandId)) return Response.json({ error: { code: 'INTERNAL', message: 'The server had a problem.' } }, { status: 500 });
    return Response.json({ brand: { id: brandId }, suppliers: BRAND_SUPPLIERS[brandId] ?? [] });
  }
  const detailId = /\/suppliers\/(s\d)$/.exec(url)?.[1];
  if (detailId && failDetailFor.has(detailId)) {
    return Response.json({ error: { code: 'INTERNAL', message: 'The server had a problem.' } }, { status: 500 });
  }
  if (url.endsWith('/suppliers/s1')) return Response.json({ supplier: ABC });
  if (url.endsWith('/suppliers/s2')) return Response.json({ supplier: XYZ });
  if (url.includes('/brands')) return Response.json({ brands: BRANDS });
  if (url.includes('/categories')) return Response.json({ categories: CATEGORIES });
  return Response.json({}, { status: 404 });
}

function renderForm(props: { initial?: Expense; onSubmit?: (input: ExpenseInput, v: number | undefined) => Promise<Expense> } = {}) {
  const onSubmit = vi.fn<(input: ExpenseInput, baseVersion: number | undefined) => Promise<Expense>>(
    props.onSubmit ?? (async () => ({}) as Expense),
  );
  const onDone = vi.fn();
  failDetailFor = new Set();
  failBrandFor = new Set();
  fetchMock = vi.fn(fakeApi);
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ExpenseForm
          {...(props.initial ? { initial: props.initial } : {})}
          categories={CATEGORIES}
          submitLabel="Save expense"
          cancelTo="/expenses"
          onSubmit={onSubmit}
          onDone={onDone}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSubmit, onDone, user: setupUser() };
}
type User = TestUser;

const summary = () => within(screen.getByTestId('payment-summary'));
const status = () => within(screen.getByTestId('payment-status'));
const categoriesBox = () => within(screen.getByTestId('expense-categories'));
const brandsBox = () => within(screen.getByTestId('expense-brands'));
const selected = (box: () => ReturnType<typeof within>) =>
  box()
    .getAllByRole('button', { name: /^Remove / })
    .map((b: HTMLElement) => b.getAttribute('aria-label')!.replace(/^Remove /, ''));

async function chooseSupplier(user: User, name: RegExp) {
  await user.click(screen.getByRole('button', { name: 'Supplier (optional)' }));
  await user.click(await screen.findByRole('option', { name }));
}
async function chooseBrand(user: User, name: string) {
  await user.click(screen.getByRole('button', { name: 'Brand (optional)' }));
  await user.click(await screen.findByRole('option', { name }));
}
async function addCategory(user: User, name: string) {
  await user.click(await categoriesBox().findByRole('button', { name }));
}
const removeSupplier = (user: User) => user.click(screen.getByRole('button', { name: 'Remove supplier' }));

describe('ExpenseForm: optional description', () => {
  it('saves without a description and sends null', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '90');
    await addCategory(user, 'Packaging');
    expect(screen.getByLabelText(/Description \(optional\)/)).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        description: null,
        categoryIds: ['c1'],
        brandIds: [],
        amount: '90',
        payments: [{ amount: '90', paymentMode: 'cash' }],
      }),
      undefined,
    );
  });

  it('still requires at least one category', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '90');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Choose at least one category')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ExpenseForm: multiple categories (Feature 6)', () => {
  it('selects several categories in order, prevents duplicates, removes one, and keeps them while other fields change', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '5000');
    await addCategory(user, 'Transport');
    await addCategory(user, 'Packaging');
    await addCategory(user, 'Maintenance');
    expect(selected(categoriesBox)).toEqual(['Transport', 'Packaging', 'Maintenance']);
    expect(categoriesBox().getByText('Main')).toBeInTheDocument();
    // A selected category is no longer offered (no duplicates).
    expect(categoriesBox().queryByRole('button', { name: 'Transport' })).not.toBeInTheDocument();
    await user.click(categoriesBox().getByRole('button', { name: 'Remove Packaging' }));
    // Other fields do not disturb the selection.
    await user.type(screen.getByLabelText(/Description/), 'Tempo hire');
    await user.clear(screen.getByLabelText('Total expense amount'));
    await user.type(screen.getByLabelText('Total expense amount'), '5500');
    expect(selected(categoriesBox)).toEqual(['Transport', 'Maintenance']);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ categoryIds: ['c4', 'c3'], amount: '5500', payments: [{ amount: '5500', paymentMode: 'cash' }] });
  });

  it('search filters the options and Enter picks the single match', async () => {
    const { user } = renderForm();
    await user.type(categoriesBox().getByLabelText('Search or add category'), 'mainte{Enter}');
    expect(selected(categoriesBox)).toEqual(['Maintenance']);
  });
});

describe('ExpenseForm: payment breakdown', () => {
  it('starts with one payment row that cannot be removed, and follows the expense amount', async () => {
    const { user } = renderForm();
    expect(screen.getAllByTestId('payment-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Remove payment/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('2500');
    expect(summary().getByText('Paid').nextSibling).toHaveTextContent('₹2,500.00');
    expect(screen.getByTestId('payment-badge')).toHaveTextContent('Fully paid');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');
  });

  it('adds and removes rows (three or more) and updates the totals immediately', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.clear(screen.getByLabelText('Amount paid'));
    await user.type(screen.getByLabelText('Amount paid'), '1000');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');

    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    expect(screen.getByLabelText('Amount paid (payment 2)')).toHaveValue('1500.00');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');

    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(3);
    await user.type(screen.getByLabelText('Amount paid (payment 3)'), '100');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('-₹100.00');

    await user.click(screen.getByRole('button', { name: 'Remove payment 3' }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹0.00');
    await user.click(screen.getByRole('button', { name: 'Remove payment 2' }));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(1);
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');
  });

  it('blocks saving while the allocations do not match the amount, with a clear message', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await addCategory(user, 'Packaging');
    await user.clear(screen.getByLabelText('Amount paid'));
    await user.type(screen.getByLabelText('Amount paid'), '1000');
    expect(screen.getByRole('alert')).toHaveTextContent(/₹1,500\.00 is still unallocated/);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Amount paid'));
    await user.type(screen.getByLabelText('Amount paid'), '3000');
    expect(screen.getByRole('alert')).toHaveTextContent(/₹500\.00 more than the expense amount ₹2,500\.00/);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits every allocation when they equal the amount', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await addCategory(user, 'Packaging');
    await user.clear(screen.getByLabelText('Amount paid'));
    await user.type(screen.getByLabelText('Amount paid'), '1000');
    await user.selectOptions(screen.getByLabelText('Payment method'), 'upi');
    await user.click(screen.getByRole('button', { name: /Add payment/ }));
    await user.selectOptions(screen.getByLabelText('Payment method (payment 2)'), 'cash');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].payments).toEqual([
      { amount: '1000', paymentMode: 'upi' },
      { amount: '1500.00', paymentMode: 'cash' },
    ]);
  });
});

describe('ExpenseForm: payment status bug fix (Feature 5)', () => {
  it('entering the amount fills the payment and shows the status options at once, defaulting to Paid in full (no supplier needed)', async () => {
    const { user } = renderForm();
    expect(screen.queryByTestId('payment-status')).not.toBeInTheDocument(); // nothing to pay yet
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('2500');
    expect(status().getByRole('radio', { name: 'Paid in full' })).toHaveAttribute('aria-checked', 'true');
    expect(status().getByRole('radio', { name: 'Part paid' })).toHaveAttribute('aria-checked', 'false');
    expect(status().getByRole('radio', { name: 'Not paid yet' })).toBeInTheDocument();
  });

  it('selecting a supplier keeps the entered payment amount, method and status', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await user.selectOptions(screen.getByLabelText('Payment method'), 'upi');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('ABC Distributors'));
    expect(screen.getByLabelText('Amount paid')).toHaveValue('2500');
    expect(screen.getByLabelText('Payment method')).toHaveValue('upi');
    expect(status().getByRole('radio', { name: 'Paid in full' })).toHaveAttribute('aria-checked', 'true');
    // Changing the supplier again, or removing it, does not touch the payment either.
    await chooseSupplier(user, /XYZ Traders/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('XYZ Traders'));
    await removeSupplier(user);
    expect(screen.getByLabelText('Amount paid')).toHaveValue('2500');
    await addCategory(user, 'Packaging');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: null, amount: '2500', payments: [{ amount: '2500', paymentMode: 'upi' }] });
  });

  it('the paid amount keeps following the total while the bill is paid in full', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '250');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('ABC'));
    await user.type(screen.getByLabelText('Total expense amount'), '0');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('2500');
  });

  it('part paid: the remainder stays payable to the supplier', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await user.click(status().getByRole('radio', { name: 'Part paid' }));
    expect(status().getByRole('radio', { name: 'Part paid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('');
    expect(screen.getByLabelText('Amount paid')).toHaveFocus();
    await user.keyboard('1000');
    expect(screen.getByTestId('payment-remaining')).toHaveTextContent('₹1,500.00');
    expect(screen.getByText(/stays due to ABC Distributors/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's1', payments: [{ amount: '1000', paymentMode: 'cash' }] });
  });

  it('not paid yet: saved with no payments; without a supplier it is refused with an explanation', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '2500');
    await addCategory(user, 'Packaging');
    await user.click(status().getByRole('radio', { name: 'Not paid yet' }));
    expect(screen.getByLabelText('Amount paid')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent(/without a supplier must be paid in full/);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(onSubmit).not.toHaveBeenCalled();

    await chooseSupplier(user, /XYZ Traders/);
    // Manually chosen category: replacing it needs confirmation; keep it.
    await user.click(await screen.findByRole('button', { name: 'Keep my selections' }));
    expect(status().getByRole('radio', { name: 'Not paid yet' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's2', amount: '2500', payments: [], categoryIds: ['c1'] });
  });

  it('editing an unpaid supplier bill keeps it unpaid (never silently marked paid)', async () => {
    const { onSubmit, user } = renderForm({
      initial: {
        id: 'e9', expenseDate: '2026-10-01', supplier: { id: 's1', name: 'ABC Distributors', isActive: true }, legacySupplierName: null,
        category: ref('c1', 'Packaging'), categories: [ref('c1', 'Packaging')], brands: [], description: 'Boxes', amount: '800.00',
        amountPaid: '0.00', payments: [], allocatedPayments: '0.00', outstanding: '800.00', paymentMode: null,
        invoiceReference: null, status: 'active', version: 4, documentCount: 0,
      } as unknown as Expense,
    });
    expect(status().getByRole('radio', { name: 'Not paid yet' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('');
    await user.clear(screen.getByLabelText(/Description/));
    await user.type(screen.getByLabelText(/Description/), 'Boxes and tape');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ payments: [], amount: '800.00', description: 'Boxes and tape', categoryIds: ['c1'] });
    expect(onSubmit.mock.calls[0]![1]).toBe(4);
  });

  it('editing keeps the saved allocations of a part-paid supplier bill when the amount changes', async () => {
    const { user } = renderForm({
      initial: {
        id: 'e2', expenseDate: '2026-10-01', supplier: { id: 's1', name: 'ABC Distributors', isActive: true }, legacySupplierName: null,
        category: ref('c1', 'Packaging'), categories: [ref('c1', 'Packaging')], brands: [], description: null, amount: '2500.00',
        amountPaid: '1000.00', payments: [{ paymentMode: 'upi', amount: '1000.00' }], allocatedPayments: '0.00', outstanding: '1500.00',
        paymentMode: 'upi', invoiceReference: null, status: 'active', version: 2, documentCount: 0,
      } as unknown as Expense,
    });
    expect(status().getByRole('radio', { name: 'Part paid' })).toHaveAttribute('aria-checked', 'true');
    await user.type(screen.getByLabelText('Total expense amount'), '0');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('1000.00');
  });
});

describe('ExpenseForm: supplier default categories (Feature 7, without a brand)', () => {
  it('2–8. pre-selects the supplier’s active default categories; edits affect only this expense; never writes supplier defaults', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '5000');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    // 16. archived defaults are never auto-selected; brands are chosen first, never by the supplier
    expect(screen.queryByText('Retired category')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Brand (optional)' })).toHaveTextContent('No brand');

    await user.click(categoriesBox().getByRole('button', { name: 'Remove Packaging' }));
    await addCategory(user, 'Maintenance');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's1', brandIds: [], categoryIds: ['c2', 'c3'], amount: '5000' });
    // 9. Nothing was sent to the supplier (its defaults are only changed in the supplier form).
    const writes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET');
    expect(writes).toEqual([]);
  });

  it('10. changing the supplier replaces untouched default categories without asking; removing it clears them', async () => {
    const { user } = renderForm();
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await chooseSupplier(user, /XYZ Traders/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Transport']));
    expect(screen.queryByRole('button', { name: 'Keep my selections' })).not.toBeInTheDocument();
    await removeSupplier(user);
    await waitFor(() => expect(categoriesBox().getByText('None selected')).toBeInTheDocument());
  });

  it('11–13. asks before replacing manual category changes; Cancel keeps supplier and every field; confirming applies the new defaults only', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '3000');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await user.click(status().getByRole('radio', { name: 'Part paid' }));
    await user.keyboard('1000');
    await user.type(screen.getByLabelText(/Description/), 'TV stock');
    await user.click(categoriesBox().getByRole('button', { name: 'Remove Packaging' })); // manual change

    await chooseSupplier(user, /XYZ Traders/);
    expect(await screen.findByText(/Replace them with the usual ones for XYZ Traders/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('ABC Distributors');
    expect(selected(categoriesBox)).toEqual(['Electronics']);

    await chooseSupplier(user, /XYZ Traders/);
    await user.click(await screen.findByRole('button', { name: 'Use XYZ Traders’s' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('XYZ Traders'));
    expect(selected(categoriesBox)).toEqual(['Transport']);
    expect(screen.getByLabelText('Total expense amount')).toHaveValue('3000');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('1000');
    expect(status().getByRole('radio', { name: 'Part paid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/Description/)).toHaveValue('TV stock');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's2', categoryIds: ['c4'], payments: [{ amount: '1000' }] });
  });

  it('13. bill files picked before changing the supplier are kept', async () => {
    vi.stubEnv('VITE_BILL_ATTACHMENTS', 'enabled'); // attachments are postponed (off by default)
    const { user } = renderForm();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'bill.pdf', { type: 'application/pdf' });
    await user.upload(document.querySelector('input[type="file"][multiple]') as HTMLInputElement, file);
    expect(await screen.findByText('bill.pdf')).toBeInTheDocument();
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await chooseSupplier(user, /XYZ Traders/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Transport']));
    expect(screen.getByText('bill.pdf')).toBeInTheDocument();
  });
});

describe('ExpenseForm: supplier defaults cannot be loaded (M3)', () => {
  const noneSelected = (box: () => ReturnType<typeof within>) => expect(box().getByText('None selected')).toBeInTheDocument();

  it('never keeps the previous supplier defaults, keeps every other field, shows an error and retries', async () => {
    vi.stubEnv('VITE_BILL_ATTACHMENTS', 'enabled'); // the picked bill file is one of the kept fields
    const { onSubmit, user } = renderForm();
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'bill.pdf', { type: 'application/pdf' });
    await user.upload(document.querySelector('input[type="file"][multiple]') as HTMLInputElement, pdf);
    await user.type(screen.getByLabelText('Total expense amount'), '3000');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await user.click(status().getByRole('radio', { name: 'Part paid' }));
    await user.keyboard('1000');
    await user.type(screen.getByLabelText(/Description/), 'TV stock');

    failDetailFor.add('s2');
    await chooseSupplier(user, /XYZ Traders/);
    expect(await screen.findByTestId('defaults-error')).toHaveTextContent(/Could not load the usual categories of XYZ Traders/);
    expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('XYZ Traders');
    noneSelected(categoriesBox);
    expect(screen.getByLabelText('Total expense amount')).toHaveValue('3000');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('1000');
    expect(status().getByRole('radio', { name: 'Part paid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/Description/)).toHaveValue('TV stock');
    expect(screen.getByText('bill.pdf')).toBeInTheDocument();

    failDetailFor.clear();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Transport']));
    expect(screen.queryByTestId('defaults-error')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's2', categoryIds: ['c4'], payments: [{ amount: '1000' }] });
  });

  it('asks before touching hand-edited categories: Cancel keeps everything; Remove drops only the previous supplier items', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '500');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await addCategory(user, 'Maintenance'); // added by hand

    failDetailFor.add('s2');
    await chooseSupplier(user, /XYZ Traders/);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('ABC Distributors');
    expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging', 'Maintenance']);

    await chooseSupplier(user, /XYZ Traders/);
    await user.click(await screen.findByRole('button', { name: 'Remove them' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('XYZ Traders'));
    expect(selected(categoriesBox)).toEqual(['Maintenance']); // only what the user added themselves
    expect(screen.getByTestId('defaults-error')).toBeInTheDocument();
  });

  it('Keep my selections makes them the user own; a later successful retry still asks before replacing them', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '500');
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await user.click(categoriesBox().getByRole('button', { name: 'Remove Packaging' }));

    failDetailFor.add('s2');
    await chooseSupplier(user, /XYZ Traders/);
    await user.click(await screen.findByRole('button', { name: 'Keep my selections' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Supplier (optional)' })).toHaveTextContent('XYZ Traders'));
    expect(selected(categoriesBox)).toEqual(['Electronics']);

    failDetailFor.clear();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Replace them with the usual ones for XYZ Traders/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(selected(categoriesBox)).toEqual(['Electronics']);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ supplierId: 's2', categoryIds: ['c2'] });
  });
});

describe('ExpenseForm: brand-first entry (Feature 3)', () => {
  const supplierButton = () => screen.getByRole('button', { name: 'Supplier (optional)' });
  const supplierChoices = async (user: User) => {
    await user.click(supplierButton());
    const names = (await within(await screen.findByRole('listbox', { name: 'supplier' })).findAllByRole('option')).map((o) => o.textContent ?? '');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    return names;
  };

  it('a brand with ONE supplier selects it automatically, with its default categories', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '1200');
    await chooseBrand(user, 'Samsung');
    await waitFor(() => expect(supplierButton()).toHaveTextContent('ABC Distributors'));
    expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']);
    expect(screen.getByTestId('brand-notice')).toHaveTextContent(/ABC Distributors is the only supplier of Samsung/);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b1'], supplierId: 's1', categoryIds: ['c2', 'c1'], amount: '1200' });
  });

  it('a brand with SEVERAL suppliers offers only those and requires a choice', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '700');
    await addCategory(user, 'Packaging');
    await chooseBrand(user, 'LG');
    await waitFor(() => expect(supplierButton()).toHaveTextContent('Choose LG'));
    expect(await supplierChoices(user)).toEqual(['ABC Distributors', 'XYZ Traders']); // never "Other Co"
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText(/Choose which of LG's suppliers/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await chooseSupplier(user, /XYZ Traders/);
    // Packaging was chosen by hand: replacing it needs confirmation; keep it.
    await user.click(await screen.findByRole('button', { name: 'Keep my selections' }));
    await waitFor(() => expect(supplierButton()).toHaveTextContent('XYZ Traders'));
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b2'], supplierId: 's2', categoryIds: ['c1'] });
  });

  it('a brand WITHOUT suppliers continues without one', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '300');
    await addCategory(user, 'Maintenance');
    await chooseBrand(user, 'Sony');
    await waitFor(() => expect(screen.getByTestId('brand-notice')).toHaveTextContent(/Sony has no linked supplier/));
    expect(supplierButton()).toHaveTextContent('No supplier');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b3'], supplierId: null, categoryIds: ['c3'] });
  });

  it('changing the supplier manually loads its categories; untouched defaults are replaced without asking', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '900');
    await chooseBrand(user, 'LG');
    await waitFor(() => expect(supplierButton()).toHaveTextContent('Choose LG'));
    await chooseSupplier(user, /ABC Distributors/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await chooseSupplier(user, /XYZ Traders/);
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Transport']));
    expect(screen.queryByRole('button', { name: 'Keep my selections' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b2'], supplierId: 's2', categoryIds: ['c4'] });
  });

  it('changing the brand explains a supplier replacement first; Cancel changes nothing; unrelated fields are kept', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '4000');
    await chooseBrand(user, 'Samsung');
    await waitFor(() => expect(supplierButton()).toHaveTextContent('ABC Distributors'));
    await user.click(status().getByRole('radio', { name: 'Part paid' }));
    await user.keyboard('1500');
    await user.type(screen.getByLabelText(/Description/), 'Printers');

    await chooseBrand(user, 'HP');
    expect(await screen.findByText(/ABC Distributors is not linked to HP\. XYZ Traders, its only supplier, will be selected instead/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Brand (optional)' })).toHaveTextContent('Samsung');
    expect(supplierButton()).toHaveTextContent('ABC Distributors');

    await chooseBrand(user, 'HP');
    await user.click(await screen.findByRole('button', { name: 'Change brand' }));
    await waitFor(() => expect(supplierButton()).toHaveTextContent('XYZ Traders'));
    expect(screen.getByRole('button', { name: 'Brand (optional)' })).toHaveTextContent('HP');
    expect(selected(categoriesBox)).toEqual(['Transport']); // untouched defaults follow the supplier
    expect(screen.getByLabelText('Total expense amount')).toHaveValue('4000');
    expect(screen.getByLabelText('Amount paid')).toHaveValue('1500');
    expect(status().getByRole('radio', { name: 'Part paid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/Description/)).toHaveValue('Printers');

    // A brand the current supplier also supplies keeps it, silently.
    await chooseBrand(user, 'LG');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Brand (optional)' })).toHaveTextContent('LG'));
    expect(supplierButton()).toHaveTextContent('XYZ Traders');
    expect(screen.queryByRole('button', { name: 'Change brand' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b2'], supplierId: 's2', categoryIds: ['c4'], payments: [{ amount: '1500' }] });
  });

  it('changing the brand asks before discarding hand-picked categories ("Keep my categories")', async () => {
    const { onSubmit, user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '650');
    await chooseBrand(user, 'Samsung');
    await waitFor(() => expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging']));
    await addCategory(user, 'Maintenance');
    await chooseBrand(user, 'HP');
    expect(await screen.findByText(/You chose the categories by hand/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep my categories' }));
    await waitFor(() => expect(supplierButton()).toHaveTextContent('XYZ Traders'));
    expect(selected(categoriesBox)).toEqual(['Electronics', 'Packaging', 'Maintenance']);
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b4'], supplierId: 's2', categoryIds: ['c2', 'c1', 'c3'] });
  });

  it('14. editing keeps the saved brand, supplier and categories (never the current defaults)', async () => {
    const { onSubmit, user } = renderForm({
      initial: {
        id: 'e3', expenseDate: '2026-10-01', supplier: { id: 's2', name: 'XYZ Traders', isActive: true }, legacySupplierName: null,
        category: ref('c3', 'Maintenance'), categories: [ref('c3', 'Maintenance')], brands: [ref('b2', 'LG'), ref('b4', 'HP')],
        description: null, amount: '100.00', amountPaid: '100.00', payments: [{ paymentMode: 'cash', amount: '100.00' }],
        allocatedPayments: '0.00', outstanding: '0.00', paymentMode: 'cash', invoiceReference: null, status: 'active', version: 1, documentCount: 0,
      } as unknown as Expense,
    });
    expect(screen.getByRole('button', { name: 'Brand (optional)' })).toHaveTextContent('LG');
    expect(supplierButton()).toHaveTextContent('XYZ Traders');
    expect(selected(categoriesBox)).toEqual(['Maintenance']);
    expect(selected(brandsBox)).toEqual(['HP']); // the other brand of this expense
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b2', 'b4'], supplierId: 's2', categoryIds: ['c3'] });
  });

  it('editing an older expense whose supplier is not linked to its brand keeps that pair', async () => {
    const { onSubmit, user } = renderForm({
      initial: {
        id: 'e4', expenseDate: '2026-09-01', supplier: { id: 's1', name: 'ABC Distributors', isActive: true }, legacySupplierName: null,
        category: ref('c1', 'Packaging'), categories: [ref('c1', 'Packaging')], brands: [ref('b3', 'Sony')],
        description: 'Old bill', amount: '50.00', amountPaid: '50.00', payments: [{ paymentMode: 'cash', amount: '50.00' }],
        allocatedPayments: '0.00', outstanding: '0.00', paymentMode: 'cash', invoiceReference: null, status: 'active', version: 3, documentCount: 0,
      } as unknown as Expense,
    });
    expect(supplierButton()).toHaveTextContent('ABC Distributors');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b3'], supplierId: 's1', categoryIds: ['c1'] });
  });

  it('an older expense with a brand but no supplier can still be edited and saved as it is', async () => {
    const { onSubmit, user } = renderForm({
      initial: {
        id: 'e5', expenseDate: '2026-08-01', supplier: null, legacySupplierName: null,
        category: ref('c1', 'Packaging'), categories: [ref('c1', 'Packaging')], brands: [ref('b2', 'LG')],
        description: 'Cash purchase', amount: '75.00', amountPaid: '75.00', payments: [{ paymentMode: 'cash', amount: '75.00' }],
        allocatedPayments: '0.00', outstanding: '0.00', paymentMode: 'cash', invoiceReference: null, status: 'active', version: 2, documentCount: 0,
      } as unknown as Expense,
    });
    await waitFor(() => expect(supplierButton()).toHaveTextContent('Choose LG'));
    await user.clear(screen.getByLabelText(/Description/));
    await user.type(screen.getByLabelText(/Description/), 'Cash purchase, cable');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: ['b2'], supplierId: null, description: 'Cash purchase, cable' });
  });

  it('choosing "No brand" also removes the other brands, and says so', async () => {
    const { onSubmit, user } = renderForm({
      initial: {
        id: 'e6', expenseDate: '2026-08-01', supplier: { id: 's2', name: 'XYZ Traders', isActive: true }, legacySupplierName: null,
        category: ref('c4', 'Transport'), categories: [ref('c4', 'Transport')], brands: [ref('b4', 'HP'), ref('b2', 'LG')],
        description: null, amount: '20.00', amountPaid: '20.00', payments: [{ paymentMode: 'cash', amount: '20.00' }],
        allocatedPayments: '0.00', outstanding: '0.00', paymentMode: 'cash', invoiceReference: null, status: 'active', version: 1, documentCount: 0,
      } as unknown as Expense,
    });
    expect(selected(brandsBox)).toEqual(['LG']);
    await user.click(screen.getByRole('button', { name: 'Remove brand' }));
    expect(await screen.findByTestId('brand-notice')).toHaveTextContent(/other brand of this expense was removed too/);
    expect(supplierButton()).toHaveTextContent('XYZ Traders'); // the supplier stays
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ brandIds: [], supplierId: 's2' });
  });

  it('shows the server’s brand–supplier check on the supplier field', async () => {
    const { user } = renderForm({
      onSubmit: async () => {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', undefined, [
          { path: 'supplierId', message: 'ABC Distributors is not linked to the brand Samsung.' },
        ]);
      },
    });
    await user.type(screen.getByLabelText('Total expense amount'), '10');
    await chooseBrand(user, 'Samsung');
    await waitFor(() => expect(supplierButton()).toHaveTextContent('ABC Distributors'));
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('ABC Distributors is not linked to the brand Samsung.')).toBeInTheDocument();
  });

  it('if the brand’s suppliers cannot be loaded, the supplier is left alone and it can be retried', async () => {
    const { user } = renderForm();
    failBrandFor.add('b1');
    await chooseBrand(user, 'Samsung');
    expect(await screen.findByTestId('brand-suppliers-error')).toHaveTextContent(/Could not load the suppliers of Samsung/);
    failBrandFor.clear();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(supplierButton()).toHaveTextContent('ABC Distributors'));
  });
});

describe('ExpenseForm: loading state (Feature 2)', () => {
  it('shows progress, blocks double submits, and restores the button with the input kept after a failure', async () => {
    let reject!: (e: unknown) => void;
    const { onSubmit, user } = renderForm({ onSubmit: () => new Promise<Expense>((_, r) => (reject = r)) });
    await user.type(screen.getByLabelText('Total expense amount'), '120');
    await addCategory(user, 'Packaging');
    await user.type(screen.getByLabelText(/Description/), 'Tape');
    const save = screen.getByRole('button', { name: 'Save expense' });
    await user.click(save);
    const busy = await screen.findByRole('button', { name: /Saving…/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await user.click(busy);
    await user.click(busy);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    reject(new ApiError(500, 'INTERNAL', 'The server had a problem.'));
    const again = await screen.findByRole('button', { name: 'Save expense' });
    expect(again).toBeEnabled();
    expect(screen.getByRole('alert', { name: '' })).toBeTruthy();
    expect(screen.getAllByText('The server had a problem.').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Total expense amount')).toHaveValue('120');
    expect(screen.getByLabelText(/Description/)).toHaveValue('Tape');
    expect(selected(categoriesBox)).toEqual(['Packaging']);
  });
});

describe('ExpenseForm: payment row accessibility (L3)', () => {
  it('links amount and method errors to their own inputs and shows both', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText('Total expense amount'), '100');
    await user.clear(screen.getByLabelText('Amount paid'));
    await user.type(screen.getByLabelText('Amount paid'), '0');
    await user.selectOptions(screen.getByLabelText('Payment method'), '');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    const amount = screen.getByLabelText('Amount paid');
    const method = screen.getByLabelText('Payment method');
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
    expect(screen.getByLabelText('Amount paid (payment 2)')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove payment 2' }));
    expect(screen.getByLabelText('Amount paid')).toHaveFocus();
  });
});

describe('ExpenseForm: bill attachments postponed (default build)', () => {
  const noAttachmentUi = () => {
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/Bill photos and documents/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose files|Take photo|Upload/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/shop PC|sent automatically|Pending sync/i);
  };

  it('creates an expense without any attachment step or upload message', async () => {
    const { onSubmit, onDone, user } = renderForm();
    noAttachmentUi();
    await user.type(screen.getByLabelText('Total expense amount'), '450');
    await addCategory(user, 'Packaging');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ amount: '450', categoryIds: ['c1'], payments: [{ amount: '450', paymentMode: 'cash' }] });
    expect(onDone.mock.calls[0]![1]).toBe('Expense saved.');
  });

  it('edits an expense that already has document records without touching them', async () => {
    const { onSubmit, onDone, user } = renderForm({
      initial: {
        id: 'e9', expenseDate: '2026-10-01', supplier: null, legacySupplierName: null,
        category: ref('c1', 'Packaging'), categories: [ref('c1', 'Packaging')], brands: [], description: 'Tape', amount: '300.00',
        amountPaid: '300.00', payments: [{ paymentMode: 'cash', amount: '300.00' }], allocatedPayments: '0.00', outstanding: '0.00',
        paymentMode: 'cash', invoiceReference: null, status: 'active', version: 7, documentCount: 2,
      } as unknown as Expense,
    });
    noAttachmentUi();
    await user.clear(screen.getByLabelText(/Description \(optional\)/));
    await user.type(screen.getByLabelText(/Description \(optional\)/), 'Tape and boxes');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ description: 'Tape and boxes', categoryIds: ['c1'] });
    expect(onSubmit.mock.calls[0]![1]).toBe(7);
    expect(onDone.mock.calls[0]![1]).toBe('Changes saved.');
    // No request ever reaches the document endpoints.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/documents') || String(u).includes('/document-storage'))).toBe(false);
  });
});
