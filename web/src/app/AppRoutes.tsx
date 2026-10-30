import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute, RequireRole } from '@/components/layout/ProtectedRoute';
import { ChangePasswordPage } from '@/routes/ChangePasswordPage';
import { DashboardPage } from '@/routes/DashboardPage';
import { LoginPage } from '@/routes/LoginPage';
import { NotFoundPage } from '@/routes/NotFoundPage';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { UsersPage } from '@/routes/UsersPage';
import { NAV_ITEMS } from './navigation';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          {NAV_ITEMS.filter((item) => item.placeholder).map((item) => (
            <Route
              key={item.to}
              path={item.to}
              element={<PlaceholderPage title={item.label} description={item.stage ?? ''} />}
            />
          ))}
          <Route element={<RequireRole role="owner" />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
