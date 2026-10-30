import { randomInt } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { z } from 'zod';
import { AUTH } from '../../config/constants.js';

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const ARGON2_OPTIONS = {
  algorithm: 2 as Algorithm, // Algorithm.Argon2id (a const enum, so not importable as a value)
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const passwordSchema = z
  .string()
  .min(AUTH.passwordMinLength, `Password must be at least ${AUTH.passwordMinLength} characters`)
  .max(AUTH.passwordMaxLength, `Password must be at most ${AUTH.passwordMaxLength} characters`)
  .refine((value) => value.trim().length > 0, 'Password must not be blank');

export async function hashPassword(password: string): Promise<string> {
  const result = await hash(password, ARGON2_OPTIONS);
  // Defence in depth: the users table also rejects anything that is not an Argon2id hash.
  if (!result.startsWith('$argon2id$')) throw new Error('Unexpected password hash algorithm');
  return result;
}

/** Never throws for a wrong password or malformed hash; returns false. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same Argon2 work as a real check, so unknown e-mails, inactive and locked accounts
 * take about as long as a wrong password (reduces account enumeration by timing).
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(`dummy-${randomInt(1e9)}-${Date.now()}`);
  await verifyPassword(await dummyHash, password);
  return false;
}

// Unambiguous characters only (no 0/O, 1/l/I), so a temporary password can be read out or typed.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 20 random characters from a 56-symbol alphabet (~116 bits). Shown to the owner exactly once. */
export function generateTemporaryPassword(): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}
