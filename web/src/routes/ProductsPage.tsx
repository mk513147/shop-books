import { ChevronLeft, ChevronRight, Eye, EyeOff, Package, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/features/auth/auth-context';
import { useBrands } from '@/features/brands/brands-api';
import { useCategories } from '@/features/categories/categories-api';
import { PurchasePriceValue, specSummary, unitSummary } from '@/features/products/product-display';
import { usePagePurchasePrices, useProducts, useDebouncedValue } from '@/features/products/products-api';
import { useHidePricesOnError, usePurchasePriceReveal } from '@/features/products/usePurchasePriceReveal';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';

const SORTS: { value: string; label: string }[] = [
  { value: '', label: 'Best match / name' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'brand', label: 'Brand' },
  { value: 'selling_price', label: 'Selling price: low to high' },
  { value: 'selling_price:desc', label: 'Selling price: high to low' },
  { value: 'mrp', label: 'MRP' },
  { value: 'updated', label: 'Recently changed' },
];

/** Debounce for the catalogue search (the URL is updated when typing pauses). */
export const CATALOGUE_DEBOUNCE_MS = 250;

export function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canSeeCosts = user?.canViewPurchasePrices === true;
  const get = (k: string) => params.get(k) ?? '';
  const page = Math.max(1, Number(get('page')) || 1);
  const [search, setSearch] = useState(get('q'));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortValue, dirValue] = get('sort').split(':');

  function update(next: Record<string, string>, replace = false) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (!('page' in next)) merged.delete('page');
    setParams(merged, { replace });
  }

  // Search as you type: the URL (and the request) follows when typing pauses; Enter is immediate.
  const debounced = useDebouncedValue(search, CATALOGUE_DEBOUNCE_MS);
  const lastPushed = useRef(get('q'));
  useEffect(() => {
    const next = debounced.trim();
    if (next !== lastPushed.current) {
      lastPushed.current = next;
      update({ q: next }, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const list = useProducts({
    q: get('q') || undefined,
    brandId: get('brand') || undefined,
    categoryId: get('category') || undefined,
    status: get('status') || 'active',
    sort: sortValue || undefined,
    dir: dirValue || undefined,
    page,
    pageSize: 25,
  });
  const brands = useBrands('all');
  const categories = useCategories('all');
  const productCategories = useMemo(() => (categories.data ?? []).filter((c) => c.isProductUsable || c.productCount > 0), [categories.data]);

  const items = list.data?.items ?? [];
  const ids = items.map((p) => p.id);
  // Prices hide again whenever the visible set of products changes.
  const signature = `${params.toString()}|${ids.join(',')}`;
  const reveal = usePurchasePriceReveal(signature);
  const prices = usePagePurchasePrices(ids, canSeeCosts && reveal.revealed);
  useHidePricesOnError(prices.error, reveal.hide);
  const costOf = (id: string) => prices.data?.find((c) => c.productId === id)?.effectivePurchasePrice ?? null;
  const filterCount = ['brand', 'category', 'status', 'sort'].filter((k) => get(k)).length;

  const revealButton = canSeeCosts && items.length > 0 && (
    <Button
      variant={reveal.revealed ? 'soft' : 'outline'}
      size="sm"
      className="h-10 md:h-9"
      aria-pressed={reveal.revealed}
      onClick={() => (reveal.revealed ? reveal.hide() : reveal.reveal())}
    >
      {reveal.revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      {reveal.revealed ? 'Hide purchase prices' : 'Show purchase prices'}
    </Button>
  );

  const filters = (
    <>
      <Select aria-label="Brand" value={get('brand')} onChange={(e) => update({ brand: e.target.value })}>
        <option value="">All brands</option>
        <option value="none">No brand</option>
        {(brands.data ?? []).map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.isActive ? '' : ' (archived)'}
          </option>
        ))}
      </Select>
      <Select aria-label="Category" value={get('category')} onChange={(e) => update({ category: e.target.value })}>
        <option value="">All categories</option>
        {productCategories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select aria-label="Status" value={get('status') || 'active'} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value })}>
        <option value="active">Active products</option>
        <option value="inactive">Deactivated</option>
        <option value="all">All</option>
      </Select>
      <Select aria-label="Sort" value={get('sort')} onChange={(e) => update({ sort: e.target.value })}>
        {SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </Select>
    </>
  );

  return (
    <Page>
      <PageHeader
        title="Products"
        description="Catalogue of what the shop sells: brands, specifications and prices."
        actions={
          // Products are added by hand (Excel import is postponed: docs/products.md).
          <Button onClick={() => navigate('/products/new')}>
            <Plus aria-hidden="true" /> Add product
          </Button>
        }
      />

      <div className="space-y-2">
        <form
          role="search"
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            lastPushed.current = search.trim();
            update({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search products"
            placeholder="Search name, brand, size, pages, code…"
            enterKeyHint="search"
            autoComplete="off"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <div className="hidden gap-2 md:grid md:grid-cols-4">{filters}</div>
        <div className="flex items-center justify-between gap-2 md:hidden">
          <Button variant="outline" size="sm" className="h-10" onClick={() => setFiltersOpen(true)}>
            <SlidersHorizontal aria-hidden="true" /> Filters{filterCount ? ` (${filterCount})` : ''}
          </Button>
          {revealButton}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span aria-live="polite">
          {list.data ? `${list.data.pagination.total} product${list.data.pagination.total === 1 ? '' : 's'}` : ' '}
          {list.data?.closeMatches && ' · no exact match; showing close matches'}
        </span>
        <span className="hidden md:inline-flex">{revealButton}</span>
      </div>
      {reveal.revealed && (
        <p role="status" className="callout callout-info flex items-center justify-between gap-2">
          <span>Purchase prices are visible on this page. They hide again when you leave, change page or search.</span>
          <Button size="sm" variant="ghost" onClick={reveal.hide}>
            <EyeOff aria-hidden="true" /> Hide
          </Button>
        </p>
      )}

      {list.isPending && <LoadingState label="Loading products…" skeleton="table" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && items.length === 0 && (
        <EmptyState
          icon={Package}
          title={get('q') ? 'No products match' : 'No products here'}
          action={
            !get('q') && (
              <Button onClick={() => navigate('/products/new')}>
                <Plus aria-hidden="true" /> Add product
              </Button>
            )
          }
        >
          {get('q') ? 'Try fewer words, a brand name, or a size like “A4 140”.' : 'Add each product with its brand, specifications and prices. Then use quick lookup (F4) at the counter.'}
        </EmptyState>
      )}

      {list.isSuccess && items.length > 0 && (
        <>
          <ul className={cn('space-y-2 md:hidden', list.isPlaceholderData && 'opacity-70')}>
            {items.map((p) => (
              <li key={p.id}>
                <Link to={`/products/${p.id}`} className={cn('list-card', !p.isActive && 'opacity-80')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-semibold">
                        {p.brand && <span className="text-muted-foreground">{p.brand.name} </span>}
                        {p.name}
                      </p>
                      <p className="text-sm text-muted-foreground">{[specSummary(p), unitSummary(p)].filter(Boolean).join(' · ') || p.category.name}</p>
                      {!p.isActive && <Badge className="mt-1">Deactivated</Badge>}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="figure text-lg font-semibold">{formatInr(p.sellingPrice)}</p>
                      {p.mrp && <p className="figure text-xs text-muted-foreground">MRP {formatInr(p.mrp)}</p>}
                      {canSeeCosts && reveal.revealed && <PurchasePriceValue className="mt-1" revealed loading={prices.isPending} value={costOf(p.id)} />}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className={cn('table-shell hidden md:block', list.isPlaceholderData && 'opacity-70')}>
            <table className="data-table">
              <thead>
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-3 py-3">Specifications</th>
                  <th className="px-3 py-3">Category</th>
                  <th className="px-3 py-3 text-right">MRP</th>
                  <th className="px-3 py-3 text-right">Selling price</th>
                  {canSeeCosts && (
                    <th className={cn('px-3 py-3 text-right', reveal.revealed && 'bg-info-soft')}>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-pressed={reveal.revealed}
                        aria-label={reveal.revealed ? 'Hide purchase prices' : 'Show purchase prices for this page'}
                        onClick={() => (reveal.revealed ? reveal.hide() : reveal.reveal())}
                      >
                        Purchase {reveal.revealed ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
                      </button>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className={cn('cursor-pointer', !p.isActive && 'text-muted-foreground')} onClick={() => navigate(`/products/${p.id}`)}>
                    <td className="px-4 py-3">
                      <Link to={`/products/${p.id}`} className="font-semibold text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
                        {p.brand && <span className="font-normal text-muted-foreground">{p.brand.name} </span>}
                        {p.name}
                      </Link>
                      {!p.isActive && <Badge className="ml-2">Deactivated</Badge>}
                      {(p.sku || p.barcode) && <p className="text-xs text-muted-foreground">{[p.sku, p.barcode].filter(Boolean).join(' · ')}</p>}
                    </td>
                    <td className="px-3 py-3 text-sm">{[specSummary(p), unitSummary(p)].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-3 text-sm">{p.category.name}</td>
                    <td className="figure whitespace-nowrap px-3 py-3 text-right text-muted-foreground">{p.mrp ? formatInr(p.mrp) : '—'}</td>
                    <td className="figure whitespace-nowrap px-3 py-3 text-right text-base font-semibold">{formatInr(p.sellingPrice)}</td>
                    {canSeeCosts && (
                      <td className={cn('whitespace-nowrap px-3 py-3 text-right', reveal.revealed && 'bg-info-soft/40')}>
                        <PurchasePriceValue revealed={reveal.revealed} loading={prices.isPending} value={costOf(p.id)} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {list.data.pagination.totalPages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
                <ChevronLeft aria-hidden="true" /> Previous
              </Button>
              <span className="text-muted-foreground">
                Page {list.data.pagination.page} of {list.data.pagination.totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= list.data.pagination.totalPages} onClick={() => update({ page: String(page + 1) })}>
                Next <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}

      <Dialog open={filtersOpen} title="Filters" onClose={() => setFiltersOpen(false)} size="sm">
        <div className="grid gap-3">{filters}</div>
      </Dialog>
    </Page>
  );
}
