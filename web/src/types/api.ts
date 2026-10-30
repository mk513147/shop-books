/** GET /api/v1/health */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  version: string | null;
  timestamp: string;
}

export type Role = 'owner' | 'manager';

/** The signed-in user, as reported by the server (never trusted from the client). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

/** POST /auth/login, GET /auth/me, POST /auth/change-password */
export interface SessionResponse {
  user: SessionUser;
  csrfToken: string;
}

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

/** POST /users and POST /users/:id/reset-password */
export interface TemporaryPasswordResponse {
  user: UserSummary;
  temporaryPassword: string;
}
