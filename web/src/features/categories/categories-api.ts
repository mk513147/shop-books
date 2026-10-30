import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { Category } from '@/types/api';

export type CategoryStatus = 'active' | 'archived' | 'all';

export function useCategories(status: CategoryStatus = 'all') {
  return useQuery({
    queryKey: ['categories', status],
    queryFn: ({ signal }) =>
      apiRequest<{ categories: Category[] }>(`/categories?status=${status}`, { signal }).then((r) => r.categories),
  });
}

function useCategoryMutation<TVars>(fn: (vars: TVars) => Promise<{ category: Category }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['categories'] }),
  });
}

export const useCreateCategory = () =>
  useCategoryMutation((input: { name: string; description: string | null }) =>
    apiRequest('/categories', { method: 'POST', json: input }),
  );

export const useUpdateCategory = () =>
  useCategoryMutation(
    ({ id, ...changes }: { id: string; name?: string; description?: string | null; isActive?: boolean }) =>
      apiRequest(`/categories/${id}`, { method: 'PATCH', json: changes }),
  );
