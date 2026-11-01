import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { databaseNameProblem } from '../database/isolation.js';
import { REPO_ROOT } from './loadEnvFiles.js';

/**
 * Thrown when configuration is missing or invalid. Messages name the offending variables
 * but never include their values, so they are safe to log and print.
 */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export type NodeEnv = 'development' | 'test' | 'production';

export interface DatabaseConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databasePoolMax: number;
}

export interface AppConfig extends DatabaseConfig {
  port: number;
  /** Interface to bind (e.g. 127.0.0.1 behind a local tunnel); undefined = all interfaces. */
  host: string | undefined;
  frontendOrigins: string[];
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  trustProxy: boolean;
  appVersion: string | undefined;
  /** Server-side secret used to derive per-session CSRF tokens (HMAC). */
  sessionSecret: string;
  /** Private storage for bill photographs/documents (docs/architecture.md → Bill documents). */
  documentStorage: {
    driver: 'local';
    /** Absolute directory outside any web root; never served statically. */
    directory: string;
  };
  /** Shop name printed on reports, Excel files and e-mails. */
  shopName: string;
  /** Outgoing e-mail (monthly reports). See docs/architecture.md → Monthly e-mail reports. */
  email: {
    /** none = not configured (deliveries fail honestly); outbox = write to a local folder (development only). */
    provider: 'none' | 'outbox';
    from: string;
    outboxDirectory: string;
  };
  /** In-process scheduler for monthly reports (state lives in PostgreSQL). */
  reportScheduler: { enabled: boolean; intervalMs: number };
  cookie: {
    /** `__Host-` prefixed in production (requires Secure, Path=/ and no Domain). */
    name: string;
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
  };
}

const PLACEHOLDER_PATTERN = /change[_-]?me|placeholder|your[_-]/i;

function parseDatabaseName(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
    return decodeURIComponent(parsed.pathname.replace(/^\//, '')) || null;
  } catch {
    return null;
  }
}

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const databaseShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required')
    .refine((value) => parseDatabaseName(value) !== null, {
      error: 'DATABASE_URL must be a postgres:// or postgresql:// URL that names a database',
    }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
};

const appSchema = z.object({
  ...databaseShape,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).max(255).optional(),
  /** Secure (HTTPS-only) session cookie. Default: on in production, off elsewhere. */
  COOKIE_SECURE: booleanString.optional(),
  FRONTEND_URL: z.string({ error: 'FRONTEND_URL is required' }).min(1, 'FRONTEND_URL is required'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),
  TRUST_PROXY: booleanString.default(false),
  APP_VERSION: z.string().trim().optional(),
  SESSION_SECRET: z.string({ error: 'SESSION_SECRET is required' }).min(1, 'SESSION_SECRET is required'),
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  DOCUMENT_STORAGE_DRIVER: z.enum(['local'], 'only "local" is implemented so far').default('local'),
  DOCUMENT_STORAGE_DIR: z.string().trim().optional(),
  SHOP_NAME: z.string().trim().min(1).max(100).default('Shop-Books'),
  EMAIL_PROVIDER: z.enum(['none', 'outbox'], 'use "none" or "outbox" (no other provider is implemented yet)').optional(),
  EMAIL_FROM: z.string().trim().max(200).optional(),
  EMAIL_OUTBOX_DIR: z.string().trim().optional(),
  REPORT_SCHEDULER_ENABLED: booleanString.optional(),
  REPORT_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
});

const databaseSchema = z.object(databaseShape);

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.join('.') || 'configuration';
    // Zod's default messages never embed the rejected value; custom ones are written above.
    return `${name}: ${issue.message}`;
  });
}

function emptyToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    cleaned[key] = value === '' ? undefined : value;
  }
  return cleaned;
}

/** Guards that stop one environment from silently using another environment's database. */
function checkDatabaseIsolation(nodeEnv: NodeEnv, databaseUrl: string, issues: string[]): void {
  const name = parseDatabaseName(databaseUrl);
  if (name === null) return;
  const problem = databaseNameProblem(nodeEnv, name);
  if (problem) issues.push(`DATABASE_URL: ${problem}`);
}

/** Minimal configuration for tooling that only needs the database (e.g. the migration CLI). */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const result = databaseSchema.safeParse(emptyToUndefined(env));
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  const issues: string[] = [];
  checkDatabaseIsolation(result.data.NODE_ENV, result.data.DATABASE_URL, issues);
  if (issues.length > 0) throw new ConfigError(issues);
  return {
    nodeEnv: result.data.NODE_ENV,
    databaseUrl: result.data.DATABASE_URL,
    databasePoolMax: result.data.DATABASE_POOL_MAX,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = appSchema.safeParse(emptyToUndefined(env));
  if (!result.success) throw new ConfigError(describeIssues(result.error));

  const data = result.data;
  const issues: string[] = [];

  checkDatabaseIsolation(data.NODE_ENV, data.DATABASE_URL, issues);

  const frontendOrigins: string[] = [];
  for (const raw of data.FRONTEND_URL.split(',').map((part) => part.trim()).filter(Boolean)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (data.NODE_ENV === 'production' && url.protocol !== 'https:' && !isLocal) {
        issues.push('FRONTEND_URL: production origins must use https');
      }
      frontendOrigins.push(url.origin);
    } catch {
      issues.push('FRONTEND_URL: every entry must be a valid http(s) URL (comma-separated)');
      break;
    }
  }
  if (frontendOrigins.length === 0 && issues.every((i) => !i.startsWith('FRONTEND_URL'))) {
    issues.push('FRONTEND_URL: at least one origin is required');
  }

  const secret = data.SESSION_SECRET;
  if (secret.length < 32) issues.push('SESSION_SECRET: must be at least 32 characters');
  else if (PLACEHOLDER_PATTERN.test(secret)) {
    issues.push('SESSION_SECRET: looks like a placeholder; generate a random value');
  }

  const secureCookie = data.COOKIE_SECURE ?? data.NODE_ENV === 'production';
  if (data.NODE_ENV === 'production' && !secureCookie) {
    issues.push('COOKIE_SECURE: session cookies must be Secure in production');
  }
  if (data.SESSION_COOKIE_SAMESITE === 'none' && !secureCookie) {
    issues.push('SESSION_COOKIE_SAMESITE: "none" requires Secure cookies (production, or COOKIE_SECURE=true behind HTTPS)');
  }

  // Production must name the storage directory explicitly (and it must be absolute); development
  // and tests default to <repo>/storage/documents[-test], which is gitignored and never served.
  const storageDir = data.DOCUMENT_STORAGE_DIR
    ? data.DOCUMENT_STORAGE_DIR
    : data.NODE_ENV === 'production'
      ? null
      : join(REPO_ROOT, 'storage', data.NODE_ENV === 'test' ? 'documents-test' : 'documents');
  if (storageDir === null) issues.push('DOCUMENT_STORAGE_DIR: required in production');
  else if (!isAbsolute(storageDir)) issues.push('DOCUMENT_STORAGE_DIR: must be an absolute path');

  const emailProvider = data.EMAIL_PROVIDER ?? (data.NODE_ENV === 'production' ? 'none' : 'outbox');
  if (emailProvider === 'outbox' && data.NODE_ENV === 'production') {
    issues.push('EMAIL_PROVIDER: "outbox" only writes files locally and is not allowed in production; use "none" until a real provider is configured');
  }
  const emailFrom = data.EMAIL_FROM || `${data.SHOP_NAME} <reports@localhost>`;
  const fromAddress = (/<([^<>]+)>\s*$/.exec(emailFrom)?.[1] ?? emailFrom).trim();
  if (!/^[^@\s<>]+@[^@\s<>]+$/.test(fromAddress)) {
    issues.push('EMAIL_FROM: must be an address like "Shop-Books <reports@example.com>"');
  }
  const outboxDir = data.EMAIL_OUTBOX_DIR || join(REPO_ROOT, 'storage', data.NODE_ENV === 'test' ? 'email-outbox-test' : 'email-outbox');
  if (!isAbsolute(outboxDir)) issues.push('EMAIL_OUTBOX_DIR: must be an absolute path');

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    nodeEnv: data.NODE_ENV,
    databaseUrl: data.DATABASE_URL,
    databasePoolMax: data.DATABASE_POOL_MAX,
    port: data.PORT,
    host: data.HOST,
    frontendOrigins,
    // Keep test output quiet unless a level is explicitly requested.
    logLevel: data.LOG_LEVEL ?? (data.NODE_ENV === 'test' ? 'silent' : 'info'),
    trustProxy: data.TRUST_PROXY,
    appVersion: data.APP_VERSION || undefined,
    sessionSecret: secret,
    documentStorage: { driver: data.DOCUMENT_STORAGE_DRIVER, directory: storageDir! },
    shopName: data.SHOP_NAME,
    email: { provider: emailProvider, from: emailFrom, outboxDirectory: outboxDir },
    reportScheduler: {
      enabled: data.REPORT_SCHEDULER_ENABLED ?? data.NODE_ENV !== 'test',
      intervalMs: data.REPORT_SCHEDULER_INTERVAL_SECONDS * 1000,
    },
    cookie: {
      name: secureCookie ? '__Host-sb_session' : 'sb_session',
      secure: secureCookie,
      sameSite: data.SESSION_COOKIE_SAMESITE,
    },
  };
}
