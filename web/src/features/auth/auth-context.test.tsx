/**
 * Release blocker F3: the signed-in account can change underneath a tab (another tab of the same
 * browser signs in as someone else, or out; the session cookie is shared). Every tab must notice it
 * on its next session refresh, forget the previous account's cached data and mutations, and keep
 * everything when the same account merely refreshes its session.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/api';
import { AuthProvider, SESSION_QUERY_KEY, useAuth } from './auth-context';

const person = (id: string, name: string, canViewPurchasePrices = true): SessionUser => ({
  id,
  email: `${id}@example.com`,
  name,
  role: 'manager',
  mustChangePassword: false,
  canViewPurchasePrices,
  canEditPurchasePrices: canViewPurchasePrices,
});

/** The "server": one shared session cookie for every tab. */
let current: SessionUser | null;
let meCalls = 0;

function stubServer() {
  meCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      if (path === '/auth/me') {
        meCalls += 1;
        return current ? Response.json({ user: current, csrfToken: `csrf-${current.id}-${meCalls}` }) : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, { status: 401 });
      }
      if (path === '/auth/login') {
        const { email } = JSON.parse(String(init.body)) as { email: string };
        current = person(email.split('@')[0]!, email.startsWith('b') ? 'Bina' : 'Asha');
        return Response.json({ user: current, csrfToken: 'csrf-login' });
      }
      if (path === '/auth/logout') {
        current = null;
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: path } }, { status: 404 });
    }),
  );
}

let auth: Record<string, ReturnType<typeof useAuth>> = {};
function Probe({ tab }: { tab: string }) {
  const value = useAuth();
  auth[tab] = value;
  return <p data-testid={`who-${tab}`}>{value.status === 'authenticated' ? value.user!.name : value.status}</p>;
}

function openTab(tab: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Probe tab={tab} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return qc;
}

/** What the previous account left in this tab: catalogue data, revealed prices, a typed price. */
async function seed(qc: QueryClient) {
  qc.setQueryData(['products', 'list', 'page-1'], { items: ['Register'] });
  qc.setQueryData(['product-costs', 'page', 'p1'], [{ productId: 'p1', effectivePurchasePrice: '41.00' }]);
  await act(async () => {
    await qc
      .getMutationCache()
      .build(qc, { mutationFn: async (v: { defaultPurchasePrice: string }) => v })
      .execute({ defaultPurchasePrice: '45.00' });
  });
}
const leftovers = (qc: QueryClient) => ({
  queries: qc
    .getQueryCache()
    .getAll()
    .filter((q) => q.queryKey[0] !== SESSION_QUERY_KEY[0]).length,
  mutations: qc.getMutationCache().getAll().length,
});
const refresh = (qc: QueryClient) =>
  act(async () => {
    await qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  });

describe('account changes underneath a tab (F3)', () => {
  beforeEach(() => {
    auth = {};
    current = person('a', 'Asha');
    stubServer();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a session refresh that returns ANOTHER account forgets the previous account’s data and mutations before showing it', async () => {
    const qc = openTab('A');
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    await seed(qc);
    expect(leftovers(qc)).toEqual({ queries: 2, mutations: 1 });

    current = person('b', 'Bina');
    await refresh(qc);
    expect(await screen.findByText('Bina')).toBeInTheDocument();
    expect(leftovers(qc)).toEqual({ queries: 0, mutations: 0 });
  });

  it('the same account refreshing its session keeps every cached query and mutation', async () => {
    const qc = openTab('A');
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    await seed(qc);
    await refresh(qc);
    await refresh(qc);
    expect(meCalls).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId('who-A')).toHaveTextContent('Asha');
    expect(leftovers(qc)).toEqual({ queries: 2, mutations: 1 });
  });

  it('the session ended elsewhere: the refresh returns to sign-in and forgets everything', async () => {
    const qc = openTab('A');
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    await seed(qc);
    current = null;
    await refresh(qc);
    expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
    expect(leftovers(qc)).toEqual({ queries: 0, mutations: 0 });
  });

  it('purchase-price permission revoked (same account): prices are dropped, other data stays', async () => {
    const qc = openTab('A');
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    await seed(qc);
    current = person('a', 'Asha', false);
    await refresh(qc);
    await waitFor(() => expect(qc.getQueryCache().findAll({ queryKey: ['product-costs'] })).toHaveLength(0));
    expect(qc.getQueryData(['products', 'list', 'page-1'])).toEqual({ items: ['Register'] });
    expect(screen.getByTestId('who-A')).toHaveTextContent('Asha');
  });

  it('two tabs: signing in as someone else in tab B makes tab A re-read the session at once and forget A’s data', async () => {
    const qcA = openTab('A');
    const qcB = openTab('B');
    await waitFor(() => expect(screen.getByTestId('who-A')).toHaveTextContent('Asha'));
    await waitFor(() => expect(screen.getByTestId('who-B')).toHaveTextContent('Asha'));
    await seed(qcA);

    await act(async () => {
      await auth.B!.login('b@example.com', 'secret-password');
    });
    // No focus event, no request in tab A: the announcement alone makes it re-read the session.
    await waitFor(() => expect(screen.getByTestId('who-A')).toHaveTextContent('Bina'));
    expect(screen.getByTestId('who-B')).toHaveTextContent('Bina');
    expect(leftovers(qcA)).toEqual({ queries: 0, mutations: 0 });
    expect(qcB.getQueryData<{ user: SessionUser }>(SESSION_QUERY_KEY)?.user.id).toBe('b');
  });

  it('two tabs: signing out in tab B signs tab A out too, without a refresh loop', async () => {
    const qcA = openTab('A');
    openTab('B');
    await waitFor(() => expect(screen.getByTestId('who-A')).toHaveTextContent('Asha'));
    await waitFor(() => expect(screen.getByTestId('who-B')).toHaveTextContent('Asha'));
    await seed(qcA);

    await act(async () => {
      await auth.B!.logout();
    });
    await waitFor(() => expect(screen.getByTestId('who-A')).toHaveTextContent('unauthenticated'));
    expect(leftovers(qcA)).toEqual({ queries: 0, mutations: 0 });
    // A 401 never re-announces: the number of session reads settles.
    const settled = meCalls;
    await new Promise((r) => setTimeout(r, 200));
    expect(meCalls).toBe(settled);
  });
});
