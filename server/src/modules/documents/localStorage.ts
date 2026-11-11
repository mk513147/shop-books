import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { isValidStorageKey, StorageObjectMissing, type DocumentStorage, type StoredObject } from './storage.js';

/**
 * Development / single-server adapter: files in a private directory on the API host.
 *
 * - The directory must be outside any web root; Express never serves it (there is no static
 *   middleware in the API at all). Files are created with mode 0600, folders 0700 (POSIX).
 * - Writes are atomic: bytes go to a temporary "*.part" file which is then hard-linked to the
 *   final name (fails if that name exists) and removed. A crash can leave only a "*.part" file,
 *   which reconciliation reports as a stray entry.
 * - Every key is validated and the resolved path must stay inside the root directory.
 */
export class LocalDocumentStorage implements DocumentStorage {
  readonly driver = 'local';
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private pathFor(key: string): string {
    if (!isValidStorageKey(key)) throw new Error('Invalid storage key');
    const full = resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  /** The content type is not needed on disk (it is kept in the metadata row). */
  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const target = this.pathFor(key);
    const dir = resolve(target, '..');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(6).toString('hex')}.part`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // link() fails with EEXIST instead of silently replacing an existing object. File systems
      // without hard links (FAT/exFAT) fall back to an exists-check + rename.
      try {
        await link(temp, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw err;
        if (await this.exists(key)) throw Object.assign(new Error('Storage key already exists'), { code: 'EEXIST' });
        await rename(temp, target);
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async open(key: string): Promise<{ stream: Readable; sizeBytes: number }> {
    const path = this.pathFor(key);
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new StorageObjectMissing(key);
      size = info.size;
    } catch (err) {
      if (err instanceof StorageObjectMissing || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageObjectMissing(key);
      }
      throw err;
    }
    return { stream: createReadStream(path), sizeBytes: size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async digest(key: string): Promise<{ sizeBytes: number; sha256Hex: string }> {
    const { stream } = await this.open(key);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of stream) {
      sizeBytes += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    return { sizeBytes, sha256Hex: hash.digest('hex') };
  }

  /** The directory is on this machine: available whenever it can be created/read. */
  async isAvailable(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      return (await stat(this.root)).isDirectory();
    } catch {
      return false;
    }
  }

  async *list(): AsyncIterable<StoredObject> {
    yield* this.walk(this.root);
  }

  private async *walk(dir: string): AsyncIterable<StoredObject> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
        const key = relative(this.root, full).split(sep).join('/');
        yield { key, validKey: isValidStorageKey(key), sizeBytes: info.size, modifiedAt: info.mtime };
      }
    }
  }

  /** Local files have no pre-signed URLs: the API streams them after authorising the request. */
  async createAccessUrl(): Promise<string | null> {
    return null;
  }

  /** For reconciliation only: removes a stray entry (e.g. a leftover "*.part" file) by relative name. */
  async deleteStray(relativeName: string): Promise<void> {
    const full = resolve(this.root, ...relativeName.split('/'));
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid path');
    await rm(full, { force: true });
  }
}
