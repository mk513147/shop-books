import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../../config/env.js';

type CookieConfig = AppConfig['cookie'];

function baseOptions(cookie: CookieConfig): CookieOptions {
  // HttpOnly: unreadable by page scripts. Path=/ and no Domain (required by the __Host- prefix).
  return { httpOnly: true, secure: cookie.secure, sameSite: cookie.sameSite, path: '/' };
}

export function setSessionCookie(res: Response, cookie: CookieConfig, token: string, expires: Date): void {
  res.cookie(cookie.name, token, { ...baseOptions(cookie), expires });
}

export function clearSessionCookie(res: Response, cookie: CookieConfig): void {
  res.clearCookie(cookie.name, baseOptions(cookie));
}

/** Minimal Cookie-header reader (avoids a dependency for a single cookie). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}
