import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { createCategory, listCategories, updateCategory } from './categories.service.js';

const nameSchema = z.string().trim().min(1, 'Name is required').max(80, 'Name must be at most 80 characters');
// Empty string clears the description.
const descriptionSchema = z
  .string()
  .trim()
  .max(500, 'Description must be at most 500 characters')
  .nullable()
  .transform((v) => (v ? v : null));

const createSchema = z.strictObject({ name: nameSchema, description: descriptionSchema.optional() });

const updateSchema = z
  .strictObject({ name: nameSchema.optional(), description: descriptionSchema.optional(), isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const listQuerySchema = z.object({ status: z.enum(['active', 'archived', 'all']).default('all') });

function parseId(raw: string | undefined): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError('Category not found');
  return parsed.data;
}

/** Expense categories: owner and managers alike (mounted below requirePasswordCurrent). */
export function createCategoriesRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { status } = listQuerySchema.parse(req.query);
    res.json({ categories: await listCategories(db, status) });
  });

  router.post('/', async (req, res) => {
    const body = createSchema.parse(req.body);
    const category = await createCategory(db, { name: body.name, description: body.description ?? null }, getActor(res));
    res.status(201).json({ category });
  });

  router.patch('/:id', async (req, res) => {
    const body = updateSchema.parse(req.body);
    res.json({ category: await updateCategory(db, parseId(req.params.id), body, getActor(res)) });
  });

  return router;
}
