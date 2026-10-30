import { describe, expect, it } from 'vitest';
import { NAVIGATE_FALLBACK_DENYLIST } from '../../pwa-config';

const denied = (path: string) => NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(path));

describe('service-worker navigation fallback denylist', () => {
  it.each(['/api', '/api/', '/api/v1/health', '/api/v1/expenses/123/documents/456', '/api/v1/exports/monthly'])(
    'never serves the app shell for %s',
    (path) => {
      expect(denied(path)).toBe(true);
    },
  );

  it.each(['/', '/login', '/expenses', '/suppliers/42', '/apiary', '/application'])(
    'still serves the app shell for front-end route %s',
    (path) => {
      expect(denied(path)).toBe(false);
    },
  );
});
