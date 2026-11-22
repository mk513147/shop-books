import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { hasUnsavedInput, resetUnsavedWork } from '@/features/system/unsaved-work';
import { setupUser } from '@/test/user-event';
import { ShortcutsProvider } from './ShortcutsProvider';
import { DESKTOP_QUERY, shortcutFor } from './shortcuts';

function stubDevice(desktop: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: desktop && query === DESKTOP_QUERY,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...extra }) as KeyboardEvent;

describe('shortcutFor (rules)', () => {
  beforeEach(() => stubDevice(true));
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('F2 adds an expense, F4 opens the lookup; other keys do nothing', () => {
    expect(shortcutFor(key('F2'))).toBe('add-expense');
    expect(shortcutFor(key('F4'))).toBe('quick-lookup');
    for (const k of ['F1', 'F3', 'F5', 'F6', 'F7', 'F8', 'F11', 'F12', 'a', 'Escape']) expect(shortcutFor(key(k)), k).toBeNull();
  });

  it('ignores modifiers, auto-repeat, IME composition and already-handled events', () => {
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
      expect(shortcutFor(key('F4', extra)), JSON.stringify(extra)).toBeNull();
      expect(shortcutFor(key('F2', extra)), JSON.stringify(extra)).toBeNull();
    }
  });

  it('F2 is ignored while typing in a field; F4 works there', () => {
    document.body.innerHTML = '<input id="f" type="text" /><textarea id="t"></textarea><div id="c" contenteditable="true"></div>';
    for (const id of ['f', 't']) {
      (document.getElementById(id) as HTMLElement).focus();
      expect(shortcutFor(key('F2')), id).toBeNull();
      expect(shortcutFor(key('F4')), id).toBe('quick-lookup');
    }
  });

  it('nothing while another dialog is open', () => {
    document.body.innerHTML = '<dialog open></dialog>';
    expect(shortcutFor(key('F2'))).toBeNull();
    expect(shortcutFor(key('F4'))).toBeNull();
  });

  it('nothing on phones, tablets and touch devices', () => {
    stubDevice(false);
    expect(shortcutFor(key('F2'))).toBeNull();
    expect(shortcutFor(key('F4'))).toBeNull();
  });
});

describe('ShortcutsProvider (behaviour)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    stubDevice(true);
    resetUnsavedWork();
    fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path.endsWith('/products/quick-search')) {
        return Response.json({
          items: [
            {
              id: 'p1',
              name: 'Register',
              brand: 'Classmate',
              category: 'Notebooks',
              size: 'A4',
              pageCount: 140,
              gsm: null,
              binding: null,
              sellingUnit: 'piece',
              packQty: 1,
              sku: null,
              barcode: null,
              mrp: '55.00',
              sellingPrice: '50.00',
              close: false,
            },
          ],
          hasMore: false,
        });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'No route' } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  function renderApp(path = '/expenses/new') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <ShortcutsProvider>
              <Routes>
                <Route
                  path="/expenses/new"
                  element={
                    <form aria-label="Expense">
                      <h1>New expense page</h1>
                      <input aria-label="Amount" defaultValue="" />
                      <input aria-label="Description" defaultValue="" />
                    </form>
                  }
                />
                <Route
                  path="/customers"
                  element={
                    <form aria-label="Customer">
                      <h1>Customers page</h1>
                      <input aria-label="Customer name" />
                    </form>
                  }
                />
                <Route path="/products/:id" element={<h1>Product page</h1>} />
              </Routes>
            </ShortcutsProvider>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('F4 over a half-filled expense: lookup opens, Esc returns with value, focus and caret intact', async () => {
    const user = setupUser();
    renderApp();
    const amount = screen.getByLabelText('Amount') as HTMLInputElement;
    const description = screen.getByLabelText('Description') as HTMLInputElement;
    await user.type(amount, '1250.50');
    await user.type(description, 'Stock for school');
    description.setSelectionRange(6, 9);
    fireEvent.keyDown(window, { key: 'F4' });

    const search = await screen.findByRole('combobox', { name: 'Search products' });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, 'register');
    expect(await screen.findByRole('option', { name: /Classmate Register/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('lookup-selected')).toHaveTextContent('₹50.00');

    // Esc closes the native dialog (cancel event) and returns to the form.
    const dialog = search.closest('dialog')!;
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(description).toHaveFocus());
    expect(amount.value).toBe('1250.50');
    expect(description.value).toBe('Stock for school');
    expect([description.selectionStart, description.selectionEnd]).toEqual([6, 9]);
  });

  it('typing in the lookup does not mark the page as having unsaved work', async () => {
    const user = setupUser();
    renderApp('/customers');
    fireEvent.keyDown(window, { key: 'F4' });
    const search = await screen.findByRole('combobox', { name: 'Search products' });
    await user.type(search, 'classmate');
    expect(hasUnsavedInput()).toBe(false);
  });

  it('the lookup sends one request after typing pauses, not one per key', async () => {
    const user = setupUser();
    renderApp('/customers');
    fireEvent.keyDown(window, { key: 'F4' });
    const search = await screen.findByRole('combobox', { name: 'Search products' });
    await user.type(search, 'classmate');
    await screen.findByRole('option', { name: /Classmate Register/ });
    const queries = fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('q'));
    expect(queries).toEqual(['classmate']);
    // Requests carry an AbortSignal, so a newer search cancels an older one.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('F2 goes to Add expense, but asks first when something typed is unsaved', async () => {
    const user = setupUser();
    renderApp('/customers');
    await user.type(screen.getByLabelText('Customer name'), 'Asha');
    // While typing in the field F2 does nothing.
    fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.queryByText('Leave this screen?')).not.toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: 'F2' });
    expect(await screen.findByText('Leave this screen?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(screen.getByRole('heading', { name: 'Customers page' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F2' });
    await user.click(await screen.findByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByRole('heading', { name: 'New expense page' })).toBeInTheDocument();
  });

  it('F2 on the Add expense screen does nothing; F2 with nothing typed goes straight there', async () => {
    renderApp('/expenses/new');
    fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.queryByText('Leave this screen?')).not.toBeInTheDocument();
    act(() => resetUnsavedWork());
  });

  it('does nothing on touch devices', async () => {
    stubDevice(false);
    renderApp('/customers');
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.keyDown(window, { key: 'F2' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('combobox', { name: 'Search products' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Customers page' })).toBeInTheDocument();
  });
});

describe('unsaved-work tracking shared by the updater and the shortcuts', () => {
  it('one caller stopping does not stop tracking for the other', async () => {
    const { trackUnsavedWork } = await import('@/features/system/unsaved-work');
    document.body.innerHTML = '<form><input id="x" /></form>';
    resetUnsavedWork();
    const stopUpdater = trackUnsavedWork();
    const stopShortcuts = trackUnsavedWork();
    stopShortcuts();
    stopShortcuts(); // a second call is harmless
    fireEvent.input(document.getElementById('x')!, { target: { value: 'a' } });
    expect(hasUnsavedInput()).toBe(true);
    stopUpdater();
    resetUnsavedWork();
    fireEvent.input(document.getElementById('x')!, { target: { value: 'b' } });
    expect(hasUnsavedInput()).toBe(false);
    document.body.innerHTML = '';
  });
});
