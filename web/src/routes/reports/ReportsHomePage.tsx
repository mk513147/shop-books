import { BarChart3, CalendarDays, ChevronRight, FileSpreadsheet, ListOrdered, Mail, PieChart, Truck, Users, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/card';
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
      <ul className="grid gap-2.5 sm:grid-cols-2 md:gap-3 lg:grid-cols-3">
        {CARDS.filter((c) => !c.owner || user?.role === 'owner').map(({ to, icon: Icon, title, text }) => (
          <li key={to}>
            <Card className="surface-interactive group h-full">
              <Link
                to={to}
                className="flex h-full min-h-[4.75rem] items-center gap-3.5 rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold tracking-[-0.01em]">{title}</span>
                  <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{text}</span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground/70 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </Link>
            </Card>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <FileSpreadsheet className="mt-px size-4 shrink-0" aria-hidden="true" />
        Figures are recorded transactions only. Customer dues and advances are not sales or income.
      </p>
    </Page>
  );
}
