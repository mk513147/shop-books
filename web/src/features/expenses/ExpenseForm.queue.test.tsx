import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { setupUser, type TestUser } from '@/test/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentQueueProvider } from '@/features/documents/queue/AttachmentQueueProvider';
import type { AttachmentQueueApi } from '@/features/documents/queue/engine';
import { MemoryAttachmentStore } from '@/features/documents/queue/store';
import type { Category, Expense } from '@/types/api';
import { ExpenseForm } from './ExpenseForm';

// Targeted timeout (this file only): full expense-form scenarios plus the offline attachment queue
// (up to 3.2 s per test measured while the full suite runs in parallel). See ExpenseForm.test.tsx.
vi.setConfig({ testTimeout: 15_000 });

// These tests cover the bill-attachment path, which is postponed (off by default): switch it on here.
beforeEach(() => vi.stubEnv('VITE_BILL_ATTACHMENTS', 'enabled'));
afterEach(() => vi.unstubAllEnvs());

const CATEGORIES = [{ id: 'c1', name: 'Packaging', description: null, isActive: true, expenseCount: 0, createdAt: '', updatedAt: '' }] as Category[];

describe('ExpenseForm with the offline attachment queue', () => {
  it('saving keeps the chosen bill files on this device for the new expense (PC offline), without waiting for an upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/brands') ? Response.json({ brands: [] }) : Response.json({}, { status: 404 }),
      ),
    );
    if (!globalThis.crypto?.subtle) {
      vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: { digest: async () => new Uint8Array(32).buffer } });
    }
    const store = new MemoryAttachmentStore({ durable: true });
    const api: AttachmentQueueApi = { storageStatus: async () => ({ available: false }), upload: vi.fn(), getDocument: vi.fn() };
    const onDone = vi.fn();
    const onSubmit = vi.fn(async () => ({ id: 'new-expense', documentCount: 0 }) as Expense);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <AttachmentQueueProvider userId="u1" store={store} api={api}>
            <ExpenseForm categories={CATEGORIES} submitLabel="Save expense" cancelTo="/expenses" onSubmit={onSubmit} onDone={onDone} />
          </AttachmentQueueProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = setupUser();
    await user.type(screen.getByLabelText('Total expense amount'), '90');
    await user.click(await screen.findByRole('button', { name: 'Packaging' }));
    await user.upload(document.querySelector('input[type="file"][multiple]') as HTMLInputElement, new File(['%PDF-1.4 x %%EOF'], 'bill.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(/kept on this device and sent to the shop PC automatically/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-expense' }), expect.stringMatching(/1 bill file saved on this device/)));
    const queued = await store.list('u1');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ expenseId: 'new-expense', fileName: 'bill.pdf', userId: 'u1' });
    expect(api.upload).not.toHaveBeenCalled();
  });
});

describe('ExpenseForm: files picked before saving survive a refresh (drafts)', () => {
  function mount(stores: { store: MemoryAttachmentStore; drafts: MemoryAttachmentStore }) {
    const onSubmit = vi.fn(async () => ({ id: 'exp-77', documentCount: 0 }) as Expense);
    const api: AttachmentQueueApi = { storageStatus: async () => ({ available: false }), upload: vi.fn(), getDocument: vi.fn() };
    const onDone = vi.fn();
    const view = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <AttachmentQueueProvider userId="u1" store={stores.store} drafts={stores.drafts} api={api}>
            <ExpenseForm categories={CATEGORIES} submitLabel="Save expense" cancelTo="/expenses" onSubmit={onSubmit} onDone={onDone} />
          </AttachmentQueueProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { ...view, onDone, user: setupUser() };
  }
  const setupFetch = () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/brands') ? Response.json({ brands: [] }) : Response.json({}, { status: 404 }))),
    );
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: { digest: async () => new Uint8Array(32).buffer } });
  };
  const chooseFile = async (user: TestUser) => {
    await screen.findByRole('button', { name: /Choose files/ });
    const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    await user.upload(input, new File(['%PDF-1.4 d %%EOF'], 'draft.pdf', { type: 'application/pdf' }));
    await screen.findByText('draft.pdf');
  };
  const newStores = () => ({ store: new MemoryAttachmentStore({ durable: true }), drafts: new MemoryAttachmentStore({ durable: true }) });

  it('a refresh before saving keeps the file; it can be added again and is queued when the expense is saved', async () => {
    setupFetch();
    const stores = newStores();
    const first = mount(stores);
    await chooseFile(first.user);
    await waitFor(async () => expect(await stores.drafts.list('u1')).toHaveLength(1));
    first.unmount(); // the page was refreshed or closed before saving

    const second = mount(stores);
    expect(await screen.findByTestId('draft-recovery')).toHaveTextContent(/draft\.pdf/);
    await second.user.click(screen.getByRole('button', { name: 'Add them to this expense' }));
    expect(await screen.findByText('draft.pdf')).toBeInTheDocument();
    await second.user.type(screen.getByLabelText('Total expense amount'), '40');
    await second.user.click(await screen.findByRole('button', { name: 'Packaging' }));
    await second.user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(second.onDone).toHaveBeenCalled());
    expect((await stores.store.list('u1')).map((i) => [i.expenseId, i.fileName])).toEqual([['exp-77', 'draft.pdf']]);
    await waitFor(async () => expect(await stores.drafts.list('u1')).toEqual([])); // no copy left behind
  });

  it('drafts are discarded only after confirmation; removing a file from the form removes its draft', async () => {
    setupFetch();
    const stores = newStores();
    const first = mount(stores);
    await chooseFile(first.user);
    await waitFor(async () => expect(await stores.drafts.list('u1')).toHaveLength(1));
    first.unmount();

    const second = mount(stores);
    await second.user.click(await screen.findByRole('button', { name: 'Discard…' }));
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    await second.user.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(await stores.drafts.list('u1')).toHaveLength(1);
    await second.user.click(screen.getByRole('button', { name: 'Discard…' }));
    await second.user.click(screen.getByRole('button', { name: 'Delete from device' }));
    await waitFor(() => expect(screen.queryByTestId('draft-recovery')).not.toBeInTheDocument());
    expect(await stores.drafts.list('u1')).toEqual([]);

    await chooseFile(second.user);
    await waitFor(async () => expect(await stores.drafts.list('u1')).toHaveLength(1));
    await second.user.click(screen.getByRole('button', { name: 'Remove draft.pdf' }));
    await waitFor(async () => expect(await stores.drafts.list('u1')).toEqual([]));
  });
});
