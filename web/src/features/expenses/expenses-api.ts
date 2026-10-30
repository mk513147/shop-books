import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type {
  AuditHistoryEntry,
  Expense,
  ExpenseInput,
  ExpenseListResponse,
  PaymentMode,
  PersonRef,
} from '@/types/api';

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};
export const PAYMENT_MODES = Object.keys(PAYMENT_MODE_LABELS) as PaymentMode[];

/** Filter/sort/page state; mirrors the URL search params and GET /expenses query params. */
export type ExpenseListParams = Record<string, string>;

export function useExpenseList(params: ExpenseListParams) {
  const search = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ['expenses', 'list', search],
    queryFn: ({ signal }) => apiRequest<ExpenseListResponse>(`/expenses?${search}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useExpense(id: string) {
  return useQuery({
    queryKey: ['expenses', 'detail', id],
    queryFn: ({ signal }) => apiRequest<{ expense: Expense }>(`/expenses/${id}`, { signal }).then((r) => r.expense),
  });
}

export function useExpenseHistory(id: string) {
  return useQuery({
    queryKey: ['expenses', 'history', id],
    queryFn: ({ signal }) =>
      apiRequest<{ history: AuditHistoryEntry[] }>(`/expenses/${id}/history`, { signal }).then((r) => r.history),
  });
}

export function useRecorders() {
  return useQuery({
    queryKey: ['expenses', 'recorders'],
    queryFn: ({ signal }) => apiRequest<{ users: PersonRef[] }>('/expenses/recorders', { signal }).then((r) => r.users),
    staleTime: 5 * 60 * 1000,
  });
}

function useExpenseMutation<TVars>(fn: (vars: TVars) => Promise<{ expense: Expense }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => (await fn(vars)).expense,
    onSuccess: (expense) => queryClient.setQueryData(['expenses', 'detail', expense.id], expense),
    // Lists, totals, history and category usage counts may all have changed.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

/**
 * `idempotencyKey` is created once per opened form and reused for every retry of that form, so a
 * repeated submit (lost response, double tap, flaky network) never records the expense twice.
 */
export const useCreateExpense = () =>
  useExpenseMutation(({ idempotencyKey, ...input }: ExpenseInput & { idempotencyKey: string }) =>
    apiRequest('/expenses', { method: 'POST', json: input, headers: { 'Idempotency-Key': idempotencyKey } }),
  );

export const useUpdateExpense = () =>
  useExpenseMutation(({ id, ...body }: ExpenseInput & { id: string; version: number }) =>
    apiRequest(`/expenses/${id}`, { method: 'PATCH', json: body }),
  );

export const useVoidExpense = () =>
  useExpenseMutation(({ id, ...body }: { id: string; reason: string; version: number }) =>
    apiRequest(`/expenses/${id}/void`, { method: 'POST', json: body }),
  );

export const useRestoreExpense = () =>
  useExpenseMutation(({ id, ...body }: { id: string; reason: string; version: number }) =>
    apiRequest(`/expenses/${id}/restore`, { method: 'POST', json: body }),
  );
