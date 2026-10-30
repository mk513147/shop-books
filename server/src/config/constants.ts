/** Shared business conventions. See docs/architecture.md ("Financial data conventions"). */
export const CURRENCY = 'INR';
export const MONEY_DECIMAL_PLACES = 2;
/** All reporting-period boundaries are computed in this timezone. */
export const REPORTING_TIME_ZONE = 'Asia/Kolkata';
/** Financial year runs January (1) through December. */
export const FINANCIAL_YEAR_START_MONTH = 1;

/** Authentication policy (approved in Stage 2). See docs/architecture.md ("Authentication"). */
export const AUTH = {
  sessionIdleTimeoutMs: 12 * 60 * 60 * 1000,
  sessionAbsoluteTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  /** last_seen_at is only rewritten when older than this, to avoid a write on every request. */
  sessionTouchIntervalMs: 60 * 1000,
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
