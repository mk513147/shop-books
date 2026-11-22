import { ExternalLink, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog, SEARCH_SHEET_CLASS } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { productTitle, specSummary, unitSummary } from '@/features/products/product-display';
import { lookupByCode, useDebouncedValue, useQuickSearch } from '@/features/products/products-api';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { QuickSearchItem } from '@/types/api';

/** Debounce of the quick lookup (fast typists pause ~150 ms between words). */
export const QUICK_LOOKUP_DEBOUNCE_MS = 150;

/**
 * Product quick lookup: a dialog over the current screen (the screen underneath, e.g. a half-filled
 * expense, stays mounted and untouched). Type-ahead with request cancellation; Enter on a code that
 * matches exactly (barcode scanners end with Enter) selects that product at once. Shows selling
 * price and MRP only: purchase prices are never shown here.
 *
 * Wrapped in data-no-unsaved, so typing here does not count as unsaved work on the page beneath.
 */
export function QuickLookupDialog({ open, onClose, onOpenProduct }: { open: boolean; onClose: () => void; onOpenProduct: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<QuickSearchItem | null>(null);
  const [codeMessage, setCodeMessage] = useState<string | null>(null);
  const debounced = useDebouncedValue(q, QUICK_LOOKUP_DEBOUNCE_MS);
  const results = useQuickSearch(open ? debounced : '');
  const items = results.data?.items ?? [];
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setSelected(null);
      setActive(0);
      setCodeMessage(null);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setActive(0), [debounced]);

  async function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // A search field's own Esc would only clear the text (and swallow the dialog's cancel):
      // one Esc always closes the lookup and returns to where the user was.
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const term = q.trim();
      // A scanned / typed code: exact barcode or SKU first, without waiting for the debounce.
      if (/^[A-Za-z0-9-]{4,64}$/.test(term) && /\d/.test(term)) {
        const found = await lookupByCode(term).catch(() => []);
        const hit = found.find((p) => p.isActive) ?? found[0];
        if (hit) {
          setSelected({
            id: hit.id,
            name: hit.name,
            brand: hit.brand?.name ?? null,
            category: hit.category.name,
            size: hit.size,
            pageCount: hit.pageCount,
            gsm: hit.gsm,
            binding: hit.binding,
            sellingUnit: hit.sellingUnit,
            packQty: hit.packQty,
            sku: hit.sku,
            barcode: hit.barcode,
            mrp: hit.mrp,
            sellingPrice: hit.sellingPrice,
            close: false,
          });
          setCodeMessage(null);
          return;
        }
      }
      const item = items[active];
      if (item) setSelected(item);
      else if (term) setCodeMessage('No product matches. Check the spelling or try fewer words.');
    }
  }

  return (
    <Dialog open={open} title="Product quick lookup" onClose={onClose} size="lg" className={SEARCH_SHEET_CLASS}>
      <div data-no-unsaved className="flex h-full flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={items[active] ? `${listId}-${items[active].id}` : undefined}
            aria-label="Search products"
            placeholder="Brand, name, size, pages, barcode…"
            autoComplete="off"
            enterKeyHint="search"
            className="pl-9"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSelected(null);
              setCodeMessage(null);
            }}
            onKeyDown={(e) => void onKeyDown(e)}
          />
        </div>

        {selected && (
          <div className="rounded-xl border bg-surface-muted p-4" data-testid="lookup-selected">
            <p className="font-semibold">{productTitle(selected)}</p>
            <p className="text-sm text-muted-foreground">{[specSummary(selected), unitSummary(selected), selected.category].filter(Boolean).join(' · ')}</p>
            <div className="mt-2 flex flex-wrap items-baseline gap-4">
              <span className="figure text-2xl font-semibold">{formatInr(selected.sellingPrice)}</span>
              {selected.mrp && <span className="figure text-sm text-muted-foreground">MRP {formatInr(selected.mrp)}</span>}
              {(selected.sku || selected.barcode) && <span className="text-xs text-muted-foreground">{[selected.sku, selected.barcode].filter(Boolean).join(' · ')}</span>}
            </div>
            <button type="button" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" onClick={() => onOpenProduct(selected.id)}>
              <ExternalLink className="size-3.5" aria-hidden="true" /> Open product page
            </button>
          </div>
        )}

        {codeMessage && <p className="text-sm text-muted-foreground">{codeMessage}</p>}
        {results.isError && <p className="text-sm text-destructive">Could not search. Check the connection and try again.</p>}

        <ul id={listId} role="listbox" aria-label="Products" className={cn('min-h-0 flex-1 overflow-y-auto', results.isFetching && 'opacity-70')}>
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${item.id}`}
              role="option"
              aria-selected={i === active}
              className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2', i === active ? 'bg-primary-soft' : 'hover:bg-surface-muted')}
              onMouseEnter={() => setActive(i)}
              onClick={() => setSelected(item)}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{productTitle(item)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[specSummary(item), unitSummary(item)].filter(Boolean).join(' · ') || item.category}
                  {item.close && ' · close match'}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="figure block font-semibold">{formatInr(item.sellingPrice)}</span>
                {item.mrp && <span className="figure block text-xs text-muted-foreground">MRP {formatInr(item.mrp)}</span>}
              </span>
            </li>
          ))}
        </ul>
        {results.data?.hasMore && <p className="text-xs text-muted-foreground">More products match: type more words to narrow down.</p>}
        <p className="hidden text-xs text-muted-foreground lg:block">↑ ↓ to move · Enter to choose · Esc to close and return to where you were</p>
      </div>
    </Dialog>
  );
}
