import type { Queryable } from '../../database/connection.js';

export type AuthEventType =
  | 'owner_bootstrapped'
  | 'login_success'
  | 'login_failure'
  | 'login_rate_limited'
  | 'account_locked'
  | 'logout'
  | 'password_changed'
  | 'password_reset'
  | 'user_created'
  | 'user_updated'
  | 'user_activated'
  | 'user_deactivated'
  | 'sessions_revoked';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthEvent {
  type: AuthEventType;
  userId?: string | null;
  actorUserId?: string | null;
  emailAttempted?: string | null;
  /** Never put passwords, hashes or tokens in here. */
  details?: Record<string, unknown>;
}

/** Appends to auth_events. Pass the transaction client so the event commits with the change. */
export async function recordAuthEvent(db: Queryable, ctx: RequestContext, event: AuthEvent): Promise<void> {
  await db.query(
    `INSERT INTO auth_events (event_type, user_id, actor_user_id, email_attempted, ip, user_agent, details)
     VALUES ($1, $2, $3, $4, $5::inet, $6, $7::jsonb)`,
    [
      event.type,
      event.userId ?? null,
      event.actorUserId ?? null,
      event.emailAttempted?.slice(0, 254) ?? null,
      ctx.ip,
      ctx.userAgent,
      JSON.stringify(event.details ?? {}),
    ],
  );
}
