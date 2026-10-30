import type pg from 'pg';
import { AUTH } from '../../config/constants.js';
import type { Database } from '../../database/connection.js';
import { withTransaction } from '../../database/transaction.js';
import { ValidationError } from '../../utils/errors.js';
import { recordAuthEvent, type RequestContext } from './auth.events.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { withSessionTransaction } from './sessionTransaction.js';
import { createSession, revokeUserSessions, type AuthenticatedUser, type NewSession, type Role } from './sessions.js';

interface UserAuthRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  must_change_password: boolean;
  is_active: boolean;
  failed_login_count: number;
  lockout_count: number;
  is_locked: boolean;
}

/** Row-locks the user so concurrent attempts are serialized and cannot bypass the lockout. */
const SELECT_USER_FOR_UPDATE = `
  SELECT id, email, name, role, password_hash, must_change_password, is_active,
         failed_login_count, lockout_count, COALESCE(locked_until > now(), false) AS is_locked
    FROM users`;

function toAuthenticatedUser(row: UserAuthRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChangePassword: row.must_change_password,
  };
}

/** 15 min, 30, 60, 120, then capped at AUTH.maxLockoutMs (4 h). */
export function lockoutDurationMs(lockoutNumber: number): number {
  const exponent = Math.min(Math.max(lockoutNumber - 1, 0), 16);
  return Math.min(AUTH.baseLockoutMs * 2 ** exponent, AUTH.maxLockoutMs);
}

/** Records a wrong password; locks the account after AUTH.maxFailedAttempts. Caller holds the row lock. */
async function registerFailedPassword(
  client: pg.PoolClient,
  user: UserAuthRow,
  ctx: RequestContext,
  emailAttempted: string | null,
): Promise<void> {
  const failed = user.failed_login_count + 1;
  await recordAuthEvent(client, ctx, {
    type: 'login_failure',
    userId: user.id,
    emailAttempted,
    details: { reason: 'wrong_password' },
  });
  if (failed < AUTH.maxFailedAttempts) {
    await client.query(`UPDATE users SET failed_login_count = $2 WHERE id = $1`, [user.id, failed]);
    return;
  }
  const lockoutNumber = user.lockout_count + 1;
  const durationMs = lockoutDurationMs(lockoutNumber);
  await client.query(
    `UPDATE users
        SET failed_login_count = 0,
            lockout_count = $2,
            locked_until = now() + ($3::bigint * interval '1 millisecond')
      WHERE id = $1`,
    [user.id, lockoutNumber, durationMs],
  );
  await recordAuthEvent(client, ctx, {
    type: 'account_locked',
    userId: user.id,
    details: { lockoutNumber, minutes: durationMs / 60_000 },
  });
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser; session: NewSession }
  | { ok: false; reason: 'invalid' | 'rate_limited' };

export async function login(db: Database, email: string, password: string, ctx: RequestContext): Promise<LoginResult> {
  // Per-IP limit on recent failures (persistent: counted from auth_events).
  if (ctx.ip) {
    const recent = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_events
        WHERE event_type = 'login_failure' AND ip = $1::inet
          AND created_at > now() - ($2::bigint * interval '1 millisecond')`,
      [ctx.ip, AUTH.ipFailureWindowMs],
    );
    if ((recent.rows[0]?.n ?? 0) >= AUTH.ipFailureLimit) {
      await recordAuthEvent(db, ctx, { type: 'login_rate_limited', emailAttempted: email });
      return { ok: false, reason: 'rate_limited' };
    }
  }

  return withTransaction(db, async (client) => {
    const { rows } = await client.query<UserAuthRow>(`${SELECT_USER_FOR_UPDATE} WHERE email = $1 FOR UPDATE`, [
      email,
    ]);
    const user = rows[0];

    if (!user || !user.is_active || user.is_locked) {
      // Same Argon2 cost and the same generic answer as a wrong password.
      await verifyAgainstDummy(password);
      const reason = !user ? 'unknown_email' : !user.is_active ? 'inactive' : 'locked';
      await recordAuthEvent(client, ctx, {
        type: 'login_failure',
        userId: user?.id ?? null,
        emailAttempted: email,
        details: { reason },
      });
      return { ok: false, reason: 'invalid' };
    }

    if (!(await verifyPassword(user.password_hash, password))) {
      await registerFailedPassword(client, user, ctx, email);
      return { ok: false, reason: 'invalid' };
    }

    await client.query(
      `UPDATE users
          SET failed_login_count = 0, lockout_count = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [user.id],
    );
    const session = await createSession(client, user.id, ctx);
    await recordAuthEvent(client, ctx, { type: 'login_success', userId: user.id });
    return { ok: true, user: toAuthenticatedUser(user), session };
  });
}

export type ChangePasswordResult =
  | { ok: true; user: AuthenticatedUser; session: NewSession }
  | { ok: false; reason: 'invalid_current_password' };

/**
 * Verifies the current password, stores the new hash, clears the first-login flag, revokes EVERY
 * session of the user (including the current one) and issues a fresh session for this client.
 */
export async function changePassword(
  db: Database,
  userId: string,
  sessionId: string,
  currentPassword: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<ChangePasswordResult> {
  if (currentPassword === newPassword) {
    throw new ValidationError([{ path: 'newPassword', message: 'The new password must be different' }]);
  }
  const newHash = await hashPassword(newPassword);

  // The requesting session must still be live when the change commits (see sessionTransaction.ts).
  return withSessionTransaction(db, sessionId, async (client) => {
    const { rows } = await client.query<UserAuthRow>(
      `${SELECT_USER_FOR_UPDATE} WHERE id = $1 AND is_active FOR UPDATE`,
      [userId],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(user.password_hash, currentPassword))) {
      if (user) await registerFailedPassword(client, user, ctx, null);
      return { ok: false, reason: 'invalid_current_password' };
    }

    await client.query(
      `UPDATE users
          SET password_hash = $2, must_change_password = false, password_changed_at = now(),
              failed_login_count = 0
        WHERE id = $1`,
      [user.id, newHash],
    );
    const revoked = await revokeUserSessions(client, user.id, 'password_changed');
    const session = await createSession(client, user.id, ctx);
    await recordAuthEvent(client, ctx, { type: 'password_changed', userId: user.id, details: { revoked } });
    return { ok: true, user: { ...toAuthenticatedUser(user), mustChangePassword: false }, session };
  });
}
