import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { AuditHistoryEntry, Salesman, SalesmanInput, SalesmanListResponse } from '@/types/api';

export interface SalesmanListParams {
  q?: string | undefined;
  status?: string | undefined;
  page?: number;
  pageSize?: number;
}

export function useSalesmen(params: SalesmanListParams) {
  const search = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    queryKey: ['salesmen', 'list', search],
    queryFn: ({ signal }) => apiRequest<SalesmanListResponse>(`/salesmen?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useSalesman(id: string) {
  return useQuery({
    queryKey: ['salesmen', 'detail', id],
    queryFn: ({ signal }) => apiRequest<{ salesman: Salesman }>(`/salesmen/${id}`, { signal }).then((r) => r.salesman),
  });
}

export function useSalesmanHistory(id: string, enabled = true) {
  return useQuery({
    queryKey: ['salesmen', 'history', id],
    queryFn: ({ signal }) => apiRequest<{ history: AuditHistoryEntry[] }>(`/salesmen/${id}/history`, { signal }).then((r) => r.history),
    enabled,
  });
}

function useSalesmanMutation<TVars>(fn: (vars: TVars) => Promise<{ salesman: Salesman }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => (await fn(vars)).salesman,
    onSuccess: (salesman) => queryClient.setQueryData(['salesmen', 'detail', salesman.id], salesman),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['salesmen'] }),
  });
}

export const useCreateSalesman = () =>
  useSalesmanMutation((input: SalesmanInput) => apiRequest('/salesmen', { method: 'POST', json: input }));

export const useUpdateSalesman = () =>
  useSalesmanMutation(({ id, ...body }: Partial<SalesmanInput> & { id: string; version: number; isActive?: boolean }) =>
    apiRequest(`/salesmen/${id}`, { method: 'PATCH', json: body }),
  );
