import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { linkCategorySchema, supplierCreateSchema, supplierListQuerySchema, supplierUpdateSchema } from './suppliers.schemas.js';
import {
  createSupplier,
  getSupplier,
  getSupplierHistory,
  linkSupplierCategory,
  listSuppliers,
  unlinkSupplierCategory,
  updateSupplier,
} from './suppliers.service.js';

function parseId(raw: string | undefined, what = 'Supplier'): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}

/** Suppliers: owner and managers alike, like expenses (mounted below requirePasswordCurrent). */
export function createSuppliersRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listSuppliers(db, supplierListQuerySchema.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    const input = supplierCreateSchema.parse(req.body);
    res.status(201).json({ supplier: await createSupplier(db, input, getActor(res)) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ supplier: await getSupplier(db, parseId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const { version, ...changes } = supplierUpdateSchema.parse(req.body);
    res.json({ supplier: await updateSupplier(db, parseId(req.params.id), changes, version, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getSupplierHistory(db, parseId(req.params.id)) });
  });

  router.post('/:id/categories', async (req, res) => {
    const { categoryId } = linkCategorySchema.parse(req.body);
    res.json({ supplier: await linkSupplierCategory(db, parseId(req.params.id), categoryId, getActor(res)) });
  });

  router.delete('/:id/categories/:categoryId', async (req, res) => {
    const categoryId = parseId(req.params.categoryId, 'Category');
    res.json({ supplier: await unlinkSupplierCategory(db, parseId(req.params.id), categoryId, getActor(res)) });
  });

  return router;
}
