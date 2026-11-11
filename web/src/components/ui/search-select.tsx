import { ChevronsUpDown, Search, X } from 'lucide-react';
import { useEffect, useId, useState, type ComponentType, type ReactNode } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { controlClass } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SearchSelectOption {
  id: string;
  name: string;
  /** Second line in the list (e.g. a phone number). */
  detail?: string | null;
  /** Archived options are shown only when already selected. */
  isActive?: boolean;
}

interface SearchSelectProps {
  id: string;
  /** Accessible name of the dialog and its search box ("brand", "supplier", "category"). */
  noun: string;
  options: SearchSelectOption[];
  value: SearchSelectOption | null;
  onChange: (option: SearchSelectOption | null) => void;
  /** Text on the button when nothing is chosen. */
  placeholder: string;
  /** Label of the "none" option (also shows a clear button); null = a choice is required. */
  noneLabel?: string | null;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  invalid?: boolean;
  describedBy?: string | undefined;
  disabled?: boolean;
  loading?: boolean;
  /** Shown under the list when nothing matches / there are no options. */
  emptyText?: ReactNode;
  /** Extra row at the end of the list (e.g. "Add a new supplier"). */
  footer?: ReactNode;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Searchable single choice from a known list: a button that opens a sheet (phones) / dialog
 * (desktop) with a search box and a keyboard-navigable list. Same interaction as SupplierPicker.
 */
export function SearchSelect({
  id,
  noun,
  options,
  value,
  onChange,
  placeholder,
  noneLabel = null,
  icon: Icon,
  invalid,
  describedBy,
  disabled = false,
  loading = false,
  emptyText,
  footer,
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const q = norm(query);
  const matches = options.filter((o) => o.isActive !== false || o.id === value?.id).filter((o) => !q || norm(o.name).includes(q) || norm(o.detail ?? '').includes(q));
  const rows: (SearchSelectOption | null)[] = [...(noneLabel !== null && !q ? [null] : []), ...matches];

  useEffect(() => setActive(0), [q]);

  function choose(option: SearchSelectOption | null) {
    onChange(option);
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
          disabled={disabled}
          onClick={() => {
            setQuery('');
            setOpen(true);
          }}
          className={cn(controlClass, 'flex h-11 items-center gap-2 pr-10 text-left disabled:opacity-60 md:h-10')}
        >
          {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground')}>
            {value ? value.name : placeholder}
            {value && value.isActive === false && <span className="text-muted-foreground"> (archived)</span>}
          </span>
          {(!value || noneLabel === null) && <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </button>
        {value && noneLabel !== null && !disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Remove ${noun}`}
            className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <Dialog open={open} title={`Choose ${noun}`} onClose={() => setOpen(false)} size="sm" className="md:h-[min(36rem,85dvh)]">
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              type="search"
              role="combobox"
              aria-label={`Search ${noun}`}
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows.length ? optionId(active) : undefined}
              autoComplete="off"
              enterKeyHint="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, rows.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (rows.length > 0) choose(rows[active] ?? null);
                }
              }}
              className={cn(controlClass, 'h-11 pl-9 md:h-10')}
            />
          </div>
          <ul id={listId} role="listbox" aria-label={noun} className="-mx-1 space-y-0.5">
            {rows.map((option, i) => {
              const selected = option === null ? value === null : option.id === value?.id;
              return (
                <li
                  key={option?.id ?? '__none'}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(option)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
                    i === active && 'bg-accent',
                    selected && 'font-medium text-primary-soft-foreground',
                  )}
                >
                  {option === null ? (
                    <span className="text-muted-foreground">{noneLabel}</span>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.name}</span>
                      {option.detail && <span className="block text-xs text-muted-foreground">{option.detail}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!loading && matches.length === 0 && (
            <p className="text-sm text-muted-foreground">{q ? `Nothing matches “${query.trim()}”.` : (emptyText ?? 'Nothing to choose yet.')}</p>
          )}
          {footer}
        </div>
      </Dialog>
    </>
  );
}
