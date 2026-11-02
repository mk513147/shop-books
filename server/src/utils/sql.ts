/**
 * "Contains" pattern for ILIKE with user text matched literally: %, _ and \ are escaped.
 * Use as `col ILIKE $n ESCAPE '\'` with the result bound as a parameter.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Display label of an expense row: its description, or its category name when it has none
 * (descriptions are optional). Read-side only; never used for filtering or storage.
 */
export const expenseLabelSql = (alias: string): string =>
  `COALESCE(${alias}.description, (SELECT xc.name FROM expense_categories xc WHERE xc.id = ${alias}.category_id))`;
