import type { Request, RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';
import type { RequestContext } from '../modules/auth/auth.events.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChanging(req: Request): boolean {
  return !SAFE_METHODS.has(req.method);
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Cross-site request defence for every state-changing request (including login): the browser's
 * Origin header (or, failing that, Referer) must be one of the configured frontend origins.
 * Requests carrying neither are rejected.
 */
export function verifyOrigin(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (!isStateChanging(req)) return next();
    const origin = req.get('origin');
    const source = origin && origin !== 'null' ? originOf(origin) : originOf(req.get('referer') ?? '');
    if (!source || !allowed.has(source)) {
      return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed'));
    }
    next();
  };
}

/** State-changing API requests must be JSON (blocks HTML-form and other simple cross-site posts). */
export const requireJson: RequestHandler = (req, _res, next) => {
  if (!isStateChanging(req)) return next();
  const type = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must use Content-Type: application/json'));
  }
  next();
};

export function requestContext(req: Request): RequestContext {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  };
}
