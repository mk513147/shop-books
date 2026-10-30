export interface ApiErrorDetail {
  path: string;
  message: string;
}

/** A failed API call. `status` is 0 when the server could not be reached at all. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/+$/, '');
}

// --- Session plumbing --------------------------------------------------------------------------
// The CSRF token is held in memory only (never localStorage) and sent on state-changing requests.
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request (other than sign-in itself) gets 401, i.e. the session ended. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string; details?: ApiErrorDetail[] };
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON. State-changing requests always send a JSON body (the API requires it). */
  json?: unknown;
}

/**
 * The single entry point for talking to the API. Sends the session cookie, adds the CSRF header
 * and a JSON body to state-changing requests, parses the server's error envelope, and turns
 * network failures into ApiError(status 0).
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { json, headers, ...init } = options;
  const method = (init.method ?? 'GET').toUpperCase();
  const finalHeaders = new Headers(headers);
  finalHeaders.set('Accept', 'application/json');
  let body: string | undefined;
  if (!SAFE_METHODS.has(method)) {
    finalHeaders.set('Content-Type', 'application/json');
    body = JSON.stringify(json ?? {});
    if (csrfToken) finalHeaders.set('X-CSRF-Token', csrfToken);
  } else if (json !== undefined) {
    throw new Error(`${method} requests cannot have a body`);
  }

  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${normalisedPath}`, {
      credentials: 'include',
      ...init,
      method,
      headers: finalHeaders,
      body,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page): handled below.
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    const error = new ApiError(
      response.status,
      envelope.error?.code ?? 'HTTP_ERROR',
      envelope.error?.message ?? `The server responded with an error (${response.status}).`,
      envelope.error?.requestId,
      envelope.error?.details,
    );
    if (response.status === 401 && normalisedPath !== '/auth/login') onUnauthorized?.();
    throw error;
  }
  return payload as T;
}
