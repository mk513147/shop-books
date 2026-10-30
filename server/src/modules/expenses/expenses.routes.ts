import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { parseIdempotencyKey } from '../idempotency/idempotency.js';
import { expenseInputSchema, expenseUpdateSchema, listQuerySchema, reasonSchema } from './expenses.schemas.js';
import {
  createExpense,
  getExpense,
  getExpenseHistory,
  listExpenses,
  listRecorders,
  restoreExpense,
  updateExpense,
  voidExpense,
} from './expenses.service.js';

function parseId(raw: string | undefined): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError('Expense not found');
  return parsed.data;
}

/** Expenses: owner and managers alike (mounted below requirePasswordCurrent). */
export function createExpensesRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listExpenses(db, listQuerySchema.parse(req.query)));
  });

  router.get('/recorders', async (_req, res) => {
    res.json({ users: await listRecorders(db) });
  });

  router.post('/', async (req, res) => {
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    const input = expenseInputSchema.parse(req.body);
    const result = await createExpense(db, input, getActor(res), key);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });

  router.get('/:id', async (req, res) => {
    res.json({ expense: await getExpense(db, parseId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const { version, ...input } = expenseUpdateSchema.parse(req.body);
    res.json({ expense: await updateExpense(db, parseId(req.params.id), input, version, getActor(res)) });
  });

  router.post('/:id/void', async (req, res) => {
    const { reason, version } = reasonSchema.parse(req.body);
    res.json({ expense: await voidExpense(db, parseId(req.params.id), reason, version, getActor(res)) });
  });

  router.post('/:id/restore', async (req, res) => {
    const { reason, version } = reasonSchema.parse(req.body);
    res.json({ expense: await restoreExpense(db, parseId(req.params.id), reason, version, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getExpenseHistory(db, parseId(req.params.id)) });
  });

  return router;
}
