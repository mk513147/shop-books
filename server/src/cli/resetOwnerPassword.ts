import { loadDatabaseConfig } from '../config/env.js';
import { loadEnvFiles } from '../config/loadEnvFiles.js';
import { createPool } from '../database/connection.js';
import { getMigrationStatus } from '../database/migrator.js';
import { resetOwnerPassword } from '../modules/auth/ownerRecovery.js';
import { Prompter } from './prompt.js';
import { askNewPassword, askValid, emailSchema, reportCliError, UserFacingError } from './shared.js';

/**
 * Owner account recovery:  npm run owner:reset-password
 *
 * Only usable from an interactive terminal on a machine that can reach the database with the
 * server's own configuration (i.e. direct server shell access). There is no HTTP equivalent.
 * The owner must choose a new password again at the next sign-in.
 */
const REFUSALS = {
  no_owner: 'There is no owner account. Use "npm run owner:create" instead.',
  multiple_owners: 'More than one owner account exists. Refusing to continue; investigate the database.',
  email_mismatch: 'That email does not belong to the owner account. Nothing was changed.',
} as const;

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UserFacingError('owner:reset-password must be run from an interactive terminal on the server.');
  }
  loadEnvFiles();
  const config = loadDatabaseConfig();
  const pool = createPool(config);
  const prompter = new Prompter();
  try {
    const status = await getMigrationStatus(pool);
    if (status.pending.length > 0 || status.issues.length > 0) {
      throw new UserFacingError('The database is not fully migrated. Run "npm run db:migrate" first.');
    }
    const owners = await pool.query(`SELECT 1 FROM users WHERE role = 'owner'`);
    if (owners.rowCount === 0) throw new UserFacingError(REFUSALS.no_owner);
    if ((owners.rowCount ?? 0) > 1) throw new UserFacingError(REFUSALS.multiple_owners);

    console.log(`Reset the Shop-Books owner password (environment: ${config.nodeEnv})`);
    const email = await askValid(prompter, 'Owner email: ', emailSchema);
    const password = await askNewPassword(prompter, 'New password');

    const result = await resetOwnerPassword(pool, email, password);
    if (!result.ok) throw new UserFacingError(REFUSALS[result.reason]);
    console.log(
      `Owner password reset. ${result.revokedSessions} session(s) signed out. ` +
        'Sign in with the new password; you will be asked to choose another one.',
    );
  } finally {
    prompter.close();
    await pool.end();
  }
}

main().catch((err: unknown) => reportCliError('Owner password reset', err));
