import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { setupUser } from '@/test/user-event';
import { AppUpdater } from './app-update';
import { AppUpdateNotice, UPDATE_MESSAGES, type UpdaterHooks } from './AppUpdateNotice';

function harness(published: { build: string }) {
  const reload = vi.fn();
  const make = (hooks: UpdaterHooks) =>
    new AppUpdater({
      currentBuild: 'build-A',
      compatLevel: 1,
      fetchBuild: async () => published.build,
      fetchServer: async () => ({ version: '1', clientCompat: 1 }),
      prepare: async () => true,
      reload,
      hardReload: async () => undefined,
      storage: null,
      wait: async () => undefined,
      ...hooks,
    });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/expenses/new']}>
        <Routes>
          <Route
            path="/expenses/new"
            element={
              <form>
                <label htmlFor="amount">Amount</label>
                <input id="amount" />
                <Link to="/expenses">Done</Link>
              </form>
            }
          />
          <Route path="/expenses" element={<p>Expenses list</p>} />
        </Routes>
        <AppUpdateNotice enabled createUpdater={make} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { reload };
}

describe('AppUpdateNotice', () => {
  it('shows "Refreshing to the latest version…" and reloads when a new build is found and nothing is unsaved', async () => {
    const { reload } = harness({ build: 'build-B' });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('app-update-notice')).toHaveTextContent(UPDATE_MESSAGES.refreshing);
    expect(UPDATE_MESSAGES.refreshing).toBe('Shop-Books has been updated. Refreshing to the latest version…');
  });

  it('does nothing visible when the app is current', async () => {
    const { reload } = harness({ build: 'build-A' });
    await act(async () => undefined);
    expect(screen.queryByTestId('app-update-notice')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('defers while a form has unsaved input, prompts, and refreshes after the user leaves the form', async () => {
    const published = { build: 'build-A' };
    const { reload } = harness(published);
    const user = setupUser();
    await user.type(screen.getByLabelText('Amount'), '250');
    await user.tab(); // the field no longer has focus, but the typed value is unsaved

    published.build = 'build-B';
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.dispatchEvent(new Event('online')); // e.g. coming back online / to the foreground
    });
    // First check happened at start-up; force through the throttle the way a new page would.
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(await screen.findByTestId('app-update-notice')).toHaveTextContent(UPDATE_MESSAGES.waiting);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Done' }));
    expect(await screen.findByText('Expenses list')).toBeInTheDocument();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('"Refresh" with unsaved input asks before discarding it', async () => {
    const published = { build: 'build-A' };
    const { reload } = harness(published);
    const user = setupUser();
    await user.type(screen.getByLabelText('Amount'), '9');
    published.build = 'build-B';
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await screen.findByText(UPDATE_MESSAGES.waiting);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(confirm).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
