import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';

export const REPORT_TABS = [
  { to: '/reports/expenses', label: 'Expenses' },
  { to: '/reports/categories', label: 'Categories' },
  { to: '/reports/suppliers', label: 'Suppliers' },
  { to: '/reports/customers', label: 'Customers' },
  { to: '/reports/transactions', label: 'Transactions' },
  { to: '/reports/monthly', label: 'Monthly summary' },
] as const;

/** Report navigation: a horizontally scrollable pill row on phones (inside its own container only). */
export function ReportTabs() {
  const { user } = useAuth();
  const tabs = [...REPORT_TABS, ...(user?.role === 'owner' ? [{ to: '/reports/email', label: 'Monthly e-mail' }] : [])];
  return (
    <nav aria-label="Reports" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
      <ul className="flex w-max gap-1 rounded-xl bg-surface-muted p-1 md:w-fit md:max-w-full md:flex-wrap">
        {tabs.map((t) => (
          <li key={t.to}>
            <NavLink
              to={t.to}
              className={({ isActive }) =>
                cn(
                  'inline-flex h-10 items-center rounded-lg px-3.5 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive ? 'bg-card font-semibold text-foreground shadow-card' : 'font-medium text-muted-foreground hover:text-foreground',
                )
              }
            >
              {t.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Previous / next pagination row used by every paginated report. */
export function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-sm">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/** Filter row: stacks on phones, wraps on desktop. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center [&>*]:lg:w-auto">{children}</div>;
}
