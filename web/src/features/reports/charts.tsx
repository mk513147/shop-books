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
export function share(amount: string, max: bigint): number {
  if (max <= 0n) return 0;
  return Number((toPaise(amount) * 10_000n) / max) / 100;
}

/**
 * Monthly expense columns (one series, one accent hue). Each column is focusable and shows its
 * exact value on hover/focus; "Show table" gives the same data as a table. Columns grow in once
 * when the chart appears (transform only; skipped with reduced motion).
 */
export function TrendChart({ points, highlightFrom }: { points: TrendPoint[]; highlightFrom?: string }) {
  const [table, setTable] = useState(false);
  const id = useId();
  let maxPoint: TrendPoint | null = null;
  for (const p of points) if (!maxPoint || toPaise(p.amount) > toPaise(maxPoint.amount)) maxPoint = p;
  const max = maxPoint ? toPaise(maxPoint.amount) : 0n;
  if (points.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  return (
    <div className="space-y-3">
      {table ? (
        <table className="data-table animate-fade-in" aria-describedby={`${id}-title`}>
          <thead>
            <tr>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2 text-right">Expenses</th>
              <th className="px-3 py-2 text-right">Count</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.month}>
                <td className="px-3 py-2">{monthName(p.month, true)}</td>
                <td className="figure px-3 py-2 text-right">{formatInr(p.amount)}</td>
                <td className="figure px-3 py-2 text-right">{p.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative pt-5">
          {/* Scale: the highest month, so the bars can be read without hovering. */}
          {maxPoint && max > 0n && (
            <p className="figure absolute left-0 top-0 text-[0.6875rem] text-muted-foreground" aria-hidden="true">
              {formatInr(maxPoint.amount)}
            </p>
          )}
          {/* Recessive top line, mid grid line and baseline. */}
          <div className="absolute inset-x-0 top-5 border-t border-dashed border-border" aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-[calc(1.5rem+5.25rem)] border-t border-dashed border-border/70" aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-6 border-t border-border" aria-hidden="true" />
          <ul className="relative flex h-48 items-end gap-1.5 sm:gap-3" aria-label="Monthly expenses">
            {points.map((p, i) => {
              const pct = share(p.amount, max);
              const inPeriod = !highlightFrom || p.month >= highlightFrom.slice(0, 7);
              return (
                <li key={p.month} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                  <button
                    type="button"
                    className="flex h-[calc(100%-1.5rem)] w-full items-end justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${monthName(p.month, true)}: ${formatInr(p.amount)}, ${p.count} expense(s)`}
                  >
                    <span
                      className={cn(
                        'block w-full max-w-11 origin-bottom animate-grow-y rounded-t-md transition-[background-color,opacity] duration-150',
                        inPeriod ? 'bg-primary group-hover:bg-primary-hover' : 'bg-primary/30 group-hover:bg-primary/45',
                      )}
                      style={{ height: p.amount === '0.00' ? '2px' : `${Math.max(pct, 1.5)}%`, animationDelay: `${i * 40}ms` }}
                    />
                  </button>
                  <span className={cn('h-6 pt-1.5 text-[0.6875rem]', inPeriod ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                    {monthName(p.month)}
                  </span>
                  {/* Tooltip (hover and keyboard focus). */}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-lg border bg-card px-2.5 py-1.5 text-xs shadow-raised group-focus-within:block group-hover:block"
                  >
                    <strong className="block font-semibold">{monthName(p.month, true)}</strong>
                    <span className="figure">{formatInr(p.amount)}</span> · {p.count} expense(s)
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="inline-flex min-h-9 items-center text-xs font-medium text-primary underline-offset-2 hover:underline"
        onClick={() => setTable((t) => !t)}
      >
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
    <ul className="space-y-3.5">
      {items.map((i, index) => (
        <li key={i.key} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">
              {i.href ? (
                <Link to={i.href} className="block truncate font-medium hover:text-primary hover:underline">
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
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
            <div
              className="h-1.5 origin-left animate-grow-x rounded-full bg-primary"
              style={{ width: `${i.amount === '0.00' ? 0 : Math.max(share(i.amount, max), 1)}%`, animationDelay: `${Math.min(index, 10) * 30}ms` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface CompositionPart {
  key: string;
  label: string;
  amount: string;
  /** jade = paid (soft jade = paid later), amber = still owed, blue = neutral. */
  tone: 'accent' | 'accentSoft' | 'warning' | 'info';
}

const PART_FILL = { accent: 'bg-primary', accentSoft: 'bg-primary/40', warning: 'bg-warning-strong', info: 'bg-info' } as const;

/**
 * How one server total splits into parts (e.g. paid now / settled later / still payable): a single
 * proportional bar plus a legend with the exact figures. The legend carries the meaning in words;
 * the bar only shows proportions.
 */
export function CompositionBar({ total, parts }: { total: string; parts: CompositionPart[] }) {
  const whole = toPaise(total);
  return (
    <div className="space-y-3">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
        {whole > 0n &&
          parts.map((p, i) =>
            p.amount === '0.00' ? null : (
              <span
                key={p.key}
                className={cn('h-full origin-left animate-grow-x first:rounded-l-full last:rounded-r-full', PART_FILL[p.tone])}
                style={{ width: `${Math.max(share(p.amount, whole), 1)}%`, animationDelay: `${i * 80}ms` }}
              />
            ),
          )}
      </div>
      <dl className="divide-y">
        {parts.map((p) => (
          <div key={p.key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', PART_FILL[p.tone])} />
              {p.label}
            </dt>
            <dd className={cn('figure shrink-0 font-semibold', p.tone === 'warning' && p.amount !== '0.00' && 'text-warning')}>{formatInr(p.amount)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
