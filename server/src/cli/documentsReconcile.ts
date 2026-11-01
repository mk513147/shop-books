import { loadConfig } from '../config/env.js';
import { loadEnvFiles } from '../config/loadEnvFiles.js';
import { createPool } from '../database/connection.js';
import { getMigrationStatus } from '../database/migrator.js';
import { LocalDocumentStorage } from '../modules/documents/localStorage.js';
import { reconcileDocuments } from '../modules/documents/reconcile.js';
import { createDocumentStorage } from '../modules/documents/storage.js';
import { reportCliError, UserFacingError } from './shared.js';

/**
 * Checks bill-document metadata against document storage:
 *   npm run documents:reconcile                          report only (changes nothing)
 *   npm run documents:reconcile -- --verify              also re-hash every file (slower)
 *   npm run documents:reconcile -- --delete-orphans      delete orphan/stray files older than 24 h
 *        [--min-age-hours=N]  (minimum 1)  [--yes] (required in production)
 *
 * Orphans are files with no metadata row (an upload interrupted between storing and recording, or
 * a failed clean-up). The grace period protects uploads still in progress. Files that DO have a
 * row are never deleted by this tool, including removed documents (kept as evidence).
 * Exit code 1 when a metadata row has no file or a checksum differs (restore from backup).
 */
async function main(): Promise<void> {
  loadEnvFiles();
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');
  const deleteOrphans = args.includes('--delete-orphans');
  const ageArg = args.find((a) => a.startsWith('--min-age-hours='));
  const minAgeHours = ageArg ? Number(ageArg.split('=')[1]) : 24;
  if (!Number.isFinite(minAgeHours) || minAgeHours < 1) throw new UserFacingError('--min-age-hours must be at least 1.');

  const config = loadConfig();
  if (deleteOrphans && config.nodeEnv === 'production' && !args.includes('--yes')) {
    throw new UserFacingError('Deleting files in production requires --yes.');
  }
  const pool = createPool(config);
  const storage = createDocumentStorage(config.documentStorage);
  try {
    const status = await getMigrationStatus(pool);
    if (!status.applied.some((m) => m.version === '0005')) {
      throw new UserFacingError('Migration 0005_expense_documents has not been applied yet. Run "npm run db:migrate" first.');
    }
    const report = await reconcileDocuments(pool, storage, verify);
    console.log(`Document reconciliation (environment: ${config.nodeEnv}, storage: ${storage.driver})\n`);
    console.log(`Metadata rows: ${report.documents}   Stored objects: ${report.storedObjects}`);
    console.log(`Orphan files (no metadata): ${report.orphanFiles.length}`);
    console.log(`Stray entries (not valid keys, e.g. *.part): ${report.strayEntries.length}`);
    console.log(`MISSING files for metadata rows: ${report.missingFiles.length}`);
    for (const m of report.missingFiles) console.log(`  document ${m.documentId} (expense ${m.expenseId}, ${m.status})`);
    if (verify) {
      console.log(`Checksum mismatches: ${report.checksumMismatches.length}`);
      for (const m of report.checksumMismatches) console.log(`  document ${m.documentId}`);
    }

    if (deleteOrphans) {
      const cutoff = Date.now() - minAgeHours * 3600 * 1000;
      let deleted = 0;
      for (const o of report.orphanFiles) {
        if (o.modifiedAt.getTime() > cutoff) continue;
        await storage.delete(o.key);
        deleted += 1;
      }
      for (const s of report.strayEntries) {
        if (s.modifiedAt.getTime() > cutoff || !(storage instanceof LocalDocumentStorage)) continue;
        await storage.deleteStray(s.key);
        deleted += 1;
      }
      console.log(`\nDeleted ${deleted} orphan/stray file(s) older than ${minAgeHours} h.`);
    } else if (report.orphanFiles.length + report.strayEntries.length > 0) {
      console.log('\nRe-run with --delete-orphans to delete orphan/stray files older than 24 h.');
    }
    if (report.missingFiles.length > 0 || report.checksumMismatches.length > 0) {
      console.error('\nPROBLEM: some documents are missing or altered. Restore them from the storage backup.');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => reportCliError('Document reconciliation', err));
