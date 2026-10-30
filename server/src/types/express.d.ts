import type { SessionContext } from '../modules/auth/sessions.js';

declare global {
  namespace Express {
    interface Locals {
      requestId?: string;
      /** Set only by requireAuth, from a server-validated session. */
      auth?: SessionContext;
    }
  }
}

export {};
