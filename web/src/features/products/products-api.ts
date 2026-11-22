import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api-client';
import { useConfidentialMutation } from './useConfidentialMutation';
import type {
  AuditHistoryEntry,
  EffectiveCost,
  Product,
  ProductCosts,
  ProductInput,
  ProductListResponse,
  ProductSupplierLink,
  QuickSearchItem,
  SimilarProduct,
} from '@/types/api';

/**
 * Product catalogue API hooks.
 *
 * Two query-key roots on purpose:
 *   ['products', …]       ordinary catalogue data (never contains purchase prices); refreshed by
 *                         live updates;
 *   ['product-costs', …]  purchase prices AND purchase-price history, fetched ONLY while revealed,
 *                         never kept after hiding (gcTime 0 + removeQueries), never retried, never
 *                         refetched by live updates, removed on sign-out and when the permission
 *                         is revoked. Every fetch is recorded server-side (access trail).
 */

export const PRODUCT_COSTS_ROOT = 'product-costs';

/** Removes every cached purchase price from memory (used when prices are hidden again). */
export function forgetPurchasePrices(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: [PRODUCT_COSTS_ROOT] });
}

/** A value that settles `ms` after the last change (search-as-you-type). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface ProductListParams {
  q?: string | undefined;
  brandId?: string | undefined;
  categoryId?: string | undefined;
  status?: string | undefined;
  sort?: string | undefined;
  dir?: string | undefined;
  page?: number;
  pageSize?: number;
}

export function productQueryString(params: ProductListParams): string {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}

/** Catalogue list. A newer search cancels the older request (TanStack passes the AbortSignal). */
export function useProducts(params: ProductListParams) {
  const search = productQueryString(params);
  return useQuery({
    queryKey: ['products', 'list', search],
    queryFn: ({ signal }) => apiRequest<ProductListResponse>(`/products?${search}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** Minimum characters before searching: 2, or 1 when it is a digit (codes). */
export const searchable = (q: string) => {
  const t = q.trim();
  return t.length >= 2 || /^\d$/.test(t);
};

export function useQuickSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['products', 'quick', term],
    queryFn: ({ signal }) =>
      apiRequest<{ items: QuickSearchItem[]; hasMore: boolean }>(`/products/quick-search?${new URLSearchParams({ q: term, limit: '10' })}`, { signal }),
    enabled: searchable(term),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export async function lookupByCode(code: string, signal?: AbortSignal): Promise<Product[]> {
  return (await apiRequest<{ products: Product[] }>(`/products/lookup?${new URLSearchParams({ code })}`, { signal })).products;
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: ['products', 'detail', id],
    queryFn: ({ signal }) => apiRequest<{ product: Product }>(`/products/${id}`, { signal }).then((r) => r.product),
  });
}

/** Product + supplier-link history (never purchase prices: those come from useProductCostHistory). */
export function useProductHistory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['products', 'history', id],
    queryFn: ({ signal }) => apiRequest<{ history: AuditHistoryEntry[] }>(`/products/${id}/history`, { signal }).then((r) => r.history),
    enabled,
  });
}

export function useSimilarProducts(params: { name: string; brandId: string | null; size: string; pageCount: string; gsm: string; binding: string; excludeId?: string | undefined }) {
  const name = params.name.trim();
  const query = new URLSearchParams({ name });
  if (params.brandId) query.set('brandId', params.brandId);
  if (params.size.trim()) query.set('size', params.size.trim());
  if (/^\d+$/.test(params.pageCount)) query.set('pageCount', params.pageCount);
  if (/^\d+$/.test(params.gsm)) query.set('gsm', params.gsm);
  if (params.binding.trim()) query.set('binding', params.binding.trim());
  if (params.excludeId) query.set('excludeId', params.excludeId);
  const search = query.toString();
  return useQuery({
    queryKey: ['products', 'similar', search],
    queryFn: ({ signal }) => apiRequest<{ similar: SimilarProduct[] }>(`/products/similar?${search}`, { signal }).then((r) => r.similar),
    enabled: name.length >= 2,
    staleTime: 30_000,
  });
}

const NOTHING_PUBLIC = () => ({});

/** Creates a product. The input may hold a default purchase price: never kept in the mutation cache. */
export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useConfidentialMutation({
    mutationFn: async ({ input, idempotencyKey }: { input: ProductInput & { defaultPurchasePrice?: string | null }; idempotencyKey: string }) => {
      // The answer never contains a purchase price.
      const { product } = await apiRequest<{ product: Product }>('/products', { method: 'POST', json: input, headers: { 'Idempotency-Key': idempotencyKey } });
      queryClient.setQueryData(['products', 'detail', product.id], product);
      return product;
    },
    publicPart: NOTHING_PUBLIC,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['brands'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<ProductInput> & { id: string; version: number; isActive?: boolean }) =>
      apiRequest<{ product: Product }>(`/products/${id}`, { method: 'PATCH', json: body }).then((r) => r.product),
    onSuccess: (product) => queryClient.setQueryData(['products', 'detail', product.id], product),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['brands'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
  });
}

// --- Supplier links ------------------------------------------------------------------------------------

export function useProductSuppliers(id: string) {
  return useQuery({
    queryKey: ['products', 'suppliers', id],
    queryFn: ({ signal }) => apiRequest<{ suppliers: ProductSupplierLink[] }>(`/products/${id}/suppliers`, { signal }).then((r) => r.suppliers),
  });
}

export function useSupplierSuggestions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['products', 'supplier-suggestions', id],
    queryFn: ({ signal }) =>
      apiRequest<{ suppliers: { id: string; name: string; phone: string | null }[] }>(`/products/${id}/supplier-suggestions`, { signal }).then((r) => r.suppliers),
    enabled,
  });
}

const LINK_PUBLIC = ({ supplierId }: { supplierId: string }) => ({ supplierId });

/**
 * Supplier-link writes. Their input may hold a supplier purchase price, so it is never kept in the
 * mutation cache (only the supplier id, for the row's spinner); the answers never hold prices.
 */
function useLinkMutation<TVars extends { supplierId: string }>(fn: (vars: TVars) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useConfidentialMutation({
    mutationFn: async (vars: TVars) => {
      await fn(vars);
    },
    publicPart: LINK_PUBLIC,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      // Supplier prices may have changed. Prices shown right now (revealed) refetch; hidden ones
      // are not cached at all (gcTime 0), so nothing stale can be shown later.
      void queryClient.invalidateQueries({ queryKey: [PRODUCT_COSTS_ROOT] });
    },
  });
}

export interface LinkInput {
  supplierId: string;
  supplierProductCode: string | null;
  notes: string | null;
  isPreferred: boolean;
  purchasePrice?: string | null;
}

export const useLinkSupplier = (productId: string) =>
  useLinkMutation((input: LinkInput) => apiRequest(`/products/${productId}/suppliers`, { method: 'POST', json: input }));

export const useUpdateSupplierLink = (productId: string) =>
  useLinkMutation(({ supplierId, ...body }: Partial<LinkInput> & { supplierId: string; version: number }) =>
    apiRequest(`/products/${productId}/suppliers/${supplierId}`, { method: 'PATCH', json: body }),
  );

/** Unlink with the version the user saw: a link changed by someone else meanwhile answers 409. */
export const useUnlinkSupplier = (productId: string) =>
  useLinkMutation(({ supplierId, version }: { supplierId: string; version: number }) =>
    apiRequest(`/products/${productId}/suppliers/${supplierId}?${new URLSearchParams({ version: String(version) })}`, { method: 'DELETE' }),
  );

// --- Purchase prices (protected) ------------------------------------------------------------------------

/** One page's prices, fetched only while `enabled` (revealed). Never cached after use. */
export function usePagePurchasePrices(ids: string[], enabled: boolean) {
  const key = [...ids].sort().join(',');
  return useQuery({
    queryKey: [PRODUCT_COSTS_ROOT, 'page', key],
    queryFn: ({ signal }) =>
      apiRequest<{ prices: EffectiveCost[] }>(`/products/purchase-prices?${new URLSearchParams({ ids: key, scope: 'page' })}`, { signal }).then((r) => r.prices),
    enabled: enabled && ids.length > 0,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}

export function useProductCosts(id: string, enabled: boolean, scope: 'product' | 'form' = 'product') {
  return useQuery({
    queryKey: [PRODUCT_COSTS_ROOT, 'product', id],
    queryFn: ({ signal }) => apiRequest<{ costs: ProductCosts }>(`/products/${id}/costs?scope=${scope}`, { signal }).then((r) => r.costs),
    enabled,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}

/** Purchase-price history of one product (protected; fetched only while revealed; never kept). */
export function useProductCostHistory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [PRODUCT_COSTS_ROOT, 'history', id],
    queryFn: ({ signal }) => apiRequest<{ history: AuditHistoryEntry[] }>(`/products/${id}/cost-history`, { signal }).then((r) => r.history),
    enabled,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}

/** True while some screen is showing this cost query (i.e. prices are revealed right now). */
function isCostQueryShown(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
  return (queryClient.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() ?? 0) > 0;
}

/**
 * Sets the default purchase price. Neither the typed price nor the answer (every price of the
 * product) is kept in the mutation cache: the answer goes only into the price query on screen.
 */
export function useSetDefaultCost(productId: string) {
  const queryClient = useQueryClient();
  return useConfidentialMutation({
    mutationFn: async (body: { defaultPurchasePrice: string | null; version: number }): Promise<void> => {
      const { costs } = await apiRequest<{ costs: ProductCosts }>(`/products/${productId}/costs`, { method: 'PUT', json: body });
      // Only into a query that is on screen: if the prices were hidden (or the screen left) while
      // the save was in flight, the answer must not put them back into memory.
      const key = [PRODUCT_COSTS_ROOT, 'product', productId];
      if (isCostQueryShown(queryClient, key)) queryClient.setQueryData(key, costs);
    },
    publicPart: NOTHING_PUBLIC,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['products', 'history', productId] });
      void queryClient.invalidateQueries({ queryKey: [PRODUCT_COSTS_ROOT, 'history', productId] });
    },
  });
}
