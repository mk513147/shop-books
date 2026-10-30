import { BookOpen, LayoutDashboard, ReceiptText, Truck, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Short note shown on the placeholder screen. */
  stage?: string;
}

/** Future modules are listed now so the shell is complete; their screens are placeholders. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/expenses', label: 'Expenses', icon: ReceiptText, stage: 'Expense entry and management' },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, stage: 'Suppliers, contacts and payments' },
  { to: '/customers', label: 'Customers', icon: Users, stage: 'Customer advances and dues' },
  { to: '/reports', label: 'Reports', icon: BookOpen, stage: 'Reports and Excel export' },
];
