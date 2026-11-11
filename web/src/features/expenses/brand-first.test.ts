import { describe, expect, it } from 'vitest';
import { categoriesModified, defaultCategoryIds, planSupplierForBrand, type BrandSupplierOption } from './brand-first';

const s = (id: string): BrandSupplierOption => ({
  id,
  name: id.toUpperCase(),
  phone: null,
  isActive: true,
  categories: [
    { id: `${id}-c`, name: 'Active', isActive: true },
    { id: `${id}-old`, name: 'Archived', isActive: false },
  ],
});

describe('brand-first supplier rules', () => {
  it('one supplier: selected automatically (or kept when it is already chosen)', () => {
    expect(planSupplierForBrand(null, [s('a')])).toEqual({ kind: 'auto', supplier: s('a') });
    expect(planSupplierForBrand('x', [s('a')])).toEqual({ kind: 'auto', supplier: s('a') });
    expect(planSupplierForBrand('a', [s('a')])).toEqual({ kind: 'keep' });
  });
  it('several suppliers: a compatible choice is kept, otherwise the user must choose', () => {
    expect(planSupplierForBrand('b', [s('a'), s('b')])).toEqual({ kind: 'keep' });
    expect(planSupplierForBrand(null, [s('a'), s('b')])).toEqual({ kind: 'choose' });
    expect(planSupplierForBrand('x', [s('a'), s('b')])).toEqual({ kind: 'choose' });
  });
  it('no supplier: continue without one', () => {
    expect(planSupplierForBrand(null, [])).toEqual({ kind: 'none' });
    expect(planSupplierForBrand('x', [])).toEqual({ kind: 'none' });
  });
  it('only active default categories; hand-picked categories are detected', () => {
    expect(defaultCategoryIds(s('a'))).toEqual(['a-c']);
    expect(categoriesModified([], null)).toBe(false);
    expect(categoriesModified(['x'], null)).toBe(true);
    expect(categoriesModified(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(categoriesModified(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
  });
});
