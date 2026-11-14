import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupUser } from '@/test/user-event';
import { AppUpdater } from './app-update';
import { AppUpdateNotice, UPDATE_TEXT, type UpdaterHooks } from './AppUpdateNotice';

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function harness(published: { build: string }, opts: { prepareOk?: boolean } = {}) {
  const reload = vi.fn();
  const hardReload = vi.fn(async () => undefined);
  const make = (hooks: UpdaterHooks) =>
    new AppUpdater({
      currentBuild: 'build-A',
      compatLevel: 1,
      fetchBuild: async () => published.build,
      fetchServer: async () => ({ version: '1', clientCompat: 1 }),
      prepare: async () => opts.prepareOk ?? true,
      reload,
      hardReload,
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
  return { reload, hardReload, user: setupUser() };
}

/** The app comes back to the foreground after a new release was deployed. */
async function returnToForeground() {
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
}

describe('AppUpdateNotice', () => {
  it('nothing is shown while the app is current', async () => {
    const { reload } = harness({ build: 'build-A' });
    await act(async () => undefined);
    expect(screen.queryByTestId('app-update-notice')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a new release found while the app is open shows "new update available"; Update now shows "Updating Shop-Books..." and reloads once', async () => {
    const published = { build: 'build-A' };
    const { reload, user } = harness(published);
    await act(async () => undefined);
    published.build = 'build-B';
    await returnToForeground();

    const notice = await screen.findByTestId('app-update-notice');
    expect(notice).toHaveTextContent(UPDATE_TEXT.available);
    expect(UPDATE_TEXT.available).toBe('Shop-Books has a new update available.');
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('app-update-notice')).toHaveTextContent('Updating Shop-Books...');
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });

  it('"Later" hides the notice for that version; a newer release shows it again', async () => {
    const published = { build: 'build-A' };
    const { reload, user } = harness(published);
    await act(async () => undefined);
    published.build = 'build-B';
    await returnToForeground();
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByTestId('app-update-notice')).not.toBeInTheDocument();
    await returnToForeground();
    expect(screen.queryByTestId('app-update-notice')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    published.build = 'build-C';
    await returnToForeground();
    expect(await screen.findByTestId('app-update-notice')).toHaveTextContent(UPDATE_TEXT.available);
  });

  it('with unsaved input it never reloads, says so, and updates by itself after the user leaves the form', async () => {
    const published = { build: 'build-A' };
    const { reload, user } = harness(published);
    await act(async () => undefined);
    await user.type(screen.getByLabelText('Amount'), '250');
    await user.tab();

    published.build = 'build-B';
    await returnToForeground();
    const notice = await screen.findByTestId('app-update-notice');
    expect(notice).toHaveTextContent(UPDATE_TEXT.availableBusy);
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('link', { name: 'Done' }));
    expect(await screen.findByText('Expenses list')).toBeInTheDocument();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('"Update now" with unsaved input asks before discarding it', async () => {
    const published = { build: 'build-A' };
    const { reload, user } = harness(published);
    await act(async () => undefined);
    await user.type(screen.getByLabelText('Amount'), '9');
    published.build = 'build-B';
    await returnToForeground();
    await screen.findByText(UPDATE_TEXT.available);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Update now' }));
    expect(confirm).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('a failed service-worker update is reported; Update now then resets the service worker', async () => {
    const published = { build: 'build-A' };
    const { reload, hardReload, user } = harness(published, { prepareOk: false });
    await act(async () => undefined);
    published.build = 'build-B';
    await returnToForeground();
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(await screen.findByText(UPDATE_TEXT.failed)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Update now' }));
    expect(hardReload).toHaveBeenCalledTimes(1);
  });

  it('when the app is opened with a new release published and nothing unsaved, it updates at once', async () => {
    const { reload } = harness({ build: 'build-B' });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('app-update-notice')).toHaveTextContent(UPDATE_TEXT.updating);
  });
});
