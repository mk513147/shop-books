import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getAuth } from '../../middleware/auth.js';
import { requestContext } from '../../middleware/requestGuards.js';
import { NotFoundError } from '../../utils/errors.js';
import { type Actor, createManager, listUsers, resetPassword, revokeSessionsForUser, updateUser } from './users.service.js';

const nameSchema = z.string().trim().min(1, 'Name is required').max(100);

const createUserSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254)),
  name: nameSchema,
});

// Roles cannot be changed here: the owner role is unique and managers stay managers (see docs).
const updateUserSchema = z
  .strictObject({ name: nameSchema.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, 'Nothing to update');

const idSchema = z.uuid();

function actorOf(res: Response): Actor {
  const auth = getAuth(res);
  return { userId: auth.user.id, sessionId: auth.sessionId };
}

function parseId(raw: string | undefined): string {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('User not found');
  return parsed.data;
}

/** Owner-only account management (mounted behind requireRole('owner')). */
export function createUsersRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ users: await listUsers(db) });
  });

  router.post('/', async (req, res) => {
    const body = createUserSchema.parse(req.body);
    const result = await createManager(db, body, actorOf(res), requestContext(req));
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  });

  router.patch('/:id', async (req, res) => {
    const body = updateUserSchema.parse(req.body);
    const user = await updateUser(db, parseId(req.params.id), body, actorOf(res), requestContext(req));
    res.json({ user });
  });

  router.post('/:id/reset-password', async (req, res) => {
    const result = await resetPassword(db, parseId(req.params.id), actorOf(res), requestContext(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });

  router.post('/:id/revoke-sessions', async (req, res) => {
    const revoked = await revokeSessionsForUser(db, parseId(req.params.id), actorOf(res), requestContext(req));
    res.json({ revoked });
  });

  return router;
}
