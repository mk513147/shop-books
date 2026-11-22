/**
 * Seeds the LOCAL TEST DATABASE (shop_books_test) for the product catalogue Playwright suite
 * (web/playwright.products.config.ts) and writes the import fixture workbook to the OS temp
 * directory. Refuses any other database (same guards as the integration tests). Never touches
 * development or production data.
 *
 *   NODE_ENV=test npx tsx tests/e2e/productsE2eSeed.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadEnvFiles } from '../../src/config/loadEnvFiles.js';
import { runMigrations } from '../../src/database/migrator.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { connectTestDatabase } from '../helpers.js';

export const E2E_PASSWORD = 'e2e-password-123';
export const E2E_FIXTURE_DIR = path.join(tmpdir(), 'shop-books-e2e');

if (process.env.NODE_ENV !== 'test') throw new Error('Run with NODE_ENV=test (seeds the local test database only)');
loadEnvFiles();
const db = await connectTestDatabase();
if (!db) throw new Error('The local test database is not reachable');

await runMigrations(db);
await db.query('TRUNCATE users, sessions, auth_events, idempotency_keys RESTART IDENTITY CASCADE');
const hash = await hashPassword(E2E_PASSWORD);
const users = await db.query<{ id: string; email: string }>(
  `INSERT INTO users (email, name, role, password_hash, can_view_purchase_prices, can_edit_purchase_prices) VALUES
     ('owner@e2e.test', 'Olivia Owner', 'owner', $1, false, false),
     ('costs@e2e.test', 'Asha Costs', 'manager', $1, true, true),
     ('staff@e2e.test', 'Ravi Staff', 'manager', $1, false, false)
   RETURNING id, email`,
  [hash],
);
const owner = users.rows.find((u) => u.email === 'owner@e2e.test')!.id;
const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0]!.id;
const notebooks = await one(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ('Notebook (Copy)', true, $1, $1) RETURNING id`, [owner]);
await one(`INSERT INTO expense_categories (name, is_product_usable, created_by, updated_by) VALUES ('Rent', false, $1, $1) RETURNING id`, [owner]);
const classmate = await one(`INSERT INTO brands (name, created_by, updated_by) VALUES ('Classmate', $1, $1) RETURNING id`, [owner]);
await one(`INSERT INTO brands (name, created_by, updated_by) VALUES ('DOMS', $1, $1) RETURNING id`, [owner]);
const sharma = await one(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ('Sharma Traders', $1, $1) RETURNING id`, [owner]);
await one(`INSERT INTO suppliers (name, created_by, updated_by) VALUES ('National Distributors', $1, $1) RETURNING id`, [owner]);
await db.query(`INSERT INTO supplier_brands (supplier_id, brand_id, created_by) VALUES ($1, $2, $3)`, [sharma, classmate, owner]);
const register = await one(
  `INSERT INTO products (name, brand_id, category_id, size, page_count, binding, mrp, selling_price, barcode, created_by, updated_by)
   VALUES ('Register', $1, $2, 'A4', 140, 'register', 55, 50, '8901234567890', $3, $3) RETURNING id`,
  [classmate, notebooks, owner],
);
await db.query(`INSERT INTO product_costs (product_id, default_purchase_price, created_by, updated_by) VALUES ($1, 41.25, $2, $2)`, [register, owner]);

// Import fixture: one good row, an exact duplicate, and an ambiguous row (unknown brand + "50,3/pc").
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Products');
ws.addRow(['Brand', 'Product name', 'Category', 'Pages', 'Selling price', 'MRP']);
ws.addRow(['Classmate', 'Long Book', 'Notebook (Copy)', 120, 45, 50]);
ws.addRow(['Classmate', 'Long Book', 'Notebook (Copy)', 120, 45, 50]);
ws.addRow(['Oddy', 'Design Pad', 'Notebook (Copy)', 20, '50,3/pc', 80]);
await mkdir(E2E_FIXTURE_DIR, { recursive: true });
await writeFile(path.join(E2E_FIXTURE_DIR, 'products-import.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));

await db.end();
console.log('Seeded shop_books_test for the product e2e suite.');
