import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { loadEnvFiles } from './config/loadEnvFiles.js';
import { createPool } from './database/connection.js';
import { DocumentQueueWorker } from './modules/documents/documentQueue.js';
import { createDocumentStorage } from './modules/documents/storage.js';
import { createEmailSender } from './modules/email/email.js';
import { ReportScheduler } from './modules/monthlyReports/scheduler.js';
import { createLogger } from './utils/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  loadEnvFiles();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Fail closed: refuse to start with missing or invalid configuration.
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(1);
  }

  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const emailSender = createEmailSender(config.email);
  // Monthly e-mail reports: a timer in this process; all state and locking are in PostgreSQL.
  const scheduler = new ReportScheduler({
    db: pool,
    sender: emailSender,
    shopName: config.shopName,
    from: config.email.from,
    logger,
    intervalMs: config.reportScheduler.intervalMs,
  });
  const storage = createDocumentStorage(config.documentStorage, {
    // Secret-free: only the HTTP status and method are logged.
    onAgentRejected: (d) =>
      logger.error(d, 'Document storage agent rejected the request signature: check DOCUMENT_STORAGE_AGENT_SECRET and the desktop clock'),
  });
  // Uploads accepted while the desktop storage agent was offline wait in PostgreSQL until delivered.
  const documentQueue = new DocumentQueueWorker({ db: pool, storage, logger, intervalMs: 60_000 });
  const app = createApp({ config, db: pool, logger, emailSender, storage, onReportQueued: () => scheduler.nudge() });
  if (storage.driver === 'agent') documentQueue.start();
  if (storage.driver === 'disabled') logger.info('Bill attachments are postponed: document storage is disabled (uploads are refused)');
  if (config.reportScheduler.enabled) scheduler.start();
  logger.info({ emailProvider: emailSender.provider, scheduler: config.reportScheduler.enabled }, 'Monthly report scheduler configured');

  const onListening = () => logger.info({ port: config.port, host: config.host ?? 'all interfaces', env: config.nodeEnv }, 'Shop-Books API listening');
  const server = config.host ? app.listen(config.port, config.host, onListening) : app.listen(config.port, onListening);

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    scheduler.stop();
    documentQueue.stop();
    const forceTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    server.close((closeErr) => {
      if (closeErr) logger.error({ err: closeErr }, 'Error while closing HTTP server');
      pool.end().then(
        () => process.exit(closeErr ? 1 : exitCode),
        (poolErr: unknown) => {
          logger.error({ err: poolErr }, 'Error while closing database pool');
          process.exit(1);
        },
      );
    });
    server.closeIdleConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException', 1);
  });
  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server error');
    shutdown('serverError', 1);
  });
}

main();
