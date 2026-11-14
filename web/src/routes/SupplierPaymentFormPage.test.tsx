import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { setupUser } from '@/test/user-event';
import type { Supplier, SupplierBalance } from '@/types/api';
import { NewSupplierPaymentPage } from './SupplierPaymentFormPage';

vi.setConfig({ testTimeout: 15_000 });

function supplier(id: string, name: string, payable: string, isActive = true): Supplier {
  return {
    id,
    name,
    phone: null,
    address: null,
    notes: null,
    isActive,
    version: 1,
    categories: [],
    brands: [],
    expenseCount: 1,
    payable,
    unallocated: '0.00',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

const UNPAID = supplier('11111111-1111-4111-8111-111111111111', 'Unpaid Traders', '500.00');
const PARTLY = supplier('22222222-2222-4222-8222-222222222222', 'Partly Paid Co', '600.00');
const ARCHIVED_OWED = supplier('33333333-3333-4333-8333-333333333333', 'Old Owed Ltd', '50.00', false);
const FULLY_PAID = supplier('44444444-4444-4444-8444-444444444444', 'Settled Stores', '0.00');

const balanceOf = (s: Supplier): SupplierBalance => ({
  supplierId: s.id,
  totalBills: s.payable,
  paidAtPurchase: '0.00',
  totalPayments: '0.00',
  allocated: '0.00',
  payable: s.payable,
  unallocated: '0.00',
  netBalance: s.payable,
  billCount: 1,
  paymentCount: 0,
});

interface ApiState {
  /** What GET /suppliers?balance=payable answers (the server does the filtering). */
  payableList: Supplier[];
  /** Answer to POST /supplier-payments. */
  createResponse?: () => Response;
}

function fakeApi(state: ApiState) {
  const all = [UNPAID, PARTLY, ARCHIVED_OWED, FULLY_PAID];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method ?? 'GET';
    if (method === 'POST' && url.pathname.endsWith('/supplier-payments')) {
      return state.createResponse?.() ?? Response.json({ payment: { id: 'p1' } }, { status: 201 });
    }
    if (url.pathname.endsWith('/suppliers')) {
      const items = url.searchParams.get('balance') === 'payable' ? state.payableList : all.filter((s) => s.isActive);
      return Response.json({ items, pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 } });
    }
    const m = /\/suppliers\/([^/]+)(\/balance|\/open-bills)?$/.exec(url.pathname);
    if (m) {
      const s = all.find((x) => x.id === m[1]);
      if (!s) return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
      if (m[2] === '/balance') return Response.json({ balance: balanceOf(s) });
      if (m[2] === '/open-bills') return Response.json({ bills: [] });
      return Response.json({ supplier: s });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'No route' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage(path = '/supplier-payments/new') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/supplier-payments/new" element={<NewSupplierPaymentPage />} />
          <Route path="/supplier-payments/:id" element={<p>Payment saved page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return setupUser();
}

const supplierRequests = (fn: ReturnType<typeof fakeApi>) =>
  fn.mock.calls.map(([u]) => new URL(String(u), 'http://localhost')).filter((u) => u.pathname.endsWith('/suppliers'));

describe('supplier payment form: supplier dropdown', () => {
  it('asks the server only for suppliers with an outstanding balance (archived included) and shows what is owed', async () => {
    const api = fakeApi({ payableList: [UNPAID, PARTLY, ARCHIVED_OWED] });
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Supplier' }));

    const list = await screen.findByRole('listbox', { name: 'Suppliers' });
    await within(list).findByRole('option', { name: /Unpaid Traders/ });
    const requests = supplierRequests(api);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.searchParams.get('balance')).toBe('payable');
      expect(r.searchParams.get('status')).toBe('all');
    }
    const names = within(list).getAllByRole('option').map((o) => o.textContent);
    expect(names).toHaveLength(3);
    expect(names.join('|')).not.toMatch(/Settled Stores/);
    expect(within(list).getByRole('option', { name: /Partly Paid Co/ })).toHaveTextContent('Owed ₹600.00');
    expect(within(list).getByRole('option', { name: /Old Owed Ltd/ })).toHaveTextContent('(archived)');
  });

  it('shows a clear empty state when nobody is owed anything', async () => {
    fakeApi({ payableList: [] });
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Supplier' }));
    expect(await screen.findByText(/No supplier has an outstanding balance/)).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('keeps an archived supplier marked as archived after it is chosen', async () => {
    fakeApi({ payableList: [ARCHIVED_OWED] });
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Supplier' }));
    await user.click(await screen.findByRole('option', { name: /Old Owed Ltd/ }));
    expect(await screen.findByRole('button', { name: 'Supplier' })).toHaveTextContent('Old Owed Ltd (archived)');
    expect(await screen.findByText(/Currently payable/)).toHaveTextContent('₹50.00');
  });

  it('refuses a fully paid supplier opened from a link, without calling the server', async () => {
    const api = fakeApi({ payableList: [UNPAID] });
    const user = renderPage(`/supplier-payments/new?supplierId=${FULLY_PAID.id}`);
    expect(await screen.findByText(/Settled Stores has no outstanding bills/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount paid'), '100');
    await user.click(screen.getByText('UPI'));
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText(/Choose a supplier you still owe/)).toBeInTheDocument();
    expect(api.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('shows the server refusal under the supplier when the list was stale', async () => {
    fakeApi({
      payableList: [UNPAID],
      createResponse: () =>
        Response.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Some fields are invalid',
              details: [{ path: 'supplierId', message: 'This supplier has no outstanding bills to pay' }],
            },
          },
          { status: 400 },
        ),
    });
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Supplier' }));
    await user.click(await screen.findByRole('option', { name: /Unpaid Traders/ }));
    await user.type(screen.getByLabelText('Amount paid'), '100');
    await user.click(screen.getByText('UPI'));
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(screen.getAllByText('This supplier has no outstanding bills to pay').length).toBeGreaterThan(0));
    expect(screen.queryByText('Payment saved page')).not.toBeInTheDocument();
  });
});
