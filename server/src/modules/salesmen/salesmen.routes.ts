import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { salesmanCreateSchema, salesmanListQuerySchema, salesmanUpdateSchema } from './salesmen.schemas.js';
import { createSalesman, getSalesman, getSalesmanHistory, listSalesmen, updateSalesman } from './salesmen.service.js';

function parseId(raw: unknown): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError('Salesman not found');
  return parsed.data;
}

/**
 * Salesmen directory (owner and managers; mounted below requirePasswordCurrent).
 *
 *   GET  /              list/search (q: name or phone, status, page, pageSize)    POST /  create
 *   GET  /:id           detail                                                     PATCH /:id  edit / deactivate / reactivate (+ version)
 *   GET  /:id/history   audit history
 */
export function createSalesmenRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listSalesmen(db, salesmanListQuerySchema.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    res.status(201).json({ salesman: await createSalesman(db, salesmanCreateSchema.parse(req.body), getActor(res)) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ salesman: await getSalesman(db, parseId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const { version, ...changes } = salesmanUpdateSchema.parse(req.body);
    res.json({ salesman: await updateSalesman(db, parseId(req.params.id), changes, version, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getSalesmanHistory(db, parseId(req.params.id)) });
  });

  return router;
}
