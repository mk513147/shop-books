import { BadgeCheck, BookOpen, Factory, LayoutDashboard, ReceiptText, Tags, Truck, UserCog, Users, Wallet, type LucideIcon } from 'lucide-react';
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
  /** Sidebar section the item is listed under. */
  group: NavGroup;
}

export type NavGroup = 'Overview' | 'Records' | 'People' | 'Setup';
export const NAV_GROUPS: NavGroup[] = ['Overview', 'Records', 'People', 'Setup'];

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, mobileTab: true, mobileLabel: 'Home', group: 'Overview' },
  { to: '/expenses', label: 'Expenses', icon: ReceiptText, mobileTab: true, group: 'Records' },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, mobileTab: true, group: 'People' },
  { to: '/supplier-payments', label: 'Supplier payments', icon: Wallet, group: 'Records' },
  { to: '/categories', label: 'Categories', icon: Tags, group: 'Setup' },
  { to: '/brands', label: 'Brands', icon: Factory, group: 'Setup' },
  { to: '/customers', label: 'Customers', icon: Users, group: 'People' },
  { to: '/salesmen', label: 'Salesmen', icon: BadgeCheck, group: 'People' },
  { to: '/reports', label: 'Reports', icon: BookOpen, group: 'Overview' },
  { to: '/users', label: 'Users', icon: UserCog, role: 'owner', group: 'Setup' },
];

export function navItemsFor(role: Role | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.role || item.role === role);
}
