import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { recordAuthEvent, type RequestContext } from '../auth/auth.events.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { revokeUserSessions, type Role } from '../auth/sessions.js';

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = `id, email, name, role, is_active, must_change_password,
  CASE WHEN locked_until > now() THEN locked_until END AS locked_until, last_login_at, created_at`;

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    lockedUntil: row.locked_until?.toISOString() ?? null,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === constraint
  );
}

export async function listUsers(db: Database): Promise<UserSummary[]> {
  const result = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY (role = 'owner') DESC, lower(name), email`,
  );
  return result.rows.map(toSummary);
}

/** Creates a MANAGER with a one-time temporary password (the only role creatable via the API). */
export async function createManager(
  db: Database,
  input: { email: string; name: string },
  actor: Actor,
  ctx: RequestContext,
): Promise<{ user: UserSummary; temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    return await withSessionTransaction(db, actor.sessionId, async (client) => {
      const result = await client.query<UserRow>(
        `INSERT INTO users (email, name, role, password_hash, must_change_password, created_by)
         VALUES ($1, $2, 'manager', $3, true, $4)
         RETURNING ${USER_COLUMNS}`,
        [input.email, input.name, passwordHash, actor.userId],
      );
      const user = toSummary(result.rows[0]!);
      await recordAuthEvent(client, ctx, { type: 'user_created', userId: user.id, actorUserId: actor.userId });
      return { user, temporaryPassword };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_unique')) {
      throw new AppError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
    }
    throw err;
  }
}

async function lockUser(client: Queryable, id: string): Promise<UserRow> {
  const result = await client.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('User not found');
  return row;
}

export async function updateUser(
  db: Database,
  id: string,
  changes: { name?: string | undefined; isActive?: boolean | undefined },
  actor: Actor,
  ctx: RequestContext,
): Promise<UserSummary> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockUser(client, id);
    if (changes.isActive === false && current.role === 'owner') {
      throw new AppError(409, 'OWNER_CANNOT_BE_DEACTIVATED', 'The owner account cannot be deactivated');
    }

    const result = await client.query<UserRow>(
      `UPDATE users
          SET name = COALESCE($2, name),
              is_active = COALESCE($3, is_active)
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id, changes.name ?? null, changes.isActive ?? null],
    );
    const updated = result.rows[0]!;

    if (changes.name !== undefined && changes.name !== current.name) {
      await recordAuthEvent(client, ctx, { type: 'user_updated', userId: id, actorUserId: actor.userId });
    }
    if (current.is_active && !updated.is_active) {
      // Deactivation takes effect immediately: every existing session is revoked.
      const revoked = await revokeUserSessions(client, id, 'user_deactivated');
      await recordAuthEvent(client, ctx, {
        type: 'user_deactivated',
        userId: id,
        actorUserId: actor.userId,
        details: { revoked },
      });
    } else if (!current.is_active && updated.is_active) {
      await recordAuthEvent(client, ctx, { type: 'user_activated', userId: id, actorUserId: actor.userId });
    }
    return toSummary(updated);
  });
}

/** Owner-initiated reset: new temporary password, must change at next login, lockout cleared, sessions revoked. */
export async function resetPassword(
  db: Database,
  id: string,
  actor: Actor,
  ctx: RequestContext,
): Promise<{ user: UserSummary; temporaryPassword: string }> {
  if (id === actor.userId) {
    throw new AppError(400, 'USE_CHANGE_PASSWORD', 'Use "Change password" to change your own password');
  }
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    await lockUser(client, id);
    const result = await client.query<UserRow>(
      `UPDATE users
          SET password_hash = $2, must_change_password = true, password_changed_at = now(),
              failed_login_count = 0, lockout_count = 0, locked_until = NULL
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id, passwordHash],
    );
    const revoked = await revokeUserSessions(client, id, 'password_reset');
    await recordAuthEvent(client, ctx, { type: 'password_reset', userId: id, actorUserId: actor.userId, details: { revoked } });
    return { user: toSummary(result.rows[0]!), temporaryPassword };
  });
}

export async function revokeSessionsForUser(
  db: Database,
  id: string,
  actor: Actor,
  ctx: RequestContext,
): Promise<number> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    await lockUser(client, id);
    const revoked = await revokeUserSessions(client, id, 'revoked_by_owner');
    await recordAuthEvent(client, ctx, { type: 'sessions_revoked', userId: id, actorUserId: actor.userId, details: { revoked } });
    return revoked;
  });
}
