/** GET /api/v1/health */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  version: string | null;
  timestamp: string;
}
