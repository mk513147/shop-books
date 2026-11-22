import { useMutation, type MutateOptions, type UseMutationResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

/**
 * A mutation whose INPUT may contain a purchase price (typed by the user).
 *
 * TanStack Query keeps every mutation's `variables` and result (`data`) in the MutationCache, and
 * on the hook, for as long as the screen is mounted and then for `gcTime` (5 minutes by default).
 * That would keep confidential prices in memory after the user hid them, after the permission was
 * revoked, or after the screen was left. So:
 *
 *  - the confidential input is handed to the request through a ref, keyed by a one-off token, and
 *    dropped as soon as the request starts (also on unmount); the mutation's recorded `variables`
 *    are only the token plus a NON-confidential projection (`publicPart`, e.g. the supplier id used
 *    for a row's spinner);
 *  - `mutationFn` must return nothing confidential (callers put a price answer only into a query
 *    that is on screen, never into the mutation result);
 *  - `gcTime: 0`: the finished mutation leaves the cache as soon as nothing observes it.
 *
 * Errors are ApiErrors (code + server message); the server never puts amounts in error messages.
 */
type Recorded<TPublic> = TPublic & { readonly token: number };

export type ConfidentialMutation<TInput, TPublic, TResult> = Omit<UseMutationResult<TResult, Error, Recorded<TPublic>>, 'mutate' | 'mutateAsync'> & {
  mutate: (input: TInput, options?: MutateOptions<TResult, Error, Recorded<TPublic>>) => void;
  mutateAsync: (input: TInput, options?: MutateOptions<TResult, Error, Recorded<TPublic>>) => Promise<TResult>;
};

let nextToken = 0;

export function useConfidentialMutation<TInput, TPublic extends object, TResult = void>({
  mutationFn,
  publicPart,
  onSettled,
}: {
  mutationFn: (input: TInput) => Promise<TResult>;
  publicPart: (input: TInput) => TPublic;
  onSettled?: () => void;
}): ConfidentialMutation<TInput, TPublic, TResult> {
  const inputs = useRef(new Map<number, TInput>());
  useEffect(() => {
    const pending = inputs.current;
    return () => pending.clear();
  }, []);

  const mutation = useMutation<TResult, Error, Recorded<TPublic>>({
    mutationFn: ({ token }) => {
      const input = inputs.current.get(token);
      inputs.current.delete(token);
      if (input === undefined) return Promise.reject(new Error('This change was cancelled. Try again.'));
      return mutationFn(input);
    },
    gcTime: 0,
    ...(onSettled ? { onSettled } : {}),
  });

  const { mutate: run, mutateAsync: runAsync } = mutation;
  const record = useCallback(
    (input: TInput): Recorded<TPublic> => {
      nextToken += 1;
      inputs.current.set(nextToken, input);
      return { ...publicPart(input), token: nextToken };
    },
    [publicPart],
  );
  const mutate = useCallback((input: TInput, options?: MutateOptions<TResult, Error, Recorded<TPublic>>) => run(record(input), options), [run, record]);
  const mutateAsync = useCallback(
    (input: TInput, options?: MutateOptions<TResult, Error, Recorded<TPublic>>) => runAsync(record(input), options),
    [runAsync, record],
  );
  return { ...mutation, mutate, mutateAsync };
}
