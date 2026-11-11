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
  /** Number of reverse proxies in front of the API whose X-Forwarded-For is trusted (0 = none). */
  trustProxy: number;
  appVersion: string | undefined;
  /** Server-side secret used to derive per-session CSRF tokens (HMAC). */
  sessionSecret: string;
  /**
   * Private storage for bill photographs/documents (docs/architecture.md → Bill documents).
   * `disabled`: bill attachments are postponed (docs/bill-attachments-postponed.md).
   */
  documentStorage:
    | { driver: 'disabled' }
    | {
        driver: 'local';
        /** Absolute directory outside any web root; never served statically. */
        directory: string;
      }
    | {
        /** The authenticated storage agent on the owner's desktop (reached through Cloudflare Tunnel). */
        driver: 'agent';
        /** Base URL of the agent, e.g. https://storage.example.com (https except for localhost). */
        url: string;
        /** Shared secret for the HMAC request signatures (never sent itself). */
        secret: string;
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

export function parseDatabaseName(url: string): string | null {
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
  // true = 1 hop (e.g. one tunnel); a number counts proxies, e.g. 2 for Vercel rewrite -> Render.
  TRUST_PROXY: z
    .enum(['true', 'false', '0', '1', '2', '3'], 'use true, false or the number of proxy hops (1-3)')
    .default('false')
    .transform((v) => (v === 'true' ? 1 : v === 'false' ? 0 : Number(v))),
  APP_VERSION: z.string().trim().optional(),
  SESSION_SECRET: z.string({ error: 'SESSION_SECRET is required' }).min(1, 'SESSION_SECRET is required'),
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Default: "disabled" in production unless DOCUMENT_STORAGE_DIR is set, "local" elsewhere (see loadConfig).
  DOCUMENT_STORAGE_DRIVER: z.enum(['disabled', 'local', 'agent'], 'use "disabled", "local" or "agent"').optional(),
  DOCUMENT_STORAGE_DIR: z.string().trim().optional(),
  DOCUMENT_STORAGE_AGENT_URL: z.string().trim().optional(),
  DOCUMENT_STORAGE_AGENT_SECRET: z.string().optional(),
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

/** The storage agent's base URL: https (http only for localhost), no credentials/query/fragment/path. */
function checkAgentUrl(raw: string | undefined, issues: string[]): string | null {
  if (!raw) {
    issues.push('DOCUMENT_STORAGE_AGENT_URL: required when DOCUMENT_STORAGE_DRIVER=agent');
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push('DOCUMENT_STORAGE_AGENT_URL: must be a valid URL');
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    issues.push('DOCUMENT_STORAGE_AGENT_URL: must use https:// (http:// only for localhost)');
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    issues.push('DOCUMENT_STORAGE_AGENT_URL: only scheme, host and port are allowed (no path, query or credentials)');
    return null;
  }
  if (isPlaceholderHost(url.hostname) || PLACEHOLDER_PATTERN.test(raw)) {
    issues.push('DOCUMENT_STORAGE_AGENT_URL: looks like a placeholder; set the real storage hostname or use DOCUMENT_STORAGE_DRIVER=disabled');
    return null;
  }
  return url.origin;
}

/** Documentation-only hostnames (RFC 2606/6761) can never be real document storage. */
function isPlaceholderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)example\.(com|net|org)$/.test(host) || /(^|\.)(example|invalid)$/.test(host) || host === 'localhost.localdomain';
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

  // Missing storage settings must not stop the API: production defaults to "disabled" (attachments
  // postponed) unless a local directory is named; development/test keep the local default.
  const storageDriver =
    data.DOCUMENT_STORAGE_DRIVER ?? (data.NODE_ENV === 'production' && !data.DOCUMENT_STORAGE_DIR ? 'disabled' : 'local');
  let documentStorage: AppConfig['documentStorage'] | null = null;
  if (storageDriver === 'disabled') {
    // Nothing is stored or contacted; DOCUMENT_STORAGE_AGENT_* / DOCUMENT_STORAGE_DIR are ignored.
    documentStorage = { driver: 'disabled' };
  } else if (storageDriver === 'agent') {
    const agentUrl = checkAgentUrl(data.DOCUMENT_STORAGE_AGENT_URL, issues);
    const agentSecret = data.DOCUMENT_STORAGE_AGENT_SECRET ?? '';
    if (agentSecret.length < 32) issues.push('DOCUMENT_STORAGE_AGENT_SECRET: must be at least 32 characters');
    else if (PLACEHOLDER_PATTERN.test(agentSecret)) issues.push('DOCUMENT_STORAGE_AGENT_SECRET: looks like a placeholder; generate a random value');
    else if (agentSecret === secret) issues.push('DOCUMENT_STORAGE_AGENT_SECRET: must differ from SESSION_SECRET');
    if (agentUrl) documentStorage = { driver: 'agent', url: agentUrl, secret: agentSecret };
  } else {
    // Render's disk is wiped on every deploy/restart: bill documents must never live there.
    if (env.RENDER === 'true') {
      issues.push('DOCUMENT_STORAGE_DRIVER: "local" stores files on Render\'s temporary disk; use "agent" (the desktop storage agent) or "disabled"');
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
    else documentStorage = { driver: 'local', directory: storageDir };
  }

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
    documentStorage: documentStorage!,
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
