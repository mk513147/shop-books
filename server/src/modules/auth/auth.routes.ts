import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../database/connection.js';
import { getAuth } from '../../middleware/auth.js';
import { requestContext } from '../../middleware/requestGuards.js';
import { AppError } from '../../utils/errors.js';
import { recordAuthEvent } from './auth.events.js';
import { changePassword, login } from './auth.service.js';
import { clearSessionCookie, readCookie, setSessionCookie } from './cookies.js';
import { passwordSchema } from './password.js';
import { revokeSession, revokeSessionByToken } from './sessions.js';
import { csrfTokenFor } from './tokens.js';

export interface AuthRouteDeps {
  db: Database;
  config: AppConfig;
}

const GENERIC_LOGIN_FAILURE = 'Invalid email or password, or the account is temporarily locked.';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  // Bounded so a huge body cannot make Argon2 do excessive work.
  password: z.string().min(1).max(1024),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

/** POST /auth/login: public, but still behind the Origin and JSON-only guards. */
export function createLoginHandler({ db, config }: AuthRouteDeps): RequestHandler {
  return async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(401, 'INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);
    const ctx = requestContext(req);

    const result = await login(db, parsed.data.email, parsed.data.password, ctx);
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        res.setHeader('Retry-After', String(15 * 60));
        throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again later.');
      }
      throw new AppError(401, 'INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);
    }

    // Signing in again from the same browser retires the previous session.
    const previous = readCookie(req, config.cookie.name);
    if (previous) await revokeSessionByToken(db, previous, 'logout');

    setSessionCookie(res, config.cookie, result.session.token, result.session.absoluteExpiresAt);
    res.json({ user: result.user, csrfToken: csrfTokenFor(result.session.token, config.sessionSecret) });
  };
}

/** /auth routes that need a session (mounted after requireAuth + requireCsrf). */
export function createAuthRouter({ db, config }: AuthRouteDeps): Router {
  const router = Router();

  router.get('/me', (_req, res) => {
    const auth = getAuth(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: auth.user, csrfToken: csrfTokenFor(auth.token, config.sessionSecret) });
  });

  router.post('/logout', async (req, res) => {
    const auth = getAuth(res);
    await revokeSession(db, auth.sessionId, 'logout');
    await recordAuthEvent(db, requestContext(req), { type: 'logout', userId: auth.user.id });
    clearSessionCookie(res, config.cookie);
    res.status(204).end();
  });

  router.post('/change-password', async (req, res) => {
    const body = changePasswordSchema.parse(req.body);
    const auth = getAuth(res);
    const result = await changePassword(
      db,
      auth.user.id,
      auth.sessionId,
      body.currentPassword,
      body.newPassword,
      requestContext(req),
    );
    if (!result.ok) {
      throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect');
    }
    setSessionCookie(res, config.cookie, result.session.token, result.session.absoluteExpiresAt);
    res.json({ user: result.user, csrfToken: csrfTokenFor(result.session.token, config.sessionSecret) });
  });

  return router;
}
