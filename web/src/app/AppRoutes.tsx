import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute, RequireRole } from '@/components/layout/ProtectedRoute';
import { BrandsPage } from '@/routes/BrandsPage';
import { CategoriesPage } from '@/routes/CategoriesPage';
import { ChangePasswordPage } from '@/routes/ChangePasswordPage';
import { CustomerDetailPage } from '@/routes/CustomerDetailPage';
import { CustomerLedgerPage } from '@/routes/CustomerLedgerPage';
import { CustomersPage } from '@/routes/CustomersPage';
import { CustomerTransactionPage } from '@/routes/CustomerTransactionPage';
import { SalesmanDetailPage } from '@/routes/SalesmanDetailPage';
import { SalesmenPage } from '@/routes/SalesmenPage';
import { DashboardPage } from '@/routes/DashboardPage';
import { ExpenseDetailPage } from '@/routes/ExpenseDetailPage';
import { EditExpensePage, NewExpensePage } from '@/routes/ExpenseFormPage';
import { ExpensesPage } from '@/routes/ExpensesPage';
import { LoginPage } from '@/routes/LoginPage';
import { NotFoundPage } from '@/routes/NotFoundPage';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { CategoryReportPage } from '@/routes/reports/CategoryReportPage';
import { CustomerReportPage } from '@/routes/reports/CustomerReportPage';
import { ExpenseReportPage } from '@/routes/reports/ExpenseReportPage';
import { MonthlyEmailPage } from '@/routes/reports/MonthlyEmailPage';
import { MonthlySummaryPage } from '@/routes/reports/MonthlySummaryPage';
import { ReportsHomePage } from '@/routes/reports/ReportsHomePage';
import { SupplierReportPage } from '@/routes/reports/SupplierReportPage';
import { TransactionsReportPage } from '@/routes/reports/TransactionsReportPage';
import { SupplierDetailPage } from '@/routes/SupplierDetailPage';
import { SupplierLedgerPage } from '@/routes/SupplierLedgerPage';
import { SupplierPaymentDetailPage } from '@/routes/SupplierPaymentDetailPage';
import { NewSupplierPaymentPage } from '@/routes/SupplierPaymentFormPage';
import { SupplierPaymentsPage } from '@/routes/SupplierPaymentsPage';
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
          <Route path="/brands" element={<BrandsPage />} />
          <Route path="/suppliers" element={<SuppliersPage />} />
          <Route path="/suppliers/:id" element={<SupplierDetailPage />} />
          <Route path="/suppliers/:id/ledger" element={<SupplierLedgerPage />} />
          <Route path="/supplier-payments" element={<SupplierPaymentsPage />} />
          <Route path="/supplier-payments/new" element={<NewSupplierPaymentPage />} />
          <Route path="/supplier-payments/:id" element={<SupplierPaymentDetailPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
          <Route path="/customers/:id/ledger" element={<CustomerLedgerPage />} />
          <Route path="/customers/:id/transactions/:txnId" element={<CustomerTransactionPage />} />
          <Route path="/salesmen" element={<SalesmenPage />} />
          <Route path="/salesmen/:id" element={<SalesmanDetailPage />} />
          <Route path="/reports" element={<ReportsHomePage />} />
          <Route path="/reports/expenses" element={<ExpenseReportPage />} />
          <Route path="/reports/categories" element={<CategoryReportPage />} />
          <Route path="/reports/suppliers" element={<SupplierReportPage />} />
          <Route path="/reports/customers" element={<CustomerReportPage />} />
          <Route path="/reports/transactions" element={<TransactionsReportPage />} />
          <Route path="/reports/monthly" element={<MonthlySummaryPage />} />
          {NAV_ITEMS.filter((item) => item.placeholder).map((item) => (
            <Route
              key={item.to}
              path={item.to}
              element={<PlaceholderPage title={item.label} description={item.stage ?? ''} />}
            />
          ))}
          <Route element={<RequireRole role="owner" />}>
            <Route path="/users" element={<UsersPage />} />
            <Route path="/reports/email" element={<MonthlyEmailPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
