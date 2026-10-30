import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { TemporaryPasswordResponse, UserSummary } from '@/types/api';

const USERS_KEY = ['users'] as const;

export function useUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: ({ signal }) => apiRequest<{ users: UserSummary[] }>('/users', { signal }).then((r) => r.users),
  });
}

function useUsersMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export const useCreateUser = () =>
  useUsersMutation((input: { email: string; name: string }) =>
    apiRequest<TemporaryPasswordResponse>('/users', { method: 'POST', json: input }),
  );

export const useSetUserActive = () =>
  useUsersMutation(({ id, isActive }: { id: string; isActive: boolean }) =>
    apiRequest<{ user: UserSummary }>(`/users/${id}`, { method: 'PATCH', json: { isActive } }),
  );

export const useResetPassword = () =>
  useUsersMutation((id: string) =>
    apiRequest<TemporaryPasswordResponse>(`/users/${id}/reset-password`, { method: 'POST' }),
  );

export const useRevokeSessions = () =>
  useUsersMutation((id: string) => apiRequest<{ revoked: number }>(`/users/${id}/revoke-sessions`, { method: 'POST' }));
