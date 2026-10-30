import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LoadingState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import type { Role } from '@/types/api';

/**
 * Gate for every application screen. While the session is being checked nothing protected is
 * rendered; signed-out visitors go to the login page; a pending temporary password forces the
 * change-password screen. (The API enforces all of this independently.)
 */
export function ProtectedRoute() {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }
  if (status === 'unauthenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <Outlet />;
}

/** Hides owner-only screens from managers (the API returns 403 for them regardless). */
export function RequireRole({ role }: { role: Role }) {
  const { user } = useAuth();
  if (user?.role !== role) {
    return (
      <div role="alert" className="mx-auto max-w-2xl space-y-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Not available</h1>
        <p className="text-sm text-muted-foreground">Only the owner can open this page.</p>
      </div>
    );
  }
  return <Outlet />;
}
