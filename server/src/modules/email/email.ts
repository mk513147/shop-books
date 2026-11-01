import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AppConfig } from '../../config/env.js';

/**
 * Provider-independent outgoing e-mail. Business code depends only on EmailSender.
 *
 * Implemented adapters:
 *  - none:    not configured. Every send fails (non-retryable) with a clear message, so nothing is
 *             ever reported as delivered.
 *  - outbox:  development only. Writes each message to a folder on disk and reports it as
 *             SIMULATED (never as sent).
 *  - RecordingEmailSender: tests (in memory, can be told to fail).
 * A real provider (SMTP relay or an HTTP e-mail API) is added by implementing EmailSender and
 * wiring it in createEmailSender; see docs/architecture.md → Monthly e-mail reports.
 */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
  /** Stable per delivery: providers that support idempotency keys must receive it. */
  idempotencyKey: string;
}

export interface SendResult {
  provider: string;
  /** Provider's message/reference id, when it returns one. */
  messageId: string | null;
  /** true when nothing left this machine (local outbox). Such deliveries are never "sent". */
  simulated: boolean;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** true for temporary problems (network, rate limit, provider 5xx); false for permanent ones. */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface EmailSender {
  readonly provider: string;
  /** Whether a real provider is configured (false for none/outbox). */
  readonly deliversForReal: boolean;
  send(message: EmailMessage): Promise<SendResult>;
}

export class DisabledEmailSender implements EmailSender {
  readonly provider = 'none';
  readonly deliversForReal = false;
  async send(): Promise<SendResult> {
    throw new EmailSendError('E-mail is not configured on the server (EMAIL_PROVIDER=none). Nothing was sent.', false);
  }
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';

/** Writes message.json, body.html, body.txt and attachments into <dir>/<idempotencyKey>/. */
export class OutboxEmailSender implements EmailSender {
  readonly provider = 'outbox';
  readonly deliversForReal = false;
  private readonly root: string;
  constructor(directory: string) {
    this.root = resolve(directory);
  }
  async send(message: EmailMessage): Promise<SendResult> {
    const folder = resolve(this.root, safeName(message.idempotencyKey));
    if (!folder.startsWith(this.root + sep)) throw new EmailSendError('Invalid message key', false);
    try {
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, 'message.json'),
        JSON.stringify(
          {
            note: 'Written by the local outbox adapter. This e-mail was NOT sent.',
            from: message.from,
            to: message.to,
            subject: message.subject,
            attachments: message.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: a.content.length })),
            writtenAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      await writeFile(join(folder, 'body.html'), message.html);
      await writeFile(join(folder, 'body.txt'), message.text);
      for (const a of message.attachments) await writeFile(join(folder, safeName(a.filename)), a.content);
    } catch (err) {
      throw new EmailSendError(`Could not write to the local outbox: ${(err as Error).message}`, true);
    }
    return { provider: this.provider, messageId: safeName(message.idempotencyKey), simulated: true };
  }
}

/** In-memory sender for automated tests. `failWith` makes the next sends fail. */
export class RecordingEmailSender implements EmailSender {
  readonly provider = 'test';
  readonly deliversForReal = true;
  readonly sent: EmailMessage[] = [];
  failWith: EmailSendError[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    const failure = this.failWith.shift();
    if (failure) throw failure;
    this.sent.push(message);
    return { provider: this.provider, messageId: `test-${this.sent.length}`, simulated: false };
  }
}

export function createEmailSender(config: AppConfig['email']): EmailSender {
  switch (config.provider) {
    case 'outbox':
      return new OutboxEmailSender(config.outboxDirectory);
    case 'none':
      return new DisabledEmailSender();
  }
}
