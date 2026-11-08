import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Primary label of an expense: its description, or its category name when it has none. */
/**
 * Main text of an expense row: its description; without one, its first (primary) category. The
 * other categories are deliberately not listed here (see categorySummary / the details page).
 */
export function expenseLabel(expense: { description: string | null; category: { name: string } }): string {
  return expense.description?.trim() ? expense.description : expense.category.name;
}

/** Compact category text for list rows: "Transport" or "Transport +2" (never a long list). */
export function categorySummary(expense: { category: { name: string }; categories?: { name: string }[] }): string {
  const extra = (expense.categories?.length ?? 1) - 1;
  return extra > 0 ? `${expense.category.name} +${extra}` : expense.category.name;
}
