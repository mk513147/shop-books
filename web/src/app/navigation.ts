import { BookOpen, LayoutDashboard, ReceiptText, Tags, Truck, UserCog, Users, type LucideIcon } from 'lucide-react';
import type { Role } from '@/types/api';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Short note shown on the placeholder screen. */
  stage?: string;
  /** Restricts the item to one role (the API enforces this independently). */
  role?: Role;
  /** Module not built yet: rendered as a placeholder screen. */
  placeholder?: boolean;
  /** Shown as a tab in the phone bottom bar; everything else is under "More". */
  mobileTab?: boolean;
  /** Shorter label for the bottom bar. */
  mobileLabel?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, mobileTab: true, mobileLabel: 'Home' },
  { to: '/expenses', label: 'Expenses', icon: ReceiptText, mobileTab: true },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, mobileTab: true },
  { to: '/categories', label: 'Categories', icon: Tags },
  { to: '/customers', label: 'Customers', icon: Users, stage: 'Customer advances and dues', placeholder: true },
  { to: '/reports', label: 'Reports', icon: BookOpen, stage: 'Reports and Excel export', placeholder: true },
  { to: '/users', label: 'Users', icon: UserCog, role: 'owner' },
];

export function navItemsFor(role: Role | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.role || item.role === role);
}
