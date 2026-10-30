import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ApiError, apiRequest, setCsrfToken, setUnauthorizedHandler } from '@/lib/api-client';
import type { SessionResponse, SessionUser } from '@/types/api';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<SessionUser>;
}

export const SESSION_QUERY_KEY = ['auth', 'session'] as const;

/** Loads the session from the server. A 401 simply means "not signed in". */
async function fetchSession(): Promise<SessionResponse | null> {
  try {
    return await apiRequest<SessionResponse>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Server-session-backed authentication. The browser never sees the session token (HttpOnly
 * cookie); it only learns who is signed in from GET /auth/me, plus a CSRF token kept in memory.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const data = session.data;
  useEffect(() => {
    setCsrfToken(data?.csrfToken ?? null);
  }, [data]);

  const signedOut = useCallback(() => {
    setCsrfToken(null);
    // Drop every cached response that belonged to the previous session.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
  }, [queryClient]);

  // Any 401 from the API (expired, revoked, deactivated) returns the app to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(signedOut);
    return () => setUnauthorizedHandler(null);
  }, [signedOut]);

  const applySession = useCallback(
    (next: SessionResponse) => {
      setCsrfToken(next.csrfToken);
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
      return next.user;
    },
    [queryClient],
  );

  const value = useMemo<AuthContextValue>(() => {
    let status: AuthStatus = 'loading';
    if (data) status = 'authenticated';
    else if (data === null || session.isError) status = 'unauthenticated';
    return {
      status,
      user: data?.user ?? null,
      login: async (email, password) =>
        applySession(await apiRequest<SessionResponse>('/auth/login', { method: 'POST', json: { email, password } })),
      logout: async () => {
        try {
          await apiRequest('/auth/logout', { method: 'POST' });
        } finally {
          signedOut();
        }
      },
      changePassword: async (currentPassword, newPassword) =>
        applySession(
          await apiRequest<SessionResponse>('/auth/change-password', {
            method: 'POST',
            json: { currentPassword, newPassword },
          }),
        ),
    };
  }, [data, session.isError, applySession, signedOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
