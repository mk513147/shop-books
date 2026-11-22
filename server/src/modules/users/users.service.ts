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
  /** Effective permission to SEE product purchase prices (always true for the owner). */
  canViewPurchasePrices: boolean;
  /** Effective permission to CHANGE purchase prices (always true for the owner; needs view). */
  canEditPurchasePrices: boolean;
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
  can_view_purchase_prices: boolean;
  can_edit_purchase_prices: boolean;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = `id, email, name, role, is_active, must_change_password, can_view_purchase_prices, can_edit_purchase_prices,
  CASE WHEN locked_until > now() THEN locked_until END AS locked_until, last_login_at, created_at`;

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    canViewPurchasePrices: row.role === 'owner' || row.can_view_purchase_prices,
    canEditPurchasePrices: row.role === 'owner' || (row.can_view_purchase_prices && row.can_edit_purchase_prices),
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
  changes: {
    name?: string | undefined;
    isActive?: boolean | undefined;
    canViewPurchasePrices?: boolean | undefined;
    canEditPurchasePrices?: boolean | undefined;
  },
  actor: Actor,
  ctx: RequestContext,
): Promise<UserSummary> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockUser(client, id);
    if (changes.isActive === false && current.role === 'owner') {
      throw new AppError(409, 'OWNER_CANNOT_BE_DEACTIVATED', 'The owner account cannot be deactivated');
    }
    if ((changes.canViewPurchasePrices !== undefined || changes.canEditPurchasePrices !== undefined) && current.role === 'owner') {
      throw new AppError(400, 'OWNER_ALWAYS_HAS_ACCESS', 'The owner can always see and change purchase prices');
    }
    // Changing prices needs seeing them: turning "view" off also turns "change" off, and "change"
    // cannot be turned on for someone who cannot see prices (also a CHECK in migration 0017).
    const nextView = changes.canViewPurchasePrices ?? current.can_view_purchase_prices;
    const nextEdit = nextView ? (changes.canEditPurchasePrices ?? current.can_edit_purchase_prices) : false;
    if (changes.canEditPurchasePrices === true && !nextView) {
      throw new AppError(400, 'EDIT_NEEDS_VIEW', 'Allow this manager to see purchase prices before allowing them to change prices');
    }

    const result = await client.query<UserRow>(
      `UPDATE users
          SET name = COALESCE($2, name),
              is_active = COALESCE($3, is_active),
              can_view_purchase_prices = $4,
              can_edit_purchase_prices = $5
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id, changes.name ?? null, changes.isActive ?? null, nextView, nextEdit],
    );
    const updated = result.rows[0]!;

    // Takes effect on the user's next request (the flag is read from the database every time).
    if (
      updated.can_view_purchase_prices !== current.can_view_purchase_prices ||
      updated.can_edit_purchase_prices !== current.can_edit_purchase_prices
    ) {
      await recordAuthEvent(client, ctx, {
        type: 'user_updated',
        userId: id,
        actorUserId: actor.userId,
        details: { canViewPurchasePrices: updated.can_view_purchase_prices, canEditPurchasePrices: updated.can_edit_purchase_prices },
      });
    }

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
