import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { SESSION_QUERY_KEY } from '@/features/auth/auth-context';
import { ApiError } from '@/lib/api-client';
import { forgetPurchasePrices } from './products-api';

/**
 * Show/hide state for purchase prices on one screen.
 *
 * Revealed prices are tied to a "view signature" (e.g. page + filters + search + sort): when it
 * changes they are hidden automatically. They are also hidden when the tab goes to the background
 * and when the screen is left (unmount). Hiding removes every cached purchase price from memory.
 * Nothing is ever written to browser storage or the URL. Hiding in the browser is a convenience:
 * the API decides who may receive prices at all.
 */
export function usePurchasePriceReveal(signature: string) {
  const queryClient = useQueryClient();
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const revealed = revealedFor !== null && revealedFor === signature;

  const hide = useCallback(() => setRevealedFor(null), []);

  // Forget AFTER the price queries were switched off by the re-render: removing a query that is
  // still enabled makes it fetch again at once (prices back in memory, one more access record).
  useEffect(() => {
    if (!revealed) forgetPurchasePrices(queryClient);
  }, [revealed, queryClient]);

  // Another page / filter / search / sort: hide and forget.
  useEffect(() => {
    if (revealedFor !== null && revealedFor !== signature) hide();
  }, [signature, revealedFor, hide]);

  // Tab in the background: hide and forget.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [hide]);

  // Leaving the screen: forget.
  useEffect(() => () => forgetPurchasePrices(queryClient), [queryClient]);

  return { revealed, reveal: () => setRevealedFor(signature), hide };
}

/**
 * A purchase-price request failed: hide (nothing stale stays visible). A 403 means the permission
 * was revoked since the screen loaded: the signed-in user is refreshed, so the screen stops
 * offering prices at all.
 */
export function useHidePricesOnError(error: unknown, hide: () => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!error || handled.current === error) return;
    handled.current = error;
    hide();
    const revoked = error instanceof ApiError && error.status === 403;
    toast({
      title: revoked ? 'You can no longer see purchase prices' : 'Could not load purchase prices',
      description: revoked ? 'Your access was changed by the owner.' : 'Check the connection and try again.',
      tone: 'error',
    });
    if (revoked) void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [error, hide, queryClient, toast]);
}
