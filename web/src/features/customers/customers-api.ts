import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type {
  AuditHistoryEntry,
  Customer,
  CustomerInput,
  CustomerLedger,
  CustomerListResponse,
  CustomersSummary,
  CustomerTransaction,
  CustomerTxnInput,
  CustomerTxnType,
} from '@/types/api';

/** Plain-language labels (no accounting jargon). */
export const TXN_LABELS: Record<CustomerTxnType, string> = {
  due: 'Due added',
  due_payment: 'Due payment received',
  advance: 'Advance received',
  advance_refund: 'Advance refunded',
};

/** Endpoint per entry type (POST /customers/:id/<path>). */
const TXN_PATHS: Record<CustomerTxnType, string> = {
  due: 'dues',
  due_payment: 'due-payments',
  advance: 'advances',
  advance_refund: 'refunds',
};

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

export function useCustomers(params: Record<string, string | number | undefined>) {
  const search = qs(params);
  return useQuery({
    queryKey: ['customers', 'list', search],
    queryFn: ({ signal }) => apiRequest<CustomerListResponse>(`/customers?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useCustomersSummary() {
  return useQuery({
    queryKey: ['customers', 'summary'],
    queryFn: ({ signal }) => apiRequest<{ summary: CustomersSummary }>('/customers/summary', { signal }).then((r) => r.summary),
  });
}

export function useCustomer(id: string) {
  return useQuery({
    queryKey: ['customers', 'detail', id],
    queryFn: ({ signal }) => apiRequest<{ customer: Customer }>(`/customers/${id}`, { signal }).then((r) => r.customer),
  });
}

export function useCustomerHistory(id: string, enabled = true) {
  return useQuery({
    queryKey: ['customers', 'history', id],
    queryFn: ({ signal }) => apiRequest<{ history: AuditHistoryEntry[] }>(`/customers/${id}/history`, { signal }).then((r) => r.history),
    enabled,
  });
}

export function useOpenDues(id: string, enabled = true) {
  return useQuery({
    queryKey: ['customers', 'open-dues', id],
    queryFn: ({ signal }) => apiRequest<{ dues: CustomerTransaction[] }>(`/customers/${id}/open-dues`, { signal }).then((r) => r.dues),
    enabled,
  });
}

export function useCustomerLedger(id: string, params: Record<string, string | undefined>) {
  const search = qs(params);
  return useQuery({
    queryKey: ['customers', 'ledger', id, search],
    queryFn: ({ signal }) => apiRequest<CustomerLedger>(`/customers/${id}/ledger?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useCustomerTransaction(customerId: string, txnId: string) {
  return useQuery({
    queryKey: ['customers', 'transaction', customerId, txnId],
    queryFn: ({ signal }) =>
      apiRequest<{ transaction: CustomerTransaction }>(`/customers/${customerId}/transactions/${txnId}`, { signal }).then(
        (r) => r.transaction,
      ),
  });
}

export function useCustomerTransactionHistory(customerId: string, txnId: string) {
  return useQuery({
    queryKey: ['customers', 'transaction-history', customerId, txnId],
    queryFn: ({ signal }) =>
      apiRequest<{ history: AuditHistoryEntry[] }>(`/customers/${customerId}/transactions/${txnId}/history`, { signal }).then(
        (r) => r.history,
      ),
  });
}

function useInvalidateCustomers() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['customers'] });
}

export function useCreateCustomer() {
  const invalidate = useInvalidateCustomers();
  return useMutation({
    mutationFn: (input: CustomerInput) =>
      apiRequest<{ customer: Customer }>('/customers', { method: 'POST', json: input }).then((r) => r.customer),
    onSettled: invalidate,
  });
}

export function useUpdateCustomer() {
  const invalidate = useInvalidateCustomers();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CustomerInput> & { id: string; version: number; isActive?: boolean }) =>
      apiRequest<{ customer: Customer }>(`/customers/${id}`, { method: 'PATCH', json: body }).then((r) => r.customer),
    onSettled: invalidate,
  });
}

/** `idempotencyKey`: one per opened form, reused on retries, so an entry is never recorded twice. */
export function useRecordCustomerTxn() {
  const invalidate = useInvalidateCustomers();
  return useMutation({
    mutationFn: ({
      customerId,
      type,
      idempotencyKey,
      input,
    }: {
      customerId: string;
      type: CustomerTxnType;
      idempotencyKey: string;
      input: CustomerTxnInput;
    }) =>
      apiRequest<{ transaction: CustomerTransaction }>(`/customers/${customerId}/${TXN_PATHS[type]}`, {
        method: 'POST',
        json: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }).then((r) => r.transaction),
    onSettled: invalidate,
  });
}

export function useReverseCustomerTxn() {
  const invalidate = useInvalidateCustomers();
  return useMutation({
    mutationFn: ({ customerId, id, reason, version }: { customerId: string; id: string; reason: string; version: number }) =>
      apiRequest<{ transaction: CustomerTransaction }>(`/customers/${customerId}/transactions/${id}/reverse`, {
        method: 'POST',
        json: { reason, version },
      }).then((r) => r.transaction),
    onSettled: invalidate,
  });
}
