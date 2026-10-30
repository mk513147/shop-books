import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes (256 bits), base64url-encoded. Only its SHA-256 digest is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Plausibility check before hashing: rejects junk cookies cheaply. */
export function isWellFormedSessionToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The CSRF token is derived from the session token with a server-side secret, so it needs no
 * storage, changes whenever the session changes, and cannot be computed by an attacker.
 */
export function csrfTokenFor(sessionToken: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
