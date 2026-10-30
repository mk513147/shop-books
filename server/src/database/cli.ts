import { loadDatabaseConfig, ConfigError } from '../config/env.js';
import { loadEnvFiles } from '../config/loadEnvFiles.js';
import { createPool } from './connection.js';
import { getMigrationStatus, MigrationError, runMigrations } from './migrator.js';

const USAGE = 'Usage: db:status | db:migrate [--yes]';

async function main(): Promise<number> {
  const [command, ...flags] = process.argv.slice(2);
  if (command !== 'status' && command !== 'migrate') {
    console.error(USAGE);
    return 2;
  }

  loadEnvFiles();
  const config = loadDatabaseConfig();

  // Migrations never run automatically at API startup; in production they need explicit consent.
  if (command === 'migrate' && config.nodeEnv === 'production' && !flags.includes('--yes')) {
    console.error('Refusing to migrate a production database without --yes. Review `db:status` first.');
    return 2;
  }

  const pool = createPool(config);
  try {
    if (command === 'status') {
      const status = await getMigrationStatus(pool);
      console.log(`Environment: ${config.nodeEnv}`);
      for (const row of status.applied) {
        console.log(`  applied  ${row.version}_${row.name}  (${row.appliedAt.toISOString()})`);
      }
      for (const file of status.pending) console.log(`  PENDING  ${file.filename}`);
      if (status.applied.length === 0 && status.pending.length === 0) console.log('  (no migrations)');
      for (const issue of status.issues) console.error(`  PROBLEM  ${issue}`);
      return status.issues.length > 0 ? 1 : 0;
    }

    const result = await runMigrations(pool, undefined, (file) => console.log(`  applied  ${file.filename}`));
    console.log(
      result.applied.length === 0 ? 'Database is up to date.' : `Applied ${result.applied.length} migration(s).`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // ConfigError / MigrationError messages never contain connection strings or secrets.
    if (err instanceof ConfigError || err instanceof MigrationError) console.error(err.message);
    else console.error('Database command failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  },
);
