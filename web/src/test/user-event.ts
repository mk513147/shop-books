import userEvent from '@testing-library/user-event';

export type TestUser = ReturnType<typeof userEvent.setup>;

/** Increases after every test (see setup.ts), so a user-event instance knows when its test is over. */
let testGeneration = 0;

/** Called by src/test/setup.ts after each test. */
export function endTestGeneration(): void {
  testGeneration++;
}

/**
 * `userEvent.setup()` that can only act during the test that created it.
 *
 * Why: when a test times out, Vitest moves on but does NOT stop it. Its remaining `await user.*`
 * calls keep running and, through the global `screen`, type into and click the NEXT test's freshly
 * rendered form. That makes an unrelated test fail with a misleading assertion (e.g. an empty
 * "Payment 1 amount" right after typing the total). Here every interaction of a finished test
 * rejects instead, so a timeout fails only the test that timed out.
 *
 * `delay: null`: user-event otherwise waits for a timer (`delay: 0`) between every keystroke and
 * pointer action. Those event-loop turns, not the app, were about half of the expense-form tests'
 * run time (76–79 s -> 41–44 s for ExpenseForm.test.tsx) and stretch further under CPU load. Every
 * event is still dispatched and wrapped in act(), so React state and effects settle after each
 * interaction exactly as before; asynchronous results are still awaited with findBy/waitFor.
 */
export function setupUser(options?: Parameters<typeof userEvent.setup>[0]): TestUser {
  const owner = testGeneration;
  const user = userEvent.setup({ delay: null, ...options });
  return new Proxy(user, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (owner !== testGeneration) {
          return Promise.reject(
            new Error(`user.${String(property)}() was called after its test had ended (it timed out or failed); it must not touch the next test's page.`),
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
