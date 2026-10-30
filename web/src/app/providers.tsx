import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AuthProvider, type AuthStatus } from '@/features/auth/auth-context';
import { createQueryClient } from './query-client';

interface AppProvidersProps {
  children: ReactNode;
  /** Test seams; production uses the defaults. */
  queryClient?: QueryClient;
  authStatus?: AuthStatus;
}

export function AppProviders({ children, queryClient, authStatus }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <AuthProvider status={authStatus}>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
