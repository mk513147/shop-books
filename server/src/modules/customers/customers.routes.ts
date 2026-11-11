import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { parseIdempotencyKey } from '../idempotency/idempotency.js';
import {
  getCustomerLedger,
  getCustomerTransaction,
  getCustomerTransactionHistory,
  listOpenDues,
  recordCustomerTransaction,
  reverseCustomerTransaction,
  settleAllDues,
} from './customerLedger.service.js';
import {
  advanceSchema,
  customerCreateSchema,
  customerLedgerQuerySchema,
  customerListQuerySchema,
  customerUpdateSchema,
  duePaymentSchema,
  dueSchema,
  refundSchema,
  reverseSchema,
  settleAllSchema,
  type CustomerTxnType,
} from './customers.schemas.js';
import {
  createCustomer,
  getCustomer,
  getCustomerHistory,
  getCustomersSummary,
  listCustomers,
  updateCustomer,
} from './customers.service.js';

function parseId(raw: unknown, what = 'Customer'): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}

/**
 * Customers and their ledger (owner and managers; mounted below requirePasswordCurrent).
 *
 *   GET  /                      list/search (q, status, balance)        POST /        create
 *   GET  /summary               total due / total advance (never netted)
 *   GET  /:id                   detail with both balances                 PATCH /:id   edit / archive / reactivate
 *   GET  /:id/history           profile audit history
 *   GET  /:id/ledger            entries with running due + running advance (from, to, type, status)
 *   GET  /:id/open-dues         dues with something still owed
 *   POST /:id/dues              record a due                  } Idempotency-Key supported
 *   POST /:id/advances          record an advance received    }
 *   POST /:id/due-payments      record a payment against a due}
 *   POST /:id/refunds           refund advance (≤ advance)    }
 *   POST /:id/due-payments/settle-all   pay the FULL outstanding due: one payment split over the open
 *                               dues oldest-first, in one transaction (Idempotency-Key required)
 *   GET  /:id/transactions/:txnId            one entry
 *   POST /:id/transactions/:txnId/reverse    { reason, version }
 *   GET  /:id/transactions/:txnId/history    entry audit history
 */
export function createCustomersRouter({ db }: { db: Database }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listCustomers(db, customerListQuerySchema.parse(req.query)));
  });

  router.get('/summary', async (_req, res) => {
    res.json({ summary: await getCustomersSummary(db) });
  });

  router.post('/', async (req, res) => {
    res.status(201).json({ customer: await createCustomer(db, customerCreateSchema.parse(req.body), getActor(res)) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ customer: await getCustomer(db, parseId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const { version, ...changes } = customerUpdateSchema.parse(req.body);
    res.json({ customer: await updateCustomer(db, parseId(req.params.id), changes, version, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getCustomerHistory(db, parseId(req.params.id)) });
  });

  router.get('/:id/ledger', async (req, res) => {
    res.json(await getCustomerLedger(db, parseId(req.params.id), customerLedgerQuerySchema.parse(req.query)));
  });

  router.get('/:id/open-dues', async (req, res) => {
    res.json({ dues: await listOpenDues(db, parseId(req.params.id)) });
  });

  const record =
    (type: CustomerTxnType, schema: z.ZodType<Record<string, unknown>>): RequestHandler =>
    async (req, res) => {
      const key = parseIdempotencyKey(req.get('Idempotency-Key'));
      const body = schema.parse(req.body) as {
        amount: string;
        txnDate: string;
        paymentMode?: string;
        dueId?: string;
        categoryId?: string;
        description: string | null;
        reference: string | null;
        notes: string | null;
      };
      const result = await recordCustomerTransaction(
        db,
        parseId(req.params.id),
        {
          type,
          amount: body.amount,
          txnDate: body.txnDate,
          paymentMode: (body.paymentMode ?? null) as never,
          dueId: body.dueId ?? null,
          categoryId: body.categoryId ?? null,
          description: body.description,
          reference: body.reference,
          notes: body.notes,
        },
        getActor(res),
        key,
      );
      if (result.replayed) res.set('Idempotent-Replayed', 'true');
      res.status(result.status).json(result.body);
    };

  router.post('/:id/dues', record('due', dueSchema));
  router.post('/:id/advances', record('advance', advanceSchema));
  router.post('/:id/due-payments', record('due_payment', duePaymentSchema));
  router.post('/:id/refunds', record('advance_refund', refundSchema));

  router.post('/:id/due-payments/settle-all', async (req, res) => {
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    if (key === null) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header so the payment can never be recorded twice.');
    }
    const result = await settleAllDues(db, parseId(req.params.id), settleAllSchema.parse(req.body), getActor(res), key);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });

  router.get('/:id/transactions/:txnId', async (req, res) => {
    res.json({ transaction: await getCustomerTransaction(db, parseId(req.params.id), parseId(req.params.txnId, 'Entry')) });
  });

  router.post('/:id/transactions/:txnId/reverse', async (req, res) => {
    const { reason, version } = reverseSchema.parse(req.body);
    const transaction = await reverseCustomerTransaction(
      db,
      parseId(req.params.id),
      parseId(req.params.txnId, 'Entry'),
      reason,
      version,
      getActor(res),
    );
    res.json({ transaction });
  });

  router.get('/:id/transactions/:txnId/history', async (req, res) => {
    res.json({ history: await getCustomerTransactionHistory(db, parseId(req.params.id), parseId(req.params.txnId, 'Entry')) });
  });

  return router;
}
