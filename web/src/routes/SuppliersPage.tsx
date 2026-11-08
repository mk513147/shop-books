import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, History, MapPin, Pencil, Phone, Plus, Search, Truck } from 'lucide-react';
import { StatTile } from '@/components/finance/StatTile';
import { useSuppliersSummary } from '@/features/supplierPayments/payments-api';
import { formatInr } from '@/lib/money';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { SupplierFormDialog } from '@/features/suppliers/SupplierForm';
import { useSupplierHistory, useSuppliers, useUpdateSupplier } from '@/features/suppliers/suppliers-api';
import { cn } from '@/lib/utils';
import type { Supplier } from '@/types/api';

const SUPPLIER_FIELDS: Record<string, string> = {
  name: 'Name',
  phone: 'Phone',
  address: 'Address',
  notes: 'Notes',
  isActive: 'Active',
};

function displaySupplierValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'isActive') return value ? 'Yes' : 'No';
  return String(value);
}

function CategoryChips({ supplier }: { supplier: Supplier }) {
  if (supplier.categories.length === 0) return <span className="text-xs text-muted-foreground">No usual categories</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {supplier.categories.map((c) => (
        <Badge key={c.id} tone={c.isActive ? 'accent' : 'neutral'}>
          {c.name}
          {!c.isActive && ' (archived)'}
        </Badge>
      ))}
    </div>
  );
}

type Dialogs =
  | { kind: 'add' }
  | { kind: 'edit'; supplier: Supplier }
  | { kind: 'archive'; supplier: Supplier }
  | { kind: 'history'; supplier: Supplier }
  | null;

function SupplierActions({ supplier, open }: { supplier: Supplier; open: (d: Dialogs) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => open({ kind: 'edit', supplier })}>
        <Pencil aria-hidden="true" /> Edit
      </Button>
      <Button size="sm" variant="outline" onClick={() => open({ kind: 'archive', supplier })}>
        {supplier.isActive ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
        {supplier.isActive ? 'Archive' : 'Reactivate'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => open({ kind: 'history', supplier })} aria-label={`History of ${supplier.name}`}>
        <History aria-hidden="true" />
        <span className="md:sr-only">History</span>
      </Button>
    </div>
  );
}

export function ArchiveDialog({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const update = useUpdateSupplier();
  const toast = useToast();
  const archiving = supplier?.isActive ?? true;
  const close = () => {
    update.reset();
    onClose();
  };
  return (
    <Dialog
      open={supplier !== null}
      title={archiving ? 'Archive supplier?' : 'Reactivate supplier?'}
      onClose={close}
      size="sm"
      footer={
        <DialogActions>
          <Button variant="outline" onClick={close} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            variant={archiving ? 'destructive' : 'default'}
            loading={update.isPending}
            onClick={() =>
              supplier &&
              update.mutate(
                { id: supplier.id, version: supplier.version, isActive: !supplier.isActive },
                {
                  onSuccess: () => {
                    toast({ title: archiving ? 'Supplier archived' : 'Supplier reactivated', description: supplier.name, tone: 'success' });
                    close();
                  },
                },
              )
            }
          >
            {update.isPending ? (archiving ? 'Archiving…' : 'Reactivating…') : archiving ? 'Archive' : 'Reactivate'}
          </Button>
        </DialogActions>
      }
    >
      <p className="text-sm">
        {archiving
          ? `“${supplier?.name}” will no longer be offered for new expenses. Its ${supplier?.expenseCount ?? 0} existing expense(s) keep this supplier.`
          : `“${supplier?.name}” can be chosen for new expenses again.`}
      </p>
      {update.isError && (
        <p role="alert" className="mt-3 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          {errorMessage(update.error)}
        </p>
      )}
    </Dialog>
  );
}

export function HistoryDialog({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const history = useSupplierHistory(supplier?.id ?? '', supplier !== null);
  return (
    <Dialog open={supplier !== null} title={`History: ${supplier?.name ?? ''}`} onClose={onClose} size="md">
      <AuditHistory history={history} fieldLabels={SUPPLIER_FIELDS} display={displaySupplierValue} />
    </Dialog>
  );
}

export function SuppliersPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? 'active') as 'active' | 'archived' | 'all';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(q);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const balance = params.get('balance') === 'payable' ? 'payable' : 'all';
  const list = useSuppliers({ q, status, page, pageSize: 25, balance });
  const summary = useSuppliersSummary();

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged);
  }

  return (
    <Page>
      <PageHeader
        title="Suppliers"
        description="Who you buy from, with the categories you usually buy from them."
        actions={
          <Button onClick={() => setDialog({ kind: 'add' })}>
            <Plus aria-hidden="true" /> Add supplier
          </Button>
        }
      />

      {summary.data && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Total payable" amount={summary.data.totalPayable} tone={summary.data.totalPayable !== '0.00' ? 'warning' : 'muted'} />
          <StatTile label="Total payments" amount={summary.data.totalPayments} />
          <StatTile label="Unallocated payments" amount={summary.data.totalUnallocated} tone={summary.data.totalUnallocated !== '0.00' ? 'accent' : 'muted'} />
          <button
            type="button"
            onClick={() => update({ balance: balance === 'payable' ? '' : 'payable', page: '' })}
            className={cn(
              'min-w-0 rounded-xl border bg-card p-3 text-left shadow-card hover:bg-accent md:p-4',
              balance === 'payable' && 'border-primary ring-1 ring-primary',
            )}
            aria-pressed={balance === 'payable'}
          >
            <p className="text-xs text-muted-foreground">Suppliers with dues</p>
            <p className="figure mt-0.5 text-lg font-semibold md:text-xl">{summary.data.suppliersWithPayable}</p>
            <p className="mt-0.5 text-xs text-primary">{balance === 'payable' ? 'Showing only these' : 'Show only these'}</p>
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2 md:flex-row">
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
            aria-label="Search suppliers"
            placeholder="Search by name or phone"
            enterKeyHint="search"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value === '' && q) update({ q: '', page: '' });
            }}
          />
        </form>
        <Select
          aria-label="Status"
          className="md:w-44"
          value={status}
          onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value, page: '' })}
        >
          <option value="active">Active suppliers</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Select>
      </div>

      {list.isPending && <LoadingState label="Loading suppliers…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          icon={Truck}
          title={q ? 'No suppliers match' : status === 'active' ? 'No suppliers yet' : 'Nothing here'}
          action={
            !q && status === 'active' && (
              <Button onClick={() => setDialog({ kind: 'add' })}>
                <Plus aria-hidden="true" /> Add supplier
              </Button>
            )
          }
        >
          {q ? 'Try a different name or phone number.' : 'Add the suppliers you buy from to choose them quickly when recording expenses.'}
        </EmptyState>
      )}

      {list.isSuccess && list.data.items.length > 0 && (
        <>
          {/* Phones: cards */}
          <ul className="space-y-2 md:hidden">
            {list.data.items.map((s) => (
              <li key={s.id} className={cn('space-y-3 rounded-xl border bg-card p-4 shadow-card', !s.isActive && 'opacity-80')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/suppliers/${s.id}`} className="font-medium break-words hover:underline">
                      {s.name}
                    </Link>
                    <Link to={`/expenses?supplierId=${s.id}&status=all`} className="text-xs text-primary">
                      {s.expenseCount} expense{s.expenseCount === 1 ? '' : 's'}
                    </Link>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {s.payable !== '0.00' && <span className="figure text-sm font-semibold text-warning">{formatInr(s.payable)}</span>}
                    {!s.isActive && <Badge>Archived</Badge>}
                  </div>
                </div>
                {(s.phone || s.address) && (
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {s.phone && (
                      <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-2 text-foreground">
                        <Phone className="size-3.5" aria-hidden="true" />
                        {s.phone}
                      </a>
                    )}
                    {s.address && (
                      <p className="flex items-start gap-2">
                        <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-words">{s.address}</span>
                      </p>
                    )}
                  </div>
                )}
                <CategoryChips supplier={s} />
                <SupplierActions supplier={s} open={setDialog} />
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Supplier</th>
                  <th className="px-4 py-2.5 font-medium">Contact</th>
                  <th className="px-4 py-2.5 font-medium">Usual categories</th>
                  <th className="px-4 py-2.5 text-right font-medium">Expenses</th>
                  <th className="px-4 py-2.5 text-right font-medium">Payable</th>
                  <th className="px-4 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.items.map((s) => (
                  <tr key={s.id} className={cn('align-top', !s.isActive && 'text-muted-foreground')}>
                    <td className="px-4 py-3">
                      <Link to={`/suppliers/${s.id}`} className="font-medium text-foreground hover:underline">
                        {s.name}
                      </Link>
                      {!s.isActive && <Badge className="mt-1">Archived</Badge>}
                      {s.notes && <p className="mt-0.5 line-clamp-2 max-w-xs text-xs text-muted-foreground">{s.notes}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <p>{s.phone ?? '—'}</p>
                      {s.address && <p className="line-clamp-2 max-w-56 text-xs text-muted-foreground">{s.address}</p>}
                    </td>
                    <td className="max-w-72 px-4 py-3">
                      <CategoryChips supplier={s} />
                    </td>
                    <td className="figure px-4 py-3 text-right">
                      <Link to={`/expenses?supplierId=${s.id}&status=all`} className="text-primary hover:underline">
                        {s.expenseCount}
                      </Link>
                    </td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', s.payable !== '0.00' && 'font-medium text-warning')}>
                      {formatInr(s.payable)}
                      {s.unallocated !== '0.00' && <span className="block text-xs text-muted-foreground">{formatInr(s.unallocated)} unallocated</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <SupplierActions supplier={s} open={setDialog} />
                      </div>
                    </td>
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
              <Button
                variant="outline"
                size="sm"
                disabled={page >= list.data.pagination.totalPages}
                onClick={() => update({ page: String(page + 1) })}
              >
                Next <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}

      <SupplierFormDialog
        open={dialog?.kind === 'add' || dialog?.kind === 'edit'}
        supplier={dialog?.kind === 'edit' ? dialog.supplier : undefined}
        onClose={() => setDialog(null)}
        onSaved={() => setDialog(null)}
      />
      <ArchiveDialog supplier={dialog?.kind === 'archive' ? dialog.supplier : null} onClose={() => setDialog(null)} />
      <HistoryDialog supplier={dialog?.kind === 'history' ? dialog.supplier : null} onClose={() => setDialog(null)} />
    </Page>
  );
}
