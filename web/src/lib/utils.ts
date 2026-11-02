import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Primary label of an expense: its description, or its category name when it has none. */
export function expenseLabel(expense: { description: string | null; category: { name: string } }): string {
  return expense.description?.trim() ? expense.description : expense.category.name;
}
