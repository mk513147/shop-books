import { createHash } from 'node:crypto';
import type { Queryable } from '../../database/connection.js';
import type { DocumentStorage, StoredObject } from './storage.js';

export interface ReconcileReport {
  /** Metadata rows checked. */
  documents: number;
  /** Stored objects found. */
  storedObjects: number;
  /** Stored files with no metadata row (e.g. a crash between storing and recording). Safe to delete. */
  orphanFiles: StoredObject[];
  /** Entries that are not valid storage keys (e.g. leftover "*.part" temp files). Safe to delete. */
  strayEntries: StoredObject[];
  /** Metadata rows whose file is missing: DATA LOSS, restore the file from backup. */
  missingFiles: { documentId: string; expenseId: string; storageKey: string; status: string }[];
  /** With verification: stored bytes whose size or SHA-256 differs from the metadata. */
  checksumMismatches: { documentId: string; storageKey: string }[];
  verified: boolean;
}

async function sha256Of(storage: DocumentStorage, key: string): Promise<{ hash: Buffer; size: number }> {
  const { stream } = await storage.open(key);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hash: hash.digest(), size };
}

/**
 * Compares document metadata with what is actually stored. READ-ONLY: it never deletes; the CLI
 * deletes orphans/strays separately, and only those older than a grace period.
 */
export async function reconcileDocuments(db: Queryable, storage: DocumentStorage, verify = false): Promise<ReconcileReport> {
  const rows = (
    await db.query<{ id: string; expense_id: string; storage_key: string; status: string; size_bytes: number; sha256: Buffer }>(
      `SELECT id, expense_id, storage_key, status, size_bytes, sha256 FROM expense_documents ORDER BY created_at, id`,
    )
  ).rows;
  const known = new Set(rows.map((r) => r.storage_key));

  const report: ReconcileReport = {
    documents: rows.length,
    storedObjects: 0,
    orphanFiles: [],
    strayEntries: [],
    missingFiles: [],
    checksumMismatches: [],
    verified: verify,
  };

  for await (const object of storage.list()) {
    report.storedObjects += 1;
    if (!object.validKey) report.strayEntries.push(object);
    else if (!known.has(object.key)) report.orphanFiles.push(object);
  }

  for (const row of rows) {
    if (!(await storage.exists(row.storage_key))) {
      report.missingFiles.push({ documentId: row.id, expenseId: row.expense_id, storageKey: row.storage_key, status: row.status });
      continue;
    }
    if (verify) {
      const actual = await sha256Of(storage, row.storage_key);
      if (actual.size !== row.size_bytes || !actual.hash.equals(row.sha256)) {
        report.checksumMismatches.push({ documentId: row.id, storageKey: row.storage_key });
      }
    }
  }
  return report;
}
