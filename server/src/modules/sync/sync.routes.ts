import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { listChanges } from './sync.service.js';

const querySchema = z.object({
  // Audit ids are bigint; carried as decimal strings (no precision loss in JSON).
  after: z
    .string()
    .regex(/^\d{1,18}$/, 'Invalid cursor')
    .optional(),
});

/**
 * Read-only change feed for live updates. Mounted below requirePasswordCurrent, so it needs a
 * valid session like every financial route; owners and managers see the same feed.
 */
export function createSyncRouter({ db }: { db: Database }): Router {
  const router = Router();
  router.get('/changes', async (req, res) => {
    const { after } = querySchema.parse(req.query);
    res.json(await listChanges(db, after ?? null));
  });
  return router;
}
