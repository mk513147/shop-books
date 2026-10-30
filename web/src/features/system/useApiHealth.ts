import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type { HealthResponse } from '@/types/api';

/** Connectivity check against GET /api/v1/health. Carries no financial data. */
export function useApiHealth() {
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: ({ signal }) => apiRequest<HealthResponse>('/health', { signal }),
    retry: false,
    staleTime: 15_000,
  });
}
