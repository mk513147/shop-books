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
