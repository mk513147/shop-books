/** GET /api/v1/health */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  version: string | null;
  timestamp: string;
}

export type Role = 'owner' | 'manager';

/** The signed-in user, as reported by the server (never trusted from the client). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

/** POST /auth/login, GET /auth/me, POST /auth/change-password */
export interface SessionResponse {
  user: SessionUser;
  csrfToken: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** POST /users and POST /users/:id/reset-password */
export interface TemporaryPasswordResponse {
  user: UserSummary;
  temporaryPassword: string;
}

export interface PersonRef {
  id: string;
  name: string;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  expenseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierRef {
  id: string;
  name: string;
  isActive: boolean;
}

/** A category or brand as attached to an expense or supplier. */
export interface ClassRef {
  id: string;
  name: string;
  isActive: boolean;
}

/** Brand (manufacturer): master data independent of suppliers and categories. */
export interface Brand {
  id: string;
  name: string;
  isActive: boolean;
  expenseCount: number;
  supplierCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  /** Default categories: pre-selected on NEW expenses for this supplier, never a restriction. */
  categories: ClassRef[];
  /** Default brands: pre-selected on NEW expenses for this supplier. */
  brands: ClassRef[];
  expenseCount: number;
  /** Derived: still owed on active bills / payments not yet allocated to bills. */
  payable: string;
  unallocated: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInput {
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  categoryIds: string[];
  brandIds: string[];
}

export interface SupplierListResponse {
  items: Supplier[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export type PaymentMode = 'cash' | 'upi' | 'bank_transfer' | 'card' | 'cheque' | 'other';

/** One payment method's share of an expense. */
export interface ExpensePayment {
  paymentMode: PaymentMode;
  amount: string;
}

/** Money fields are decimal strings ("1250.00"); never parse them into numbers for arithmetic. */
export interface Expense {
  id: string;
  expenseDate: string;
  supplier: SupplierRef | null;
  /** Supplier text as typed before suppliers existed (migrated expenses only). */
  legacySupplierName: string | null;
  /** Primary category: the first of `categories`. */
  category: ClassRef;
  /** All categories, first = primary. Labels only: the amount is never split or repeated. */
  categories: ClassRef[];
  /** Brands, in the order chosen (may be empty). */
  brands: ClassRef[];
  /** Optional: null when none was entered (show the category name instead). */
  description: string | null;
  amount: string;
  /** Paid at purchase: the exact sum of `payments`. */
  amountPaid: string;
  /** How the paid-at-purchase amount was made up, one row per payment method. */
  payments: ExpensePayment[];
  /** Supplier payments allocated to this bill. */
  allocatedPayments: string;
  /** amount - amountPaid - allocatedPayments. */
  outstanding: string;
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
  /** Active bill documents attached. */
  documentCount: number;
}

export type DocumentMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** Bill photograph / PDF attached to an expense (metadata only; the file is fetched separately). */
export interface ExpenseDocument {
  id: string;
  expenseId: string;
  fileName: string;
  mimeType: DocumentMimeType;
  sizeBytes: number;
  sha256: string;
  status: 'active' | 'removed';
  uploadedBy: PersonRef;
  createdAt: string;
  removedAt: string | null;
  removedBy: PersonRef | null;
  removeReason: string | null;
  /** Saved, but still waiting to reach the desktop document storage (it was offline). */
  pendingDelivery: boolean;
}

export interface ExpenseInput {
  expenseDate: string;
  supplierId: string | null;
  /** At least one; the first is the primary category. */
  categoryIds: string[];
  brandIds: string[];
  description: string | null;
  amount: string;
  /** Must add up to `amount` (a supplier bill may be paid in part or not at all). */
  payments: ExpensePayment[];
  invoiceReference: string | null;
}

export interface ExpenseListResponse {
  items: Expense[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  totals: { count: number; amount: string; amountPaid: string; outstanding: string };
}

export type AuditAction =
  | 'create'
  | 'update'
  | 'void'
  | 'restore'
  | 'archive'
  | 'reactivate'
  | 'link_category'
  | 'unlink_category'
  | 'link_brand'
  | 'unlink_brand'
  | 'import'
  | 'document_add'
  | 'document_remove'
  | 'reverse'
  | 'allocate'
  | 'release_allocation';

export interface AuditHistoryEntry {
  id: string;
  occurredAt: string;
  action: AuditAction;
  /** null for records created by a data migration. */
  actor: PersonRef | null;
  reason: string | null;
  changes: { field: string; before: unknown; after: unknown }[];
  after: Record<string, unknown>;
}

// --- Supplier payments and ledger (Stage 3C) ---------------------------------------------------

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  expense: { id: string; expenseDate: string; description: string; invoiceReference: string | null; amount: string; status: 'active' | 'voided' };
  amount: string;
  status: 'active' | 'released';
  createdAt: string;
  createdBy: PersonRef;
  releasedAt: string | null;
  releasedBy: PersonRef | null;
  releaseReason: string | null;
}

export interface SupplierPayment {
  id: string;
  supplier: SupplierRef;
  paymentDate: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  paymentMode: PaymentMode;
  reference: string | null;
  notes: string | null;
  status: 'active' | 'reversed';
  version: number;
  createdAt: string;
  createdBy: PersonRef;
  updatedAt: string;
  updatedBy: PersonRef;
  reversedAt: string | null;
  reversedBy: PersonRef | null;
  reversalReason: string | null;
}

export interface SupplierPaymentDetail extends SupplierPayment {
  allocations: PaymentAllocation[];
}

export interface SupplierPaymentListResponse {
  items: SupplierPayment[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  totals: { count: number; amount: string; allocated: string; unallocated: string };
}

export interface AllocationInput {
  expenseId: string;
  amount: string;
}

export interface SupplierPaymentInput {
  supplierId: string;
  amount: string;
  paymentDate: string;
  paymentMode: PaymentMode;
  reference: string | null;
  notes: string | null;
  allocations: AllocationInput[];
}

export interface SupplierBalance {
  supplierId: string;
  totalBills: string;
  paidAtPurchase: string;
  totalPayments: string;
  allocated: string;
  payable: string;
  unallocated: string;
  netBalance: string;
  billCount: number;
  paymentCount: number;
}

export type SupplierLedgerType = 'bill' | 'paid_at_purchase' | 'payment';

export interface SupplierLedgerEntry {
  key: string;
  type: SupplierLedgerType;
  sourceId: string;
  date: string;
  reference: string | null;
  description: string;
  paymentMode: PaymentMode | null;
  /** Paid-at-purchase entries: per-method breakdown of `debit` (null for other entries). */
  payments: ExpensePayment[] | null;
  credit: string;
  debit: string;
  runningBalance: string;
  status: 'active' | 'voided' | 'reversed';
  counted: boolean;
  allocated: string | null;
  createdAt: string;
}

export interface SupplierLedger {
  supplier: SupplierRef;
  balance: SupplierBalance;
  broughtForward: string | null;
  entries: SupplierLedgerEntry[];
  truncated: boolean;
}

export interface OpenBill {
  id: string;
  expenseDate: string;
  description: string;
  invoiceReference: string | null;
  amount: string;
  amountPaid: string;
  allocated: string;
  payable: string;
}

export interface SuppliersSummary {
  totalPayable: string;
  totalPayments: string;
  totalUnallocated: string;
  suppliersWithPayable: number;
  topPayable: { id: string; name: string; isActive: boolean; payable: string; unallocated: string }[];
}

// --- Customers and customer ledger (Stage 3D) --------------------------------------------------

/** Two INDEPENDENT balances: what the customer owes (due) and what the shop holds (advance). */
export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  dueBalance: string;
  advanceBalance: string;
  transactionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerInput {
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export interface CustomerListResponse {
  items: Customer[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface CustomersSummary {
  totalDue: string;
  totalAdvance: string;
  customersWithDue: number;
  customersWithAdvance: number;
}

export type CustomerTxnType = 'due' | 'due_payment' | 'advance' | 'advance_refund';

export interface CustomerTransaction {
  id: string;
  customerId: string;
  type: CustomerTxnType;
  txnDate: string;
  amount: string;
  paymentMode: PaymentMode | null;
  due: { id: string; txnDate: string; description: string | null; amount: string } | null;
  description: string | null;
  reference: string | null;
  notes: string | null;
  paidAmount: string | null;
  remainingAmount: string | null;
  status: 'active' | 'reversed';
  version: number;
  createdAt: string;
  createdBy: PersonRef;
  reversedAt: string | null;
  reversedBy: PersonRef | null;
  reversalReason: string | null;
}

export interface CustomerLedgerEntry extends CustomerTransaction {
  dueEffect: string | null;
  advanceEffect: string | null;
  runningDue: string;
  runningAdvance: string;
  counted: boolean;
}

export interface CustomerLedger {
  customer: { id: string; name: string; isActive: boolean };
  balances: { due: string; advance: string };
  broughtForward: { due: string; advance: string } | null;
  entries: CustomerLedgerEntry[];
  truncated: boolean;
}

export interface CustomerTxnInput {
  amount: string;
  txnDate: string;
  paymentMode?: PaymentMode;
  dueId?: string;
  description: string | null;
  reference: string | null;
  notes: string | null;
}

// --- Salesmen (standalone directory; migration 0013) ---------------------------------------------

export interface Salesman {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: PersonRef;
  updatedBy: PersonRef;
}

export interface SalesmanInput {
  name: string;
  phone: string | null;
  notes: string | null;
}

export interface SalesmanListResponse {
  items: Salesman[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
