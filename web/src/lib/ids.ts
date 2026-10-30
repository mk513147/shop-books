/**
 * A fresh Idempotency-Key value (random, 128 bits). crypto.randomUUID only exists in secure
 * contexts (HTTPS / localhost); getRandomValues also works over plain-HTTP LAN testing.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
