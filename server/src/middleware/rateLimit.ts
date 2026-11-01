import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';
import { getAuth } from './auth.js';

/**
 * Small fixed-window limiter per signed-in user, held in memory (one API process serves the shop).
 * Use only behind requireAuth. It protects expensive endpoints (file uploads) from runaway
 * clients; it is not a security boundary across several API instances.
 */
export function perUserRateLimit(name: string, limit: number, windowMs: number): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return (_req, res, next) => {
    const key = `${name}:${getAuth(res).user.id}`;
    const now = Date.now();
    let entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      windows.set(key, entry);
      // Opportunistic cleanup keeps the map small.
      if (windows.size > 1000) {
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.'));
    }
    next();
  };
}
