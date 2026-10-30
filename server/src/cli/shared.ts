import { z } from 'zod';
import { ConfigError } from '../config/env.js';
import { passwordSchema } from '../modules/auth/password.js';
import type { Prompter } from './prompt.js';

/** An error whose message is safe and useful to print to the operator. */
export class UserFacingError extends Error {}

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));
export const nameSchema = z.string().trim().min(1, 'Name is required').max(100);

export async function askValid<T>(prompter: Prompter, question: string, schema: z.ZodType<T>, hidden = false): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const parsed = schema.safeParse(await prompter.ask(question, hidden));
    if (parsed.success) return parsed.data;
    console.error(`  ${parsed.error.issues[0]?.message ?? 'Invalid value'}`);
  }
  throw new UserFacingError('Too many invalid answers.');
}

/** Hidden password entry with confirmation, validated against the shared password policy. */
export async function askNewPassword(prompter: Prompter, label = 'Password'): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await askValid(prompter, `${label} (hidden, min 12 characters): `, passwordSchema, true);
    const second = await prompter.ask('Repeat password: ', true);
    if (first === second) return first;
    console.error('  Passwords do not match.');
  }
  throw new UserFacingError('Passwords did not match.');
}

/** Prints a safe message (never secrets) and sets a failing exit code. */
export function reportCliError(action: string, err: unknown): void {
  const code = (err as { code?: string }).code;
  if (err instanceof UserFacingError || err instanceof ConfigError) console.error(err.message);
  else if (code === '23505') console.error(`${action} failed: an owner or this email already exists.`);
  else console.error(`${action} failed:`, err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
}
