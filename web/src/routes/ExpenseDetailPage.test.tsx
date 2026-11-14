import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppRoutes } from '@/app/AppRoutes';
import { AppProviders } from '@/app/providers';
import type { Expense, SessionUser } from '@/types/api';

/**
 * Regression tests for the expense detail page.
 *
 * Opening an existing expense crashed the whole app with React error #310 ("Rendered more hooks
 * than during the previous render"): a hook was called after the loading/error early returns, so
 * the loaded render had one more hook than the loading render. The tests below load real
 * (loading → loaded) transitions through the router, exactly as a phone does.
 */

const MANAGER: SessionUser = { id: 'u2', email: 'm@example.com', name: 'Manu', role: 'manager', mustChangePassword: false };

const PERSON = { id: 'u1', name: 'Olivia' };

/** A record created with the current app: split payments, several categories, brands. */
const NEW_EXPENSE: Expense = {
  id: 'e-new',
  expenseDate: '2026-11-10',
  supplier: { id: 's1', name: 'Acme Traders', isActive: true },
  legacySupplierName: null,
  category: { id: 'c1', name: 'Stock', isActive: true },
  categories: [
    { id: 'c1', name: 'Stock', isActive: true },
    { id: 'c2', name: 'Transport', isActive: true },
  ],
  brands: [{ id: 'b1', name: 'Brand A', isActive: true }],
  description: 'November stock',
  amount: '2500.00',
  amountPaid: '1500.00',
  payments: [
    { paymentMode: 'upi', amount: '1000.00' },
    { paymentMode: 'cash', amount: '500.00' },
  ],
  allocatedPayments: '0.00',
  outstanding: '1000.00',
  paymentMode: 'upi',
  invoiceReference: 'INV-7',
  status: 'active',
  version: 1,
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
  createdBy: PERSON,
  updatedBy: PERSON,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  documentCount: 0,
};

/**
 * A record from before suppliers, split payments, categories[] and brands existed. The API fills
 * the newer fields with their neutral values; `categories` and `brands` may be missing entirely on
 * very old cached answers, so the page must tolerate that too.
 */
const LEGACY_EXPENSE = {
  id: 'e-legacy',
  expenseDate: '2025-01-05',
  supplier: null,
  legacySupplierName: 'Old Supplier (typed)',
  category: { id: 'c9', name: 'Misc', isActive: false },
  description: null,
  amount: '120.00',
  amountPaid: '120.00',
  payments: [],
  allocatedPayments: '0.00',
  outstanding: '0.00',
  paymentMode: null,
  invoiceReference: null,
  status: 'active',
  version: 1,
  createdAt: '2025-01-05T09:00:00.000Z',
  updatedAt: '2025-01-05T09:00:00.000Z',
  createdBy: PERSON,
  updatedBy: PERSON,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  documentCount: 0,
} as unknown as Expense;

function fakeApi(expenses: Record<string, Expense | { status: number }>) {
  const fn = vi.fn(async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path.endsWith('/auth/me')) return Response.json({ user: MANAGER, csrfToken: 'csrf' });
    if (path.endsWith('/health')) return Response.json({ status: 'ok', database: 'up', version: null, timestamp: '2026-01-01T00:00:00Z' });
    if (path.endsWith('/sync/changes')) return Response.json({ cursor: '0', events: [], truncated: false });
    const detail = path.match(/\/expenses\/([^/]+)$/);
    if (detail) {
      const record = expenses[detail[1]!];
      if (!record) return Response.json({ error: { code: 'NOT_FOUND', message: 'Expense not found' } }, { status: 404 });
      if ('status' in record && typeof record.status === 'number') {
        return Response.json({ error: { code: 'INTERNAL', message: 'Server error' } }, { status: record.status });
      }
      return Response.json({ expense: record });
    }
    if (path.endsWith('/history')) return Response.json({ history: [] });
    if (path.endsWith('/documents')) return Response.json({ documents: [] });
    return Response.json({ error: { code: 'NOT_FOUND', message: 'No route' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProviders queryClient={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('ExpenseDetailPage', () => {
  let consoleError: MockInstance<(...args: unknown[]) => void>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  function expectNoCrash() {
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    const hookErrors = consoleError.mock.calls.filter((call) =>
      call.some((arg) => /Rendered more hooks|Rendered fewer hooks|Unhandled UI error|change in the order of Hooks/i.test(String(arg))),
    );
    expect(hookErrors).toEqual([]);
  }

  it('opens an expense recorded with the current app (loading → loaded) without crashing', async () => {
    fakeApi({ [NEW_EXPENSE.id]: NEW_EXPENSE });
    renderAt(`/expenses/${NEW_EXPENSE.id}`);
    expect(await screen.findByRole('heading', { name: 'November stock' })).toBeInTheDocument();
    expectNoCrash();
    expect(screen.getByText('Acme Traders')).toBeInTheDocument();
    expect(screen.getByTestId('expense-categories')).toHaveTextContent('Stock');
    expect(screen.getByTestId('expense-categories')).toHaveTextContent('Transport');
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/expenses/${NEW_EXPENSE.id}/edit`);
    expect(screen.getByRole('button', { name: 'Void' })).toBeInTheDocument();
  });

  it('opens a legacy expense (no supplier link, no split payments, no categories/brands arrays)', async () => {
    fakeApi({ [LEGACY_EXPENSE.id]: LEGACY_EXPENSE });
    renderAt(`/expenses/${LEGACY_EXPENSE.id}`);
    expect(await screen.findByRole('heading', { name: 'Misc' })).toBeInTheDocument();
    expectNoCrash();
    expect(screen.getByText(/Originally typed as/)).toHaveTextContent('Old Supplier (typed)');
    expect(screen.getByTestId('expense-categories')).toHaveTextContent('Misc');
    expect(screen.getByTestId('expense-categories')).toHaveTextContent('(archived)');
  });

  it('opens a voided expense and offers Restore', async () => {
    fakeApi({
      'e-void': {
        ...NEW_EXPENSE,
        id: 'e-void',
        status: 'voided',
        voidedAt: '2026-11-11T10:00:00.000Z',
        voidedBy: PERSON,
        voidReason: 'Duplicate entry',
      },
    });
    renderAt('/expenses/e-void');
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expectNoCrash();
    expect(screen.getByText(/Duplicate entry/)).toBeInTheDocument();
  });

  it('shows a readable error for a missing record instead of crashing', async () => {
    fakeApi({});
    renderAt('/expenses/does-not-exist');
    expect(await screen.findByText('Could not load this expense')).toBeInTheDocument();
    expectNoCrash();
  });

  it('shows a readable error when the API fails', async () => {
    fakeApi({ 'e-500': { status: 500 } });
    renderAt('/expenses/e-500');
    expect(await screen.findByText('Could not load this expense')).toBeInTheDocument();
    expectNoCrash();
  });
});
