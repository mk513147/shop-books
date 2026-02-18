import { getDb } from "./db";

export const initDatabase = async () => {
	const db = await getDb();

	await db.execAsync(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('income','expense')) NOT NULL,
      amount REAL NOT NULL,
      category TEXT,
      note TEXT,
      date TEXT NOT NULL,
      paymentType TEXT CHECK(paymentType IN ('cash','online','due','due_paid')),
      supplierId INTEGER,
      imagePath TEXT,
      createdAt TEXT,
      FOREIGN KEY (supplierId) REFERENCES suppliers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date
    ON transactions(date);

    CREATE INDEX IF NOT EXISTS idx_transactions_supplier
    ON transactions(supplierId);
  `);
};
