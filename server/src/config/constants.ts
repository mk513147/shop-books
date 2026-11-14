/** Shared business conventions. See docs/architecture.md ("Financial data conventions"). */
export const CURRENCY = 'INR';
export const MONEY_DECIMAL_PLACES = 2;
/** All reporting-period boundaries are computed in this timezone. */
export const REPORTING_TIME_ZONE = 'Asia/Kolkata';
/** Financial year runs January (1) through December. */
export const FINANCIAL_YEAR_START_MONTH = 1;

/**
 * Web-app compatibility level required by this API (GET /api/v1/version). Raise it together with
 * API_COMPAT_LEVEL in web/src/features/system/app-update.ts only when an API change needs the new
 * frontend: open apps built for a lower level then refresh themselves (when nothing is unsaved).
 */
export const CLIENT_COMPAT_LEVEL = 1;

/** Authentication policy (approved in Stage 2). See docs/architecture.md ("Authentication"). */
export const AUTH = {
  /** A session unused for this long is dead. */
  sessionIdleTimeoutMs: 30 * 24 * 60 * 60 * 1000,
  /**
   * Rolling lifetime: `sessions.absolute_expires_at` is pushed to now + this whenever the session is
   * renewed (see findActiveSession). Same value as the idle timeout.
   */
  sessionLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  /**
   * Hard cap measured from `sessions.created_at`: renewal can never push the expiry beyond it, so a
   * session is never permanent and every browser signs in again at least this often.
   */
  sessionMaxAgeMs: 90 * 24 * 60 * 60 * 1000,
  /**
   * Renewal granularity: last_seen_at and the expiry are rewritten (and the cookie re-issued) at most
   * this often per session, i.e. about one write per manager per day instead of one per request.
   */
  sessionTouchIntervalMs: 24 * 60 * 60 * 1000,
  /** Failed attempts that trigger a lockout. */
  maxFailedAttempts: 5,
  /** First lockout; each further lockout doubles it, up to the maximum. */
  baseLockoutMs: 15 * 60 * 1000,
  maxLockoutMs: 4 * 60 * 60 * 1000,
  /** Per-IP limit: failed logins from one address within the window before answering 429. */
  ipFailureLimit: 20,
  ipFailureWindowMs: 15 * 60 * 1000,
  passwordMinLength: 12,
  passwordMaxLength: 128,
} as const;
