import type { Database } from '../../database/connection.js';
import { withTransaction } from '../../database/transaction.js';
import { recordAuthEvent } from './auth.events.js';
import { hashPassword } from './password.js';
import { revokeUserSessions } from './sessions.js';

export type OwnerRecoveryResult =
  | { ok: true; revokedSessions: number }
  | { ok: false; reason: 'no_owner' | 'multiple_owners' | 'email_mismatch' };

/**
 * Server-side owner recovery (used only by the `owner:reset-password` CLI; there is no HTTP route).
 * Sets a new password, forces a change at next sign-in, clears any lockout and revokes every
 * session of the owner. Never creates an owner and never changes roles.
 */
export async function resetOwnerPassword(db: Database, email: string, newPassword: string): Promise<OwnerRecoveryResult> {
  const passwordHash = await hashPassword(newPassword);
  return withTransaction(db, async (client) => {
    const owners = await client.query<{ id: string; matches: boolean }>(
      `SELECT id, email = $1::citext AS matches FROM users WHERE role = 'owner' FOR UPDATE`,
      [email],
    );
    if (owners.rowCount === 0) return { ok: false, reason: 'no_owner' };
    // Impossible while the users_single_owner index exists; checked anyway as defence in depth.
    if ((owners.rowCount ?? 0) > 1) return { ok: false, reason: 'multiple_owners' };
    const owner = owners.rows[0]!;
    if (!owner.matches) return { ok: false, reason: 'email_mismatch' };

    await client.query(
      `UPDATE users
          SET password_hash = $2, must_change_password = true, password_changed_at = now(),
              failed_login_count = 0, lockout_count = 0, locked_until = NULL
        WHERE id = $1`,
      [owner.id, passwordHash],
    );
    const revokedSessions = await revokeUserSessions(client, owner.id, 'password_reset');
    await recordAuthEvent(client, { ip: null, userAgent: 'owner:reset-password CLI' }, {
      type: 'password_reset',
      userId: owner.id,
      details: { via: 'cli', revoked: revokedSessions },
    });
    return { ok: true, revokedSessions };
  });
}
