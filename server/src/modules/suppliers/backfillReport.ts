import type { Queryable } from '../../database/connection.js';

export interface BackfillReport {
  mappings: { originalName: string; supplierName: string; expenseCount: number; matchRule: 'exact' | 'normalised' }[];
  /** Expenses with a legacy supplier name but no supplier (must be 0; the migration enforces it). */
  unlinkedExpenses: number;
  /** Active suppliers whose names differ only in punctuation, spacing or case: review by hand. */
  possibleDuplicates: { key: string; names: string[] }[];
}

/** Read-only summary of the 0004 supplier backfill, plus suppliers that look like duplicates. */
export async function buildBackfillReport(db: Queryable): Promise<BackfillReport> {
  const mappings = await db.query<{ original_name: string; supplier_name: string; expense_count: number; match_rule: 'exact' | 'normalised' }>(
    `SELECT original_name, supplier_name, expense_count, match_rule
       FROM supplier_backfill_log ORDER BY lower(supplier_name), original_name`,
  );
  const unlinked = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM expenses WHERE legacy_supplier_name IS NOT NULL AND supplier_id IS NULL`,
  );
  const duplicates = await db.query<{ key: string; names: string[] }>(
    `SELECT lower(regexp_replace(name, '[^[:alnum:]]', '', 'g')) AS key,
            array_agg(name ORDER BY name) AS names
       FROM suppliers
      WHERE is_active
      GROUP BY 1
     HAVING count(*) > 1
      ORDER BY 1`,
  );
  return {
    mappings: mappings.rows.map((r) => ({
      originalName: r.original_name,
      supplierName: r.supplier_name,
      expenseCount: r.expense_count,
      matchRule: r.match_rule,
    })),
    unlinkedExpenses: unlinked.rows[0]!.n,
    possibleDuplicates: duplicates.rows,
  };
}
