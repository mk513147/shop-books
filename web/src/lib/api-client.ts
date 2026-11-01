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

export function getCsrfToken(): string | null {
  return csrfToken;
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

export interface UploadOptions {
  /** Extra request headers (e.g. X-File-Name). */
  headers?: Record<string, string>;
  /** Upload progress, 0..1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Sends a file as a raw application/octet-stream body (the only non-JSON request the API accepts,
 * on its upload routes). Uses XMLHttpRequest because fetch cannot report upload progress.
 * Same session cookie, CSRF header and error envelope handling as apiRequest.
 */
export function uploadBinary<T>(path: string, body: Blob, options: UploadOptions = {}): Promise<T> {
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBaseUrl()}${normalisedPath}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON (e.g. a proxy error page): handled below.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T);
        return;
      }
      const envelope = (payload ?? {}) as ErrorEnvelope;
      if (xhr.status === 401) onUnauthorized?.();
      reject(
        new ApiError(
          xhr.status,
          envelope.error?.code ?? 'HTTP_ERROR',
          envelope.error?.message ??
            (xhr.status === 413 ? 'The file is too large (maximum 10 MB).' : `The server responded with an error (${xhr.status}).`),
          envelope.error?.requestId,
          envelope.error?.details,
        ),
      );
    };
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
