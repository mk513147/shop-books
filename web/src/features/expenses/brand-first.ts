import type { ClassRef } from '@/types/api';

/** A supplier offered for the chosen brand (GET /brands/:id/suppliers): active, with active default categories. */
export interface BrandSupplierOption {
  id: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  categories: ClassRef[];
}

/**
 * What happens to the supplier when a brand is chosen (brand-first expense entry):
 *  - keep:   the current supplier stays (it supplies the brand, or there is nothing to change);
 *  - auto:   the brand has exactly ONE supplier: it is selected automatically;
 *  - choose: the brand has several suppliers and the current one is not among them (or none is
 *            chosen): the user must pick one;
 *  - none:   the brand has no suppliers: the expense continues without one.
 */
export type SupplierPlan =
  | { kind: 'keep' }
  | { kind: 'auto'; supplier: BrandSupplierOption }
  | { kind: 'choose' }
  | { kind: 'none' };

export function planSupplierForBrand(currentSupplierId: string | null, options: BrandSupplierOption[]): SupplierPlan {
  if (options.length === 1) return options[0]!.id === currentSupplierId ? { kind: 'keep' } : { kind: 'auto', supplier: options[0]! };
  if (options.length === 0) return { kind: 'none' };
  if (currentSupplierId !== null && options.some((o) => o.id === currentSupplierId)) return { kind: 'keep' };
  return { kind: 'choose' };
}

/** A supplier's ACTIVE default categories (archived ones are never auto-selected). */
export const defaultCategoryIds = (s: { categories: ClassRef[] }): string[] => s.categories.filter((c) => c.isActive).map((c) => c.id);

export const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Were the selected categories chosen by hand? They were not if nothing is selected or they are
 * exactly the defaults applied automatically for the current supplier.
 */
export function categoriesModified(current: string[], autoApplied: string[] | null): boolean {
  if (current.length === 0) return false;
  return !(autoApplied !== null && sameSet(current, autoApplied));
}
