import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiBaseUrl, apiRequest, uploadBinary } from '@/lib/api-client';

/**
 * Product import (Excel) API: /api/v1/product-imports. Only the owner and managers allowed to see
 * purchase prices can use it (the API answers 403 PURCHASE_PRICE_FORBIDDEN otherwise).
 * Shapes mirror server/src/modules/productImports (imports.service.ts, analyse.ts).
 */

export const IMPORT_FIELDS = [
  'brand',
  'name',
  'category',
  'size',
  'pages',
  'gsm',
  'binding',
  'unit',
  'packQty',
  'mrp',
  'sellingPrice',
  'purchasePrice',
  'sku',
  'barcode',
  'aliases',
  'notes',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  brand: 'Brand',
  name: 'Product name',
  category: 'Category',
  size: 'Size',
  pages: 'Pages',
  gsm: 'GSM (paper weight)',
  binding: 'Binding',
  unit: 'Selling unit',
  packQty: 'Pieces per pack',
  mrp: 'MRP',
  sellingPrice: 'Selling price',
  purchasePrice: 'Purchase price',
  sku: 'SKU / item code',
  barcode: 'Barcode',
  aliases: 'Other search names',
  notes: 'Notes / description',
};

export type SellingUnit = 'piece' | 'pack' | 'box' | 'set' | 'ream';
export type Decision = 'pending' | 'create' | 'update' | 'skip';
export type Group = 'new' | 'update' | 'duplicate' | 'error';
export type BatchStatus = 'review' | 'committed' | 'discarded';

export interface Mapping {
  columns: Record<string, ImportField | 'ignore'>;
  confirmed: boolean;
}

export type SizeRule = { action: 'keep' } | { action: 'attribute'; key: string; value: string };

export interface ValueRules {
  gsmSuffix: boolean;
  sizes: Record<string, SizeRule>;
}

export type BrandDecision =
  | { action: 'existing'; brandId: string; prefix: string }
  | { action: 'create'; name: string; prefix: string }
  | { action: 'not_brand' };

export interface BrandCandidate {
  key: string;
  rows: number;
  examples: string[];
  decision: BrandDecision | null;
  similarInFile: string[];
}

export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  field?: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface RowOverrides {
  name?: string;
  brandId?: string | null;
  categoryId?: string;
  size?: string | null;
  pageCount?: number | null;
  gsm?: number | null;
  binding?: string | null;
  sellingUnit?: SellingUnit;
  packQty?: number;
  mrp?: string | null;
  sellingPrice?: string;
  purchasePrice?: string | null;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  attributes?: Record<string, string>;
  confirmSpAboveMrp?: boolean;
}

export type ProposedBrand = { kind: 'existing'; id: string; name: string } | { kind: 'new'; name: string } | null;

export interface Proposal {
  name: string | null;
  brand: ProposedBrand;
  brandKey: string | null;
  categoryId: string | null;
  categoryName: string | null;
  size: string | null;
  pageCount: number | null;
  gsm: number | null;
  binding: string | null;
  sellingUnit: SellingUnit;
  packQty: number;
  attributes: Record<string, string>;
  mrp: string | null;
  sellingPrice: string | null;
  purchasePrice: string | null;
  sku: string | null;
  barcode: string | null;
  searchAliases: string[];
  description: string | null;
  confirmSpAboveMrp: boolean;
  suggestedName: string | null;
}

export interface SkippedRow {
  rowNumber: number;
  reason: 'header' | 'section' | 'above_header';
  text: string;
}

export interface ImportCounts {
  new: number;
  update: number;
  duplicate: number;
  error: number;
  total: number;
  toCreate: number;
  toUpdate: number;
  toSkip: number;
  pending: number;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  sheetName: string;
  blockRange: string;
  headerRow: number;
  header: Record<string, string>;
  mapping: Mapping;
  valueRules: ValueRules;
  brandDecisions: Record<string, BrandDecision>;
  sectionCategories: Record<string, string>;
  status: BatchStatus;
  version: number;
  createdAt: string;
  createdBy: string;
  committedAt: string | null;
  committedBy: string | null;
  skippedRows: SkippedRow[];
  sections: { name: string; rows: number; categoryId: string | null }[];
  counts: ImportCounts;
  brandCandidates: BrandCandidate[];
  sizeValues: { value: string; rows: number; rule: SizeRule | null }[];
  gsmInNames: number;
  blockers: string[];
  result: { created: number; updated: number; skipped: number; brandsCreated: number } | null;
  fields: readonly ImportField[];
}

export interface ImportRow {
  rowNumber: number;
  splitIndex: number;
  section: string | null;
  raw: Record<string, string>;
  rawTypes: Record<string, string>;
  proposal: Proposal;
  overrides: RowOverrides;
  issues: Issue[];
  group: Group;
  decision: Decision;
  effectiveDecision: Decision;
  duplicateOf: number | null;
  matchedProduct: { id: string; name: string; brand: string | null; sellingPrice: string; mrp: string | null } | null;
  resultProductId: string | null;
}

export interface ImportRowsResponse {
  items: ImportRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface BatchSummary {
  id: string;
  fileName: string;
  sheetName: string;
  status: BatchStatus;
  rows: number;
  createdAt: string;
  createdBy: string;
  committedAt: string | null;
}

export interface DetectedBlock {
  range: string;
  duplicateOf: string | null;
}

export interface SheetPreview {
  name: string;
  rowCount: number;
  columnCount: number;
  preview: { row: number; cells: string[] }[];
  blocks: DetectedBlock[];
}

/** Client-side check before uploading (the server re-checks everything). */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function checkImportFile(file: File): string | null {
  if (!/\.xlsx$/i.test(file.name)) return 'Choose an Excel workbook saved as .xlsx (not .xls, .xlsm or .csv).';
  if (file.size > MAX_IMPORT_BYTES) return 'The workbook is larger than 2 MB. Remove other sheets or split it, then try again.';
  if (file.size === 0) return 'The file is empty.';
  return null;
}

/** Message for API errors, with the permission case spelled out. */
export function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'PURCHASE_PRICE_FORBIDDEN') {
    return 'Only the owner and managers allowed to see purchase prices can import products.';
  }
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Check your connection and try again.';
}

const fileHeaders = (file: File) => ({ 'X-File-Name': encodeURIComponent(file.name) });

export function inspectWorkbook(file: File): Promise<{ sheets: SheetPreview[] }> {
  return uploadBinary<{ sheets: SheetPreview[] }>('/product-imports/inspect', file, { headers: fileHeaders(file) });
}

export function createImportBatch(
  file: File,
  options: { sheet: string; range: string; headerRow: number; sectionRows: boolean },
): Promise<{ batch: ImportBatch }> {
  const query = new URLSearchParams({
    sheet: options.sheet,
    range: options.range,
    headerRow: String(options.headerRow),
    sectionRows: String(options.sectionRows),
  });
  return uploadBinary<{ batch: ImportBatch }>(`/product-imports?${query}`, file, { headers: fileHeaders(file) });
}

const batchKey = (id: string) => ['product-imports', 'batch', id] as const;
const rowsKey = (id: string) => ['product-imports', 'rows', id] as const;

export function useImportBatches() {
  return useQuery({
    queryKey: ['product-imports', 'list'],
    queryFn: ({ signal }) => apiRequest<{ batches: BatchSummary[] }>('/product-imports', { signal }).then((r) => r.batches),
  });
}

export function useImportBatch(id: string) {
  return useQuery({
    queryKey: batchKey(id),
    queryFn: ({ signal }) => apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}`, { signal }).then((r) => r.batch),
  });
}

export function useImportRows(id: string, params: { group?: Group | undefined; page: number; pageSize?: number }) {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize ?? 50) });
  if (params.group) query.set('group', params.group);
  const search = query.toString();
  return useQuery({
    queryKey: [...rowsKey(id), search],
    queryFn: ({ signal }) => apiRequest<ImportRowsResponse>(`/product-imports/${id}/rows?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** Every review mutation returns the whole batch: replace it and refresh the rows. */
function useBatchMutation<TVars>(id: string, fn: (vars: TVars) => Promise<{ batch: ImportBatch }>, onCommitted = false) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: ({ batch }) => {
      queryClient.setQueryData(batchKey(id), batch);
      void queryClient.invalidateQueries({ queryKey: rowsKey(id) });
      void queryClient.invalidateQueries({ queryKey: ['product-imports', 'list'] });
      if (onCommitted) {
        void queryClient.invalidateQueries({ queryKey: ['products'] });
        void queryClient.invalidateQueries({ queryKey: ['brands'] });
        void queryClient.invalidateQueries({ queryKey: ['categories'] });
      }
    },
    onError: (err) => {
      // Someone else changed the batch, or the catalogue changed: show the latest state.
      if (err instanceof ApiError && (err.code === 'VERSION_CONFLICT' || err.code === 'IMPORT_STALE')) {
        void queryClient.invalidateQueries({ queryKey: batchKey(id) });
        void queryClient.invalidateQueries({ queryKey: rowsKey(id) });
      }
    },
  });
}

export interface SettingsInput {
  version: number;
  mapping?: Mapping;
  valueRules?: ValueRules;
  brandDecisions?: Record<string, BrandDecision | null>;
  sectionCategories?: Record<string, string | null>;
}

export const useUpdateImportSettings = (id: string) =>
  useBatchMutation(id, (body: SettingsInput) => apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}`, { method: 'PATCH', json: body }));

export interface RowChange {
  rowNumber: number;
  splitIndex: number;
  decision?: Decision;
  overrides?: RowOverrides | null;
}

export const useUpdateImportRows = (id: string) =>
  useBatchMutation(id, (body: { version: number; rows: RowChange[] }) =>
    apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}/rows`, { method: 'PATCH', json: body }),
  );

export const useSplitImportRow = (id: string) =>
  useBatchMutation(id, ({ rowNumber, ...body }: { rowNumber: number; version: number; parts: RowOverrides[] }) =>
    apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}/rows/${rowNumber}/split`, { method: 'POST', json: body }),
  );

export const useUnsplitImportRow = (id: string) =>
  useBatchMutation(id, ({ rowNumber, version }: { rowNumber: number; version: number }) =>
    apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}/rows/${rowNumber}/unsplit`, { method: 'POST', json: { version } }),
  );

export const useCommitImport = (id: string) =>
  useBatchMutation(id, (body: { version: number }) => apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}/commit`, { method: 'POST', json: body }), true);

export const useDiscardImport = (id: string) =>
  useBatchMutation(id, (body: { version: number }) => apiRequest<{ batch: ImportBatch }>(`/product-imports/${id}/discard`, { method: 'POST', json: body }));

function fileNameFrom(disposition: string | null, fallback: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = /filename="([^"]+)"/i.exec(disposition ?? '');
  return plain?.[1] ?? fallback;
}

/** Downloads the review / error report workbook of a batch. */
export async function downloadImportReport(id: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/product-imports/${id}/report`, {
    credentials: 'include',
    headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json' },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `Download failed (${response.status}).`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFrom(response.headers.get('Content-Disposition'), 'import-review.xlsx');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return a.download;
}
