/**
 * Navigations to these paths must NEVER be answered with the cached app shell (index.html).
 *
 * Rule for all future work: every API endpoint and every private-document endpoint
 * (bill photographs, report downloads, ...) must live under /api/. Anything outside /api/ is
 * treated as a normal front-end route by the service worker.
 */
export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [/^\/api(\/|$)/];
