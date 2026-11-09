import { AUTH } from '../../config/constants.js';
import type { Queryable } from '../../database/connection.js';
import type { RequestContext } from './auth.events.js';
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from './tokens.js';

export type Role = 'owner' | 'manager';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface SessionContext {
  sessionId: string;
  /** The raw token from the cookie, kept only in memory for CSRF derivation. Never logged. */
  token: string;
  user: AuthenticatedUser;
  /**
   * Set only when this request extended the session: the new expiry, so the caller re-issues the
   * SAME cookie value with a later Expires. Never set on ordinary requests (no Set-Cookie churn).
   */
  renewedExpiresAt?: Date;
}

export type RevocationReason =
  | 'logout'
  | 'password_changed'
  | 'password_reset'
  | 'user_deactivated'
  | 'revoked_by_owner';

export interface NewSession {
  token: string;
  sessionId: string;
  absoluteExpiresAt: Date;
}

export async function createSession(db: Queryable, userId: string, ctx: RequestContext): Promise<NewSession> {
  const token = generateSessionToken();
  const result = await db.query<{ id: string; absolute_expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'), $4::inet, $5)
     RETURNING id, absolute_expires_at`,
    [userId, hashSessionToken(token), AUTH.sessionLifetimeMs, ctx.ip, ctx.userAgent],
  );
  const row = result.rows[0]!;
  return { token, sessionId: row.id, absoluteExpiresAt: row.absolute_expires_at };
}

interface SessionRow {
  session_id: string;
  needs_renewal: boolean;
  user_id: string;
  email: string;
  name: string;
  role: Role;
  must_change_password: boolean;
}

/**
 * Validates a session token entirely server-side: not revoked, before its
 * rolling expiry, within the idle timeout and the hard maximum age, and belonging to an ACTIVE user.
 * Identity and role come only from the database, never from the client.
 *
 * Rolling renewal (the token never changes): when the session was last renewed more than
 * sessionTouchIntervalMs ago, OR its expiry is more than that interval short of what a renewal
 * would give now (this also lifts sessions created under the old 7-day policy), one UPDATE sets
 * last_seen_at = now() and expiry = LEAST(now() + lifetime, created_at + maximum age), never earlier
 * than before. The caller then re-issues the cookie with the new Expires. Requests in between
 * perform no write.
 */
export async function findActiveSession(db: Queryable, token: string): Promise<SessionContext | null> {
  if (!isWellFormedSessionToken(token)) return null;
  const result = await db.query<SessionRow>(
    `SELECT s.id AS session_id,
            (s.last_seen_at < now() - ($3::bigint * interval '1 millisecond')
             OR LEAST(now() + ($4::bigint * interval '1 millisecond'), s.created_at + ($5::bigint * interval '1 millisecond'))
                - s.absolute_expires_at > ($3::bigint * interval '1 millisecond')) AS needs_renewal,
            u.id AS user_id, u.email, u.name, u.role, u.must_change_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.absolute_expires_at > now()
        AND s.last_seen_at > now() - ($2::bigint * interval '1 millisecond')
        AND s.created_at > now() - ($5::bigint * interval '1 millisecond')
        AND u.is_active`,
    [
      hashSessionToken(token),
      AUTH.sessionIdleTimeoutMs,
      AUTH.sessionTouchIntervalMs,
      AUTH.sessionLifetimeMs,
      AUTH.sessionMaxAgeMs,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  let renewedExpiresAt: Date | undefined;
  if (row.needs_renewal) {
    const renewed = await db.query<{ absolute_expires_at: Date }>(
      `UPDATE sessions
          SET last_seen_at = now(),
              absolute_expires_at = GREATEST(
                absolute_expires_at,
                LEAST(now() + ($2::bigint * interval '1 millisecond'), created_at + ($3::bigint * interval '1 millisecond')))
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING absolute_expires_at`,
      [row.session_id, AUTH.sessionLifetimeMs, AUTH.sessionMaxAgeMs],
    );
    // No row: revoked a moment ago. This request was already validated, so it proceeds without renewal.
    renewedExpiresAt = renewed.rows[0]?.absolute_expires_at;
  }
  return {
    sessionId: row.session_id,
    token,
    ...(renewedExpiresAt ? { renewedExpiresAt } : {}),
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      mustChangePassword: row.must_change_password,
    },
  };
}

export async function revokeSession(db: Queryable, sessionId: string, reason: RevocationReason): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

export async function revokeSessionByToken(db: Queryable, token: string, reason: RevocationReason): Promise<void> {
  if (!isWellFormedSessionToken(token)) return;
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashSessionToken(token), reason],
  );
}

/** Revokes every live session of a user. Returns how many were revoked. */
export async function revokeUserSessions(db: Queryable, userId: string, reason: RevocationReason): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount ?? 0;
}
