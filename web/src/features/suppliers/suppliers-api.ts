import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { AuditHistoryEntry, Supplier, SupplierInput, SupplierListResponse } from '@/types/api';

export interface SupplierListParams {
  q?: string;
  status?: 'active' | 'archived' | 'all';
  balance?: 'all' | 'payable';
  page?: number;
  pageSize?: number;
}

export function useSuppliers(params: SupplierListParams, enabled = true) {
  const search = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    queryKey: ['suppliers', 'list', search],
    queryFn: ({ signal }) => apiRequest<SupplierListResponse>(`/suppliers?${search}`, { signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useSupplier(id: string | null) {
  return useQuery({
    queryKey: ['suppliers', 'detail', id],
    queryFn: ({ signal }) => apiRequest<{ supplier: Supplier }>(`/suppliers/${id}`, { signal }).then((r) => r.supplier),
    enabled: id !== null,
  });
}

export function useSupplierHistory(id: string, enabled = true) {
  return useQuery({
    queryKey: ['suppliers', 'history', id],
    queryFn: ({ signal }) =>
      apiRequest<{ history: AuditHistoryEntry[] }>(`/suppliers/${id}/history`, { signal }).then((r) => r.history),
    enabled,
  });
}

function useSupplierMutation<TVars>(fn: (vars: TVars) => Promise<{ supplier: Supplier }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => (await fn(vars)).supplier,
    onSuccess: (supplier) => queryClient.setQueryData(['suppliers', 'detail', supplier.id], supplier),
    // Supplier names/status show on expenses too.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

export const useCreateSupplier = () =>
  useSupplierMutation((input: SupplierInput) => apiRequest('/suppliers', { method: 'POST', json: input }));

export const useUpdateSupplier = () =>
  useSupplierMutation(
    ({ id, ...body }: Partial<SupplierInput> & { id: string; version: number; isActive?: boolean }) =>
      apiRequest(`/suppliers/${id}`, { method: 'PATCH', json: body }),
  );

export const useLinkSupplierCategory = () =>
  useSupplierMutation(({ id, categoryId }: { id: string; categoryId: string }) =>
    apiRequest(`/suppliers/${id}/categories`, { method: 'POST', json: { categoryId } }),
  );
