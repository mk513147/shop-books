import { File as NodeFile } from 'node:buffer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { setupUser } from '@/test/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseDocument } from '@/types/api';
import { billAttachmentsEnabled } from './attachments-feature';
import { ExpenseDocumentsOnRecord } from './ExpenseDocuments';
import { PausedDeviceFilesNotice } from './queue/PausedDeviceFiles';
import { IndexedDbAttachmentStore } from './queue/store';
import type { QueuedAttachment } from './queue/types';

vi.mock('@/features/auth/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Owner', role: 'owner' } }) }));

const person = { id: 'u1', name: 'Owner' };
const doc = (id: string, extra: Partial<ExpenseDocument> = {}): ExpenseDocument => ({
  id,
  expenseId: 'exp-1',
  fileName: `${id}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: 1200,
  sha256: '0'.repeat(64),
  status: 'active',
  uploadedBy: person,
  createdAt: '2026-10-01T10:00:00.000Z',
  removedAt: null,
  removedBy: null,
  removeReason: null,
  pendingDelivery: false,
  ...extra,
});

let serverDocs: ExpenseDocument[] = [];
let requests: { url: string; method: string }[] = [];

function renderCard() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
      if (String(input).includes('/documents')) return Response.json({ documents: serverDocs });
      return Response.json({}, { status: 404 });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ExpenseDocumentsOnRecord expenseId="exp-1" voided={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  serverDocs = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('bill attachments postponed: expense documents on record', () => {
  it('is off unless the build sets VITE_BILL_ATTACHMENTS=enabled', () => {
    expect(billAttachmentsEnabled()).toBe(false);
    vi.stubEnv('VITE_BILL_ATTACHMENTS', 'true');
    expect(billAttachmentsEnabled()).toBe(false);
    vi.stubEnv('VITE_BILL_ATTACHMENTS', 'enabled');
    expect(billAttachmentsEnabled()).toBe(true);
  });

  it('shows no documents card (and no upload area) for an expense without document records', async () => {
    const { container } = renderCard();
    await waitFor(() => expect(requests.some((r) => r.url.includes('/expenses/exp-1/documents'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps existing records visible read-only, with no upload controls and no dead file links', async () => {
    serverDocs = [
      doc('on-pc'),
      doc('in-db', { pendingDelivery: true }),
      doc('removed', { status: 'removed', removedAt: '2026-10-02T10:00:00.000Z', removedBy: person, removeReason: 'Wrong bill' }),
    ];
    const user = setupUser();
    renderCard();
    expect(await screen.findByText('Bill documents on record')).toBeInTheDocument();
    expect(screen.getByTestId('attachments-paused-note')).toBeInTheDocument();

    const rowOf = (name: string) => screen.getByText(name).closest('li')!;
    // Stored on the shop PC: listed, but no link that would fail while storage is paused.
    expect(within(rowOf('on-pc.pdf')).queryByRole('link')).toBeNull();
    expect(within(rowOf('on-pc.pdf')).getByText(/cannot be opened while attachments are paused/)).toBeInTheDocument();
    // Bytes still held by the app (server-side upload queue): can still be opened.
    expect(within(rowOf('in-db.pdf')).getByRole('link', { name: 'View in-db.pdf' })).toHaveAttribute(
      'href',
      expect.stringContaining('/expenses/exp-1/documents/in-db/content'),
    );
    // Removed records are not hidden either.
    await user.click(screen.getByRole('button', { name: 'Show removed documents (1)' }));
    expect(screen.getByText(/Reason: Wrong bill/)).toBeInTheDocument();

    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Choose files|Take photo|Upload/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for storage|shop PC is online/)).not.toBeInTheDocument();
    // Only reads: nothing is uploaded or changed.
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('bill attachments postponed: files left in this browser by the earlier offline queue', () => {
  it('are counted for the signed-in user and reported, never sent or deleted', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const uploads = new IndexedDbAttachmentStore(factory, 'uploads');
    const item: QueuedAttachment = {
      id: 'a1',
      expenseId: 'exp-1',
      userId: 'u1',
      fileName: 'bill.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 8,
      sha256: '0'.repeat(64),
      createdAt: '2026-10-01T10:00:00.000Z',
      status: 'waiting_pc',
      retryCount: 0,
      lastError: null,
      nextAttemptAt: null,
      serverDocumentId: null,
      blob: new NodeFile(['%PDF-1.4'], 'bill.pdf', { type: 'application/pdf' }) as unknown as Blob,
    };
    await uploads.put(item);
    await uploads.put({ ...item, id: 'a2', userId: 'someone-else' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<PausedDeviceFilesNotice userId="u1" />);
    expect(await screen.findByTestId('paused-device-files')).toHaveTextContent('1 bill file chosen on this device');
    await setupUser().click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByTestId('paused-device-files')).not.toBeInTheDocument();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await uploads.list('u1')).map((i) => i.id)).toEqual(['a1']);
    expect(await uploads.list('someone-else')).toHaveLength(1);
  });

  it('says nothing (and creates no browser database) on a device that never used attachments', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const { container } = render(<PausedDeviceFilesNotice userId="u1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
    expect(await factory.databases()).toEqual([]);
  });
});
