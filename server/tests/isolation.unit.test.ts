import { describe, expect, it } from 'vitest';
import {
  connectionTarget,
  databaseNameProblem,
  DESIGNATED_DEV_DATABASE,
  DESIGNATED_TEST_DATABASE,
  isProtectedDatabaseName,
  operationProblem,
  testDatabaseUrlProblem,
} from '../src/database/isolation.js';

describe('database isolation: staging and production are never test or development databases', () => {
  it('designates exactly one automated-test database', () => {
    expect(DESIGNATED_TEST_DATABASE).toBe('shop_books_test');
  });

  it('recognises staging/production names', () => {
    for (const name of ['shop_books_staging', 'SHOP_BOOKS_STAGING', 'shop_books_prod', 'shop_books_production']) {
      expect(isProtectedDatabaseName(name), name).toBe(true);
    }
    for (const name of ['shop_books_dev', 'shop_books_test', 'shop_books']) expect(isProtectedDatabaseName(name), name).toBe(false);
  });

  it('a staging/production database is refused for test and development, even with a *_test suffix', () => {
    for (const env of ['test', 'development']) {
      expect(databaseNameProblem(env, 'shop_books_staging'), env).toMatch(/staging\/production database/);
      expect(databaseNameProblem(env, 'shop_books_staging_test'), env).toMatch(/staging\/production database/);
    }
    expect(databaseNameProblem('production', 'shop_books_staging')).toBeNull();
  });

  it('keeps the existing rules for the other databases', () => {
    expect(databaseNameProblem('test', 'shop_books_test')).toBeNull();
    expect(databaseNameProblem('development', 'shop_books_dev')).toBeNull();
    expect(databaseNameProblem('test', 'shop_books_dev')).toMatch(/must end in "_test"/);
    expect(databaseNameProblem('production', 'shop_books_test')).toMatch(/only be used when NODE_ENV=test/);
  });
});

const url = (rest: string) => `postgresql://u:p@${rest}`;

describe('automated tests: only the local designated test database (URL check)', () => {
  it('1-2. accepts localhost and 127.0.0.1 (and ::1)', () => {
    expect(testDatabaseUrlProblem(url('localhost:5432/shop_books_test'))).toBeNull();
    expect(testDatabaseUrlProblem(url('127.0.0.1:5432/shop_books_test'))).toBeNull();
    expect(testDatabaseUrlProblem(url('[::1]:5432/shop_books_test'))).toBeNull();
    expect(testDatabaseUrlProblem(url('localhost/shop_books_test?sslmode=disable&application_name=t'))).toBeNull();
  });

  it('accepts the harmless parameters of a Neon URL; still rejects every redirecting one next to them', () => {
    const neon = 'postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    expect(connectionTarget(neon)).toMatchObject({ problem: null, target: { host: 'ep-cool-name-123456.eu-central-1.aws.neon.tech', database: 'neondb', local: false } });
    for (const extra of ['host=evil.example.com', 'hostaddr=10.0.0.1', 'port=6543', 'user=postgres', 'password=x', 'options=-c%20x%3Dy', 'service=prod', 'db=other', 'sslrootcert=x']) {
      expect(connectionTarget(`${neon}&${extra}`).problem, extra).toMatch(/can redirect the connection/);
    }
    // A Neon URL is remote: changing commands still need the exact name.
    expect(operationProblem('production', neon, 'neondb', ['--yes'])).toMatch(/remote host.*--confirm-database=neondb/);
    expect(operationProblem('production', neon, 'neondb', ['--yes', '--confirm-database=neondb'])).toBeNull();
    expect(testDatabaseUrlProblem(url('localhost/shop_books_test?sslmode=require&channel_binding=require'))).toBeNull();
  });

  it('3. rejects a remote hostname', () => {
    expect(testDatabaseUrlProblem(url('db.example.com:5432/shop_books_test'))).toMatch(/not local/);
    expect(testDatabaseUrlProblem(url('192.168.1.10/shop_books_test'))).toMatch(/not local/);
  });

  it('4. rejects ?host= and every other redirecting query parameter', () => {
    for (const q of ['host=prod.example.com', 'hostaddr=10.0.0.1', 'port=6543', 'user=postgres', 'options=-c%20search_path%3Dx', 'db=shop_books_dev', 'service=prod']) {
      expect(testDatabaseUrlProblem(url(`localhost:5432/shop_books_test?${q}`)), q).toMatch(/can redirect the connection/);
    }
  });

  it('5. rejects an unknown host (socket, empty, unparseable)', () => {
    expect(testDatabaseUrlProblem('postgresql:///shop_books_test')).toMatch(/host cannot be determined/);
    expect(testDatabaseUrlProblem('postgresql://%2Ftmp/shop_books_test')).toMatch(/host cannot be determined/);
    expect(testDatabaseUrlProblem('not a url')).toMatch(/cannot be parsed/);
    expect(testDatabaseUrlProblem('mysql://localhost/shop_books_test')).toMatch(/not a postgres/);
  });

  it('6. rejects any other database name, or none', () => {
    expect(testDatabaseUrlProblem(url('localhost/shop_books_test2'))).toMatch(/is not "shop_books_test"/);
    expect(testDatabaseUrlProblem(url('localhost/other_test'))).toMatch(/is not "shop_books_test"/);
    expect(testDatabaseUrlProblem(url('localhost/'))).toMatch(/name cannot be determined/);
  });

  it('7. rejects the development database', () => {
    expect(testDatabaseUrlProblem(url(`localhost:5432/${DESIGNATED_DEV_DATABASE}`))).toMatch(/is not "shop_books_test"/);
    expect(databaseNameProblem('test', DESIGNATED_DEV_DATABASE)).toMatch(/must end in "_test"/);
  });

  it('parses what the driver would reach', () => {
    expect(connectionTarget(url('LocalHost:5432/shop_books_test')).target).toEqual({ host: 'LocalHost', database: 'shop_books_test', local: true });
  });
});

describe('changing commands (db:migrate, documents:reconcile --delete-orphans)', () => {
  const dev = url('localhost:5432/shop_books_dev');
  const test = url('localhost:5432/shop_books_test');

  it('the two routine local combinations need no confirmation', () => {
    expect(operationProblem('development', dev, 'shop_books_dev', [])).toBeNull();
    expect(operationProblem('test', test, 'shop_books_test', [])).toBeNull();
    expect(operationProblem('development', url('127.0.0.1/shop_books_dev'), 'shop_books_dev', [])).toBeNull();
  });

  it('a remote host always needs the exact name, whatever NODE_ENV says', () => {
    for (const env of ['development', 'test', 'production']) {
      const remote = url('db.example.com:5432/neondb');
      expect(operationProblem(env, remote, 'neondb', []), env).toMatch(/remote host "db.example.com".*--confirm-database=neondb/);
      expect(operationProblem(env, remote, 'neondb', ['--yes']), env).not.toBeNull();
      expect(operationProblem(env, remote, 'neondb', ['--confirm-database=shop_books_dev']), env).toMatch(/does not match/);
      expect(operationProblem(env, remote, 'neondb', ['--confirm-database=neondb']), env).toBeNull();
    }
    // Even a remote database that happens to be called shop_books_dev.
    expect(operationProblem('development', url('db.example.com/shop_books_dev'), 'shop_books_dev', [])).toMatch(/remote host/);
  });

  it('production mode, protected names and other local names need the exact name', () => {
    expect(operationProblem('production', dev, 'shop_books_dev', [])).toMatch(/production mode/);
    expect(operationProblem('production', url('localhost/shop_books_staging'), 'shop_books_staging', [])).toMatch(/production mode/);
    expect(operationProblem('development', url('localhost/shop_books_copy'), 'shop_books_copy', [])).toMatch(/not the designated database/);
    expect(operationProblem('test', url('localhost/shop_books_test'), 'shop_books_test', ['--confirm-database=x'])).toBeNull();
  });

  it('fails closed, even with a confirmation, when the target is unknown or differs from the server', () => {
    expect(operationProblem('development', url('localhost/shop_books_dev?host=prod.example.com'), 'shop_books_dev', ['--confirm-database=shop_books_dev'])).toMatch(/can redirect/);
    expect(operationProblem('production', 'postgresql:///shopbooks', 'shopbooks', ['--confirm-database=shopbooks'])).toMatch(/host cannot be determined/);
    expect(operationProblem('development', dev, 'shop_books_test', ['--confirm-database=shop_books_test'])).toMatch(/server reports database "shop_books_test"/);
  });
});
