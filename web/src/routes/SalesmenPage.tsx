import { BadgeCheck, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SalesmanFormDialog } from '@/features/salesmen/SalesmanFormDialog';
import { useSalesmen } from '@/features/salesmen/salesmen-api';
import { cn } from '@/lib/utils';

export function SalesmenPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const get = (k: string) => params.get(k) ?? '';
  const page = Math.max(1, Number(get('page')) || 1);
  const [search, setSearch] = useState(get('q'));
  const [adding, setAdding] = useState(false);
  const list = useSalesmen({ q: get('q') || undefined, status: get('status') || 'active', page, pageSize: 25 });

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (!('page' in next)) merged.delete('page');
    setParams(merged);
  }

  return (
    <Page>
      <PageHeader
        title="Salesmen"
        description="A contact list of salesmen. Deactivated salesmen keep their details and history."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" /> Add salesman
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <form
          role="search"
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search salesmen"
            placeholder="Search by name or phone"
            enterKeyHint="search"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value === '' && get('q')) update({ q: '' });
            }}
          />
        </form>
        <Select aria-label="Status" value={get('status') || 'active'} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value })}>
          <option value="active">Active salesmen</option>
          <option value="archived">Deactivated</option>
          <option value="all">All</option>
        </Select>
      </div>

      {list.isPending && <LoadingState label="Loading salesmen…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          icon={BadgeCheck}
          title={get('q') ? 'No salesmen match' : 'No salesmen here'}
          action={
            !get('q') && (
              <Button onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" /> Add salesman
              </Button>
            )
          }
        >
          {get('q') ? 'Try a different name or phone number.' : 'Add a salesman to keep their contact details in one place.'}
        </EmptyState>
      )}

      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <ul className="space-y-2 md:hidden">
            {list.data.items.map((s) => (
              <li key={s.id}>
                <Link to={`/salesmen/${s.id}`} className={cn('block rounded-xl border bg-card p-4 shadow-card', !s.isActive && 'opacity-80')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">{s.phone ?? 'No phone number'}</p>
                    </div>
                    {!s.isActive && <Badge>Deactivated</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Salesman</th>
                  <th className="px-4 py-2.5 font-medium">Phone</th>
                  <th className="px-4 py-2.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.items.map((s) => (
                  <tr key={s.id} className={cn('cursor-pointer hover:bg-accent/50', !s.isActive && 'text-muted-foreground')} onClick={() => navigate(`/salesmen/${s.id}`)}>
                    <td className="px-4 py-3">
                      <Link to={`/salesmen/${s.id}`} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
                        {s.name}
                      </Link>
                      {!s.isActive && <Badge className="ml-2">Deactivated</Badge>}
                    </td>
                    <td className="px-4 py-3">{s.phone ?? '—'}</td>
                    <td className="max-w-80 truncate px-4 py-3 text-muted-foreground">{s.notes ?? '—'}</td>
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

      <SalesmanFormDialog open={adding} onClose={() => setAdding(false)} onSaved={(s) => navigate(`/salesmen/${s.id}`)} />
    </Page>
  );
}
