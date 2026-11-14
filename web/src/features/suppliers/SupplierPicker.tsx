import { ChevronsUpDown, Plus, Search, Truck, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Dialog, SEARCH_SHEET_CLASS } from '@/components/ui/dialog';
import { controlClass } from '@/components/ui/input';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Supplier, SupplierRef } from '@/types/api';
import { useSuppliers } from './suppliers-api';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface SupplierPickerProps {
  id: string;
  value: SupplierRef | null;
  onChange: (supplier: SupplierRef | null) => void;
  /** Opens the "Add supplier" form, prefilled with what was typed. Omit to hide that option. */
  onAddSupplier?: (typedName: string) => void;
  /** Label of the "no supplier" option; null hides it (a supplier is required). */
  noneLabel?: string | null;
  invalid?: boolean;
  describedBy?: string;
  /**
   * Only suppliers still owed money (unpaid or partly paid, non-voided bills), archived ones
   * included, each with the amount outstanding. Used by the supplier payment form; the server
   * applies the same rule when the payment is saved.
   */
  outstandingOnly?: boolean;
}

type Option =
  | { kind: 'none' }
  | { kind: 'supplier'; supplier: Pick<Supplier, 'id' | 'name' | 'phone' | 'isActive' | 'payable'> }
  | { kind: 'add' };

/**
 * Searchable supplier selector backed by GET /suppliers (active only, or with `outstandingOnly`
 * every supplier with a payable balance). Opens as a sheet on phones and a dialog on desktop, so
 * it works the same with touch, mouse and keyboard.
 */
export function SupplierPicker({
  id,
  value,
  onChange,
  onAddSupplier,
  noneLabel = 'No supplier',
  invalid,
  describedBy,
  outstandingOnly = false,
}: SupplierPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = useDebounced(query.trim(), 200);
  const list = useSuppliers(
    outstandingOnly ? { q, status: 'all', balance: 'payable', pageSize: 20 } : { q, status: 'active', pageSize: 20 },
    open,
  );
  const listId = useId();

  const options: Option[] = [
    ...(noneLabel !== null ? [{ kind: 'none' as const }] : []),
    ...(list.data?.items ?? []).map((s) => ({ kind: 'supplier' as const, supplier: s })),
    ...(onAddSupplier ? [{ kind: 'add' as const }] : []),
  ];

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  function choose(option: Option) {
    if (option.kind === 'add') {
      setOpen(false);
      onAddSupplier?.(query.trim());
      return;
    }
    onChange(option.kind === 'none' ? null : { id: option.supplier.id, name: option.supplier.name, isActive: option.supplier.isActive });
    setOpen(false);
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <>
      <div className="relative">
        <button
          id={id}
          type="button"
          aria-haspopup="dialog"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onClick={() => {
            setQuery('');
            setOpen(true);
          }}
          className={cn(controlClass, 'flex h-11 items-center gap-2 pr-10 text-left md:h-10')}
        >
          <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground')}>
            {value ? value.name : (noneLabel ?? 'Choose a supplier')}
            {value && !value.isActive && <span className="text-muted-foreground"> (archived)</span>}
          </span>
          {(!value || noneLabel === null) && <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </button>
        {value && noneLabel !== null && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Remove supplier"
            className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <Dialog open={open} title="Choose supplier" onClose={() => setOpen(false)} size="sm" className={SEARCH_SHEET_CLASS}>
        <div className="space-y-3">
          {/* Stays at the top while the results scroll (the sheet sits above the phone keyboard). */}
          <div className="sticky top-0 z-10 -mt-4 bg-card pt-4 pb-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                autoFocus
                type="search"
                role="combobox"
                aria-label="Search suppliers"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={optionId(active)}
                autoComplete="off"
                enterKeyHint="search"
                placeholder="Search by name or phone"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, options.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const option = options[active];
                    if (option) choose(option);
                  }
                }}
                className={cn(controlClass, 'h-11 pl-9 md:h-10')}
              />
              </div>
          </div>

          <ul id={listId} role="listbox" aria-label="Suppliers" className="-mx-1 space-y-0.5">
            {options.map((option, i) => {
              const selected =
                (option.kind === 'none' && value === null) || (option.kind === 'supplier' && option.supplier.id === value?.id);
              return (
                <li
                  key={option.kind === 'supplier' ? option.supplier.id : option.kind}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(option)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
                    i === active && 'bg-accent',
                    selected && 'font-medium text-primary-soft-foreground',
                    option.kind === 'add' && 'mt-1 border-t pt-3 text-primary',
                  )}
                >
                  {option.kind === 'none' && <span className="text-muted-foreground">{noneLabel}</span>}
                  {option.kind === 'supplier' && (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {option.supplier.name}
                          {!option.supplier.isActive && <span className="text-muted-foreground"> (archived)</span>}
                        </span>
                        {option.supplier.phone && <span className="block text-xs text-muted-foreground">{option.supplier.phone}</span>}
                      </span>
                      {outstandingOnly && (
                        <span className="shrink-0 text-right text-xs text-muted-foreground">
                          Owed <span className="figure font-medium text-warning">{formatInr(option.supplier.payable)}</span>
                        </span>
                      )}
                    </>
                  )}
                  {option.kind === 'add' && (
                    <>
                      <Plus className="size-4" aria-hidden="true" />
                      <span className="truncate">{query.trim() ? `Add supplier “${query.trim()}”` : 'Add a new supplier'}</span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {list.isFetching && <p className="text-xs text-muted-foreground">Searching…</p>}
          {list.isError && <p className="text-sm text-destructive">Could not load suppliers. Check the connection and try again.</p>}
          {list.isSuccess && list.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {outstandingOnly
                ? q
                  ? `No supplier with an outstanding balance matches “${q}”.`
                  : 'No supplier has an outstanding balance. Every recorded bill is fully paid.'
                : q
                  ? `No active supplier matches “${q}”.`
                  : 'No suppliers yet.'}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
