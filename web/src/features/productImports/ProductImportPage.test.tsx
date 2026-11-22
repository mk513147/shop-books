import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { ProductImportBatchPage, ProductImportPage } from '@/routes/ProductImportPage';
import type { ImportBatch } from './imports-api';

const BATCH: ImportBatch = {
  id: 'b1',
  fileName: 'copy.xlsx',
  sheetName: 'Copy',
  blockRange: 'A1:E27',
  headerRow: 3,
  header: { A: 'NAME', B: 'PAGE ', C: 'SIZE', D: 'MRP', E: 'SP' },
  // As the server guesses it: "SP" is deliberately left unmapped.
  mapping: { columns: { A: 'name', B: 'pages', C: 'size', D: 'mrp' }, confirmed: false },
  valueRules: { gsmSuffix: false, sizes: {} },
  brandDecisions: {},
  sectionCategories: {},
  status: 'review',
  version: 3,
  createdAt: '2026-11-22T10:00:00.000Z',
  createdBy: 'Owner',
  committedAt: null,
  committedBy: null,
  skippedRows: [{ rowNumber: 13, reason: 'header', text: 'NAME | PAGE  | SIZE | MRP | SP' }],
  sections: [{ name: 'CLASSMATE', rows: 4, categoryId: null }],
  counts: { new: 0, update: 0, duplicate: 0, error: 17, total: 17, toCreate: 0, toUpdate: 0, toSkip: 0, pending: 17 },
  brandCandidates: [
    { key: 'PAPERKARFT', rows: 1, examples: ['PAPERKARFT SPIRAL'], decision: null, similarInFile: ['PAPERKART'] },
    { key: 'PAPERKART', rows: 1, examples: ['PAPERKART SPIRAL'], decision: null, similarInFile: ['PAPERKARFT'] },
  ],
  sizeValues: [{ value: 'SL', rows: 3, rule: null }],
  gsmInNames: 2,
  blockers: ['Confirm the column mapping.', 'Map a column to the selling price.', '17 rows still need a decision (fix the errors, choose update or skip).'],
  result: null,
  fields: ['brand', 'name', 'category', 'size', 'pages', 'gsm', 'binding', 'unit', 'packQty', 'mrp', 'sellingPrice', 'purchasePrice', 'sku', 'barcode', 'aliases', 'notes'],
};

function mockApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') return Response.json({ batch: BATCH });
    if (url.includes('/product-imports/b1/rows')) {
      return Response.json({ items: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } });
    }
    if (url.includes('/product-imports/b1')) return Response.json({ batch: BATCH });
    if (url.includes('/product-imports')) return Response.json({ batches: [] });
    if (url.includes('/brands')) return Response.json({ brands: [] });
    if (url.includes('/categories')) return Response.json({ categories: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/products/import" element={<ProductImportPage />} />
            <Route path="/products/import/:id" element={<ProductImportBatchPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('product import review', () => {
  it('leaves "SP" unmapped and keeps Import disabled while blockers exist', async () => {
    mockApi();
    renderAt('/products/import/b1');
    const sp = await screen.findByLabelText('E: “SP”');
    expect(sp).toHaveValue('ignore');
    expect(screen.getByLabelText('A: “NAME”')).toHaveValue('name');
    expect(screen.getByRole('button', { name: /Import products/ })).toBeDisabled();
    const blockers = screen.getByTestId('import-blockers');
    expect(within(blockers).getByText('Map a column to the selling price.')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
  });

  it('points out look-alike brand spellings without merging or saving anything', async () => {
    const fetchMock = mockApi();
    renderAt('/products/import/b1');
    const first = await screen.findByTestId('brand-PAPERKARFT');
    expect(within(first).getByText(/Looks like PAPERKART — not merged automatically/)).toBeInTheDocument();
    expect(within(screen.getByTestId('brand-PAPERKART')).getByText(/Looks like PAPERKARFT/)).toBeInTheDocument();
    expect(within(first).getByText('Needs a decision')).toBeInTheDocument();
    // Nothing is decided or sent automatically.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0);
  });

  it('shows a larger-screen message on phones instead of the review', async () => {
    mockApi();
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    renderAt('/products/import/b1');
    expect(await screen.findByText(/Importing is easier on a computer or tablet/)).toBeInTheDocument();
    expect(screen.queryByText('Columns')).not.toBeInTheDocument();
  });
});

describe('product import upload', () => {
  it('refuses a file that is not .xlsx before sending anything', async () => {
    const fetchMock = mockApi();
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send');
    renderAt('/products/import');
    const input = await screen.findByLabelText('Excel workbook (.xlsx)');
    fireEvent.change(input, { target: { files: [new File(['name,price\nx,1'], 'products.csv', { type: 'text/csv' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved as \.xlsx/);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/inspect'))).toBe(false));
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the phone message on the upload page but still lists imports', async () => {
    mockApi();
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    renderAt('/products/import');
    expect(await screen.findByText(/Importing is easier on a computer or tablet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Excel workbook (.xlsx)')).not.toBeInTheDocument();
    expect(await screen.findByText('No imports yet.')).toBeInTheDocument();
  });
});
