import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDatabaseConfig } from '../src/config/env.js';
import { loadEnvFiles } from '../src/config/loadEnvFiles.js';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:s3cretpw@localhost:5432/shop_books_dev',
  FRONTEND_URL: 'http://localhost:5173',
  SESSION_SECRET: 'k'.repeat(40),
};

function messageOf(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('environment validation', () => {
  it('staging behind HTTPS: Secure + SameSite=None allowed outside production; bind address; production stays Secure', () => {
    const staging = loadConfig({ ...valid, COOKIE_SECURE: 'true', SESSION_COOKIE_SAMESITE: 'none', HOST: '127.0.0.1' });
    expect(staging.cookie).toEqual({ name: '__Host-sb_session', secure: true, sameSite: 'none' });
    expect(staging.host).toBe('127.0.0.1');
    expect(loadConfig(valid).host).toBeUndefined();
    expect(messageOf({ ...valid, SESSION_COOKIE_SAMESITE: 'none' })).toContain('requires Secure cookies');
    const prod = { ...valid, NODE_ENV: 'production', FRONTEND_URL: 'https://books.example.com', DOCUMENT_STORAGE_DIR: '/srv/docs' };
    expect(messageOf({ ...prod, COOKIE_SECURE: 'false' })).toContain('must be Secure in production');
    expect(loadConfig(prod).cookie.secure).toBe(true);
  });

  it('SHOP_BOOKS_ENV_FILE only accepts an existing .env.<name> file in the repository root', () => {
    expect(() => loadEnvFiles({ SHOP_BOOKS_ENV_FILE: '../secrets.env' })).toThrow(/must be a/);
    expect(() => loadEnvFiles({ SHOP_BOOKS_ENV_FILE: '.env.does-not-exist' })).toThrow(/not found/);
    expect(() => loadEnvFiles({ SHOP_BOOKS_ENV_FILE: 'x.env.staging' })).toThrow(/must be a/);
  });

  it('document storage: defaults outside production, explicit absolute directory required in production', () => {
    expect(loadConfig(valid).documentStorage.directory).toMatch(/storage[\\/]documents$/);
    const prod = { ...valid, NODE_ENV: 'production', FRONTEND_URL: 'https://books.example.com' };
    expect(messageOf(prod)).toContain('DOCUMENT_STORAGE_DIR: required in production');
    expect(messageOf({ ...prod, DOCUMENT_STORAGE_DIR: 'relative/dir' })).toContain('must be an absolute path');
    expect(messageOf({ ...valid, DOCUMENT_STORAGE_DRIVER: 's3' })).toContain('DOCUMENT_STORAGE_DRIVER');
  });

  it('accepts a valid configuration and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.frontendOrigins).toEqual(['http://localhost:5173']);
    expect(config.trustProxy).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('rejects missing required variables, naming them', () => {
    const message = messageOf({ NODE_ENV: 'development' });
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('FRONTEND_URL');
    expect(message).toContain('SESSION_SECRET');
  });

  it('treats empty strings as missing', () => {
    expect(messageOf({ ...valid, DATABASE_URL: '' })).toContain('DATABASE_URL');
  });

  it('rejects a non-postgres DATABASE_URL without echoing it', () => {
    const message = messageOf({ ...valid, DATABASE_URL: 'mysql://user:topsecret@host/db' });
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('topsecret');
  });

  it('rejects an invalid port and invalid NODE_ENV', () => {
    expect(messageOf({ ...valid, PORT: '99999' })).toContain('PORT');
    expect(messageOf({ ...valid, NODE_ENV: 'staging' })).toContain('NODE_ENV');
  });

  it('parses multiple frontend origins and normalises them', () => {
    const config = loadConfig({ ...valid, FRONTEND_URL: 'http://localhost:5173/, https://books.example.com/app' });
    expect(config.frontendOrigins).toEqual(['http://localhost:5173', 'https://books.example.com']);
  });

  it('rejects a malformed FRONTEND_URL', () => {
    expect(messageOf({ ...valid, FRONTEND_URL: 'not a url' })).toContain('FRONTEND_URL');
  });

  it('requires https origins in production (localhost excepted)', () => {
    const prod = { ...valid, NODE_ENV: 'production', DOCUMENT_STORAGE_DIR: '/srv/shop-books/documents' };
    expect(messageOf({ ...prod, FRONTEND_URL: 'http://books.example.com' })).toContain('https');
    expect(loadConfig({ ...prod, FRONTEND_URL: 'https://books.example.com' }).nodeEnv).toBe('production');
  });

  it('rejects a short or placeholder SESSION_SECRET without echoing it', () => {
    const short = messageOf({ ...valid, SESSION_SECRET: 'tooshort' });
    expect(short).toContain('SESSION_SECRET');
    expect(short).not.toContain('tooshort');
    expect(messageOf({ ...valid, SESSION_SECRET: 'CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME' })).toContain(
      'placeholder',
    );
    expect(loadConfig({ ...valid, SESSION_SECRET: 'x'.repeat(48) }).sessionSecret).toHaveLength(48);
  });

  it('derives cookie settings from the environment', () => {
    expect(loadConfig(valid).cookie).toEqual({ name: 'sb_session', secure: false, sameSite: 'lax' });
    const prod = loadConfig({
      ...valid,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://books.example.com',
      DOCUMENT_STORAGE_DIR: '/srv/shop-books/documents',
    });
    expect(prod.cookie).toEqual({ name: '__Host-sb_session', secure: true, sameSite: 'lax' });
    expect(messageOf({ ...valid, SESSION_COOKIE_SAMESITE: 'none' })).toContain('SESSION_COOKIE_SAMESITE');
    expect(messageOf({ ...valid, SESSION_COOKIE_SAMESITE: 'sideways' })).toContain('SESSION_COOKIE_SAMESITE');
  });

  describe('database isolation', () => {
    it('refuses a non-test database when NODE_ENV=test', () => {
      expect(messageOf({ ...valid, NODE_ENV: 'test' })).toContain('_test');
    });

    it('accepts a *_test database when NODE_ENV=test and defaults to silent logging', () => {
      const config = loadConfig({
        ...valid,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/shop_books_test',
      });
      expect(config.logLevel).toBe('silent');
    });

    it('refuses a *_test database outside NODE_ENV=test', () => {
      const env = { ...valid, DATABASE_URL: 'postgresql://u:p@localhost:5432/shop_books_test' };
      expect(messageOf(env)).toContain('_test');
      expect(messageOf({ ...env, NODE_ENV: 'production' })).toContain('_test');
    });
  });

  it('loadDatabaseConfig needs only database settings but applies the same isolation rule', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: valid.DATABASE_URL }).nodeEnv).toBe('development');
    expect(() => loadDatabaseConfig({})).toThrow(ConfigError);
    expect(() =>
      loadDatabaseConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@localhost/shop_books_dev' }),
    ).toThrow(ConfigError);
  });
});
