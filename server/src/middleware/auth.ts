import type { RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import type { Queryable } from '../database/connection.js';
import { clearSessionCookie, readCookie, setSessionCookie } from '../modules/auth/cookies.js';
import { findActiveSession, type Role, type SessionContext } from '../modules/auth/sessions.js';
import { csrfTokenFor, safeEqual } from '../modules/auth/tokens.js';
import { AppError } from '../utils/errors.js';
import { isStateChanging } from './requestGuards.js';

/** The authenticated session for this request. Only valid after requireAuth. */
export function getAuth(res: Response): SessionContext {
  const auth = res.locals.auth;
  if (!auth) throw new Error('getAuth() used on a route that is not behind requireAuth');
  return auth;
}

/** The signed-in user performing a write, from the validated session (never the request body). */
export interface Actor {
  userId: string;
  sessionId: string;
}

export function getActor(res: Response): Actor {
  const auth = getAuth(res);
  return { userId: auth.user.id, sessionId: auth.sessionId };
}

/**
 * Deny-by-default gate: mounted once in the API router, everything registered after it requires
 * a valid server-side session. Identity and role are loaded from the database on every request.
 */
export function requireAuth(db: Queryable, config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req, config.cookie.name);
    const session = token ? await findActiveSession(db, token) : null;
    if (!session) {
      if (token) clearSessionCookie(res, config.cookie);
      return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in'));
    }
    // Rolling session: same token, later Expires (only on the rare request that renewed the session).
    if (session.renewedExpiresAt) setSessionCookie(res, config.cookie, session.token, session.renewedExpiresAt);
    res.locals.auth = session;
    next();
  };
}

/** Synchronizer-token check: X-CSRF-Token must match the token derived from this session. */
export function requireCsrf(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!isStateChanging(req)) return next();
    const provided = req.get('x-csrf-token') ?? '';
    const expected = csrfTokenFor(getAuth(res).token, config.sessionSecret);
    if (!safeEqual(provided, expected)) {
      return next(new AppError(403, 'CSRF_REJECTED', 'Security check failed. Reload the page and try again.'));
    }
    next();
  };
}

/** Until a temporary password is replaced, only the auth endpoints mounted before this are usable. */
export const requirePasswordCurrent: RequestHandler = (_req, res, next) => {
  if (getAuth(res).user.mustChangePassword) {
    return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing'));
  }
  next();
};

export function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (getAuth(res).user.role !== role) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this'));
    }
    next();
  };
}
