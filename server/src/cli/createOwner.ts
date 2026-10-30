import { z } from 'zod';
import { ConfigError, loadDatabaseConfig } from '../config/env.js';
import { loadEnvFiles } from '../config/loadEnvFiles.js';
import { createPool } from '../database/connection.js';
import { getMigrationStatus } from '../database/migrator.js';
import { withTransaction } from '../database/transaction.js';
import { recordAuthEvent } from '../modules/auth/auth.events.js';
import { hashPassword, passwordSchema } from '../modules/auth/password.js';
import { Prompter } from './prompt.js';

/**
 * One-time owner bootstrap:  npm run owner:create
 * Prompts for e-mail, name and password (password never echoed, never logged, never stored in
 * plain text). Refuses if an owner already exists. There are no default credentials.
 */

const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));
const nameSchema = z.string().trim().min(1, 'Name is required').max(100);

class UserFacingError extends Error {}

async function askValid<T>(prompter: Prompter, question: string, schema: z.ZodType<T>, hidden = false): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const parsed = schema.safeParse(await prompter.ask(question, hidden));
    if (parsed.success) return parsed.data;
    console.error(`  ${parsed.error.issues[0]?.message ?? 'Invalid value'}`);
  }
  throw new UserFacingError('Too many invalid answers.');
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadDatabaseConfig();
  const pool = createPool(config);
  const prompter = new Prompter();
  try {
    const status = await getMigrationStatus(pool);
    if (status.pending.length > 0 || status.issues.length > 0) {
      throw new UserFacingError('The database is not fully migrated. Run "npm run db:migrate" first.');
    }
    const existing = await pool.query(`SELECT 1 FROM users WHERE role = 'owner'`);
    if ((existing.rowCount ?? 0) > 0) {
      throw new UserFacingError('An owner account already exists. Refusing to create another one.');
    }

    console.log(`Create the Shop-Books owner account (environment: ${config.nodeEnv})`);
    const email = await askValid(prompter, 'Owner email: ', emailSchema);
    const name = await askValid(prompter, 'Owner name: ', nameSchema);
    let password: string | null = null;
    for (let attempt = 0; attempt < 3 && password === null; attempt++) {
      const first = await askValid(prompter, 'Password (hidden, min 12 characters): ', passwordSchema, true);
      const second = await prompter.ask('Repeat password: ', true);
      if (first === second) password = first;
      else console.error('  Passwords do not match.');
    }
    if (password === null) throw new UserFacingError('Passwords did not match.');

    const passwordHash = await hashPassword(password);
    password = null;

    await withTransaction(pool, async (client) => {
      // Re-checked inside the transaction; the users_single_owner unique index is the final guard.
      const again = await client.query(`SELECT 1 FROM users WHERE role = 'owner' FOR UPDATE`);
      if ((again.rowCount ?? 0) > 0) throw new UserFacingError('An owner account already exists.');
      const created = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, role, password_hash, must_change_password)
         VALUES ($1, $2, 'owner', $3, false) RETURNING id`,
        [email, name, passwordHash],
      );
      await recordAuthEvent(client, { ip: null, userAgent: 'owner:create CLI' }, {
        type: 'owner_bootstrapped',
        userId: created.rows[0]!.id,
      });
    });
    console.log(`Owner account created for ${email}. You can now sign in.`);
  } finally {
    prompter.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: string }).code;
  if (err instanceof UserFacingError || err instanceof ConfigError) console.error(err.message);
  else if (code === '23505') console.error('Could not create the owner: an owner or this email already exists.');
  else console.error('Owner creation failed:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
