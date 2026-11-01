import { ArrowDownRight, ArrowUpRight, Clock, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/finance/StatusBadge';
import { formatDate } from '@/lib/dates';
import { formatInr } from '@/lib/money';
import { cn } from '@/lib/utils';
import { TRANSACTION_LABELS, transactionLink, type TransactionRow } from './reports-api';

/** Section heading that says whether figures are PERIOD activity or CURRENT balances. */
export function SectionHeading({ title, kind, children }: { title: string; kind: 'period' | 'current'; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">
          {kind === 'period' ? 'Recorded in the selected period' : 'Current balance as of now — not affected by the period'}
        </p>
      </div>
      {children}
    </div>
  );
}

/** "↑ 12.5% vs ₹4,000.00 previous period" (more expense is shown neutrally, not as good/bad). */
export function ChangeNote({ change, previous }: { change: string | null; previous: string | null }) {
  if (previous === null) return null;
  if (change === null) return <p className="text-xs text-muted-foreground">Previous period: {formatInr(previous)}</p>;
  const down = change.startsWith('-');
  const Icon: LucideIcon = down ? ArrowDownRight : ArrowUpRight;
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" aria-hidden="true" />
      <span>
        {down ? change.slice(1) : change}% {down ? 'lower' : 'higher'} than the previous period ({formatInr(previous)})
      </span>
    </p>
  );
}

/** A labelled figure row inside a card. */
export function FigureRow({ label, amount, hint, tone }: { label: string; amount: string; hint?: string; tone?: 'warning' | 'accent' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">
        {label}
        {hint && <span className="block text-xs">{hint}</span>}
      </span>
      <span className={cn('figure shrink-0 font-medium', tone === 'warning' && 'text-warning', tone === 'accent' && 'text-primary')}>
        {formatInr(amount)}
      </span>
    </div>
  );
}

/** One transaction in a feed or history list (phones and compact cards). */
export function TransactionItem({ t }: { t: TransactionRow }) {
  const cancelled = t.status !== 'active';
  return (
    <Link to={transactionLink(t)} className="flex items-start justify-between gap-3 py-2.5 hover:bg-accent/40">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{TRANSACTION_LABELS[t.type]}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {formatDate(t.date)}
          {t.entity && ` · ${t.entity}`}
          {t.description && ` · ${t.description}`}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cn('figure text-sm font-semibold', cancelled && 'text-muted-foreground line-through')}>{formatInr(t.amount)}</span>
        {cancelled && <StatusBadge status={t.status} />}
      </span>
    </Link>
  );
}

export function GeneratedNote({ at }: { at?: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="size-3.5" aria-hidden="true" />
      Figures are recorded transactions{at ? `, calculated ${new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })} IST` : ''}.
    </p>
  );
}
