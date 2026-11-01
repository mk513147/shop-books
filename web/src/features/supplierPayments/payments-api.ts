import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type {
  AllocationInput,
  AuditHistoryEntry,
  OpenBill,
  SupplierBalance,
  SupplierLedger,
  SupplierPaymentDetail,
  SupplierPaymentInput,
  SupplierPaymentListResponse,
  SuppliersSummary,
} from '@/types/api';

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

export function useSupplierPayments(params: Record<string, string | number | undefined>) {
  const search = qs(params);
  return useQuery({
    queryKey: ['supplier-payments', 'list', search],
    queryFn: ({ signal }) => apiRequest<SupplierPaymentListResponse>(`/supplier-payments?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useSupplierPayment(id: string) {
  return useQuery({
    queryKey: ['supplier-payments', 'detail', id],
    queryFn: ({ signal }) =>
      apiRequest<{ payment: SupplierPaymentDetail }>(`/supplier-payments/${id}`, { signal }).then((r) => r.payment),
  });
}

export function usePaymentHistory(id: string) {
  return useQuery({
    queryKey: ['supplier-payments', 'history', id],
    queryFn: ({ signal }) =>
      apiRequest<{ history: AuditHistoryEntry[] }>(`/supplier-payments/${id}/history`, { signal }).then((r) => r.history),
  });
}

export function useSupplierBalance(id: string | null) {
  return useQuery({
    queryKey: ['suppliers', 'balance', id],
    queryFn: ({ signal }) => apiRequest<{ balance: SupplierBalance }>(`/suppliers/${id}/balance`, { signal }).then((r) => r.balance),
    enabled: id !== null,
  });
}

export function useSupplierLedger(id: string, params: Record<string, string | undefined>) {
  const search = qs(params);
  return useQuery({
    queryKey: ['suppliers', 'ledger', id, search],
    queryFn: ({ signal }) => apiRequest<SupplierLedger>(`/suppliers/${id}/ledger?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useOpenBills(supplierId: string | null) {
  return useQuery({
    queryKey: ['suppliers', 'open-bills', supplierId],
    queryFn: ({ signal }) => apiRequest<{ bills: OpenBill[] }>(`/suppliers/${supplierId}/open-bills`, { signal }).then((r) => r.bills),
    enabled: supplierId !== null,
  });
}

export function useSuppliersSummary() {
  return useQuery({
    queryKey: ['suppliers', 'summary'],
    queryFn: ({ signal }) => apiRequest<{ summary: SuppliersSummary }>('/suppliers/summary', { signal }).then((r) => r.summary),
  });
}

/** Payments change supplier balances, bills' outstanding amounts and expense histories. */
function usePaymentMutation<TVars>(fn: (vars: TVars) => Promise<{ payment: SupplierPaymentDetail }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => (await fn(vars)).payment,
    onSuccess: (payment) => queryClient.setQueryData(['supplier-payments', 'detail', payment.id], payment),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['supplier-payments'] });
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

/** `idempotencyKey`: one per opened form, reused on retries, so a payment is never recorded twice. */
export const useCreatePayment = () =>
  usePaymentMutation(({ idempotencyKey, ...input }: SupplierPaymentInput & { idempotencyKey: string }) =>
    apiRequest('/supplier-payments', { method: 'POST', json: input, headers: { 'Idempotency-Key': idempotencyKey } }),
  );

export const useAllocatePayment = () =>
  usePaymentMutation(({ id, allocations, idempotencyKey }: { id: string; allocations: AllocationInput[]; idempotencyKey: string }) =>
    apiRequest(`/supplier-payments/${id}/allocations`, {
      method: 'POST',
      json: { allocations },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  );

export const useReleaseAllocation = () =>
  usePaymentMutation(({ id, allocationId, reason }: { id: string; allocationId: string; reason: string }) =>
    apiRequest(`/supplier-payments/${id}/allocations/${allocationId}/release`, { method: 'POST', json: { reason } }),
  );

export const useReversePayment = () =>
  usePaymentMutation(({ id, reason, version }: { id: string; reason: string; version: number }) =>
    apiRequest(`/supplier-payments/${id}/reverse`, { method: 'POST', json: { reason, version } }),
  );

export const useUpdatePayment = () =>
  usePaymentMutation(
    ({ id, ...body }: { id: string; version: number; paymentDate: string; paymentMode: string; reference: string | null; notes: string | null }) =>
      apiRequest(`/supplier-payments/${id}`, { method: 'PATCH', json: body }),
  );
