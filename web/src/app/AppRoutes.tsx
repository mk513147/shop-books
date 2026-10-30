import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute, RequireRole } from '@/components/layout/ProtectedRoute';
import { CategoriesPage } from '@/routes/CategoriesPage';
import { ChangePasswordPage } from '@/routes/ChangePasswordPage';
import { DashboardPage } from '@/routes/DashboardPage';
import { ExpenseDetailPage } from '@/routes/ExpenseDetailPage';
import { EditExpensePage, NewExpensePage } from '@/routes/ExpenseFormPage';
import { ExpensesPage } from '@/routes/ExpensesPage';
import { LoginPage } from '@/routes/LoginPage';
import { NotFoundPage } from '@/routes/NotFoundPage';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { SuppliersPage } from '@/routes/SuppliersPage';
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
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/expenses/new" element={<NewExpensePage />} />
          <Route path="/expenses/:id" element={<ExpenseDetailPage />} />
          <Route path="/expenses/:id/edit" element={<EditExpensePage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/suppliers" element={<SuppliersPage />} />
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
