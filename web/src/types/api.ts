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

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  /** Linked categories: suggestions only, never a restriction. */
  categories: { id: string; name: string; isActive: boolean }[];
  expenseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInput {
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  categoryIds: string[];
}

export interface SupplierListResponse {
  items: Supplier[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export type PaymentMode = 'cash' | 'upi' | 'bank_transfer' | 'card' | 'cheque' | 'other';

/** Money fields are decimal strings ("1250.00"); never parse them into numbers for arithmetic. */
export interface Expense {
  id: string;
  expenseDate: string;
  supplier: SupplierRef | null;
  /** Supplier text as typed before suppliers existed (migrated expenses only). */
  legacySupplierName: string | null;
  category: { id: string; name: string; isActive: boolean };
  description: string;
  amount: string;
  amountPaid: string;
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
}

export interface ExpenseInput {
  expenseDate: string;
  supplierId: string | null;
  categoryId: string;
  description: string;
  amount: string;
  amountPaid: string;
  paymentMode: PaymentMode | null;
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
  | 'import';

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
