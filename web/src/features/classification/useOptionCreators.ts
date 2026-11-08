import { useState } from 'react';
import { errorMessage } from '@/components/states';
import type { MultiSelectOption } from '@/components/ui/multi-select';
import { useBrands, useCreateBrand } from '@/features/brands/brands-api';
import { useCategories, useCreateCategory } from '@/features/categories/categories-api';
import { ApiError } from '@/lib/api-client';
import type { Category } from '@/types/api';

type Note = { text: string; error: boolean } | null;

interface Creator {
  create: (name: string) => Promise<MultiSelectOption | null>;
  creating: boolean;
  note: Note;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Inline creation of a GLOBAL category, using the normal category rules (POST /categories). An
 * existing active name (any letter case) is selected instead of creating a duplicate; a name taken
 * a moment ago by someone else is picked up after a refresh.
 */
export function useCategoryCreator(): Creator {
  const categories = useCategories('active');
  const create = useCreateCategory();
  const [note, setNote] = useState<Note>(null);
  return {
    creating: create.isPending,
    note,
    create: async (name) => {
      const existing = categories.data?.find((c) => same(c.name, name));
      if (existing) {
        setNote({ text: `“${existing.name}” already exists, so it was selected.`, error: false });
        return existing;
      }
      try {
        const { category } = (await create.mutateAsync({ name, description: null })) as { category: Category };
        setNote({ text: `Created category “${category.name}” (available everywhere) and selected it.`, error: false });
        return category;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'CATEGORY_NAME_TAKEN') {
          const fresh = (await categories.refetch()).data?.find((c) => same(c.name, name));
          if (fresh) {
            setNote({ text: `“${fresh.name}” already exists, so it was selected.`, error: false });
            return fresh;
          }
        }
        setNote({ text: errorMessage(err), error: true });
        return null;
      }
    },
  };
}

/** Inline creation of a brand (POST /brands), with the same "existing name is selected" rule. */
export function useBrandCreator(): Creator {
  const brands = useBrands('active');
  const create = useCreateBrand();
  const [note, setNote] = useState<Note>(null);
  return {
    creating: create.isPending,
    note,
    create: async (name) => {
      const existing = brands.data?.find((b) => same(b.name, name));
      if (existing) {
        setNote({ text: `“${existing.name}” already exists, so it was selected.`, error: false });
        return existing;
      }
      try {
        const brand = await create.mutateAsync({ name });
        setNote({ text: `Created brand “${brand.name}” and selected it.`, error: false });
        return brand;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'BRAND_NAME_TAKEN') {
          const fresh = (await brands.refetch()).data?.find((b) => same(b.name, name));
          if (fresh) {
            setNote({ text: `“${fresh.name}” already exists, so it was selected.`, error: false });
            return fresh;
          }
        }
        setNote({ text: errorMessage(err), error: true });
        return null;
      }
    },
  };
}
