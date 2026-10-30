import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      // Global error reporting hook. Logs only non-sensitive identifiers.
      onError: (error) => {
        if (error instanceof ApiError) {
          console.error('API request failed', { status: error.status, code: error.code, requestId: error.requestId });
        } else {
          console.error('Query failed');
        }
      },
    }),
    defaultOptions: {
      queries: {
        // Retry transient failures only; never retry a definitive 4xx answer.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}
