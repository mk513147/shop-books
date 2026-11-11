import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { setupUser } from '@/test/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { Salesman } from '@/types/api';
import { SalesmanFormDialog } from './SalesmanFormDialog';

const SAVED: Salesman = {
  id: 'sm1',
  name: 'Ravi Kumar',
  phone: '9876543210',
  notes: null,
  isActive: true,
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  createdBy: { id: 'u1', name: 'Asha' },
  updatedBy: { id: 'u1', name: 'Asha' },
};

function renderDialog(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', fetchMock);
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <SalesmanFormDialog open onClose={onClose} onSaved={onSaved} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { onSaved, onClose, posts, user: setupUser() };
}

describe('SalesmanFormDialog', () => {
  it('shows a loading state, ignores repeated clicks while saving, and saves once', async () => {
    let respond!: (r: Response) => void;
    const { user, posts, onSaved } = renderDialog(() => new Promise<Response>((resolve) => (respond = resolve)));
    await user.type(screen.getByLabelText('Name'), 'Ravi Kumar');
    await user.type(screen.getByLabelText('Phone (optional)'), '9876543210');

    const save = screen.getByRole('button', { name: 'Add salesman' });
    await user.click(save);
    const busy = await screen.findByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await user.click(busy);
    await user.click(busy);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ name: 'Ravi Kumar', phone: '9876543210', notes: null });

    respond(Response.json({ salesman: SAVED }, { status: 201 }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED));
    expect(await screen.findByText('Salesman added')).toBeInTheDocument();
  });

  it('keeps the typed values after a failed save, restores the button and allows a retry', async () => {
    let attempt = 0;
    const { user, posts, onSaved } = renderDialog(async () => {
      attempt += 1;
      if (attempt === 1) return Response.json({ error: { code: 'INTERNAL', message: 'The server had a problem.' } }, { status: 500 });
      return Response.json({ salesman: SAVED }, { status: 201 });
    });
    await user.type(screen.getByLabelText('Name'), 'Ravi Kumar');
    await user.type(screen.getByLabelText('Notes (optional)'), 'Visits Mondays');
    await user.click(screen.getByRole('button', { name: 'Add salesman' }));

    expect(await screen.findAllByText('The server had a problem.')).not.toHaveLength(0);
    expect(screen.getByText('Could not save the salesman')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Ravi Kumar');
    expect(screen.getByLabelText('Notes (optional)')).toHaveValue('Visits Mondays');
    const retry = screen.getByRole('button', { name: 'Add salesman' });
    expect(retry).toBeEnabled();
    expect(onSaved).not.toHaveBeenCalled();

    await user.click(retry);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
  });

  it('validates required name and phone format before sending anything', async () => {
    const { user, posts } = renderDialog(async () => Response.json({}, { status: 404 }));
    await user.type(screen.getByLabelText('Phone (optional)'), 'call me');
    await user.click(screen.getByRole('button', { name: 'Add salesman' }));
    expect(await screen.findByText('Enter the salesman’s name')).toBeInTheDocument();
    expect(screen.getByText('Use digits, spaces, +, - or ( )')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
