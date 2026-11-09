/**
 * The keep-alive ping: one GET to the Render health endpoint, validated, logged, never throwing.
 *
 * Deliberately tiny and dependency-free. It sends no credentials, cookies, query strings or request body,
 * reads no application data, and logs only: timestamp, target URL, HTTP status, duration, outcome, error text.
 */

export const REQUEST_TIMEOUT_MS = 15_000;
/** At most ONE retry (so at most two requests per scheduled run), after a short pause. */
export const MAX_RETRIES = 1;
export const RETRY_DELAY_MS = 5_000;

export type FailureReason =
  | 'network_error'
  | 'timeout'
  | 'http_error'
  | 'invalid_json'
  | 'unexpected_body';

export interface AttemptResult {
  attempt: number;
  success: boolean;
  httpStatus: number | null;
  durationMs: number;
  reason?: FailureReason;
  /** Error name/message only: never headers, cookies or response bodies. */
  error?: string;
}

export interface KeepAliveOptions {
  url: string;
  /** The execution (scheduled) time, recorded in every log line. */
  scheduledTime: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'error', entry: Record<string, unknown>) => void;
  /** Monotonic-ish clock for durations (injectable for tests). */
  now?: () => number;
}

export interface KeepAliveResult {
  success: boolean;
  attempts: AttemptResult[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const defaultLog: NonNullable<KeepAliveOptions['log']> = (level, entry) => {
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
};

/** One request. Never throws. */
export async function attemptPing(
  url: string,
  attempt: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => number,
): Promise<AttemptResult> {
  const started = now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const done = (r: Omit<AttemptResult, 'attempt' | 'durationMs'>): AttemptResult => ({
    attempt,
    durationMs: Math.max(0, Math.round(now() - started)),
    ...r,
  });

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'shop-books-render-keepalive/1.0', 'cache-control': 'no-cache' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      return done(
        timedOut || isAbort(err)
          ? { success: false, httpStatus: null, reason: 'timeout', error: `no response within ${timeoutMs} ms` }
          : { success: false, httpStatus: null, reason: 'network_error', error: describe(err) },
      );
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return done({ success: false, httpStatus: response.status, reason: 'http_error', error: `HTTP ${response.status}` });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return done(
        timedOut || isAbort(err)
          ? { success: false, httpStatus: response.status, reason: 'timeout', error: `body not received within ${timeoutMs} ms` }
          : { success: false, httpStatus: response.status, reason: 'network_error', error: describe(err) },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return done({ success: false, httpStatus: response.status, reason: 'invalid_json', error: 'response is not valid JSON' });
    }
    if (typeof body !== 'object' || body === null || (body as { status?: unknown }).status !== 'ok') {
      // The offending value is not logged: only the fact that it was not {"status":"ok"}.
      return done({ success: false, httpStatus: response.status, reason: 'unexpected_body', error: 'status is not "ok"' });
    }
    return done({ success: true, httpStatus: response.status });
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown error';
}

/** Runs the ping with at most one retry. Never throws; always resolves with what happened. */
export async function runKeepAlive(options: KeepAliveOptions): Promise<KeepAliveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? defaultLog;
  const now = options.now ?? (() => Date.now());
  const timestamp = new Date(options.scheduledTime).toISOString();
  const attempts: AttemptResult[] = [];

  for (let attempt = 1; attempt <= 1 + MAX_RETRIES; attempt++) {
    let result: AttemptResult;
    try {
      result = await attemptPing(options.url, attempt, fetchImpl, timeoutMs, now);
    } catch (err) {
      // attemptPing never throws; this is a last line of defence so a scheduled run can never crash.
      result = { attempt, success: false, httpStatus: null, durationMs: 0, reason: 'network_error', error: describe(err) };
    }
    attempts.push(result);
    const willRetry = !result.success && attempt <= MAX_RETRIES;
    try {
      log(result.success ? 'info' : 'error', {
        event: 'render_keepalive',
        timestamp,
        target: options.url,
        attempt,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        success: result.success,
        ...(result.success ? {} : { reason: result.reason, error: result.error, willRetry }),
      });
    } catch {
      // Logging must never break the run.
    }
    if (result.success) return { success: true, attempts };
    if (willRetry) await sleep(retryDelayMs);
  }
  return { success: false, attempts };
}
