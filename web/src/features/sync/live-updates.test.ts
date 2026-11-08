import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { IDLE_AFTER_MS, LiveUpdates, POLL_INTERVAL_MS, type SyncEvent, type SyncResponse } from './live-updates';

const ME = 'u-me';
const NOW = Date.parse('2026-11-08T10:00:00Z');

const event = (id: number, extra: Partial<SyncEvent> = {}): SyncEvent => ({
  id: String(id),
  entityType: 'expense',
  entityId: `e${id}`,
  action: 'create',
  actor: { id: 'u-asha', name: 'Asha' },
  occurredAt: new Date(NOW - 1000).toISOString(),
  ...extra,
});

/** Two managers' phones are simulated by feeding responses into one client's engine. */
function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const notify = vi.fn();
  const responses: (SyncResponse | Error)[] = [];
  const fetchChanges = vi.fn(async (after: string | null) => {
    const next = responses.shift() ?? { cursor: after ?? '0', events: [], truncated: false };
    if (next instanceof Error) throw next;
    return next;
  });
  const live = new LiveUpdates({ queryClient, userId: ME, notify, fetchChanges, now: () => Date.now() });
  const roots = () => invalidate.mock.calls.map(([f]) => (f as { queryKey?: string[] })?.queryKey?.[0]);
  return { live, notify, fetchChanges, responses, invalidate, roots, queryClient };
}
const tick = (ms = POLL_INTERVAL_MS) => vi.advanceTimersByTimeAsync(ms);

describe('live updates (cross-device sync)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('starts from the current cursor without replaying old changes, then announces another manager’s new expense once', async () => {
    const { live, notify, fetchChanges, responses, roots } = setup();
    responses.push({ cursor: '100', events: [], truncated: false });
    live.start();
    await tick(0);
    expect(fetchChanges).toHaveBeenLastCalledWith(null, expect.anything());
    expect(notify).not.toHaveBeenCalled();

    responses.push({ cursor: '101', events: [event(101)], truncated: false });
    await tick();
    expect(fetchChanges).toHaveBeenLastCalledWith('100', expect.anything());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ id: 'sync-101', title: 'Asha added an expense', tone: 'info' });
    expect(notify.mock.calls[0]![0].description).toMatch(/^at /);
    // Only the affected data, each root once.
    expect(roots().sort()).toEqual(['brands', 'categories', 'expenses', 'reports', 'supplier-payments', 'suppliers']);

    // The same change re-sent (late-commit window) or an edit of it: no duplicate notification.
    responses.push({ cursor: '102', events: [event(101), event(102, { action: 'update' })], truncated: false });
    await tick();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0].title).toBe('Asha updated an expense');
    live.stop();
  });

  it('never notifies me about my own changes; skips the echo of this tab’s own save', async () => {
    const { live, notify, responses, invalidate, queryClient } = setup();
    responses.push({ cursor: '1', events: [], truncated: false });
    live.start();
    await tick(0);

    // My change from another phone: refresh silently.
    responses.push({ cursor: '2', events: [event(2, { actor: { id: ME, name: 'Me' } })], truncated: false });
    await tick();
    expect(notify).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();

    // A save in THIS tab just happened: its own echo causes no extra requests.
    invalidate.mockClear();
    await queryClient.getMutationCache().build(queryClient, { mutationFn: async () => 'ok' }).execute(undefined);
    responses.push({ cursor: '3', events: [event(3, { actor: { id: ME, name: 'Me' } })], truncated: false });
    await tick();
    expect(invalidate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    live.stop();
  });

  it('reconnects after a dropped connection, catches up from its cursor, and does not repeat or notify stale changes', async () => {
    const { live, notify, fetchChanges, responses, roots } = setup();
    responses.push({ cursor: '10', events: [], truncated: false });
    live.start();
    await tick(0);
    responses.push(new ApiError(0, 'NETWORK_ERROR', 'offline'), new ApiError(0, 'NETWORK_ERROR', 'offline'));
    await tick(); // fails
    await tick(2 * POLL_INTERVAL_MS); // backoff, fails again
    expect(fetchChanges).toHaveBeenCalledTimes(3);

    // Back online: one change while away is recent, one is old.
    responses.push({
      cursor: '12',
      events: [
        event(11, { entityType: 'supplier_payment', occurredAt: new Date(NOW - 60 * 60_000).toISOString() }),
        event(12, { entityType: 'customer_transaction' }),
      ],
      truncated: false,
    });
    live.wake(); // e.g. the 'online' event
    await tick(0);
    expect(fetchChanges).toHaveBeenLastCalledWith('10', expect.anything());
    expect(roots()).toEqual(expect.arrayContaining(['supplier-payments', 'suppliers', 'customers', 'reports']));
    expect(notify).toHaveBeenCalledTimes(1); // the hour-old change only refreshes data
    expect(notify.mock.calls[0]![0].title).toBe('Asha updated a customer ledger');
    live.stop();
  });

  it('pauses while hidden or idle and catches up immediately when used again', async () => {
    const { live, fetchChanges, responses } = setup();
    responses.push({ cursor: '1', events: [], truncated: false });
    live.start();
    await tick(0);
    live.setHidden(true);
    await tick(5 * POLL_INTERVAL_MS);
    expect(fetchChanges).toHaveBeenCalledTimes(1); // hidden: no requests at all
    const calls = fetchChanges.mock.calls.length;
    live.setHidden(false);
    await tick(0);
    expect(fetchChanges.mock.calls.length).toBe(calls + 1);

    await tick(IDLE_AFTER_MS + POLL_INTERVAL_MS);
    const idleCalls = fetchChanges.mock.calls.length;
    await tick(10 * POLL_INTERVAL_MS);
    expect(fetchChanges.mock.calls.length).toBe(idleCalls); // idle: no polling keeps the session alive
    live.touch();
    await tick(0);
    expect(fetchChanges.mock.calls.length).toBe(idleCalls + 1);
    live.stop();
  });

  it('summarises bursts, reloads everything after a very long absence, and stops when signed out', async () => {
    const { live, notify, responses, invalidate, fetchChanges } = setup();
    responses.push({ cursor: '1', events: [], truncated: false });
    live.start();
    await tick(0);
    responses.push({ cursor: '6', events: [2, 3, 4, 5, 6].map((i) => event(i)), truncated: false });
    await tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].title).toBe('5 updates from Asha');

    invalidate.mockClear();
    responses.push({ cursor: '900', events: [], truncated: true });
    await tick();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);

    responses.push(new ApiError(401, 'UNAUTHENTICATED', 'Please sign in'));
    await tick();
    const after = fetchChanges.mock.calls.length;
    await tick(10 * POLL_INTERVAL_MS);
    expect(fetchChanges.mock.calls.length).toBe(after);
  });
});
