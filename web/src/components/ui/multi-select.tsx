import { Plus, Search, X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  id: string;
  name: string;
  isActive: boolean;
}

/** How many unselected options are listed before "Show all". */
const COLLAPSED_COUNT = 12;

interface MultiSelectProps {
  /** Visible group label. */
  label: string;
  /** Singular noun for messages ("category", "brand"). */
  noun: string;
  /** Every option that may be shown: active ones, plus selected ones that are archived. */
  options: MultiSelectOption[];
  /** Selected ids, in order (the order is kept and sent to the server). */
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Ids listed first under `suggestedLabel` (e.g. a supplier's defaults). */
  suggestedIds?: Set<string>;
  suggestedLabel?: string;
  /** Creates (or finds) an option from typed text; returns the option to select, or null on failure. */
  onCreate?: (name: string) => Promise<MultiSelectOption | null>;
  creating?: boolean;
  /** Marks the first selected item (e.g. "Primary" category). */
  firstBadge?: string;
  hint?: ReactNode;
  error?: string | undefined;
  /** Status line under the control (e.g. "Created …"). */
  note?: { text: string; error: boolean } | null;
  disabled?: boolean;
  loading?: boolean;
  testId?: string;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Multi-select with removable chips: choose from a filtered list, remove with ×, optionally create
 * a new option from the search text. Archived options are never offered, only kept when already
 * selected. A selected id appears once (duplicates are impossible). Works with touch and keyboard.
 */
export function MultiSelect({
  label,
  noun,
  options,
  selected,
  onChange,
  suggestedIds,
  suggestedLabel,
  onCreate,
  creating = false,
  firstBadge,
  hint,
  error,
  note,
  disabled = false,
  loading = false,
  testId,
}: MultiSelectProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const byId = new Map(options.map((o) => [o.id, o]));
  const chosen = new Set(selected);

  const q = norm(query);
  const available = options.filter((o) => o.isActive && !chosen.has(o.id) && (q === '' || norm(o.name).includes(q)));
  const suggested = suggestedIds ? available.filter((o) => suggestedIds.has(o.id)) : [];
  const others = available.filter((o) => !suggested.includes(o));
  const visibleOthers = showAll || q !== '' ? others : others.slice(0, COLLAPSED_COUNT);
  const exact = options.find((o) => norm(o.name) === q);
  const canCreate = onCreate !== undefined && q !== '' && !(exact && exact.isActive);

  const add = (optionId: string) => {
    if (!chosen.has(optionId)) onChange([...selected, optionId]);
    setQuery('');
  };
  const remove = (optionId: string) => onChange(selected.filter((x) => x !== optionId));

  async function create() {
    if (!onCreate) return;
    const created = await onCreate(query.trim().replace(/\s+/g, ' '));
    if (created) {
      if (!chosen.has(created.id)) onChange([...selected, created.id]);
      setQuery('');
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (exact?.isActive && !chosen.has(exact.id)) add(exact.id);
    else if (available.length === 1) add(available[0]!.id);
    else if (canCreate) void create();
  }

  const optionButton = (o: MultiSelectOption) => (
    <button
      key={o.id}
      type="button"
      disabled={disabled}
      onClick={() => add(o.id)}
      className="inline-flex h-9 items-center gap-1 rounded-full border border-input bg-card px-3 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <Plus className="size-3.5 text-muted-foreground" aria-hidden="true" />
      {o.name}
    </button>
  );

  return (
    <fieldset className="space-y-2" aria-describedby={error ? `${id}-error` : undefined} data-testid={testId}>
      <legend className="text-sm font-medium">{label}</legend>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}

      <ul className="flex min-h-9 flex-wrap gap-2" aria-label={`Selected ${noun === 'category' ? 'categories' : `${noun}s`}`}>
        {selected.length === 0 && <li className="self-center text-sm text-muted-foreground">None selected</li>}
        {selected.map((sid, index) => {
          const o = byId.get(sid);
          const name = o?.name ?? 'Unknown';
          return (
            <li
              key={sid}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-primary bg-primary-soft pl-3 pr-1 text-sm text-primary-soft-foreground"
            >
              <span>{name}</span>
              {o && !o.isActive && <span className="text-xs text-muted-foreground">(archived)</span>}
              {firstBadge && index === 0 && selected.length > 1 && (
                <span className="rounded-full bg-card px-1.5 text-[11px] font-medium text-muted-foreground">{firstBadge}</span>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(sid)}
                aria-label={`Remove ${name}`}
                className="inline-flex size-7 items-center justify-center rounded-full hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={inputRef}
          id={`${id}-search`}
          aria-label={`Search or add ${noun}`}
          value={query}
          disabled={disabled}
          autoComplete="off"
          enterKeyHint="done"
          placeholder={onCreate ? `Search or add a ${noun}…` : `Search ${noun === 'category' ? 'categories' : `${noun}s`}…`}
          className="pl-9"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          {...(error ? { 'aria-invalid': true } : {})}
        />
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {suggested.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{suggestedLabel ?? 'Suggested'}</p>
          <div className="flex flex-wrap gap-2">{suggested.map(optionButton)}</div>
        </div>
      )}
      {visibleOthers.length > 0 && (
        <div className="space-y-1.5">
          {suggested.length > 0 && <p className="text-xs font-medium text-muted-foreground">All {noun === 'category' ? 'categories' : `${noun}s`}</p>}
          <div className="flex flex-wrap gap-2">{visibleOthers.map(optionButton)}</div>
        </div>
      )}
      {!showAll && q === '' && others.length > COLLAPSED_COUNT && (
        <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setShowAll(true)}>
          Show all {others.length}
        </button>
      )}
      {q !== '' && available.length === 0 && !canCreate && (
        <p className="text-sm text-muted-foreground">
          {exact && chosen.has(exact.id) ? `“${exact.name}” is already selected.` : `No matching ${noun}.`}
        </p>
      )}
      {canCreate && (
        <Button variant="outline" size="sm" disabled={disabled} loading={creating} onClick={() => void create()}>
          {!creating && <Plus aria-hidden="true" />}
          {creating ? 'Adding…' : `Add new ${noun} “${query.trim()}”`}
        </Button>
      )}
      {note && (
        <p role={note.error ? 'alert' : 'status'} className={cn('text-xs', note.error ? 'text-destructive' : 'text-muted-foreground')}>
          {note.text}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
