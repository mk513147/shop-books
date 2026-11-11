import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { setupUser } from '@/test/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseDocument } from '@/types/api';
import { ExpenseDocuments } from '../ExpenseDocuments';
import { AttachmentQueueProvider } from './AttachmentQueueProvider';
import type { AttachmentQueueApi } from './engine';
import { AttachmentSyncBanner } from './LocalAttachments';
import { MemoryAttachmentStore } from './store';

vi.mock('@/features/auth/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Manager A', role: 'manager' } }) }));

const pdf = () => new File(['%PDF-1.4 test %%EOF'], 'bill.pdf', { type: 'application/pdf' });

/** Server documents of the expense, as the shared API returns them. */
let serverDocs: ExpenseDocument[] = [];

function renderPanel(api: AttachmentQueueApi, store = new MemoryAttachmentStore({ durable: true })) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/documents')) return Response.json({ documents: serverDocs });
      return Response.json({}, { status: 404 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AttachmentQueueProvider userId="u1" store={store} api={api}>
        <ExpenseDocuments expenseId="exp-1" voided={false} />
      </AttachmentQueueProvider>
    </QueryClientProvider>,
  );
  return { store, user: setupUser() };
}

beforeEach(() => {
  // Bill attachments are postponed (off by default); these tests cover the enabled path.
  vi.stubEnv('VITE_BILL_ATTACHMENTS', 'enabled');
  serverDocs = [];
  // Web Crypto may be missing in the test DOM: a stable stand-in digest (the server re-checks anyway).
  if (!globalThis.crypto?.subtle) {
    vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: { digest: async () => new Uint8Array(32).buffer } });
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('expense documents with the offline queue', () => {
  it('a file chosen while the PC is offline is shown at once as "Waiting for PC", kept on the device, and can be removed only after confirming', async () => {
    const api: AttachmentQueueApi = {
      storageStatus: async () => ({ available: false }),
      upload: vi.fn(),
      getDocument: vi.fn(),
    };
    const { store, user } = renderPanel(api);
    await screen.findByRole('button', { name: /Choose files/ });
    const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    await user.upload(input, pdf());

    const row = await screen.findByTestId('local-attachment');
    expect(within(row).getByText('bill.pdf')).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('Waiting for PC')).toBeInTheDocument());
    expect(api.upload).not.toHaveBeenCalled();
    expect(await store.list('u1')).toHaveLength(1);
    // No promise of a backup.
    expect(screen.getByText(/They are not backed up/)).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Remove bill.pdf from this device' }));
    expect(await screen.findByText(/This is the only copy/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(await store.list('u1')).toHaveLength(1);
    await user.click(within(row).getByRole('button', { name: 'Remove bill.pdf from this device' }));
    await user.click(await screen.findByRole('button', { name: 'Remove from device' }));
    await waitFor(() => expect(screen.queryByTestId('local-attachment')).not.toBeInTheDocument());
    expect(await store.list('u1')).toEqual([]);
  });

  it('once the PC confirms the file, the local copy is gone and the shared document is listed', async () => {
    const api: AttachmentQueueApi = {
      storageStatus: async () => ({ available: true }),
      upload: vi.fn(async (item) => {
        const doc = {
          id: item.id, expenseId: 'exp-1', fileName: 'bill.pdf', mimeType: 'application/pdf' as const, sizeBytes: 10, sha256: item.sha256,
          status: 'active' as const, uploadedBy: { id: 'u1', name: 'Manager A' }, createdAt: new Date().toISOString(), removedAt: null,
          removedBy: null, removeReason: null, pendingDelivery: false,
        };
        serverDocs = [doc];
        return { document: doc };
      }),
      getDocument: vi.fn(async (_e: string, id: string) => serverDocs.find((d) => d.id === id)!),
    };
    const { store, user } = renderPanel(api);
    await screen.findByRole('button', { name: /Choose files/ });
    const input = document.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    await user.upload(input, pdf());
    await waitFor(() => expect(api.getDocument).toHaveBeenCalled());
    await waitFor(async () => expect(await store.list('u1')).toEqual([]));
    expect(await screen.findByRole('link', { name: 'View bill.pdf' })).toBeInTheDocument();
    expect(screen.queryByTestId('local-attachment')).not.toBeInTheDocument();
  });

  it('warns when the browser cannot keep files offline', async () => {
    const { OfflineStorageWarning } = await import('./LocalAttachments');
    render(<OfflineStorageWarning problem="Browser storage is unavailable (blocked)." />);
    expect(screen.getByRole('alert')).toHaveTextContent(/kept only while this page stays open/);
  });

  it('the app-wide banner counts files that are only on this device', () => {
    const items = [
      { id: 'a', status: 'waiting_pc' },
      { id: 'b', status: 'failed' },
    ] as never;
    render(<AttachmentSyncBanner items={items} onRetry={() => undefined} />);
    expect(screen.getByTestId('attachment-sync-banner')).toHaveTextContent('2 bill files are on this device only · 1 waiting for the shop PC · 1 failed');
  });
});
