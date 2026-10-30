import { loadDatabaseConfig } from '../config/env.js';
import { loadEnvFiles } from '../config/loadEnvFiles.js';
import { createPool } from '../database/connection.js';
import { getMigrationStatus } from '../database/migrator.js';
import { buildBackfillReport } from '../modules/suppliers/backfillReport.js';
import { reportCliError, UserFacingError } from './shared.js';

/**
 * Read-only report of how migration 0004 turned typed supplier names into supplier records:
 *   npm run suppliers:backfill-report
 * Changes nothing.
 */
async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadDatabaseConfig();
  const pool = createPool(config);
  try {
    const status = await getMigrationStatus(pool);
    if (!status.applied.some((m) => m.version === '0004')) {
      throw new UserFacingError('Migration 0004_suppliers has not been applied yet. Run "npm run db:migrate" first.');
    }
    const report = await buildBackfillReport(pool);

    console.log(`Supplier backfill report (environment: ${config.nodeEnv})\n`);
    if (report.mappings.length === 0) {
      console.log('No expenses had a supplier name, so no suppliers were created from existing data.');
    } else {
      console.log('Typed name  ->  supplier record  (expenses, rule)');
      for (const m of report.mappings) {
        console.log(`  "${m.originalName}"  ->  "${m.supplierName}"  (${m.expenseCount}, ${m.matchRule})`);
      }
      const merged = report.mappings.filter((m) => m.matchRule === 'normalised').length;
      console.log(`\n${report.mappings.length} distinct typed name(s); ${merged} merged by case/spacing only.`);
    }
    console.log(`Expenses with a typed name but no supplier: ${report.unlinkedExpenses}`);

    if (report.possibleDuplicates.length === 0) {
      console.log('\nNo active suppliers look like duplicates.');
    } else {
      console.log('\nPOSSIBLE DUPLICATES (names differ only in punctuation/spacing/case). These were NOT merged.');
      console.log('Review them; if they are the same supplier, move expenses to one and archive the other:');
      for (const d of report.possibleDuplicates) console.log(`  ${d.names.map((n) => `"${n}"`).join('  |  ')}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => reportCliError('Supplier backfill report', err));
