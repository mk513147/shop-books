import type { QueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '@/lib/api-client';

/**
 * Live updates across phones and sessions.
 *
 * The API exposes a read-only change feed (GET /sync/changes) built from the financial audit log,
 * which every successful write appends to in the same transaction. Each open app polls it with
 * the highest change id it has seen, and for every new change:
 *   - refreshes only the data that change can affect (TanStack Query invalidation: screens on
 *     display refetch, everything else is marked stale);
 *   - shows a small toast when ANOTHER person made the change.
 *
 * Why polling (and not SSE / WebSockets): the API runs on a host where long-lived connections
 * and several instances are not guaranteed, and the feed is in PostgreSQL, so a short GET every
 * few seconds is the simplest thing that is always correct, reconnects by itself and needs no
 * extra service. Polling pauses while the app is hidden or the user is idle (so sessions still
 * expire after the server's idle timeout) and backs off while the server is unreachable.
 *
 * Unsaved input is never touched: forms keep their own values (and the version they were opened
 * with), so a refetch never overwrites what someone is typing.
 */

export type SyncEntityType =
  | 'expense'
  | 'expense_category'
  | 'brand'
  | 'supplier'
  | 'supplier_payment'
  | 'customer'
  | 'customer_transaction'
  | 'salesman';

export interface SyncEvent {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  action: string;
  actor: { id: string; name: string } | null;
  occurredAt: string;
}

export interface SyncResponse {
  cursor: string;
  events: SyncEvent[];
  truncated: boolean;
}

export const POLL_INTERVAL_MS = 10_000;
export const MAX_BACKOFF_MS = 60_000;
/** No polling after this long without any interaction (the session can then expire normally). */
export const IDLE_AFTER_MS = 15 * 60_000;
/** Own changes made in THIS tab within this window were already refreshed by the mutation itself. */
export const OWN_MUTATION_GRACE_MS = 20_000;
/** Older changes (e.g. after a long disconnection) refresh data silently instead of notifying. */
export const NOTIFY_MAX_AGE_MS = 10 * 60_000;
/** More notifications than this in one poll are summarised in a single toast. */
export const MAX_INDIVIDUAL_TOASTS = 3;
const SEEN_LIMIT = 2000;

/** Query-key roots (first element) that each kind of change can affect. */
export const AFFECTED: Record<SyncEntityType, string[]> = {
  // Expenses feed lists, totals, reports, supplier balances/open bills and category/brand usage.
  expense: ['expenses', 'reports', 'suppliers', 'supplier-payments', 'categories', 'brands'],
  expense_category: ['categories', 'expenses', 'reports', 'suppliers'],
  brand: ['brands', 'expenses', 'suppliers'],
  supplier: ['suppliers', 'expenses', 'reports', 'supplier-payments'],
  supplier_payment: ['supplier-payments', 'suppliers', 'expenses', 'reports'],
  customer: ['customers', 'reports'],
  customer_transaction: ['customers', 'reports'],
  salesman: ['salesmen'],
};

const PHRASES: Record<SyncEntityType, Record<string, string> & { default: string }> = {
  expense: {
    create: 'added an expense',
    update: 'updated an expense',
    void: 'voided an expense',
    restore: 'restored an expense',
    document_add: 'attached a bill document',
    document_remove: 'removed a bill document',
    allocate: 'settled a bill with a supplier payment',
    release_allocation: 'released a supplier payment from a bill',
    default: 'changed an expense',
  },
  expense_category: {
    create: 'added a category',
    archive: 'archived a category',
    reactivate: 'reactivated a category',
    default: 'updated a category',
  },
  brand: { create: 'added a brand', archive: 'archived a brand', reactivate: 'reactivated a brand', default: 'updated a brand' },
  supplier: {
    create: 'added a supplier',
    update: 'updated supplier details',
    archive: 'archived a supplier',
    reactivate: 'reactivated a supplier',
    link_category: 'updated a supplier’s usual categories',
    unlink_category: 'updated a supplier’s usual categories',
    link_brand: 'updated a supplier’s brands',
    unlink_brand: 'updated a supplier’s brands',
    default: 'updated a supplier',
  },
  supplier_payment: {
    create: 'recorded a supplier payment',
    update: 'edited a supplier payment',
    allocate: 'allocated a supplier payment',
    release_allocation: 'released a supplier payment allocation',
    reverse: 'reversed a supplier payment',
    default: 'updated a supplier payment',
  },
  customer: {
    create: 'added a customer',
    update: 'updated customer details',
    archive: 'archived a customer',
    reactivate: 'reactivated a customer',
    default: 'updated a customer',
  },
  customer_transaction: { create: 'updated a customer ledger', reverse: 'reversed a customer ledger entry', default: 'updated a customer ledger' },
  salesman: {
    create: 'added a salesman',
    update: 'updated salesman details',
    archive: 'deactivated a salesman',
    reactivate: 'reactivated a salesman',
    default: 'updated a salesman',
  },
};

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** Toast text: who did what kind of change, and when. Never amounts, names of records or reasons. */
export function describeEvent(event: SyncEvent): { title: string; description: string } {
  const phrases = PHRASES[event.entityType];
  const what = phrases?.[event.action] ?? phrases?.default ?? 'made a change';
  const who = event.actor?.name || 'Someone';
  return { title: `${who} ${what}`, description: `at ${timeFormat.format(new Date(event.occurredAt))}` };
}

export type Notify = (toast: { id: string; title: string; description?: string; tone: 'info' }) => void;

export interface LiveUpdatesOptions {
  queryClient: QueryClient;
  /** The signed-in user (their own changes are never announced to them). */
  userId: string;
  notify: Notify;
  now?: () => number;
  fetchChanges?: (after: string | null, signal: AbortSignal) => Promise<SyncResponse>;
}

const defaultFetch = (after: string | null, signal: AbortSignal) =>
  apiRequest<SyncResponse>(`/sync/changes${after === null ? '' : `?after=${encodeURIComponent(after)}`}`, { signal });

/**
 * The polling engine (no React): `start()` begins, `stop()` ends. `wake()` polls immediately
 * (e.g. the app became visible or the phone came back online), `touch()` records user activity.
 */
export class LiveUpdates {
  private cursor: string | null = null;
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private inFlight = false;
  private pollAgain = false;
  private failures = 0;
  private lastActivity: number;
  private lastOwnMutation = Number.NEGATIVE_INFINITY;
  private hidden = false;
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly fetchChanges: NonNullable<LiveUpdatesOptions['fetchChanges']>;

  constructor(private readonly options: LiveUpdatesOptions) {
    this.now = options.now ?? Date.now;
    this.fetchChanges = options.fetchChanges ?? defaultFetch;
    this.lastActivity = this.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Successful writes from THIS tab refresh their own data; remember when, to skip the echo.
    this.unsubscribe = this.options.queryClient.getMutationCache().subscribe((e) => {
      if (e.type === 'updated' && e.mutation.state.status === 'success') this.lastOwnMutation = this.now();
    });
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
  }

  /** Records user activity; resumes polling at once if it had paused for inactivity. */
  touch(): void {
    const wasIdle = this.isIdle();
    this.lastActivity = this.now();
    if (wasIdle) this.wake();
  }

  /** Back in the foreground: catch up at once (refreshes anything that changed meanwhile). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) return;
    this.lastActivity = this.now();
    this.wake();
  }

  /** Poll now (coming back online / to the foreground). Concurrent requests are never made. */
  wake(): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.pollAgain = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.poll();
  }

  private isIdle(): boolean {
    return this.now() - this.lastActivity > IDLE_AFTER_MS;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (!this.running || this.inFlight) return;
    // Paused: hidden or idle. Visibility/activity calls wake() again.
    if (this.hidden || this.isIdle()) return;
    this.inFlight = true;
    this.controller = new AbortController();
    try {
      const res = await this.fetchChanges(this.cursor, this.controller.signal);
      if (!this.running) return;
      this.apply(res);
      this.failures = 0;
    } catch (err) {
      if (!this.running || (err instanceof DOMException && err.name === 'AbortError')) return;
      // 401: the session ended; the app returns to sign-in (handled by the API client). Stop here.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        this.stop();
        return;
      }
      this.failures += 1;
    } finally {
      this.inFlight = false;
      this.controller = null;
    }
    if (this.pollAgain) {
      this.pollAgain = false;
      this.schedule(0);
    } else {
      this.schedule(this.failures === 0 ? POLL_INTERVAL_MS : Math.min(POLL_INTERVAL_MS * 2 ** this.failures, MAX_BACKOFF_MS));
    }
  }

  private apply(res: SyncResponse): void {
    const first = this.cursor === null;
    this.cursor = res.cursor;
    const qc = this.options.queryClient;
    if (res.truncated) {
      // Away too long for an itemised list: reload everything on screen (except the session).
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      this.options.notify({ id: `sync-reload-${res.cursor}`, title: 'Updated with the latest changes', tone: 'info' });
      return;
    }
    if (first) return; // the first answer only sets the starting point

    const roots = new Set<string>();
    const announce: SyncEvent[] = [];
    const ownTabRecently = this.now() - this.lastOwnMutation < OWN_MUTATION_GRACE_MS;
    for (const event of res.events) {
      if (this.seen.has(event.id)) continue; // re-sent window or a repeated poll: already handled
      this.seen.add(event.id);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
      const mine = event.actor?.id === this.options.userId;
      // This tab's own write already refreshed its data; skip the echo (no duplicate requests).
      if (mine && ownTabRecently) continue;
      for (const root of AFFECTED[event.entityType] ?? []) roots.add(root);
      // Own changes from another phone refresh silently; others' recent changes are announced.
      if (!mine && this.now() - Date.parse(event.occurredAt) < NOTIFY_MAX_AGE_MS) announce.push(event);
    }
    for (const root of roots) void qc.invalidateQueries({ queryKey: [root] });

    if (announce.length > MAX_INDIVIDUAL_TOASTS) {
      const people = [...new Set(announce.map((e) => e.actor?.name || 'Someone'))];
      this.options.notify({
        id: `sync-batch-${announce.at(-1)!.id}`,
        title: `${announce.length} updates from ${people.length === 1 ? people[0] : 'other managers'}`,
        description: 'The screens have been refreshed.',
        tone: 'info',
      });
    } else {
      for (const event of announce) this.options.notify({ id: `sync-${event.id}`, ...describeEvent(event), tone: 'info' });
    }
  }
}
