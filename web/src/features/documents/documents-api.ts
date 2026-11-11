import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBaseUrl, apiRequest, uploadBinary } from '@/lib/api-client';
import type { ExpenseDocument } from '@/types/api';

export function useExpenseDocuments(expenseId: string, includeRemoved = false) {
  return useQuery({
    queryKey: ['expenses', 'documents', expenseId, includeRemoved],
    queryFn: ({ signal }) =>
      apiRequest<{ documents: ExpenseDocument[] }>(
        `/expenses/${expenseId}/documents${includeRemoved ? '?status=all' : ''}`,
        { signal },
      ).then((r) => r.documents),
  });
}

/**
 * URL of a document's bytes. The API authorises every request with the session cookie and sends
 * `Cache-Control: no-store`; the service worker never caches /api (see pwa-config.ts).
 */
export function documentContentUrl(doc: Pick<ExpenseDocument, 'id' | 'expenseId'>, download = false): string {
  return `${apiBaseUrl()}/expenses/${doc.expenseId}/documents/${doc.id}/content${download ? '?download=1' : ''}`;
}

export function uploadExpenseDocument(
  expenseId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ document: ExpenseDocument; created: boolean }> {
  return uploadBinary(`/expenses/${expenseId}/documents`, file, {
    headers: { 'X-File-Name': encodeURIComponent(file.name), ...(file.type ? { 'X-File-Type': file.type } : {}) },
    onProgress,
  });
}

export function useRemoveDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ doc, reason }: { doc: ExpenseDocument; reason: string }) =>
      apiRequest<{ document: ExpenseDocument }>(`/expenses/${doc.expenseId}/documents/${doc.id}/remove`, {
        method: 'POST',
        json: { reason },
      }).then((r) => r.document),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

/** Is the shop PC (permanent document storage) reachable through the API right now? */
export function fetchDocumentStorageStatus(): Promise<{ available: boolean; driver: string }> {
  return apiRequest<{ available: boolean; driver: string }>('/document-storage/status');
}

/**
 * Upload of one file from the offline attachment queue: "permanent" mode (stored and verified on
 * the PC, never parked on the server), the attachment id as document id (idempotent retries) and
 * the checksum computed on this device (the server refuses bytes that do not match).
 */
export function uploadQueuedAttachment(
  item: { id: string; expenseId: string; fileName: string; mimeType: string; sha256: string; blob: Blob },
  onProgress?: (fraction: number) => void,
): Promise<{ document: ExpenseDocument; created: boolean; stored: 'permanent' | 'queued' }> {
  return uploadBinary(`/expenses/${item.expenseId}/documents`, item.blob, {
    headers: {
      'X-File-Name': encodeURIComponent(item.fileName),
      ...(item.mimeType ? { 'X-File-Type': item.mimeType } : {}),
      'X-Storage-Mode': 'permanent',
      'X-Attachment-Id': item.id,
      'X-Content-SHA256': item.sha256,
    },
    ...(onProgress ? { onProgress } : {}),
  });
}

export function fetchExpenseDocument(expenseId: string, documentId: string): Promise<ExpenseDocument> {
  return apiRequest<{ document: ExpenseDocument }>(`/expenses/${expenseId}/documents/${documentId}`).then((r) => r.document);
}
