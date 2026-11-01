import { BookOpenText, Info } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { StatTile } from '@/components/finance/StatTile';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ExportButton } from '@/features/exports/ExportButton';
import { PAYMENT_MODE_LABELS } from '@/features/expenses/expenses-api';
import { useSupplierLedger } from '@/features/supplierPayments/payments-api';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { SupplierLedgerEntry, SupplierLedgerType } from '@/types/api';

const TYPE_LABELS: Record<SupplierLedgerType, string> = {
  bill: 'Bill',
  paid_at_purchase: 'Paid at purchase',
  payment: 'Payment',
};

const linkFor = (e: SupplierLedgerEntry) => (e.type === 'payment' ? `/supplier-payments/${e.sourceId}` : `/expenses/${e.sourceId}`);

function Amount({ entry }: { entry: SupplierLedgerEntry }) {
  const isCredit = entry.credit !== '0.00';
  return (
    <span className={cn('figure font-semibold', !entry.counted && 'text-muted-foreground line-through', entry.counted && isCredit && 'text-warning')}>
      {isCredit ? `+${formatInr(entry.credit)}` : `−${formatInr(entry.debit)}`}
    </span>
  );
}

function detailLine(e: SupplierLedgerEntry): string {
  const parts: string[] = [];
  if (e.paymentMode) parts.push(PAYMENT_MODE_LABELS[e.paymentMode]);
  if (e.reference) parts.push(e.reference);
  if (e.type === 'payment' && e.counted && e.allocated !== null) parts.push(`${formatInr(e.allocated)} allocated`);
  if (e.type === 'bill' && e.counted && e.allocated && e.allocated !== '0.00') parts.push(`${formatInr(e.allocated)} settled by payments`);
  return parts.join(' · ');
}

/**
 * Supplier ledger. Convention (explained on screen): CREDIT = a bill, increases what the shop owes;
 * DEBIT = money paid (at purchase or later), reduces it. Balance = net amount owed after each
 * counted entry. Every figure comes from the server.
 */
export function SupplierLedgerPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const ledger = useSupplierLedger(id, {
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
  const { supplier, balance, entries, broughtForward, truncated } = ledger.data;

  return (
    <Page>
      <PageHeader
        back={{ to: `/suppliers/${supplier.id}`, label: supplier.name }}
        title={`Ledger: ${supplier.name}`}
        actions={
          <ExportButton
            report="supplier-ledger"
            params={{ supplierId: supplier.id, from: get('from') || undefined, to: get('to') || undefined, type: get('type') || undefined, status: get('status') || undefined }}
          />
        }
      />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Bills" amount={balance.totalBills} />
        <StatTile label="Paid at purchase" amount={balance.paidAtPurchase} />
        <StatTile label="Payments" amount={balance.totalPayments} />
        <StatTile label="Payable on bills" amount={balance.payable} tone={balance.payable !== '0.00' ? 'warning' : 'muted'} />
        <StatTile label="Unallocated payments" amount={balance.unallocated} tone={balance.unallocated !== '0.00' ? 'accent' : 'muted'} />
        <StatTile label="Net balance owed" amount={balance.netBalance} hint="Payable − unallocated" />
      </div>

      <details className="rounded-xl border bg-card p-4 text-sm shadow-card">
        <summary className="flex cursor-pointer items-center gap-2 font-medium">
          <Info className="size-4 text-primary" aria-hidden="true" /> How to read this ledger
        </summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Credit (+)</strong>: a bill from the supplier. It increases what the shop owes.
          </li>
          <li>
            <strong className="text-foreground">Debit (−)</strong>: money paid, either at purchase or as a later payment. It reduces what the shop owes.
          </li>
          <li>
            <strong className="text-foreground">Balance</strong>: the net amount owed to the supplier after each entry (bills − all payments).
          </li>
          <li>
            <strong className="text-foreground">Payable on bills</strong> counts only payments allocated to bills; money paid but not yet allocated is shown
            as <em>unallocated</em>. Net balance = payable − unallocated.
          </li>
          <li>Voided bills and reversed payments stay listed (crossed out) but never change a balance.</li>
          <li>There is no opening balance: the ledger starts with the first recorded bill or payment.</li>
        </ul>
      </details>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Input type="date" aria-label="From date" value={get('from')} onChange={(e) => update({ from: e.target.value })} />
        <Input type="date" aria-label="To date" value={get('to')} onChange={(e) => update({ to: e.target.value })} />
        <Select aria-label="Entry type" value={get('type')} onChange={(e) => update({ type: e.target.value })}>
          <option value="">All entry types</option>
          <option value="bill">Bills</option>
          <option value="paid_at_purchase">Paid at purchase</option>
          <option value="payment">Payments</option>
        </Select>
        <Select aria-label="Status" value={get('status')} onChange={(e) => update({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="active">Counted only</option>
          <option value="cancelled">Voided / reversed</option>
        </Select>
      </div>

      {broughtForward !== null && (
        <p className="flex justify-between rounded-lg bg-surface-muted px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Balance before {formatDate(get('from'))} (from earlier entries)</span>
          <strong className="figure">{formatInr(broughtForward)}</strong>
        </p>
      )}
      {truncated && <p className="text-sm text-warning">Only the first 2,000 entries are shown. Narrow the date range.</p>}

      {entries.length === 0 ? (
        <EmptyState icon={BookOpenText} title="No entries">
          {params.toString() ? 'No entries match these filters.' : 'Bills and payments for this supplier will appear here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {entries.map((e) => (
              <li key={e.key}>
                <Link to={linkFor(e)} className={cn('block space-y-1 rounded-xl border bg-card p-3 shadow-card', !e.counted && 'opacity-80')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {formatDate(e.date)} · {TYPE_LABELS[e.type]}
                      </p>
                      <p className="truncate text-sm font-medium">{e.description || TYPE_LABELS[e.type]}</p>
                    </div>
                    <Amount entry={e} />
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">{detailLine(e)}</span>
                    {e.counted ? <span className="figure shrink-0">Balance {formatInr(e.runningBalance)}</span> : <StatusBadge status={e.status} />}
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
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Reference</th>
                  <th className="px-4 py-2.5 font-medium">Description</th>
                  <th className="px-4 py-2.5 text-right font-medium">Credit (bill)</th>
                  <th className="px-4 py-2.5 text-right font-medium">Debit (paid)</th>
                  <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e) => (
                  <tr key={e.key} className={cn('align-top', !e.counted && 'text-muted-foreground')}>
                    <td className="whitespace-nowrap px-4 py-3">{formatDate(e.date)}</td>
                    <td className="whitespace-nowrap px-4 py-3">{TYPE_LABELS[e.type]}</td>
                    <td className="px-4 py-3">{e.reference ?? '—'}</td>
                    <td className="max-w-72 px-4 py-3">
                      <Link to={linkFor(e)} className="line-clamp-2 hover:underline">
                        {e.description || TYPE_LABELS[e.type]}
                      </Link>
                      {detailLine(e) && <span className="block text-xs text-muted-foreground">{detailLine(e)}</span>}
                    </td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', !e.counted && 'line-through')}>
                      {e.credit !== '0.00' ? formatInr(e.credit) : ''}
                    </td>
                    <td className={cn('figure whitespace-nowrap px-4 py-3 text-right', !e.counted && 'line-through')}>
                      {e.debit !== '0.00' ? formatInr(e.debit) : ''}
                    </td>
                    <td className="figure whitespace-nowrap px-4 py-3 text-right font-medium">{e.counted ? formatInr(e.runningBalance) : '—'}</td>
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
