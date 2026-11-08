import type { Database, Queryable } from '../../database/connection.js';
import type { Actor } from '../../middleware/auth.js';
import { todayInReportingZone } from '../../utils/dates.js';
import { AppError, NotFoundError, ValidationError, type ErrorDetail } from '../../utils/errors.js';
import { fromPaise, normaliseMoney, rupees, toPaise } from '../../utils/money.js';
import { containsPattern } from '../../utils/sql.js';
import { listAuditHistory, recordFinancialAudit, type AuditHistoryEntry, type AuditSnapshot } from '../audit/financialAudit.js';
import { withSessionTransaction } from '../auth/sessionTransaction.js';
import { hashRequest, runIdempotent, type IdempotentResult } from '../idempotency/idempotency.js';
import type { ExpenseInput, ExpenseListQuery, PaymentLine, PaymentMode } from './expenses.schemas.js';

interface PersonRef {
  id: string;
  name: string;
}

/** A category or brand as shown on an expense. */
export interface ClassRef {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Expense {
  id: string;
  expenseDate: string;
  supplier: { id: string; name: string; isActive: boolean } | null;
  /** Supplier text as typed before suppliers existed (migrated expenses only); read-only history. */
  legacySupplierName: string | null;
  /** The PRIMARY category: the first of `categories` (reports attribute the amount to it). */
  category: { id: string; name: string; isActive: boolean };
  /** Every category of the expense in the user's order (first = primary); labels, not allocations. */
  categories: ClassRef[];
  /** Brands the expense relates to, in the user's order (labels only; may be empty). */
  brands: ClassRef[];
  /** Optional free text; null when none was given (clients then show the category name). */
  description: string | null;
  /** Money: decimal strings, e.g. "1250.00". */
  amount: string;
  /** Paid at purchase: always the exact sum of `payments`. */
  amountPaid: string;
  /** How the paid-at-purchase amount was made up, one row per payment method (empty when unpaid). */
  payments: PaymentLine[];
  /** Derived: active supplier-payment allocations settling this bill (Stage 3C). */
  allocatedPayments: string;
  /** Derived: amount - amountPaid - allocatedPayments (never stored). */
  outstanding: string;
  /** The first payment's method (summary of `payments`); null when nothing was paid. */
  paymentMode: PaymentMode | null;
  invoiceReference: string | null;
  status: 'active' | 'voided';
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: PersonRef;
  updatedBy: PersonRef;
  voidedAt: string | null;
  voidedBy: PersonRef | null;
  voidReason: string | null;
  /** Active bill documents attached (Stage 3B). */
  documentCount: number;
}

interface ExpenseRow {
  id: string;
  expense_date: string;
  legacy_supplier_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_active: boolean | null;
  description: string | null;
  amount: string;
  amount_paid: string;
  allocated: string;
  outstanding: string;
  payment_mode: PaymentMode | null;
  invoice_reference: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
  category_id: string;
  category_name: string;
  category_active: boolean;
  created_by_id: string;
  created_by_name: string;
  updated_by_id: string;
  updated_by_name: string;
  voided_by_id: string | null;
  voided_by_name: string | null;
  document_count: number;
}

/** Active supplier-payment allocations of expense `e` (correlated subquery). */
const ALLOCATED_SQL = `SELECT COALESCE(sum(a.amount), 0)::numeric(14,2) AS allocated
    FROM supplier_payment_allocations a WHERE a.expense_id = e.id AND a.released_at IS NULL`;

const SELECT_EXPENSE = `
  SELECT e.id, e.expense_date, e.legacy_supplier_name, e.description, e.amount, e.amount_paid,
         al.allocated, (e.amount - e.amount_paid - al.allocated)::numeric(14,2) AS outstanding, e.payment_mode, e.invoice_reference, e.version,
         e.created_at, e.updated_at, e.voided_at, e.void_reason,
         c.id AS category_id, c.name AS category_name, c.is_active AS category_active,
         s.id AS supplier_id, s.name AS supplier_name, s.is_active AS supplier_active,
         cu.id AS created_by_id, cu.name AS created_by_name,
         uu.id AS updated_by_id, uu.name AS updated_by_name,
         vu.id AS voided_by_id, vu.name AS voided_by_name,
         (SELECT count(*)::int FROM expense_documents d WHERE d.expense_id = e.id AND d.status = 'active') AS document_count
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    JOIN users cu ON cu.id = e.created_by
    JOIN users uu ON uu.id = e.updated_by
    LEFT JOIN users vu ON vu.id = e.voided_by
    CROSS JOIN LATERAL (${ALLOCATED_SQL}) al`;

type ExpenseRowWithPayments = ExpenseRow & { payments: PaymentLine[]; categories: ClassRef[]; brands: ClassRef[] };

function toExpense(row: ExpenseRowWithPayments): Expense {
  const primary = { id: row.category_id, name: row.category_name, isActive: row.category_active };
  return {
    id: row.id,
    expenseDate: row.expense_date,
    supplier: row.supplier_id
      ? { id: row.supplier_id, name: row.supplier_name ?? '', isActive: row.supplier_active ?? false }
      : null,
    legacySupplierName: row.legacy_supplier_name,
    category: primary,
    categories: row.categories.length > 0 ? row.categories : [primary],
    brands: row.brands,
    description: row.description,
    amount: row.amount,
    amountPaid: row.amount_paid,
    payments: row.payments,
    allocatedPayments: row.allocated,
    outstanding: row.outstanding,
    paymentMode: row.payment_mode,
    invoiceReference: row.invoice_reference,
    status: row.voided_at ? 'voided' : 'active',
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidedBy: row.voided_by_id ? { id: row.voided_by_id, name: row.voided_by_name ?? '' } : null,
    voidReason: row.void_reason,
    documentCount: row.document_count,
  };
}

/** Business fields recorded in the financial audit log (as of the change, incl. supplier/category names). */
function snapshot(row: ExpenseRowWithPayments): AuditSnapshot {
  return {
    expenseDate: row.expense_date,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    // All categories / brands by name, in order ("Transport, Packaging"); labels, not allocations.
    categories: row.categories.map((c) => c.name).join(', ') || row.category_name,
    brands: row.brands.length ? row.brands.map((b) => b.name).join(', ') : null,
    description: row.description,
    amount: row.amount,
    amountPaid: row.amount_paid,
    paymentMode: row.payment_mode,
    // "upi:1000.00,cash:1500.00" (audit snapshots hold primitives only).
    payments: row.payments.length ? row.payments.map((p) => `${p.paymentMode}:${p.amount}`).join(',') : null,
    invoiceReference: row.invoice_reference,
    status: row.voided_at ? 'voided' : 'active',
    voidReason: row.void_reason,
  };
}

/** Payment rows of the given expenses, in the order the user entered them. */
export async function loadPayments(client: Queryable, ids: string[]): Promise<Map<string, PaymentLine[]>> {
  const byExpense = new Map<string, PaymentLine[]>();
  if (ids.length === 0) return byExpense;
  const result = await client.query<{ expense_id: string; payment_mode: PaymentMode; amount: string }>(
    `SELECT expense_id, payment_mode, amount FROM expense_payments WHERE expense_id = ANY($1::uuid[]) ORDER BY expense_id, position`,
    [ids],
  );
  for (const r of result.rows) {
    const lines = byExpense.get(r.expense_id) ?? [];
    lines.push({ paymentMode: r.payment_mode, amount: r.amount });
    byExpense.set(r.expense_id, lines);
  }
  return byExpense;
}

export interface Classification {
  categories: ClassRef[];
  brands: ClassRef[];
}

/** Categories and brands of the given expenses, each in the order the user chose. */
export async function loadClassification(client: Queryable, ids: string[]): Promise<Map<string, Classification>> {
  const byExpense = new Map<string, Classification>(ids.map((id) => [id, { categories: [], brands: [] }]));
  if (ids.length === 0) return byExpense;
  const result = await client.query<{ expense_id: string; kind: 'category' | 'brand'; id: string; name: string; is_active: boolean }>(
    `SELECT l.expense_id, 'category' AS kind, c.id, c.name, c.is_active, l.position
       FROM expense_category_links l JOIN expense_categories c ON c.id = l.category_id
      WHERE l.expense_id = ANY($1::uuid[])
     UNION ALL
     SELECT eb.expense_id, 'brand' AS kind, b.id, b.name, b.is_active, eb.position
       FROM expense_brands eb JOIN brands b ON b.id = eb.brand_id
      WHERE eb.expense_id = ANY($1::uuid[])
     ORDER BY expense_id, kind, position`,
    [ids],
  );
  for (const r of result.rows) {
    const entry = byExpense.get(r.expense_id)!;
    (r.kind === 'category' ? entry.categories : entry.brands).push({ id: r.id, name: r.name, isActive: r.is_active });
  }
  return byExpense;
}

async function selectExpense(client: Queryable, id: string, lock = false): Promise<ExpenseRowWithPayments> {
  if (lock) await client.query(`SELECT 1 FROM expenses WHERE id = $1 FOR UPDATE`, [id]);
  const result = await client.query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Expense not found');
  const classes = (await loadClassification(client, [id])).get(id)!;
  return { ...row, ...classes, payments: (await loadPayments(client, [id])).get(id) ?? [] };
}

/** Order-sensitive identity of a payment list, for change detection. */
const paymentsKey = (payments: PaymentLine[]): string => payments.map((p) => `${p.paymentMode}:${p.amount}`).join(',');

const paidTotal = (input: ExpenseInput): bigint => input.payments.reduce((sum, p) => sum + toPaise(p.amount), 0n);

/** The final, ordered category and brand ids to store for an expense. */
interface ClassificationIds {
  categoryIds: string[];
  brandIds: string[];
}

/**
 * What an UPDATE stores. A request that only names `categoryId` (an older frontend) sets the
 * primary category and must not wipe what that client does not know about: the expense's other
 * categories stay (in their order), and omitted brands stay. Only explicit arrays replace them,
 * so an empty `brandIds: []` is the way to clear brands on purpose.
 */
function resolveClassificationForUpdate(input: ExpenseInput, current: ExpenseRowWithPayments): ClassificationIds {
  let categoryIds = input.categoryIds;
  if (input.categoriesFromLegacy) {
    const primary = input.categoryIds[0]!;
    // Position 1 was the old primary: the legacy client replaced it. Positions 2+ are kept.
    const secondary = current.categories.slice(1).map((c) => c.id).filter((cid) => cid !== primary);
    categoryIds = [primary, ...secondary];
  }
  return { categoryIds, brandIds: input.brandIds ?? current.brands.map((b) => b.id) };
}

/** Replaces the category and brand links of an expense (inside the caller's transaction). */
async function writeClassification(client: Queryable, expenseId: string, { categoryIds, brandIds }: ClassificationIds): Promise<void> {
  await client.query(`DELETE FROM expense_category_links WHERE expense_id = $1`, [expenseId]);
  await client.query(
    `INSERT INTO expense_category_links (expense_id, category_id, position)
     SELECT $1, id, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)`,
    [expenseId, categoryIds],
  );
  await client.query(`DELETE FROM expense_brands WHERE expense_id = $1`, [expenseId]);
  if (brandIds.length > 0) {
    await client.query(
      `INSERT INTO expense_brands (expense_id, brand_id, position)
       SELECT $1, id, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)`,
      [expenseId, brandIds],
    );
  }
}

/** Replaces the allocation rows of an expense (inside the caller's transaction). */
async function writePayments(client: Queryable, expenseId: string, payments: PaymentLine[]): Promise<void> {
  await client.query(`DELETE FROM expense_payments WHERE expense_id = $1`, [expenseId]);
  for (const [index, p] of payments.entries()) {
    await client.query(
      `INSERT INTO expense_payments (expense_id, position, payment_mode, amount) VALUES ($1, $2, $3, $4::numeric)`,
      [expenseId, index + 1, p.paymentMode, p.amount],
    );
  }
}

/**
 * Cross-field financial rules, checked on every create and update (the DB re-checks them too).
 * All amounts are compared as integer paise; nothing here uses floating point.
 *
 * Payments must add up to the amount paid at purchase. A bill with a supplier may be paid only
 * in part or not at all (the rest stays payable to that supplier); any other expense must be
 * paid in full. Historic supplier-less expenses that were saved part-paid may keep that state as
 * long as neither their amount nor their payments change.
 */
function validateFinancials(input: ExpenseInput, current?: ExpenseRowWithPayments): void {
  const issues: ErrorDetail[] = [];
  const amount = toPaise(input.amount);
  const paid = paidTotal(input);

  if (amount <= 0n) issues.push({ path: 'amount', message: 'The amount must be greater than zero' });
  input.payments.forEach((p, i) => {
    if (toPaise(p.amount) <= 0n) issues.push({ path: `payments.${i}.amount`, message: 'The payment amount must be greater than zero' });
  });
  if (paid > amount) {
    const reducingBelowPaid = current !== undefined && toPaise(current.amount_paid) === paid && toPaise(current.amount) !== amount;
    issues.push({
      path: reducingBelowPaid ? 'amount' : 'payments',
      message: reducingBelowPaid
        ? `The amount cannot be less than the amount already paid (₹${current.amount_paid}). Correct the payments first if they were wrong.`
        : `The payments total ${rupees(paid)}, which is more than the expense amount ${rupees(amount)} (${rupees(paid - amount)} over)`,
    });
  } else if (paid < amount && input.supplierId === null) {
    // A historic supplier-less part-paid expense may be edited (description, date, ...) as it is,
    // but only while both its amount and what was paid stay exactly as recorded.
    const keepsLegacyState =
      current !== undefined &&
      current.supplier_id === null &&
      toPaise(current.amount) === amount &&
      toPaise(current.amount_paid) === paid &&
      paid < amount;
    if (!keepsLegacyState) {
      issues.push({
        path: 'payments',
        message: `The payments total ${rupees(paid)}, but the expense amount is ${rupees(amount)} (${rupees(amount - paid)} remaining). The payments must add up to the full amount.`,
      });
    }
  }
  if (input.expenseDate > todayInReportingZone()) {
    issues.push({ path: 'expenseDate', message: 'The expense date cannot be in the future' });
  }
  if (input.expenseDate < '2000-01-01') {
    issues.push({ path: 'expenseDate', message: 'The expense date is too far in the past' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Supplier payments allocated to this bill must stay valid (the database re-checks this too):
 * the supplier cannot change, and amount - amount paid at purchase must still cover the allocations.
 */
function assertAllocationsKept(input: ExpenseInput, current: ExpenseRow): void {
  const paid = paidTotal(input);
  const allocated = toPaise(current.allocated);
  if (allocated === 0n) return;
  if (input.supplierId !== current.supplier_id) {
    throw new AppError(
      409,
      'EXPENSE_HAS_ALLOCATIONS',
      `Supplier payments (₹${current.allocated}) are allocated to this bill, so its supplier cannot change. Release those allocations first.`,
    );
  }
  if (toPaise(input.amount) - paid < allocated) {
    throw new ValidationError([
      {
        path: toPaise(input.amount) !== toPaise(current.amount) ? 'amount' : 'payments',
        message: `Supplier payments of ₹${current.allocated} are allocated to this bill: the amount minus the amount paid at purchase cannot be less than that.`,
      },
    ]);
  }
}

/**
 * Newly chosen categories / brands must exist and be ACTIVE; ones the expense already carries
 * (`keep`) may stay even if archived since. All of them are share-locked meanwhile, so none can be
 * archived halfway through the write.
 */
async function assertClassesUsable(
  client: Queryable,
  table: 'expense_categories' | 'brands',
  ids: string[],
  keep: Set<string>,
): Promise<void> {
  if (ids.length === 0) return;
  const result = await client.query<{ id: string; name: string; is_active: boolean }>(
    `SELECT id, name, is_active FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
    [ids],
  );
  const found = new Map(result.rows.map((r) => [r.id, r]));
  const what = table === 'brands' ? 'brand' : 'category';
  const path = table === 'brands' ? 'brandIds' : 'categoryIds';
  const issues: ErrorDetail[] = ids.flatMap((id) => {
    const row = found.get(id);
    if (!row) return [{ path, message: `A selected ${what} does not exist` }];
    if (!row.is_active && !keep.has(id)) return [{ path, message: `“${row.name}” is archived; choose an active ${what}` }];
    return [];
  });
  if (issues.length > 0) throw new ValidationError(issues);
}

/** New expenses (and supplier changes) may only use an ACTIVE supplier. Share-locks it meanwhile. */
async function assertSupplierUsable(client: Queryable, supplierId: string): Promise<void> {
  const result = await client.query<{ is_active: boolean }>(`SELECT is_active FROM suppliers WHERE id = $1 FOR SHARE`, [
    supplierId,
  ]);
  const row = result.rows[0];
  if (!row || !row.is_active) {
    throw new ValidationError([
      { path: 'supplierId', message: row ? 'This supplier is archived; choose an active one' : 'Supplier not found' },
    ]);
  }
}

function normalised(input: ExpenseInput): ExpenseInput {
  return {
    ...input,
    amount: normaliseMoney(input.amount),
    payments: input.payments.map((p) => ({ ...p, amount: normaliseMoney(p.amount) })),
  };
}

/** Payment method summarised on the expense row: the first payment's (null when nothing was paid). */
const primaryMode = (input: ExpenseInput): PaymentMode | null => input.payments[0]?.paymentMode ?? null;

async function insertExpense(client: Queryable, input: ExpenseInput, actor: Actor): Promise<Expense> {
  // Lock order (unchanged in spirit): categories, brands, then supplier, all FOR SHARE.
  await assertClassesUsable(client, 'expense_categories', input.categoryIds, new Set());
  const brandIds = input.brandIds ?? [];
  await assertClassesUsable(client, 'brands', brandIds, new Set());
  if (input.supplierId) await assertSupplierUsable(client, input.supplierId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO expenses (expense_date, supplier_id, category_id, description, amount, amount_paid,
                           payment_mode, invoice_reference, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9, $9)
     RETURNING id`,
    [
      input.expenseDate,
      input.supplierId,
      input.categoryIds[0],
      input.description,
      input.amount,
      fromPaise(paidTotal(input)),
      primaryMode(input),
      input.invoiceReference,
      actor.userId,
    ],
  );
  await writePayments(client, inserted.rows[0]!.id, input.payments);
  await writeClassification(client, inserted.rows[0]!.id, { categoryIds: input.categoryIds, brandIds });
  const row = await selectExpense(client, inserted.rows[0]!.id);
  await recordFinancialAudit(client, {
    entityType: 'expense',
    entityId: row.id,
    action: 'create',
    actorUserId: actor.userId,
    before: null,
    after: snapshot(row),
  });
  return toExpense(row);
}

/**
 * Creates an expense. With an idempotency key, a retried request (same key, same normalised
 * input) returns the originally created expense instead of creating a second one.
 */
export async function createExpense(
  db: Database,
  rawInput: ExpenseInput,
  actor: Actor,
  idempotencyKey: string | null = null,
): Promise<IdempotentResult<{ expense: Expense }>> {
  const input = normalised(rawInput);
  validateFinancials(input);
  if (idempotencyKey === null) {
    const expense = await withSessionTransaction(db, actor.sessionId, (client) => insertExpense(client, input, actor));
    return { status: 201, body: { expense }, replayed: false };
  }
  return runIdempotent(db, actor, 'expense.create', idempotencyKey, hashRequest(input), async (client) => {
    const expense = await insertExpense(client, input, actor);
    return { status: 201, body: { expense }, resourceId: expense.id };
  });
}

/** Locks the row and enforces "exists, expected version, (not) voided". */
async function lockForChange(
  client: Queryable,
  id: string,
  expectedVersion: number,
  mustBeVoided: boolean,
): Promise<ExpenseRowWithPayments> {
  const current = await selectExpense(client, id, true);
  if (current.version !== expectedVersion) {
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This expense was changed by someone else after you opened it. Reload to see the latest version.',
    );
  }
  const voided = current.voided_at !== null;
  if (voided && !mustBeVoided) {
    throw new AppError(409, 'EXPENSE_VOIDED', 'This expense is voided. Restore it before making changes.');
  }
  if (!voided && mustBeVoided) {
    throw new AppError(409, 'EXPENSE_NOT_VOIDED', 'This expense is not voided.');
  }
  return current;
}

export async function updateExpense(
  db: Database,
  id: string,
  rawInput: ExpenseInput,
  expectedVersion: number,
  actor: Actor,
): Promise<Expense> {
  const input = normalised(rawInput);
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockForChange(client, id, expectedVersion, false);
    validateFinancials(input, current);
    assertAllocationsKept(input, current);
    // Categories / brands the expense already has may stay even if archived since; new ones must be active.
    const currentCategoryIds = current.categories.map((c) => c.id);
    const currentBrandIds = current.brands.map((b) => b.id);
    const next = resolveClassificationForUpdate(input, current);
    await assertClassesUsable(client, 'expense_categories', next.categoryIds, new Set(currentCategoryIds));
    await assertClassesUsable(client, 'brands', next.brandIds, new Set(currentBrandIds));
    // An archived supplier may stay on an existing expense, but cannot be newly chosen.
    if (input.supplierId && input.supplierId !== current.supplier_id) await assertSupplierUsable(client, input.supplierId);

    const unchanged =
      input.expenseDate === current.expense_date &&
      input.supplierId === current.supplier_id &&
      next.categoryIds.join(',') === currentCategoryIds.join(',') &&
      next.brandIds.join(',') === currentBrandIds.join(',') &&
      input.description === current.description &&
      input.amount === current.amount &&
      paymentsKey(input.payments) === paymentsKey(current.payments) &&
      input.invoiceReference === current.invoice_reference;
    if (unchanged) return toExpense(current);

    await client.query(
      `UPDATE expenses
          SET expense_date = $2, supplier_id = $3, category_id = $4, description = $5,
              amount = $6::numeric, amount_paid = $7::numeric, payment_mode = $8, invoice_reference = $9,
              updated_by = $10, version = version + 1
        WHERE id = $1`,
      [
        id,
        input.expenseDate,
        input.supplierId,
        next.categoryIds[0],
        input.description,
        input.amount,
        fromPaise(paidTotal(input)),
        primaryMode(input),
        input.invoiceReference,
        actor.userId,
      ],
    );
    await writePayments(client, id, input.payments);
    await writeClassification(client, id, next);
    const after = await selectExpense(client, id);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: id,
      action: 'update',
      actorUserId: actor.userId,
      before: snapshot(current),
      after: snapshot(after),
    });
    return toExpense(after);
  });
}

/** Soft void: values are preserved; the row stays visible via filters and detail view. */
export async function voidExpense(db: Database, id: string, reason: string, expectedVersion: number, actor: Actor): Promise<Expense> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockForChange(client, id, expectedVersion, false);
    if (toPaise(current.allocated) > 0n) {
      throw new AppError(
        409,
        'EXPENSE_HAS_ALLOCATIONS',
        `Supplier payments (₹${current.allocated}) are allocated to this bill. Release those allocations on the payment before voiding it.`,
      );
    }
    await client.query(
      `UPDATE expenses
          SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2, version = version + 1
        WHERE id = $1`,
      [id, actor.userId, reason],
    );
    const after = await selectExpense(client, id);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: id,
      action: 'void',
      actorUserId: actor.userId,
      reason,
      before: snapshot(current),
      after: snapshot(after),
    });
    return toExpense(after);
  });
}

/** Explicit recovery of a voided expense, with its own reason; the void stays in the history. */
export async function restoreExpense(db: Database, id: string, reason: string, expectedVersion: number, actor: Actor): Promise<Expense> {
  return withSessionTransaction(db, actor.sessionId, async (client) => {
    const current = await lockForChange(client, id, expectedVersion, true);
    await client.query(
      `UPDATE expenses
          SET voided_at = NULL, voided_by = NULL, void_reason = NULL, updated_by = $2, version = version + 1
        WHERE id = $1`,
      [id, actor.userId],
    );
    const after = await selectExpense(client, id);
    await recordFinancialAudit(client, {
      entityType: 'expense',
      entityId: id,
      action: 'restore',
      actorUserId: actor.userId,
      reason,
      before: snapshot(current),
      after: snapshot(after),
    });
    return toExpense(after);
  });
}

export async function getExpense(db: Queryable, id: string): Promise<Expense> {
  return toExpense(await selectExpense(db, id));
}

export async function getExpenseHistory(db: Queryable, id: string): Promise<AuditHistoryEntry[]> {
  await selectExpense(db, id); // 404 for unknown ids
  return listAuditHistory(db, 'expense', id);
}

export interface ExpenseListResult {
  items: Expense[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  /** Over ALL rows matching the filters, excluding voided expenses. */
  totals: { count: number; amount: string; amountPaid: string; outstanding: string };
}

const SORT_SQL: Record<ExpenseListQuery['sort'], (dir: string) => string> = {
  date: (dir) => `e.expense_date ${dir}, e.created_at ${dir}`,
  amount: (dir) => `e.amount ${dir}, e.expense_date DESC`,
  created: (dir) => `e.created_at ${dir}`,
};

/** Server-side filtering, sorting and pagination. Every value is a bound parameter. */
export async function listExpenses(db: Queryable, query: ExpenseListQuery): Promise<ExpenseListResult> {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];

  if (query.status === 'active') where.push('e.voided_at IS NULL');
  if (query.status === 'voided') where.push('e.voided_at IS NOT NULL');
  if (query.q) {
    const pattern = bind(containsPattern(query.q));
    where.push(
      `(s.name ILIKE ${pattern} ESCAPE '\\' OR e.legacy_supplier_name ILIKE ${pattern} ESCAPE '\\'` +
        ` OR e.description ILIKE ${pattern} ESCAPE '\\' OR e.invoice_reference ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (query.from) where.push(`e.expense_date >= ${bind(query.from)}::date`);
  if (query.to) where.push(`e.expense_date <= ${bind(query.to)}::date`);
  // Any position; EXISTS keeps one row per expense, so totals never count an expense twice.
  if (query.categoryId) {
    where.push(`EXISTS (SELECT 1 FROM expense_category_links xl WHERE xl.expense_id = e.id AND xl.category_id = ${bind(query.categoryId)})`);
  }
  if (query.brandId) {
    where.push(`EXISTS (SELECT 1 FROM expense_brands xb WHERE xb.expense_id = e.id AND xb.brand_id = ${bind(query.brandId)})`);
  }
  if (query.supplierId) where.push(`e.supplier_id = ${bind(query.supplierId)}`);
  if (query.paymentMode === 'none') where.push('NOT EXISTS (SELECT 1 FROM expense_payments xp WHERE xp.expense_id = e.id)');
  else if (query.paymentMode) {
    where.push(`EXISTS (SELECT 1 FROM expense_payments xp WHERE xp.expense_id = e.id AND xp.payment_mode = ${bind(query.paymentMode)})`);
  }
  if (query.recordedBy) where.push(`e.created_by = ${bind(query.recordedBy)}`);
  if (query.minAmount) where.push(`e.amount >= ${bind(query.minAmount)}::numeric`);
  if (query.maxAmount) where.push(`e.amount <= ${bind(query.maxAmount)}::numeric`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const filterParams = [...params];

  const summary = await db.query<{ total: number; active_count: number; amount: string; paid: string; outstanding: string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE e.voided_at IS NULL)::int AS active_count,
            COALESCE(sum(e.amount) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS amount,
            COALESCE(sum(e.amount_paid) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS paid,
            COALESCE(sum(e.amount - e.amount_paid - al.allocated) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(20,2) AS outstanding
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id CROSS JOIN LATERAL (${ALLOCATED_SQL}) al ${whereSql}`,
    filterParams,
  );

  const dir = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = bind(query.pageSize);
  const offset = bind((query.page - 1) * query.pageSize);
  const rows = await db.query<ExpenseRow>(
    `${SELECT_EXPENSE} ${whereSql} ORDER BY ${SORT_SQL[query.sort](dir)}, e.id ${dir} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const s = summary.rows[0]!;
  const ids = rows.rows.map((r) => r.id);
  const payments = await loadPayments(db, ids);
  const classes = await loadClassification(db, ids);
  return {
    items: rows.rows.map((r) => toExpense({ ...r, ...classes.get(r.id)!, payments: payments.get(r.id) ?? [] })),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: s.total,
      totalPages: Math.max(1, Math.ceil(s.total / query.pageSize)),
    },
    totals: { count: s.active_count, amount: s.amount, amountPaid: s.paid, outstanding: s.outstanding },
  };
}

/** Users who have recorded expenses (for the "recorded by" filter; available to all roles). */
export async function listRecorders(db: Queryable): Promise<PersonRef[]> {
  const result = await db.query<PersonRef>(
    `SELECT DISTINCT u.id, u.name FROM expenses e JOIN users u ON u.id = e.created_by ORDER BY u.name`,
  );
  return result.rows;
}
