import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatus } from '@/features/auth/auth-context';
import { AppRoutes } from './AppRoutes';
import { AppProviders } from './providers';

function renderAt(path: string, authStatus: AuthStatus) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProviders queryClient={queryClient} authStatus={authStatus}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('application', () => {
  it('shows the login page, not the dashboard, to unauthenticated visitors', () => {
    renderAt('/', 'unauthenticated');
    expect(screen.getByRole('heading', { name: 'Shop-Books' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('redirects every protected route to login when unauthenticated', () => {
    renderAt('/expenses', 'unauthenticated');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('login form validates input and performs no authentication or network call', async () => {
    const fetchSpy = stubFetch(() => Promise.reject(new Error('must not be called')));
    renderAt('/login', 'unauthenticated');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'whatever');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/not available yet/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders the shell and a dashboard with no fabricated financial figures', async () => {
    stubFetch(async () =>
      Response.json({ status: 'ok', database: 'up', version: null, timestamp: '2026-01-01T00:00:00Z' }),
    );
    renderAt('/', 'preview');
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
    expect(await screen.findByText('online')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/₹|\bINR\b/);
  });

  it('shows an error state with retry when the API is unreachable', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    renderAt('/', 'preview');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument());
  });

  it('shows a not-found page for unknown routes', () => {
    renderAt('/nowhere', 'unauthenticated');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
