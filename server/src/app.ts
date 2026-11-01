import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config/env.js';
import type { Database } from './database/connection.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { createDocumentStorage, type DocumentStorage } from './modules/documents/storage.js';
import { createEmailSender, type EmailSender } from './modules/email/email.js';
import { createApiRouter } from './routes/index.js';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  logger: Logger;
  /** Private bill-document storage; built from config.documentStorage when not supplied (tests inject one). */
  storage?: DocumentStorage;
  /** Outgoing e-mail; built from config.email when not supplied (tests inject a recording sender). */
  emailSender?: EmailSender;
  /** Called when monthly-report work was queued (the server process passes scheduler.nudge). */
  onReportQueued?: () => void;
}

export const JSON_BODY_LIMIT = '100kb';

export function createApp({
  config,
  db,
  logger,
  storage = createDocumentStorage(config.documentStorage),
  emailSender = createEmailSender(config.email),
  onReportQueued,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => String(res.locals.requestId),
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
      // Keep request logs lean and free of secrets: no headers, and no query strings.
      serializers: {
        req: (req: { id: unknown; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url?.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      // Requests without an Origin header (curl, server-to-server) are not browser CORS requests.
      origin: (origin, callback) => callback(null, !origin || config.frontendOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api/v1', createApiRouter({ db, config, storage, emailSender, onReportQueued }));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
