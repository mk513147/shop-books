import { ChevronLeft, ChevronRight, Paperclip, Plus, ReceiptText, Search, SlidersHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PaymentStatusBadge } from '@/components/finance/StatusBadge';
import { StatTile } from '@/components/finance/StatTile';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useBrands } from '@/features/brands/brands-api';
import { useCategories } from '@/features/categories/categories-api';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES, useExpenseList, useRecorders } from '@/features/expenses/expenses-api';
import { useSuppliers } from '@/features/suppliers/suppliers-api';
import { formatDate } from '@/lib/dates';
import { formatInr, MONEY_INPUT } from '@/lib/money';
import { categorySummary, cn, expenseLabel } from '@/lib/utils';

const FILTER_KEYS = ['q', 'from', 'to', 'categoryId', 'brandId', 'supplierId', 'paymentMode', 'recordedBy', 'status', 'minAmount', 'maxAmount'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

const SORT_OPTIONS = [
  { value: 'date:desc', label: 'Newest first' },
  { value: 'date:asc', label: 'Oldest first' },
  { value: 'amount:desc', label: 'Highest amount' },
  { value: 'amount:asc', label: 'Lowest amount' },
  { value: 'created:desc', label: 'Recently recorded' },
];

function readFilters(params: URLSearchParams): Filters {
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? (k === 'status' ? 'active' : '')])) as Filters;
}

function FilterForm({ formId, initial, onApply }: { formId: string; initial: Filters; onApply: (f: Filters) => void }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const categories = useCategories('all');
  const brands = useBrands('all');
  const suppliers = useSuppliers({ status: 'all', pageSize: 100 });
  const recorders = useRecorders();
  const set = (key: FilterKey) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    for (const key of ['minAmount', 'maxAmount'] as const) {
      if (f[key].trim() && !MONEY_INPUT.test(f[key].trim())) {
        setError('Amounts must be numbers like 500 or 499.50');
        return;
      }
    }
    if (f.from && f.to && f.from > f.to) {
      setError('"From" date must be on or before "To" date');
      return;
    }
    setError(null);
    onApply(f);
  }

  return (
    <form id={formId} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field id="f-from" label="From">
        <Input id="f-from" type="date" value={f.from} onChange={set('from')} />
      </Field>
      <Field id="f-to" label="To">
        <Input id="f-to" type="date" value={f.to} onChange={set('to')} />
      </Field>
      <Field id="f-supplier" label="Supplier">
        <Select id="f-supplier" value={f.supplierId} onChange={set('supplierId')}>
          <option value="">All suppliers</option>
          {suppliers.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isActive ? '' : ' (archived)'}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="f-category" label="Category">
        <Select id="f-category" value={f.categoryId} onChange={set('categoryId')}>
          <option value="">All categories</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isActive ? '' : ' (archived)'}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="f-brand" label="Brand">
        <Select id="f-brand" value={f.brandId} onChange={set('brandId')}>
          <option value="">All brands</option>
          {brands.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.isActive ? '' : ' (archived)'}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="f-mode" label="Payment mode">
        <Select id="f-mode" value={f.paymentMode} onChange={set('paymentMode')}>
          <option value="">Any</option>
          {PAYMENT_MODES.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_MODE_LABELS[m]}
            </option>
          ))}
          <option value="none">None (unpaid)</option>
        </Select>
      </Field>
      <Field id="f-user" label="Recorded by">
        <Select id="f-user" value={f.recordedBy} onChange={set('recordedBy')}>
          <option value="">Anyone</option>
          {recorders.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="f-min" label="Min amount (₹)">
        <Input id="f-min" inputMode="decimal" value={f.minAmount} onChange={set('minAmount')} />
      </Field>
      <Field id="f-max" label="Max amount (₹)">
        <Input id="f-max" inputMode="decimal" value={f.maxAmount} onChange={set('maxAmount')} />
      </Field>
      <Field id="f-status" label="Status" className="sm:col-span-2">
        <Select id="f-status" value={f.status} onChange={set('status')}>
          <option value="active">Active</option>
          <option value="voided">Voided</option>
          <option value="all">All</option>
        </Select>
      </Field>
      {error && (
        <p role="alert" className="callout callout-danger sm:col-span-2">
          {error}
        </p>
      )}
    </form>
  );
}

export function ExpensesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filters = readFilters(params);
  const [search, setSearch] = useState(filters.q);
  const sort = `${params.get('sort') ?? 'date'}:${params.get('order') ?? 'desc'}`;
  const page = Math.max(1, Number(params.get('page')) || 1);

  const query: Record<string, string> = { status: filters.status, sort: sort.split(':')[0]!, order: sort.split(':')[1]!, page: String(page), pageSize: '25' };
  for (const key of FILTER_KEYS) if (filters[key].trim()) query[key] = filters[key].trim();
  const list = useExpenseList(query);

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged);
  }

  const panelFilterCount = FILTER_KEYS.filter((k) => k !== 'q' && (k === 'status' ? filters.status !== 'active' : filters[k])).length;
  const anyFilter = panelFilterCount > 0 || filters.q !== '';

  return (
    <Page>
      <PageHeader
        title="Expenses"
        actions={
          <>
            <Link to="/categories" className={cn(buttonVariants({ variant: 'ghost' }), 'hidden md:inline-flex')}>
              Categories
            </Link>
            <Button onClick={() => navigate('/expenses/new')} className="hidden md:inline-flex">
              <Plus aria-hidden="true" /> Add expense
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <form
          role="search"
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim(), page: '' });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search expenses"
            placeholder="Search supplier, description or invoice"
            enterKeyHint="search"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value === '' && filters.q) update({ q: '', page: '' });
            }}
          />
        </form>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 md:flex-none" onClick={() => setFiltersOpen(true)}>
            <SlidersHorizontal aria-hidden="true" />
            Filters
            {panelFilterCount > 0 && <Badge tone="accent">{panelFilterCount}</Badge>}
          </Button>
          <Select
            aria-label="Sort"
            className="w-auto flex-1 md:flex-none"
            value={sort}
            onChange={(e) => {
              const [s, o] = e.target.value.split(':');
              update({ sort: s === 'date' ? '' : s!, order: o === 'desc' ? '' : o!, page: '' });
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {list.data && (
        <section aria-label="Totals" className="space-y-2">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-3">
            <StatTile label="Total" amount={list.data.totals.amount} className="col-span-2 md:col-span-1" />
            <StatTile label="Paid" amount={list.data.totals.amountPaid} tone="accent" />
            <StatTile label="Outstanding" amount={list.data.totals.outstanding} tone={list.data.totals.outstanding !== '0.00' ? 'warning' : 'muted'} />
          </div>
          <p className="text-xs text-muted-foreground">
            {list.data.pagination.total} matching · totals cover {list.data.totals.count} active expense{list.data.totals.count === 1 ? '' : 's'} (voided excluded)
            {anyFilter && (
              <>
                {' · '}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => {
                    setSearch('');
                    setParams(new URLSearchParams());
                  }}
                >
                  Clear filters
                </button>
              </>
            )}
          </p>
        </section>
      )}

      {list.isPending && <LoadingState label="Loading expenses…" skeleton="table" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          icon={ReceiptText}
          title={anyFilter ? 'No expenses match' : 'No active expenses'}
          action={
            !anyFilter && (
              <Button onClick={() => navigate('/expenses/new')}>
                <Plus aria-hidden="true" /> Add expense
              </Button>
            )
          }
        >
          {anyFilter
            ? 'Try different search words or filters.'
            : 'Record one with “Add expense”. Voided expenses are listed under Filters → Status → Voided.'}
        </EmptyState>
      )}

      {list.isSuccess && list.data.items.length > 0 && (
        <>
          {/* Phones: cards */}
          <ul className="space-y-2 md:hidden">
            {list.data.items.map((e) => (
              <li key={e.id}>
                <Link to={`/expenses/${e.id}`} className="list-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={cn('flex items-center gap-1 font-semibold', e.status === 'voided' && 'text-muted-foreground')}>
                        <span className="truncate">{expenseLabel(e)}</span>
                        {e.documentCount > 0 && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label={`${e.documentCount} document(s)`} />}
                      </p>
                      {(e.supplier ?? e.description) && (
                        <p className="truncate text-sm text-muted-foreground">{e.supplier?.name ?? categorySummary(e)}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn('figure font-semibold', e.status === 'voided' && 'text-muted-foreground line-through')}>{formatInr(e.amount)}</p>
                      {e.outstanding !== '0.00' && e.status !== 'voided' && <p className="figure text-xs font-medium text-warning">due {formatInr(e.outstanding)}</p>}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {formatDate(e.expenseDate)}
                      {e.supplier ? ` · ${categorySummary(e)}` : ''} · {e.createdBy.name}
                    </span>
                    <PaymentStatusBadge amount={e.amount} outstanding={e.outstanding} voided={e.status === 'voided'} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="table-shell hidden md:block">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Paid</th>
                  <th className="px-4 py-3 text-right">Outstanding</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="hidden px-4 py-3 2xl:table-cell">Mode</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((e) => (
                  <tr
                    key={e.id}
                    className={cn('cursor-pointer', e.status === 'voided' && 'text-muted-foreground')}
                    onClick={() => navigate(`/expenses/${e.id}`)}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      <span className="figure block">{formatDate(e.expenseDate)}</span>
                      <span className="block text-xs">by {e.createdBy.name}</span>
                    </td>
                    <td className="max-w-64 px-4 py-3">
                      <Link to={`/expenses/${e.id}`} className="line-clamp-2 font-medium hover:underline" onClick={(ev) => ev.stopPropagation()}>
                        {expenseLabel(e)}
                      </Link>
                      {e.documentCount > 0 && (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Paperclip className="size-3" aria-hidden="true" /> {e.documentCount}
                          <span className="sr-only">document(s)</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{e.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3" title={e.categories?.map((c) => c.name).join(', ')}>
                      {categorySummary(e)}
                    </td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right font-semibold', e.status === 'voided' && 'font-medium line-through')}>
                      {formatInr(e.amount)}
                    </td>
                    <td className="figure whitespace-nowrap px-4 py-3 text-right">{formatInr(e.amountPaid)}</td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', e.outstanding !== '0.00' && e.status !== 'voided' && 'font-medium text-warning')}>
                      {formatInr(e.outstanding)}
                    </td>
                    <td className="px-4 py-3">
                      <PaymentStatusBadge amount={e.amount} outstanding={e.outstanding} voided={e.status === 'voided'} />
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground 2xl:table-cell">
                      {e.payments.length ? e.payments.map((p) => PAYMENT_MODE_LABELS[p.paymentMode]).join(' + ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              <ChevronLeft aria-hidden="true" /> Previous
            </Button>
            <span className="figure text-muted-foreground">
              Page {list.data.pagination.page} of {list.data.pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= list.data.pagination.totalPages}
              onClick={() => update({ page: String(page + 1) })}
            >
              Next <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        </>
      )}

      <Dialog
        open={filtersOpen}
        title="Filter expenses"
        onClose={() => setFiltersOpen(false)}
        size="md"
        footer={
          <DialogActions>
            <Button
              variant="ghost"
              onClick={() => {
                const cleared = readFilters(new URLSearchParams());
                update({ ...cleared, q: filters.q, status: '', page: '' });
                setFiltersOpen(false);
              }}
            >
              Reset filters
            </Button>
            <Button type="submit" form="expense-filters">
              Show results
            </Button>
          </DialogActions>
        }
      >
        <FilterForm
          key={params.toString()}
          formId="expense-filters"
          initial={filters}
          onApply={(f) => {
            update({ ...f, q: filters.q, status: f.status === 'active' ? '' : f.status, page: '' });
            setFiltersOpen(false);
          }}
        />
      </Dialog>
    </Page>
  );
}
