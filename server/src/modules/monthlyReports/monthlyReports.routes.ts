import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import type { EmailSender } from '../email/email.js';
import { createManualJob, listAttempts, listDeliveries, previewEmail, retryDelivery } from './deliveries.service.js';
import { addRecipient, getSettings, listRecipients, updateRecipient, updateSettings } from './settings.service.js';

const parseId = (raw: unknown, what: string) => {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
};

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid e-mail address').max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid e-mail address'));
const name = z
  .string()
  .trim()
  .max(100, 'At most 100 characters')
  .nullish()
  .transform((v) => (v ? v : null));

const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  deliveryDay: z.number().int().min(1, 'Choose a day from 1 to 28').max(28, 'Choose a day from 1 to 28'),
  deliveryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)'),
  includeExcel: z.boolean(),
  version: z.number().int().positive(),
});
const recipientCreateSchema = z.strictObject({ email, name });
const recipientUpdateSchema = z
  .strictObject({ email: email.optional(), name: name.optional(), isActive: z.boolean().optional(), version: z.number().int().positive() })
  .refine((v) => Object.keys(v).length > 1, 'Nothing to update');
const deliveriesQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  status: z.enum(['pending', 'processing', 'sent', 'simulated', 'retry_scheduled', 'failed']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const monthSchema = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });

/**
 * Monthly e-mail report configuration and delivery history. OWNER ONLY (mounted behind
 * requireRole('owner')); every change is audited and session-bound.
 */
export function createMonthlyReportsRouter({
  db,
  sender,
  shopName,
  from,
  schedulerEnabled,
  onQueued,
}: {
  db: Database;
  sender: EmailSender;
  shopName: string;
  from: string;
  schedulerEnabled: boolean;
  /** Called after work was queued (manual run, retry) so the scheduler picks it up promptly. */
  onQueued?: () => void;
}): Router {
  const router = Router();
  const provider = () => ({
    provider: sender.provider,
    deliversForReal: sender.deliversForReal,
    from,
    schedulerEnabled,
  });

  router.get('/settings', async (_req, res) => {
    res.json({ settings: await getSettings(db), email: provider() });
  });

  router.put('/settings', async (req, res) => {
    const { version, ...input } = settingsSchema.parse(req.body);
    res.json({ settings: await updateSettings(db, input, version, getActor(res)), email: provider() });
  });

  router.get('/recipients', async (_req, res) => {
    res.json({ recipients: await listRecipients(db) });
  });

  router.post('/recipients', async (req, res) => {
    res.status(201).json({ recipient: await addRecipient(db, recipientCreateSchema.parse(req.body), getActor(res)) });
  });

  router.patch('/recipients/:id', async (req, res) => {
    const { version, ...changes } = recipientUpdateSchema.parse(req.body);
    res.json({ recipient: await updateRecipient(db, parseId(req.params.id, 'Recipient'), changes, version, getActor(res)) });
  });

  router.get('/deliveries', async (req, res) => {
    res.json(await listDeliveries(db, deliveriesQuerySchema.parse(req.query)));
  });

  router.get('/deliveries/:id/attempts', async (req, res) => {
    res.json({ attempts: await listAttempts(db, parseId(req.params.id, 'Delivery')) });
  });

  router.post('/deliveries/:id/retry', async (req, res) => {
    const delivery = await retryDelivery(db, parseId(req.params.id, 'Delivery'), getActor(res));
    onQueued?.();
    res.json({ delivery });
  });

  router.post('/jobs', async (req, res) => {
    const { year, month } = monthSchema.parse(req.body);
    const result = await createManualJob(db, year, month, getActor(res));
    onQueued?.();
    res.status(201).json(result);
  });

  router.get('/preview', async (req, res) => {
    const { year, month } = monthSchema.parse(req.query);
    const settings = await getSettings(db);
    res.json({ preview: await previewEmail(db, shopName, year, month, settings.includeExcel) });
  });

  return router;
}
