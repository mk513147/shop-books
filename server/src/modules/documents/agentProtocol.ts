import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Wire protocol between the API (the `agent` storage driver) and the storage agent on the owner's
 * desktop. Every request is signed; the secret itself never travels.
 *
 *   signature = HMAC-SHA256(secret, `${METHOD}\n${pathAndQuery}\n${timestamp}\n${contentSha256Hex}`)
 *
 * `timestamp` is milliseconds since the epoch and must be within MAX_CLOCK_SKEW_MS of the agent's
 * clock, which limits replays to a short window (PUT is idempotent and DELETE of a deleted object is
 * a no-op, so a replay inside the window changes nothing). `contentSha256Hex` is the SHA-256 of the
 * request body for PUT and "" otherwise; the agent re-hashes the received bytes.
 */
export const AGENT_HEADERS = {
  timestamp: 'x-shopbooks-timestamp',
  signature: 'x-shopbooks-signature',
  contentSha256: 'x-shopbooks-content-sha256',
} as const;

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function signAgentRequest(secret: string, method: string, pathAndQuery: string, timestamp: string, contentSha256Hex = ''): string {
  return createHmac('sha256', secret).update(`${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${contentSha256Hex}`).digest('hex');
}

/** Constant-time check of a request's signature and timestamp. Returns a reason when rejected. */
export function verifyAgentRequest(
  secret: string,
  request: { method: string; pathAndQuery: string; timestamp: string | undefined; signature: string | undefined; contentSha256Hex?: string },
  now = Date.now(),
): string | null {
  const { timestamp, signature } = request;
  if (!timestamp || !/^\d{13}$/.test(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return 'missing or malformed signature';
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return 'timestamp outside the allowed window';
  const expected = Buffer.from(signAgentRequest(secret, request.method, request.pathAndQuery, timestamp, request.contentSha256Hex ?? ''), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? null : 'bad signature';
}
