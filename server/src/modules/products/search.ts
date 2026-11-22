/**
 * Product search text handling. MUST match the SQL function product_search_norm (migration 0015):
 * lower case, every run of non-alphanumeric characters becomes one space, trimmed. Parity between
 * the two is covered by tests (products.search.integration.test.ts).
 */
export function normaliseSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Most tokens used from one search (a longer query is rarely intentional and costs more). */
export const MAX_SEARCH_TOKENS = 8;

/** Distinct tokens of a search, in typed order. */
export function searchTokens(text: string): string[] {
  const normalised = normaliseSearchText(text);
  if (!normalised) return [];
  return [...new Set(normalised.split(' '))].slice(0, MAX_SEARCH_TOKENS);
}

/** Escapes LIKE wildcards (%, _ and \); use with ESCAPE '\'. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const isNumericToken = (token: string): boolean => /^[0-9]+$/.test(token);

/** Tokens long enough for typo-tolerant (trigram word-similarity) matching. */
export const FUZZY_MIN_TOKEN_LENGTH = 4;
