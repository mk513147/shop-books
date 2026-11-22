import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
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
 * Tabs of the same browser share one session cookie: signing in as someone else (or out) in one tab
 * changes the account of every tab. The tab where it happened tells the others at once; each of them
 * re-reads the session (and forgets the previous account's data if the identity changed). Only
 * explicit sign-in / sign-out / password change announce it, never a 401, so tabs cannot ping-pong.
 */
const SESSION_CHANNEL = 'shop-books-session';

function openSessionChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL);
  } catch {
    return null;
  }
}

/**
 * Server-session-backed authentication. The browser never sees the session token (HttpOnly
 * cookie); it only learns who is signed in from GET /auth/me, plus a CSRF token kept in memory.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  /**
   * Drops everything that belonged to the previous session from memory: every cached response
   * (including revealed purchase prices) AND every cached mutation (whose variables can hold prices
   * typed into a form, and whose results can hold server answers).
   */
  const forgetSessionData = useCallback(() => {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
    queryClient.getMutationCache().clear();
  }, [queryClient]);

  const session = useQuery({
    queryKey: SESSION_QUERY_KEY,
    // Every session refresh (window focus, another tab's announcement, a 403 on a price request…)
    // checks WHO is signed in. If it is no longer the account whose data this tab holds (another
    // tab signed in as someone else, or the session ended), that data is forgotten BEFORE the new
    // identity is rendered. The same account refreshing keeps everything.
    queryFn: async () => {
      const next = await fetchSession();
      const previous = queryClient.getQueryData<SessionResponse | null>(SESSION_QUERY_KEY);
      if (previous && previous.user.id !== next?.user.id) forgetSessionData();
      return next;
    },
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const data = session.data;
  useEffect(() => {
    setCsrfToken(data?.csrfToken ?? null);
  }, [data]);

  // Another tab signed in, out, or changed the password: re-read the session now. (Announcements go
  // out through this same channel object, which never receives its own messages.)
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const channel = openSessionChannel();
    if (!channel) return;
    channelRef.current = channel;
    channel.onmessage = () => void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [queryClient]);
  const announceSessionChange = useCallback(() => {
    try {
      channelRef.current?.postMessage('session-changed');
    } catch {
      // Best effort: other tabs still notice on their next session refresh (focus, request).
    }
  }, []);

  const signedOut = useCallback(() => {
    setCsrfToken(null);
    forgetSessionData();
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
  }, [queryClient, forgetSessionData]);

  // Any 401 from the API (expired, revoked, deactivated) returns the app to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(signedOut);
    return () => setUnauthorizedHandler(null);
  }, [signedOut]);

  const applySession = useCallback(
    (next: SessionResponse) => {
      // Another account signing in on this tab never sees what the previous one had loaded.
      const previous = queryClient.getQueryData<SessionResponse | null>(SESSION_QUERY_KEY);
      if (previous?.user.id !== next.user.id) forgetSessionData();
      setCsrfToken(next.csrfToken);
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
      return next.user;
    },
    [queryClient, forgetSessionData],
  );

  // Permission to see purchase prices revoked (noticed on the next session refresh, or after a 403
  // on a price request): forget any price still in memory at once.
  const canSeePrices = data?.user.canViewPurchasePrices === true;
  useEffect(() => {
    if (!canSeePrices) queryClient.removeQueries({ queryKey: ['product-costs'] });
  }, [canSeePrices, queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    let status: AuthStatus = 'loading';
    if (data) status = 'authenticated';
    else if (data === null || session.isError) status = 'unauthenticated';
    return {
      status,
      user: data?.user ?? null,
      login: async (email, password) => {
        const user = applySession(await apiRequest<SessionResponse>('/auth/login', { method: 'POST', json: { email, password } }));
        announceSessionChange();
        return user;
      },
      logout: async () => {
        try {
          await apiRequest('/auth/logout', { method: 'POST' });
        } finally {
          signedOut();
          announceSessionChange();
        }
      },
      changePassword: async (currentPassword, newPassword) => {
        const user = applySession(
          await apiRequest<SessionResponse>('/auth/change-password', {
            method: 'POST',
            json: { currentPassword, newPassword },
          }),
        );
        announceSessionChange();
        return user;
      },
    };
  }, [data, session.isError, applySession, signedOut, announceSessionChange]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
