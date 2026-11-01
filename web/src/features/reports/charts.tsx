import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatInr, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { TrendPoint } from './reports-api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym: string, long = false) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return long ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1]!;
};

/**
 * Bar geometry only: the ratio of two server-computed amounts, as a CSS percentage. Never used for
 * any displayed or stored figure (those are the server's decimal strings).
 */
function share(amount: string, max: bigint): number {
  if (max <= 0n) return 0;
  return Number((toPaise(amount) * 10_000n) / max) / 100;
}

/**
 * Monthly expense columns (one series, one accent hue). Each column is focusable and shows its
 * exact value on hover/focus; "Show table" gives the same data as a table.
 */
export function TrendChart({ points, highlightFrom }: { points: TrendPoint[]; highlightFrom?: string }) {
  const [table, setTable] = useState(false);
  const id = useId();
  const max = points.reduce((m, p) => (toPaise(p.amount) > m ? toPaise(p.amount) : m), 0n);
  if (points.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  return (
    <div className="space-y-2">
      {table ? (
        <table className="w-full text-sm" aria-describedby={`${id}-title`}>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Month</th>
              <th className="py-1 text-right font-medium">Expenses</th>
              <th className="py-1 text-right font-medium">Count</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {points.map((p) => (
              <tr key={p.month}>
                <td className="py-1.5">{monthName(p.month, true)}</td>
                <td className="figure py-1.5 text-right">{formatInr(p.amount)}</td>
                <td className="figure py-1.5 text-right">{p.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          {/* Recessive baseline and mid grid line. */}
          <div className="absolute inset-x-0 bottom-6 border-t border-border" aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-[calc(1.5rem+4rem)] border-t border-dashed border-border/60" aria-hidden="true" />
          <ul className="relative flex h-44 items-end gap-0.5" aria-label="Monthly expenses">
            {points.map((p) => {
              const pct = share(p.amount, max);
              const inPeriod = !highlightFrom || p.month >= highlightFrom.slice(0, 7);
              return (
                <li key={p.month} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                  <button
                    type="button"
                    className="flex h-[calc(100%-1.5rem)] w-full items-end justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${monthName(p.month, true)}: ${formatInr(p.amount)}, ${p.count} expense(s)`}
                  >
                    <span
                      className={cn('block w-full max-w-10 rounded-t-[4px]', inPeriod ? 'bg-primary' : 'bg-primary/45')}
                      style={{ height: p.amount === '0.00' ? '2px' : `${Math.max(pct, 1.5)}%` }}
                    />
                  </button>
                  <span className="h-6 pt-1 text-[11px] text-muted-foreground">{monthName(p.month)}</span>
                  {/* Tooltip (hover and keyboard focus). */}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-raised group-focus-within:block group-hover:block"
                  >
                    <strong className="block">{monthName(p.month, true)}</strong>
                    <span className="figure">{formatInr(p.amount)}</span> · {p.count} expense(s)
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setTable((t) => !t)}>
        {table ? 'Show chart' : 'Show as table'}
      </button>
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  /** Secondary text under the label (e.g. "3 expenses · archived"). */
  detail?: string;
  amount: string;
  /** Right-hand text after the amount (e.g. "38.5%"). */
  note?: string;
  href?: string;
}

/**
 * Horizontal bars with the label and exact value always visible as text (the list doubles as the
 * table view). One hue: bars compare magnitude; identity comes from the labels.
 */
export function BarList({ items, empty = 'Nothing recorded in this period.' }: { items: BarItem[]; empty?: string }) {
  const max = items.reduce((m, i) => (toPaise(i.amount) > m ? toPaise(i.amount) : m), 0n);
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">
              {i.href ? (
                <Link to={i.href} className="block truncate font-medium hover:underline">
                  {i.label}
                </Link>
              ) : (
                <span className="block truncate font-medium">{i.label}</span>
              )}
              {i.detail && <span className="block text-xs text-muted-foreground">{i.detail}</span>}
            </span>
            <span className="shrink-0 text-right">
              <span className="figure font-semibold">{formatInr(i.amount)}</span>
              {i.note && <span className="block text-xs text-muted-foreground">{i.note}</span>}
            </span>
          </div>
          <div className="h-2 rounded-[4px] bg-surface-muted" aria-hidden="true">
            <div className="h-2 rounded-[4px] bg-primary" style={{ width: `${i.amount === '0.00' ? 0 : Math.max(share(i.amount, max), 1)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
