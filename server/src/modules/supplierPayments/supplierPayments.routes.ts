import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { parseIdempotencyKey } from '../idempotency/idempotency.js';
import {
  allocateSchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  paymentUpdateSchema,
  reasonOnlySchema,
  reverseSchema,
} from './supplierPayments.schemas.js';
import {
  allocatePayment,
  createPayment,
  getPayment,
  getPaymentHistory,
  listPayments,
  releaseAllocation,
  reversePayment,
  updatePayment,
} from './supplierPayments.service.js';

function parseId(raw: unknown, what = 'Payment'): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}

/**
 * Supplier payments: owner and managers alike (mounted below requirePasswordCurrent).
 *
 *   GET  /                                  list (filters, totals)
 *   POST /                                  record (+ optional allocations); Idempotency-Key supported
 *   GET  /:id                               detail with allocation history
 *   PATCH /:id                              correct date / mode / reference / notes (+ version)
 *   POST /:id/allocations                   allocate (more of) the payment; Idempotency-Key supported
 *   POST /:id/allocations/:allocationId/release   { reason }
 *   POST /:id/reverse                       { reason, version }
 *   GET  /:id/history                       audit history
 */
export function createSupplierPaymentsRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listPayments(db, paymentListQuerySchema.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    const input = paymentCreateSchema.parse(req.body);
    const result = await createPayment(db, input, getActor(res), key);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });

  router.get('/:id', async (req, res) => {
    res.json({ payment: await getPayment(db, parseId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const { version, ...input } = paymentUpdateSchema.parse(req.body);
    res.json({ payment: await updatePayment(db, parseId(req.params.id), input, version, getActor(res)) });
  });

  router.post('/:id/allocations', async (req, res) => {
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    const { allocations } = allocateSchema.parse(req.body);
    const result = await allocatePayment(db, parseId(req.params.id), allocations, getActor(res), key);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });

  router.post('/:id/allocations/:allocationId/release', async (req, res) => {
    const { reason } = reasonOnlySchema.parse(req.body);
    const payment = await releaseAllocation(
      db,
      parseId(req.params.id),
      parseId(req.params.allocationId, 'Allocation'),
      reason,
      getActor(res),
    );
    res.json({ payment });
  });

  router.post('/:id/reverse', async (req, res) => {
    const { reason, version } = reverseSchema.parse(req.body);
    res.json({ payment: await reversePayment(db, parseId(req.params.id), reason, version, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getPaymentHistory(db, parseId(req.params.id)) });
  });

  return router;
}
