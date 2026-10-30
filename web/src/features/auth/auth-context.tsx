import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { isShellPreviewEnabled } from '@/lib/env';

/**
 * STAGE 1 PLACEHOLDER. There is no authentication yet (Stage 2).
 *
 * - "unauthenticated": the only state in production. Protected routes always send the visitor
 *   to the login page, so no application screen is reachable.
 * - "preview": development builds only, opt-in via VITE_PREVIEW_SHELL=true, so the empty shell
 *   can be reviewed. It grants no access to data: the API has no financial endpoints yet.
 *
 * Stage 2 replaces this with a real session-backed provider using the same `useAuth()` shape.
 */
export type AuthStatus = 'unauthenticated' | 'preview';

interface AuthContextValue {
  status: AuthStatus;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, status }: { children: ReactNode; status?: AuthStatus }) {
  const resolved: AuthStatus = status ?? (isShellPreviewEnabled() ? 'preview' : 'unauthenticated');
  const value = useMemo(() => ({ status: resolved }), [resolved]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
