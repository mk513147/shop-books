import { BarChart3, CalendarDays, FileSpreadsheet, ListOrdered, Mail, PieChart, Truck, Users, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/features/auth/auth-context';

const CARDS: { to: string; icon: LucideIcon; title: string; text: string; owner?: boolean }[] = [
  { to: '/reports/expenses', icon: BarChart3, title: 'Expense report', text: 'Totals, paid vs unpaid, payment modes, monthly trend' },
  { to: '/reports/categories', icon: PieChart, title: 'Category analysis', text: 'Where the money goes, compared with the previous period' },
  { to: '/reports/suppliers', icon: Truck, title: 'Supplier report', text: 'Payable, payments and unallocated amounts per supplier' },
  { to: '/reports/customers', icon: Users, title: 'Customer reports', text: 'Customer dues and customer advances, kept separate' },
  { to: '/reports/transactions', icon: ListOrdered, title: 'Transaction history', text: 'Every expense, payment and customer entry' },
  { to: '/reports/monthly', icon: CalendarDays, title: 'Monthly summary', text: 'One month at a glance; the same as the monthly e-mail' },
  { to: '/reports/email', icon: Mail, title: 'Monthly e-mail', text: 'Recipients, schedule and delivery history', owner: true },
];

export function ReportsHomePage() {
  const { user } = useAuth();
  return (
    <Page>
      <PageHeader title="Reports" description="Read-only analysis of recorded transactions. Every report can be downloaded as an Excel file." />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.filter((c) => !c.owner || user?.role === 'owner').map(({ to, icon: Icon, title, text }) => (
          <li key={to}>
            <Link to={to} className="flex h-full items-start gap-3 rounded-xl border bg-card p-4 shadow-card transition-colors hover:bg-accent">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span>
                <span className="block font-medium">{title}</span>
                <span className="block text-sm text-muted-foreground">{text}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileSpreadsheet className="size-4" aria-hidden="true" />
        Figures are recorded transactions only. Customer dues and advances are not sales or income.
      </p>
    </Page>
  );
}
