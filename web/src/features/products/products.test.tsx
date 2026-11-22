import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/AppRoutes';
import { AppProviders } from '@/app/providers';
import { setupUser } from '@/test/user-event';
import {
  useCreateProduct,
  useLinkSupplier,
  useProductCostHistory,
  useProductCosts,
  useProductHistory,
  useSetDefaultCost,
  useUnlinkSupplier,
  useUpdateSupplierLink,
} from './products-api';
import type { Category, Product, ProductInput, SessionUser } from '@/types/api';

const PERSON = { id: 'u1', name: 'Olivia' };
// Before the separate CHANGE permission (migration 0017) a manager who could see prices could also
// change them: these fixtures keep that meaning unless a test asks for a view-only manager.
const user = (canViewPurchasePrices: boolean, canEditPurchasePrices = canViewPurchasePrices): SessionUser => ({
  id: 'u2',
  email: 'm@example.com',
  name: 'Manu',
  role: 'manager',
  mustChangePassword: false,
  canViewPurchasePrices,
  canEditPurchasePrices,
});

const product = (id: string, name: string, extra: Partial<Product> = {}): Product => ({
  id,
  name,
  brand: { id: 'b1', name: 'Classmate', isActive: true },
  category: { id: 'c1', name: 'Notebooks', isActive: true, isProductUsable: true },
  sku: null,
  barcode: null,
  description: null,
  size: 'A4',
  pageCount: 140,
  gsm: null,
  binding: null,
  sellingUnit: 'piece',
  packQty: 1,
  attributes: {},
  searchAliases: [],
  mrp: '55.00',
  sellingPrice: '50.00',
  spAboveMrpConfirmation: null,
  supplierCount: 0,
  isActive: true,
  version: 1,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  createdBy: PERSON,
  updatedBy: PERSON,
  ...extra,
});

const category = (id: string, name: string, isProductUsable: boolean): Category => ({
  id,
  name,
  description: null,
  isActive: true,
  isProductUsable,
  expenseCount: 0,
  productCount: 0,
  createdAt: '',
  updatedAt: '',
});

const PAGES: Record<string, Product[]> = {
  '1': [product('p1', 'Register'), product('p2', 'Spiral Notebook')],
  '2': [product('p3', 'Long Book')],
};

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

function fakeApi(me: SessionUser, overrides: (call: Call) => Response | null = () => null) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, 'http://localhost');
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const call: Call = { method: init.method ?? 'GET', path, query: u.searchParams, body: init.body ? JSON.parse(String(init.body)) : null, signal: init.signal };
    calls.push(call);
    const custom = overrides(call);
    if (custom) return custom;
    if (path === '/auth/me') return Response.json({ user: me, csrfToken: 'csrf' });
    if (path === '/health') return Response.json({ status: 'ok', database: 'up', version: null, timestamp: '2026-01-01T00:00:00Z' });
    if (path === '/sync/changes') return Response.json({ cursor: '0', events: [], truncated: false });
    if (path === '/brands') return Response.json({ brands: [{ id: 'b1', name: 'Classmate', isActive: true, expenseCount: 0, supplierCount: 0, productCount: 2, createdAt: '', updatedAt: '' }] });
    if (path === '/categories') return Response.json({ categories: [category('c1', 'Notebooks', true), category('c2', 'Rent', false)] });
    if (path === '/products' && call.method === 'GET') {
      const page = u.searchParams.get('page') ?? '1';
      const items = PAGES[page] ?? [];
      return Response.json({ items, pagination: { page: Number(page), pageSize: 25, total: 3, totalPages: 2 }, closeMatches: false });
    }
    if (path === '/products/purchase-prices') {
      const ids = (u.searchParams.get('ids') ?? '').split(',');
      return Response.json({
        prices: ids.map((id) => ({ productId: id, defaultPurchasePrice: '40.00', preferredSupplier: null, effectivePurchasePrice: id === 'p1' ? '41.00' : '42.00', source: 'default' })),
      });
    }
    if (path === '/products/similar') return Response.json({ similar: [] });
    return Response.json({ error: { code: 'NOT_FOUND', message: `No route ${path}` } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AppProviders queryClient={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
  return queryClient;
}

const costQueries = (qc: QueryClient) => qc.getQueryCache().findAll({ queryKey: ['product-costs'] });

describe('product catalogue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('hides purchase prices by default and reveals only the current page on request', async () => {
    const calls = fakeApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Register').length).toBeGreaterThan(0);
    expect(within(table).getAllByTestId('cost-hidden')).toHaveLength(2);
    expect(calls.some((c) => c.path === '/products/purchase-prices')).toBe(false);

    await u.click(within(table).getByRole('button', { name: 'Show purchase prices for this page' }));
    expect(await within(table).findByText('₹41.00')).toBeInTheDocument();
    const reveal = calls.filter((c) => c.path === '/products/purchase-prices');
    expect(reveal).toHaveLength(1);
    expect(reveal[0]!.query.get('ids')!.split(',').sort()).toEqual(['p1', 'p2']);
    expect(screen.getByText(/Purchase prices are visible on this page/)).toBeInTheDocument();
    expect(costQueries(qc).length).toBeGreaterThan(0);

    // Next page: hidden again, cached prices forgotten.
    await u.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findAllByText('Long Book')).not.toHaveLength(0);
    await waitFor(() => expect(screen.queryByText('₹41.00')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('cost-hidden').length).toBeGreaterThan(0);
    expect(costQueries(qc).filter((q) => q.state.data !== undefined)).toHaveLength(0);
  });

  it('hides and forgets prices when the tab goes to the background', async () => {
    fakeApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products');
    const table = await screen.findByRole('table');
    await u.click(within(table).getByRole('button', { name: 'Show purchase prices for this page' }));
    expect(await within(table).findByText('₹41.00')).toBeInTheDocument();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await waitFor(() => expect(within(table).queryByText('₹41.00')).not.toBeInTheDocument());
    // No purchase price is left in memory (an idle, disabled query entry holds no data).
    expect(costQueries(qc).filter((q) => q.state.data !== undefined)).toHaveLength(0);
  });

  it('managers without permission get no purchase column, no reveal control and no request', async () => {
    const calls = fakeApi(user(false));
    renderAt('/products');
    const table = await screen.findByRole('table');
    expect(within(table).queryByText(/Purchase/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /purchase prices/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('purchase') || c.path.includes('/costs'))).toBe(false);
  });

  it('search as you type: one request after the pause, with cancellation support', async () => {
    const calls = fakeApi(user(false));
    const u = setupUser();
    renderAt('/products');
    await screen.findByRole('table');
    await u.type(screen.getByRole('searchbox', { name: 'Search products' }), 'classmate');
    await waitFor(() => expect(calls.some((c) => c.path === '/products' && c.query.get('q') === 'classmate')).toBe(true));
    const searched = calls.filter((c) => c.path === '/products' && c.query.get('q'));
    expect(searched.map((c) => c.query.get('q'))).toEqual(['classmate']);
    expect(searched[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('product form', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('offers only categories marked for products', async () => {
    fakeApi(user(false));
    renderAt('/products/new');
    const select = await screen.findByLabelText('Category');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Notebooks' })).toBeInTheDocument());
    expect(within(select).queryByRole('option', { name: /Rent/ })).not.toBeInTheDocument();
  });

  it('a selling price above the MRP needs explicit confirmation, sent to the server', async () => {
    let posted: Record<string, unknown> | null = null;
    fakeApi(user(false), (call) => {
      if (call.path === '/products' && call.method === 'POST') {
        posted = call.body as Record<string, unknown>;
        return Response.json({ product: product('p9', 'Register', { mrp: '40.00', sellingPrice: '45.00' }) }, { status: 201 });
      }
      if (call.path === '/products/p9') return Response.json({ product: product('p9', 'Register') });
      if (call.path.startsWith('/products/p9/')) return Response.json({ suppliers: [], history: [] });
      return null;
    });
    const u = setupUser();
    renderAt('/products/new');
    await u.type(await screen.findByLabelText('Product name (without the brand)'), 'Register');
    const select = screen.getByLabelText('Category');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Notebooks' })).toBeInTheDocument());
    await u.selectOptions(select, 'c1');
    await u.type(screen.getByLabelText('Selling price'), '45');
    await u.type(screen.getByLabelText('MRP (optional)'), '40');
    expect(screen.getByText(/above the MRP/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('Sell above the MRP?')).toBeInTheDocument();
    expect(posted).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Confirm and save' }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ name: 'Register', categoryId: 'c1', sellingPrice: '45', mrp: '40', confirmations: ['sp_above_mrp'] });
    expect(posted).not.toHaveProperty('defaultPurchasePrice');
  });

  it('keeps typed values when the server refuses, and shows its field error', async () => {
    fakeApi(user(false), (call) =>
      call.path === '/products' && call.method === 'POST'
        ? Response.json({ error: { code: 'SKU_TAKEN', message: 'An active product already uses this SKU.', details: [{ path: 'sku', message: 'Another active product already uses this SKU' }] } }, { status: 409 })
        : null,
    );
    const u = setupUser();
    renderAt('/products/new');
    await u.type(await screen.findByLabelText('Product name (without the brand)'), 'Register');
    const select = screen.getByLabelText('Category');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Notebooks' })).toBeInTheDocument());
    await u.selectOptions(select, 'c1');
    await u.type(screen.getByLabelText('Selling price'), '50');
    await u.type(screen.getByLabelText('SKU / item code (optional)'), 'CM-1');
    await u.click(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('Another active product already uses this SKU')).toBeInTheDocument();
    expect(screen.getByLabelText('Product name (without the brand)')).toHaveValue('Register');
    expect(screen.getByLabelText('SKU / item code (optional)')).toHaveValue('CM-1');
  });

  it('purchase price: absent for managers without permission; hidden until asked for others', async () => {
    fakeApi(user(false));
    const { unmount } = { unmount: () => undefined };
    renderAt('/products/new');
    await screen.findByLabelText('Product name (without the brand)');
    expect(screen.queryByText(/purchase price/i)).not.toBeInTheDocument();
    unmount();
  });

  it('authorised users see the purchase price field only after pressing the eye', async () => {
    fakeApi(user(true));
    const u = setupUser();
    renderAt('/products/new');
    await screen.findByLabelText('Product name (without the brand)');
    expect(screen.queryByLabelText('Default purchase price (optional)')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Enter purchase price' }));
    expect(screen.getByLabelText('Default purchase price (optional)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Default purchase price (optional)'), { target: { value: '30' } });
    expect(screen.getByLabelText('Default purchase price (optional)')).toHaveValue('30');
  });
});

describe('categories, users and shell', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('the Categories page switches "Use for products" and leaves expense data alone', async () => {
    let patched: unknown = null;
    fakeApi(user(false), (call) => {
      if (call.method === 'PATCH' && call.path === '/categories/c2') {
        patched = call.body;
        return Response.json({ category: { ...category('c2', 'Rent', true) } });
      }
      return null;
    });
    const u = setupUser();
    renderAt('/categories');
    const switches = await screen.findAllByRole('switch', { name: 'Use for products' });
    expect(switches.map((s) => (s as HTMLInputElement).checked)).toEqual([true, false]);
    await u.click(switches[1]!);
    await waitFor(() => expect(patched).toEqual({ isProductUsable: true }));
  });

  it('shortcut hints appear only on desktop-class devices', async () => {
    const media = (desktop: boolean) =>
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({ matches: desktop && query.includes('pointer: fine'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined })),
      );
    media(false);
    fakeApi(user(false));
    renderAt('/products');
    await screen.findByRole('table');
    expect(screen.queryByText('F4')).not.toBeInTheDocument();
    expect(screen.queryByText('F2')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  it('desktop shows F2 / F4 hints and the shortcuts help panel', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })),
    );
    fakeApi(user(false));
    const u = setupUser();
    renderAt('/products');
    await screen.findByRole('table');
    expect(screen.getByText('F2')).toBeInTheDocument();
    expect(screen.getByText('F4')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(await screen.findByText('Product quick lookup')).toBeInTheDocument();
  });
});

// --- Audit remediation: purchase-price retention, separate CHANGE permission, sign-out ----------

const COSTS = {
  productId: 'p1',
  defaultPurchasePrice: '40.00',
  preferredSupplier: null,
  effectivePurchasePrice: '40.00',
  source: 'default',
  version: 3,
  suppliers: [],
  warnings: [],
};

function editApi(me: SessionUser, extra: (call: Call) => Response | null = () => null) {
  return fakeApi(me, (c) => {
    const custom = extra(c);
    if (custom) return custom;
    if (c.path === '/products/p1' && c.method === 'GET') return Response.json({ product: product('p1', 'Register') });
    if (c.path === '/products/p1' && c.method === 'PATCH') return Response.json({ product: product('p1', 'Register', { version: 2 }) });
    if (c.path === '/products/p1/costs' && c.method === 'GET') return Response.json({ costs: COSTS });
    if (c.path === '/products/p1/costs' && c.method === 'PUT') {
      return Response.json({ costs: { ...COSTS, defaultPurchasePrice: (c.body as { defaultPurchasePrice: string }).defaultPurchasePrice, version: 4 } });
    }
    if (c.path === '/auth/logout') return new Response(null, { status: 204 });
    return null;
  });
}

const costCacheHasData = (qc: QueryClient) => costQueries(qc).some((q) => q.state.data !== undefined);

describe('purchase prices on the edit form (remediation)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('hiding an unchanged price clears it from the form and from memory; saving sends no price', async () => {
    const calls = editApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products/p1/edit');
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    expect(await screen.findByDisplayValue('40.00')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/products/p1/costs')!.query.get('scope')).toBe('form');
    await u.click(screen.getByRole('button', { name: 'Hide purchase price' }));
    expect(screen.queryByRole('group', { name: 'Unsaved purchase price' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('40.00')).not.toBeInTheDocument();
    await waitFor(() => expect(costCacheHasData(qc)).toBe(false));
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/products/p1' && c.method === 'PATCH')).toBe(true));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('hiding a CHANGED price asks first; "keep" masks it and it is still saved with the product', async () => {
    const calls = editApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products/p1/edit');
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    const field = await screen.findByDisplayValue('40.00');
    await u.clear(field);
    await u.type(field, '45');
    await u.click(screen.getByRole('button', { name: 'Hide purchase price' }));
    const ask = screen.getByRole('group', { name: 'Unsaved purchase price' });
    await u.click(within(ask).getByRole('button', { name: 'Hide and keep my change' }));
    expect(screen.queryByDisplayValue('45')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-cost')).toHaveTextContent('will be saved');
    await waitFor(() => expect(costCacheHasData(qc)).toBe(false));
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ defaultPurchasePrice: '45', version: 3 });
  });

  it('"Discard my change" drops the change explicitly; nothing is sent', async () => {
    const calls = editApi(user(true));
    const u = setupUser();
    renderAt('/products/p1/edit');
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    const field = await screen.findByDisplayValue('40.00');
    await u.clear(field);
    await u.type(field, '45');
    await u.click(screen.getByRole('button', { name: 'Hide purchase price' }));
    await u.click(within(screen.getByRole('group', { name: 'Unsaved purchase price' })).getByRole('button', { name: 'Discard my change' }));
    expect(screen.queryByTestId('pending-cost')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show purchase price' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/products/p1' && c.method === 'PATCH')).toBe(true));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('the tab going to the background hides the price: unchanged is forgotten, a change is kept masked', async () => {
    editApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products/p1/edit');
    const background = () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    };
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    await screen.findByDisplayValue('40.00');
    background();
    expect(screen.queryByDisplayValue('40.00')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-cost')).not.toBeInTheDocument();
    await waitFor(() => expect(costCacheHasData(qc)).toBe(false));

    await u.click(screen.getByRole('button', { name: 'Show purchase price' }));
    const field = await screen.findByDisplayValue('40.00');
    await u.clear(field);
    await u.type(field, '47');
    background();
    expect(screen.queryByDisplayValue('47')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-cost')).toBeInTheDocument();
    // Shown again: the user's change, not the stored price.
    await u.click(screen.getByRole('button', { name: 'Show my new purchase price' }));
    expect(await screen.findByDisplayValue('47')).toBeInTheDocument();
  });

  it('a manager who may see but not change prices gets a read-only value; saving sends no price', async () => {
    const calls = editApi(user(true, false));
    const u = setupUser();
    renderAt('/products/p1/edit');
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    expect(await screen.findByTestId('form-cost-readonly')).toHaveTextContent('₹40.00');
    expect(screen.queryByLabelText('Default purchase price (optional)')).not.toBeInTheDocument();
    expect(screen.getByText('You can see but not change purchase prices.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/products/p1' && c.method === 'PATCH')).toBe(true));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a new product offers a purchase price only to users who may change prices', async () => {
    editApi(user(true, false));
    renderAt('/products/new');
    expect(await screen.findByRole('button', { name: 'Save product' })).toBeInTheDocument();
    expect(screen.queryByTestId('purchase-price-field')).not.toBeInTheDocument();
  });
});

describe('purchase prices: revocation, sign-out and caches (remediation)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a 403 on a reveal hides the prices, says why, and refreshes the signed-in user', async () => {
    const calls = fakeApi(user(true), (c) =>
      c.path === '/products/purchase-prices'
        ? Response.json({ error: { code: 'PURCHASE_PRICE_FORBIDDEN', message: 'You do not have permission to see purchase prices' } }, { status: 403 })
        : null,
    );
    const u = setupUser();
    const qc = renderAt('/products');
    const table = await screen.findByRole('table');
    const meCalls = () => calls.filter((c) => c.path === '/auth/me').length;
    const before = meCalls();
    await u.click(within(table).getByRole('button', { name: 'Show purchase prices for this page' }));
    expect(await screen.findByText('You can no longer see purchase prices')).toBeInTheDocument();
    expect(within(table).getAllByTestId('cost-hidden').length).toBeGreaterThan(0);
    expect(within(table).queryAllByTestId('cost-visible')).toHaveLength(0);
    await waitFor(() => expect(meCalls()).toBeGreaterThan(before));
    expect(costCacheHasData(qc)).toBe(false);
  });

  it('signing out clears cached mutations (typed prices) and every cached price', async () => {
    editApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products/p1/edit');
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    await screen.findByDisplayValue('40.00');
    // A finished price mutation stays in the mutation cache with its variables until cleared.
    await act(async () => {
      await qc
        .getMutationCache()
        .build(qc, { mutationFn: async (v: { defaultPurchasePrice: string }) => v })
        .execute({ defaultPurchasePrice: '45.00' });
    });
    expect(qc.getMutationCache().getAll().length).toBeGreaterThan(0);
    await u.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);
    await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0));
    expect(costQueries(qc)).toHaveLength(0);
  });
});

describe('purchase-price history and supplier unlink (remediation)', () => {
  function Probe({ shown }: { shown: boolean }) {
    const costs = useProductCostHistory('p1', shown);
    const plain = useProductHistory('p1', true);
    return (
      <p>
        {costs.data ? `costs:${costs.data.length}` : 'costs:none'} {plain.data ? `plain:${plain.data.length}` : 'plain:none'}
      </p>
    );
  }

  it('price history is fetched only on request, under the protected cache root, and is gone when its screen closes', async () => {
    const calls = fakeApi(user(true), (c) => {
      if (c.path === '/products/p1/history') return Response.json({ history: [] });
      if (c.path === '/products/p1/cost-history') return Response.json({ history: [{ id: 'e1', entityType: 'product_cost', action: 'update', before: { purchasePrice: '40.00' }, after: { purchasePrice: '45.00' }, actor: PERSON, createdAt: '' }] });
      return null;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <Probe shown={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/plain:0/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/products/p1/cost-history')).toBe(false);
    view.rerender(
      <QueryClientProvider client={qc}>
        <Probe shown />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/costs:1/)).toBeInTheDocument();
    // Never under the ordinary ['products', …] root (shared, refreshed by live updates).
    const ordinary = qc.getQueryCache().findAll({ queryKey: ['products'] });
    expect(JSON.stringify(ordinary.map((q) => q.state.data))).not.toMatch(/45\.00|purchasePrice/);
    view.unmount();
    await waitFor(() => expect(costQueries(qc).some((q) => q.state.data !== undefined)).toBe(false));
  });

  it('unlinking a supplier sends the version the user saw', async () => {
    const calls = fakeApi(user(true), (c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : null));
    const qc = new QueryClient();
    function Unlink() {
      const unlink = useUnlinkSupplier('p1');
      return (
        <button type="button" onClick={() => unlink.mutate({ supplierId: 's1', version: 7 })}>
          Unlink now
        </button>
      );
    }
    render(
      <QueryClientProvider client={qc}>
        <Unlink />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unlink now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.path).toBe('/products/p1/suppliers/s1');
    expect(del.query.get('version')).toBe('7');
  });
});

// --- Release blocker F2: purchase prices never kept in the mutation cache -------------------------

/** Everything TanStack keeps in memory for this client: query data + mutation variables/results. */
const memory = (qc: QueryClient) =>
  JSON.stringify([
    qc.getQueryCache().getAll().map((q) => q.state.data),
    qc.getMutationCache().getAll().map((m) => ({ variables: m.state.variables, data: m.state.data, error: String(m.state.error) })),
  ]);

describe('purchase prices are not kept in the mutation cache (F2)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function hookClient() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    return { qc, wrapper };
  }
  const savedCosts = (price: string) => ({
    ...COSTS,
    defaultPurchasePrice: price,
    effectivePurchasePrice: '61.23',
    version: 4,
    suppliers: [{ supplierId: 's1', supplierName: 'Ravi', supplierActive: true, purchasePrice: '61.23', isPreferred: true }],
  });

  it('saving a default price: neither the typed price nor the answer (every price of the product) stays in the mutation cache', async () => {
    fakeApi(user(true), (c) => (c.path === '/products/p1/costs' && c.method === 'PUT' ? Response.json({ costs: savedCosts('45.67') }) : null));
    const { qc, wrapper } = hookClient();
    const hook = renderHook(() => useSetDefaultCost('p1'), { wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync({ defaultPurchasePrice: '45.67', version: 3 });
    });
    // TanStack notifies the hook on a timer: wait for the settled state.
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toBeUndefined();
    expect(hook.result.current.variables).toEqual({ token: expect.any(Number) });
    // Prices were not on screen: the answer did not go into a query either.
    expect(memory(qc)).not.toMatch(/45\.67|61\.23/);
    hook.unmount();
    await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0));
  });

  it('a default price saved while the prices are on screen updates that screen only', async () => {
    fakeApi(user(true), (c) => {
      if (c.path === '/products/p1/costs' && c.method === 'PUT') return Response.json({ costs: savedCosts('45.67') });
      if (c.path === '/products/p1/costs') return Response.json({ costs: COSTS });
      return null;
    });
    const { qc, wrapper } = hookClient();
    const hook = renderHook(() => ({ costs: useProductCosts('p1', true), save: useSetDefaultCost('p1') }), { wrapper });
    await waitFor(() => expect(hook.result.current.costs.data?.defaultPurchasePrice).toBe('40.00'));
    await act(async () => {
      await hook.result.current.save.mutateAsync({ defaultPurchasePrice: '45.67', version: 3 });
    });
    await waitFor(() => expect(hook.result.current.costs.data?.defaultPurchasePrice).toBe('45.67'));
    expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => [m.state.variables, m.state.data]))).not.toMatch(/45\.67|61\.23/);
  });

  it('a failed save leaves no confidential value behind', async () => {
    fakeApi(user(true), (c) =>
      c.path === '/products/p1/costs' && c.method === 'PUT'
        ? Response.json({ error: { code: 'VERSION_CONFLICT', message: 'The purchase price was changed by someone else after you opened it.' } }, { status: 409 })
        : null,
    );
    const { qc, wrapper } = hookClient();
    const hook = renderHook(() => useSetDefaultCost('p1'), { wrapper });
    await act(async () => {
      await expect(hook.result.current.mutateAsync({ defaultPurchasePrice: '45.67', version: 1 })).rejects.toThrow(/changed by someone else/);
    });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(memory(qc)).not.toMatch(/45\.67/);
  });

  it('supplier-price changes (link, update): no price in the mutation cache; the row spinner still knows the supplier', async () => {
    const link = { supplierId: 's1', supplierName: 'Ravi', supplierPhone: null, supplierActive: true, supplierProductCode: null, notes: null, isPreferred: false, version: 3, updatedAt: '' };
    fakeApi(user(true), (c) => {
      if (c.path === '/products/p1/suppliers' && c.method === 'POST') return Response.json({ link }, { status: 201 });
      if (c.path === '/products/p1/suppliers/s1' && c.method === 'PATCH') return Response.json({ link });
      return null;
    });
    const { qc, wrapper } = hookClient();
    const hook = renderHook(() => ({ add: useLinkSupplier('p1'), update: useUpdateSupplierLink('p1') }), { wrapper });
    await act(async () => {
      await hook.result.current.add.mutateAsync({ supplierId: 's1', supplierProductCode: null, notes: null, isPreferred: false, purchasePrice: '48.50' });
      await hook.result.current.update.mutateAsync({ supplierId: 's1', version: 2, purchasePrice: '47.50' });
    });
    await waitFor(() => expect(hook.result.current.update.isSuccess).toBe(true));
    expect(hook.result.current.update.variables).toEqual({ supplierId: 's1', token: expect.any(Number) });
    expect(memory(qc)).not.toMatch(/48\.50|47\.50/);
    hook.unmount();
    await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0));
  });

  it('creating a product with a purchase price: the caller gets the product, the cache never holds the price', async () => {
    fakeApi(user(true), (c) => (c.path === '/products' && c.method === 'POST' ? Response.json({ product: product('p9', 'New Register') }, { status: 201 }) : null));
    const { qc, wrapper } = hookClient();
    const hook = renderHook(() => useCreateProduct(), { wrapper });
    let created: Product | undefined;
    await act(async () => {
      created = await hook.result.current.mutateAsync({
        input: { ...({} as ProductInput), name: 'New Register', defaultPurchasePrice: '49.50' },
        idempotencyKey: 'key-1',
      });
    });
    expect(created?.id).toBe('p9');
    expect(memory(qc)).not.toMatch(/49\.50/);
  });

  it('edit form: a changed price kept while hidden is saved, and afterwards nothing of it is left in memory', async () => {
    const calls = editApi(user(true));
    const u = setupUser();
    const qc = renderAt('/products/p1/edit');
    await u.click(await screen.findByRole('button', { name: 'Show purchase price' }));
    const field = await screen.findByDisplayValue('40.00');
    await u.clear(field);
    await u.type(field, '45.67');
    await u.click(screen.getByRole('button', { name: 'Hide purchase price' }));
    await u.click(within(screen.getByRole('group', { name: 'Unsaved purchase price' })).getByRole('button', { name: 'Hide and keep my change' }));
    await waitFor(() => expect(memory(qc)).not.toMatch(/40\.00/));
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ defaultPurchasePrice: '45.67', version: 3 });
    await waitFor(() => expect(memory(qc)).not.toMatch(/45\.67|40\.00/));
  });
});
