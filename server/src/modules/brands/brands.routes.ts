import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { createBrand, getBrandHistory, listBrands, updateBrand } from './brands.service.js';

/** Trimmed, runs of whitespace collapsed (the database requires this form, see brands_name_valid). */
const nameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Name is required').max(80, 'Name must be at most 80 characters'));

const createSchema = z.strictObject({ name: nameSchema });
const updateSchema = z
  .strictObject({ name: nameSchema.optional(), isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const listQuerySchema = z.object({ status: z.enum(['active', 'archived', 'all']).default('all') });

function parseId(raw: string | undefined): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError('Brand not found');
  return parsed.data;
}

/** Brands: owner and managers alike, like categories (mounted below requirePasswordCurrent). */
export function createBrandsRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { status } = listQuerySchema.parse(req.query);
    res.json({ brands: await listBrands(db, status) });
  });

  router.post('/', async (req, res) => {
    const body = createSchema.parse(req.body);
    res.status(201).json({ brand: await createBrand(db, body, getActor(res)) });
  });

  router.patch('/:id', async (req, res) => {
    const body = updateSchema.parse(req.body);
    res.json({ brand: await updateBrand(db, parseId(req.params.id), body, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getBrandHistory(db, parseId(req.params.id)) });
  });

  return router;
}
