/**
 * "Contains" pattern for ILIKE with user text matched literally: %, _ and \ are escaped.
 * Use as `col ILIKE $n ESCAPE '\'` with the result bound as a parameter.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
