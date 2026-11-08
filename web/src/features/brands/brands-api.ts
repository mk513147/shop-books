import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { Brand } from '@/types/api';

export type BrandStatus = 'active' | 'archived' | 'all';

export function useBrands(status: BrandStatus = 'all') {
  return useQuery({
    queryKey: ['brands', status],
    queryFn: ({ signal }) => apiRequest<{ brands: Brand[] }>(`/brands?status=${status}`, { signal }).then((r) => r.brands),
  });
}

function useBrandMutation<TVars>(fn: (vars: TVars) => Promise<{ brand: Brand }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => (await fn(vars)).brand,
    // Brand names show on suppliers and expenses too.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['brands'] });
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

export const useCreateBrand = () =>
  useBrandMutation((input: { name: string }) => apiRequest('/brands', { method: 'POST', json: input }));

export const useUpdateBrand = () =>
  useBrandMutation(({ id, ...changes }: { id: string; name?: string; isActive?: boolean }) =>
    apiRequest(`/brands/${id}`, { method: 'PATCH', json: changes }),
  );
