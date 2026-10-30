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

interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string; details?: ApiErrorDetail[] };
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON. */
  json?: unknown;
}

/**
 * The single entry point for talking to the API. Sends cookies (for Stage 2 sessions), parses the
 * server's consistent error envelope, and turns network failures into ApiError(status 0).
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { json, headers, ...init } = options;
  const finalHeaders = new Headers(headers);
  finalHeaders.set('Accept', 'application/json');
  let body: string | undefined;
  if (json !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`, {
      credentials: 'include',
      ...init,
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
    throw new ApiError(
      response.status,
      envelope.error?.code ?? 'HTTP_ERROR',
      envelope.error?.message ?? `The server responded with an error (${response.status}).`,
      envelope.error?.requestId,
      envelope.error?.details,
    );
  }
  return payload as T;
}
