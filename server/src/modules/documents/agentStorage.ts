import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AGENT_HEADERS, signAgentRequest } from './agentProtocol.js';
import {
  isValidStorageKey,
  StorageAgentRejected,
  StorageObjectMissing,
  StorageUnavailable,
  type DocumentStorage,
  type StoredObject,
} from './storage.js';

export interface AgentStorageOptions {
  /** Until the agent's response headers arrive (uploads: includes sending the body). */
  headerTimeoutMs?: number;
  /** While streaming a download: longest the API waits for the NEXT chunk it asked for. */
  idleTimeoutMs?: number;
  /** Called (secret-free) when the agent rejects our signature: a configuration problem, not an outage. */
  onRejected?: (details: { status: number; method: string }) => void;
}

const DEFAULT_HEADER_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * `agent` driver: the API keeps no files itself. Every object lives on the owner's desktop and is
 * reached through the storage agent (`npm run storage-agent`, see docs/hosted-deployment.md),
 * normally behind a Cloudflare Tunnel. Requests are HMAC-signed (agentProtocol.ts); the agent
 * stores files with the same atomic, never-overwrite rules as the `local` driver.
 *
 * Any failure to reach the agent (network error, timeout, tunnel error page, 5xx) is reported as
 * StorageUnavailable, a refused signature as StorageAgentRejected (a subclass), so uploads are
 * queued instead of lost and reads return 503. Timeouts never limit a transfer's total duration: a
 * slow phone may take minutes to download a 10 MB bill. There are never public or pre-signed URLs.
 */
export class AgentDocumentStorage implements DocumentStorage {
  readonly driver = 'agent';
  private readonly headerTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly options: AgentStorageOptions = {},
  ) {
    this.headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Signed request. The timer only covers the wait for the response headers; the returned
   * controller can abort the body later (inactivity, consumer gone).
   */
  private async request(method: string, path: string, body?: Buffer): Promise<{ response: Response; controller: AbortController }> {
    const timestamp = String(Date.now());
    const contentSha = body ? createHash('sha256').update(body).digest('hex') : '';
    const headers: Record<string, string> = {
      [AGENT_HEADERS.timestamp]: timestamp,
      [AGENT_HEADERS.signature]: signAgentRequest(this.secret, method, path, timestamp, contentSha),
    };
    if (body) {
      headers[AGENT_HEADERS.contentSha256] = contentSha;
      headers['content-type'] = 'application/octet-stream';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.headerTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      throw new StorageUnavailable(`Document storage agent unreachable (${err instanceof Error ? err.name : 'error'})`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      this.options.onRejected?.({ status: response.status, method });
      throw new StorageAgentRejected(response.status);
    }
    return { response, controller };
  }

  private static unavailable(response: Response): StorageUnavailable {
    void response.body?.cancel().catch(() => undefined);
    return new StorageUnavailable(`Document storage agent answered HTTP ${response.status}`);
  }

  private static objectPath(key: string): string {
    if (!isValidStorageKey(key)) throw new Error('Invalid storage key');
    return `/v1/objects/${key}`;
  }

  /** The content type is not sent (the agent stores bytes only; the type is in the metadata row). */
  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const { response } = await this.request('PUT', AgentDocumentStorage.objectPath(key), data);
    // 201 stored; 200 the identical bytes were already there (a retried upload).
    if (response.status === 201 || response.status === 200) return;
    if (response.status === 409) {
      throw Object.assign(new Error('Storage key already exists with different content'), { code: 'EEXIST' });
    }
    throw AgentDocumentStorage.unavailable(response);
  }

  async open(key: string): Promise<{ stream: Readable; sizeBytes: number }> {
    const { response, controller } = await this.request('GET', AgentDocumentStorage.objectPath(key));
    if (response.status === 404) throw new StorageObjectMissing(key);
    if (response.status !== 200 || !response.body) throw AgentDocumentStorage.unavailable(response);
    const sizeBytes = Number(response.headers.get('content-length'));
    const reader = response.body.getReader();
    const idleTimeoutMs = this.idleTimeoutMs;
    // Pulled on demand: the inactivity timer runs only while the API is waiting for the agent's
    // next chunk, never while a slow client is still taking the previous one (backpressure).
    async function* chunks(): AsyncGenerator<Buffer> {
      try {
        for (;;) {
          let timer: NodeJS.Timeout | undefined;
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StorageUnavailable('Document storage agent stopped sending data')), idleTimeoutMs);
          });
          const next = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
          if (next.done) return;
          yield Buffer.from(next.value);
        }
      } finally {
        // Completed, idle, or the client went away: release the connection to the agent.
        controller.abort();
      }
    }
    return { stream: Readable.from(chunks()), sizeBytes };
  }

  async delete(key: string): Promise<void> {
    const { response } = await this.request('DELETE', AgentDocumentStorage.objectPath(key));
    if (response.status !== 204) throw AgentDocumentStorage.unavailable(response);
  }

  async exists(key: string): Promise<boolean> {
    const { response } = await this.request('HEAD', AgentDocumentStorage.objectPath(key));
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw AgentDocumentStorage.unavailable(response);
  }

  async *list(): AsyncIterable<StoredObject> {
    const { response } = await this.request('GET', '/v1/objects');
    if (response.status !== 200) throw AgentDocumentStorage.unavailable(response);
    for (const line of (await response.text()).split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { key: string; validKey: boolean; sizeBytes: number; modifiedAt: string };
      yield { key: entry.key, validKey: entry.validKey, sizeBytes: entry.sizeBytes, modifiedAt: new Date(entry.modifiedAt) };
    }
  }

  /** Never: the agent is private; the API streams files after authorising each request. */
  async createAccessUrl(): Promise<string | null> {
    return null;
  }

  /** Is the agent reachable and does it accept our signature? */
  async ping(): Promise<boolean> {
    try {
      const { response } = await this.request('GET', '/v1/health');
      void response.body?.cancel().catch(() => undefined);
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
