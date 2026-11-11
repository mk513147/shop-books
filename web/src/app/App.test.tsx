import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { setupUser } from '@/test/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/api';
import { AppRoutes } from './AppRoutes';
import { AppProviders } from './providers';

const OWNER: SessionUser = { id: 'u1', email: 'o@example.com', name: 'Olivia', role: 'owner', mustChangePassword: false };
const MANAGER: SessionUser = { id: 'u2', email: 'm@example.com', name: 'Manu', role: 'manager', mustChangePassword: false };

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Fake API: `session` drives GET /auth/me; `extra` handles anything else. */
function fakeApi(session: SessionUser | null, extra: Route = () => Response.json({}, { status: 404 })) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/auth/me')) {
      return session
        ? Response.json({ user: session, csrfToken: 'csrf' })
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } }, { status: 401 });
    }
    if (url.endsWith('/health')) {
      return Response.json({ status: 'ok', database: 'up', version: null, timestamp: '2026-01-01T00:00:00Z' });
    }
    return extra(url, init);
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

describe('application', () => {
  it('shows the login page, not the dashboard, to signed-out visitors (including deep links)', async () => {
    fakeApi(null);
    renderAt('/expenses');
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('signs in through the API and shows the shell with no fabricated financial figures', async () => {
    let signedIn = false;
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/auth/login')) {
        signedIn = true;
        return Response.json({ user: MANAGER, csrfToken: 'csrf' });
      }
      if (url.endsWith('/auth/me')) {
        return signedIn
          ? Response.json({ user: MANAGER, csrfToken: 'csrf' })
          : Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
      }
      void init;
      return Response.json({ status: 'ok', database: 'up', version: null, timestamp: '2026-01-01T00:00:00Z' });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/');
    const user = setupUser();
    await user.type(await screen.findByLabelText('Email'), 'm@example.com');
    await user.type(screen.getByLabelText('Password'), 'manager-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    const loginCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/login'))!;
    expect(JSON.parse(String(loginCall[1]!.body))).toEqual({ email: 'm@example.com', password: 'manager-password' });
    expect(document.body.textContent).not.toMatch(/₹|\bINR\b/);
    // Managers do not see owner-only navigation.
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('shows the generic error message when sign-in fails', async () => {
    fakeApi(null, () =>
      Response.json(
        { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password, or the account is temporarily locked.' } },
        { status: 401 },
      ),
    );
    renderAt('/login');
    const user = setupUser();
    await user.type(await screen.findByLabelText('Email'), 'x@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid email or password/);
  });

  it('forces a temporary password to be changed before anything else', async () => {
    fakeApi({ ...MANAGER, mustChangePassword: true });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Temporary password')).toBeInTheDocument();
  });

  it('lets the owner open Users but not a manager', async () => {
    fakeApi(OWNER, (url) => (url.endsWith('/users') ? Response.json({ users: [] }) : Response.json({})));
    const { unmount } = renderAt('/users');
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add manager' })).toBeInTheDocument();
    unmount();

    fakeApi(MANAGER);
    renderAt('/users');
    expect(await screen.findByText('Only the owner can open this page.')).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', () => {
    fakeApi(null);
    renderAt('/nowhere');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
