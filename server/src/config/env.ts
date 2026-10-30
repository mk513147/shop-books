import { z } from 'zod';
import { databaseNameProblem } from '../database/isolation.js';

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
  frontendOrigins: string[];
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  trustProxy: boolean;
  appVersion: string | undefined;
  sessionSecret: string | undefined;
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
  FRONTEND_URL: z.string({ error: 'FRONTEND_URL is required' }).min(1, 'FRONTEND_URL is required'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),
  TRUST_PROXY: booleanString.default(false),
  APP_VERSION: z.string().trim().optional(),
  SESSION_SECRET: z.string().optional(),
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
  if (secret !== undefined) {
    if (secret.length < 32) issues.push('SESSION_SECRET: must be at least 32 characters when set');
    else if (PLACEHOLDER_PATTERN.test(secret)) {
      issues.push('SESSION_SECRET: looks like a placeholder; generate a random value');
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    nodeEnv: data.NODE_ENV,
    databaseUrl: data.DATABASE_URL,
    databasePoolMax: data.DATABASE_POOL_MAX,
    port: data.PORT,
    frontendOrigins,
    // Keep test output quiet unless a level is explicitly requested.
    logLevel: data.LOG_LEVEL ?? (data.NODE_ENV === 'test' ? 'silent' : 'info'),
    trustProxy: data.TRUST_PROXY,
    appVersion: data.APP_VERSION || undefined,
    sessionSecret: secret,
  };
}
