import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

/** Structured JSON logger. Credentials and cookies are redacted if they ever reach a log call. */
export function createLogger(config: Pick<AppConfig, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.databaseUrl',
        '*.sessionSecret',
      ],
      censor: '[redacted]',
    },
  });
}
