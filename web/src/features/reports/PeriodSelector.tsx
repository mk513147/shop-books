import { CalendarRange } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatDate, todayInKolkata } from '@/lib/dates';
import { cn } from '@/lib/utils';
import type { ReportPeriod } from './reports-api';

export const PERIOD_OPTIONS = [
  ['today', 'Today'],
  ['this_week', 'This week'],
  ['this_month', 'This month'],
  ['previous_month', 'Previous month'],
  ['this_quarter', 'This quarter'],
  ['this_year', 'This year'],
  ['all_time', 'All time'],
  ['custom', 'Custom range'],
] as const;

/**
 * Reporting period kept in the URL (?period=…&from=…&to=…) so it survives reloads and is shared by
 * every card on a page. The server resolves presets to explicit Asia/Kolkata dates.
 */
export function usePeriodParams(defaultPeriod = 'this_month') {
  const [params, setParams] = useSearchParams();
  const period = params.get('period') ?? defaultPeriod;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const customReady = period !== 'custom' || (from !== '' && to !== '' && from <= to);
  return {
    period,
    from,
    to,
    /** Query params for the API; null while a custom range is incomplete. */
    query: customReady ? { period, ...(period === 'custom' ? { from, to } : {}) } : null,
    params,
    set(next: Record<string, string>) {
      const merged = new URLSearchParams(params);
      for (const [k, v] of Object.entries(next)) {
        if (v) merged.set(k, v);
        else merged.delete(k);
      }
      if ('period' in next && next.period !== 'custom') {
        merged.delete('from');
        merged.delete('to');
      }
      if (!('page' in next)) merged.delete('page');
      setParams(merged, { replace: true });
    },
  };
}

export function PeriodSelector({
  state,
  resolved,
  exclude = [],
}: {
  state: ReturnType<typeof usePeriodParams>;
  /** The server-resolved period, shown as explicit dates. */
  resolved?: ReportPeriod;
  exclude?: string[];
}) {
  const today = todayInKolkata();
  const options = PERIOD_OPTIONS.filter(([v]) => !exclude.includes(v));
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <label className="sr-only" htmlFor="report-period">
          Reporting period
        </label>
        {/* Phones and tablets: the native picker (eight choices do not fit in one row). */}
        <Select id="report-period" className="sm:w-52 xl:hidden" value={state.period} onChange={(e) => state.set({ period: e.target.value })}>
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        {/* Wide screens: the same choices as a segmented control. */}
        <div role="group" aria-label="Reporting period presets" className="hidden gap-1 rounded-xl bg-surface-muted p-1 xl:flex">
          {options.map(([value, label]) => {
            const active = state.period === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => state.set({ period: value })}
                className={cn(
                  'inline-flex min-h-10 items-center rounded-lg px-3 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-card font-semibold text-foreground shadow-card' : 'font-medium text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        {resolved && (
          <p className="figure inline-flex w-fit items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-card">
            <CalendarRange className="size-3.5" aria-hidden="true" />
            {resolved.preset === 'all_time' ? 'All recorded transactions' : `${formatDate(resolved.from)} – ${formatDate(resolved.to)}`}
          </p>
        )}
      </div>
      {state.period === 'custom' && (
        <div className="grid animate-fade-in grid-cols-2 gap-2 sm:flex sm:items-center">
          <Input type="date" aria-label="From date" className="sm:w-44" max={today} value={state.from} onChange={(e) => state.set({ from: e.target.value })} />
          <span aria-hidden="true" className="hidden text-sm text-muted-foreground sm:inline">
            to
          </span>
          <Input type="date" aria-label="To date" className="sm:w-44" max={today} value={state.to} onChange={(e) => state.set({ to: e.target.value })} />
        </div>
      )}
      {state.period === 'custom' && !state.query && <p className="text-sm text-muted-foreground">Choose a start and an end date.</p>}
    </div>
  );
}
