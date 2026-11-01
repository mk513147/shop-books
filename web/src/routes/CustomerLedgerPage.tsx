import { BookOpenText, Info } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CustomerBalances } from '@/features/customers/CustomerBalances';
import { TXN_LABELS, useCustomerLedger } from '@/features/customers/customers-api';
import { ExportButton } from '@/features/exports/ExportButton';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { CustomerLedgerEntry } from '@/types/api';

/** "+500.00" -> "+₹500.00", "-200.00" -> "−₹200.00", null -> "". */
function Effect({ value, counted, tone }: { value: string | null; counted: boolean; tone: 'due' | 'advance' }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const plus = value.startsWith('+');
  return (
    <span
      className={cn(
        'figure font-medium',
        !counted && 'text-muted-foreground line-through',
        counted && plus && (tone === 'due' ? 'text-warning' : 'text-primary'),
      )}
    >
      {plus ? '+' : '−'}
      {formatInr(value.slice(1))}
    </span>
  );
}

function detail(e: CustomerLedgerEntry): string {
  const parts: string[] = [];
  if (e.paymentMode) parts.push(PAYMENT_MODE_LABELS[e.paymentMode]);
  if (e.reference) parts.push(e.reference);
  if (e.type === 'due_payment' && e.due) parts.push(`for due of ${formatDate(e.due.txnDate)}`);
  return parts.join(' · ');
}

/**
 * Customer ledger with two separate running balances (due and advance). Signs: "+" increases that
 * balance, "−" reduces it. Reversed entries are listed but never counted.
 */
export function CustomerLedgerPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const ledger = useCustomerLedger(id, {
    from: get('from') || undefined,
    to: get('to') || undefined,
    type: get('type') || undefined,
    status: get('status') || undefined,
  });

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged, { replace: true });
  }

  if (ledger.isPending) return <LoadingState label="Loading ledger…" />;
  if (ledger.isError) return <ErrorState title="Could not load the ledger" error={ledger.error} onRetry={() => void ledger.refetch()} />;
  const { customer, balances, entries, broughtForward, truncated } = ledger.data;
  const link = (e: CustomerLedgerEntry) => `/customers/${customer.id}/transactions/${e.id}`;

  return (
    <Page>
      <PageHeader
        back={{ to: `/customers/${customer.id}`, label: customer.name }}
        title={`Ledger: ${customer.name}`}
        actions={
          <ExportButton
            report="customer-ledger"
            params={{ customerId: customer.id, from: get('from') || undefined, to: get('to') || undefined, type: get('type') || undefined, status: get('status') || undefined }}
          />
        }
      />
      <CustomerBalances due={balances.due} advance={balances.advance} compact />

      <details className="rounded-xl border bg-card p-4 text-sm shadow-card">
        <summary className="flex cursor-pointer items-center gap-2 font-medium">
          <Info className="size-4 text-primary" aria-hidden="true" /> How to read this ledger
        </summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Due</strong> column: <strong className="text-foreground">+</strong> the customer owes more (a due was added),{' '}
            <strong className="text-foreground">−</strong> they paid part of a due.
          </li>
          <li>
            <strong className="text-foreground">Advance</strong> column: <strong className="text-foreground">+</strong> money received in advance,{' '}
            <strong className="text-foreground">−</strong> advance refunded.
          </li>
          <li>The two running balances are independent: an advance is never subtracted from a due.</li>
          <li>Reversed entries stay listed (crossed out) but do not change any balance.</li>
        </ul>
      </details>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Input type="date" aria-label="From date" value={get('from')} onChange={(e) => update({ from: e.target.value })} />
        <Input type="date" aria-label="To date" value={get('to')} onChange={(e) => update({ to: e.target.value })} />
        <Select aria-label="Entry type" value={get('type')} onChange={(e) => update({ type: e.target.value })}>
          <option value="">All entry types</option>
          {Object.entries(TXN_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={get('status')} onChange={(e) => update({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="active">Counted only</option>
          <option value="reversed">Reversed</option>
        </Select>
      </div>

      {broughtForward && (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-muted px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">
            Before {formatDate(get('from'))}: due <strong className="figure text-foreground">{formatInr(broughtForward.due)}</strong>
          </span>
          <span className="text-right text-muted-foreground">
            advance <strong className="figure text-foreground">{formatInr(broughtForward.advance)}</strong>
          </span>
        </div>
      )}
      {truncated && <p className="text-sm text-warning">Only the first 2,000 entries are shown. Narrow the date range.</p>}

      {entries.length === 0 ? (
        <EmptyState icon={BookOpenText} title="No entries">
          {params.toString() ? 'No entries match these filters.' : 'Dues, payments, advances and refunds will appear here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {entries.map((e) => (
              <li key={e.id}>
                <Link to={link(e)} className={cn('block space-y-2 rounded-xl border bg-card p-3 shadow-card', !e.counted && 'opacity-80')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{formatDate(e.txnDate)}</p>
                      <p className="text-sm font-medium">{TXN_LABELS[e.type]}</p>
                      {(e.description || detail(e)) && (
                        <p className="truncate text-xs text-muted-foreground">{[e.description, detail(e)].filter(Boolean).join(' · ')}</p>
                      )}
                    </div>
                    {!e.counted && <StatusBadge status="reversed" />}
                  </div>
                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-muted p-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Due</p>
                      <Effect value={e.dueEffect} counted={e.counted} tone="due" />
                      <p className="figure text-muted-foreground">= {formatInr(e.runningDue)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Advance</p>
                      <Effect value={e.advanceEffect} counted={e.counted} tone="advance" />
                      <p className="figure text-muted-foreground">= {formatInr(e.runningAdvance)}</p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-card md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Entry</th>
                  <th className="px-4 py-2.5 font-medium">Reference</th>
                  <th className="px-4 py-2.5 font-medium">Description</th>
                  <th className="px-4 py-2.5 text-right font-medium">Due ±</th>
                  <th className="px-4 py-2.5 text-right font-medium">Advance ±</th>
                  <th className="px-4 py-2.5 text-right font-medium">Due balance</th>
                  <th className="px-4 py-2.5 text-right font-medium">Advance balance</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e) => (
                  <tr key={e.id} className={cn('align-top', !e.counted && 'text-muted-foreground')}>
                    <td className="whitespace-nowrap px-4 py-3">{formatDate(e.txnDate)}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link to={link(e)} className="hover:underline">
                        {TXN_LABELS[e.type]}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{e.reference ?? '—'}</td>
                    <td className="max-w-64 px-4 py-3">
                      <span className="line-clamp-2">{e.description ?? '—'}</span>
                      {detail(e) && <span className="block text-xs text-muted-foreground">{detail(e)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <Effect value={e.dueEffect} counted={e.counted} tone="due" />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <Effect value={e.advanceEffect} counted={e.counted} tone="advance" />
                    </td>
                    <td className="figure whitespace-nowrap px-4 py-3 text-right">{formatInr(e.runningDue)}</td>
                    <td className="figure whitespace-nowrap px-4 py-3 text-right">{formatInr(e.runningAdvance)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
