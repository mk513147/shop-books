import { getDb } from "./db";
import { TransactionInput } from "../types/transaction";

export const addTransaction = async (transaction: TransactionInput) => {
	const db = await getDb();

	await db.runAsync(
		`INSERT INTO transactions 
		(type, amount, category, note, date, paymentType, supplierId, imagePath, createdAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			transaction.type,
			transaction.amount,
			transaction.category,
			transaction.note,
			transaction.date,
			transaction.paymentType,
			transaction.supplierId,
			transaction.imagePath,
			new Date().toISOString(),
		],
	);
};
export const getSummaryByDateRange = async (from: string, to: string) => {
	const db = await getDb();

	const result = await db.getAllAsync(
		`
    SELECT type, IFNULL(SUM(amount), 0) as total
    FROM transactions
    WHERE date BETWEEN ? AND ?
    GROUP BY type
    `,
		[from, to],
	);

	return result;
};

export const getTransactionsByDateRange = async (from: string, to: string) => {
	const db = await getDb();

	const result = await db.getAllAsync(
		`
    SELECT t.*, s.name as supplierName
    FROM transactions t
    LEFT JOIN suppliers s
    ON t.supplierId = s.id
    WHERE t.date BETWEEN ? AND ?
    ORDER BY t.date DESC, t.createdAt DESC
    `,
		[from, to],
	);

	return result;
};

export const getDailyTransactionCount = async (date: string, type: string) => {
	const db = await getDb();

	const result = await db.getFirstAsync<{ count: number }>(
		`
	SELECT COUNT(*) as count
	FROM transactions
	WHERE date = ? AND type = ?
	`,
		[date, type],
	);

	return result?.count ?? 0;
};

export const checkIncomeCategorySameDay = async (
	date: string,
	category: string,
	excludeId?: number,
) => {
	const db = await getDb();

	const result = await db.getFirstAsync(
		`
    SELECT id FROM transactions
    WHERE date = ?
      AND type = 'income'
      AND category = ?
      ${excludeId ? "AND id != ?" : ""}
    LIMIT 1
    `,
		excludeId ? [date, category, excludeId] : [date, category],
	);

	return result;
};

export const checkExpenseSupplierSameDay = async (
	date: string,
	supplierId: number,
	excludeId?: number,
) => {
	const db = await getDb();

	const result = await db.getFirstAsync(
		`
    SELECT id FROM transactions
    WHERE date = ?
      AND type = 'expense'
      AND supplierId = ?
	  ${excludeId ? "AND id != ?" : ""}
    LIMIT 1
    `,
		excludeId ? [date, supplierId, excludeId] : [date, supplierId],
	);

	return result;
};

export const getTransactionsByDate = async (date: string) => {
	const db = await getDb();

	const result = await db.getAllAsync(
		`
    SELECT t.*, s.name as supplierName
    FROM transactions t
    LEFT JOIN suppliers s
    ON t.supplierId = s.id
    WHERE t.date = ?
    ORDER BY t.type, t.createdAt ASC
    `,
		[date],
	);

	return result;
};

export const updateTransaction = async (
	id: number,
	transaction: TransactionInput,
) => {
	const db = await getDb();

	await db.runAsync(
		`UPDATE transactions
		 SET type = ?, amount = ?, category = ?, note = ?, date = ?, 
		     paymentType = ?, supplierId = ?, imagePath = ?
		 WHERE id = ?`,
		[
			transaction.type,
			transaction.amount,
			transaction.category,
			transaction.note,
			transaction.date,
			transaction.paymentType,
			transaction.supplierId,
			transaction.imagePath,
			id,
		],
	);
};

export const deleteTransaction = async (id: number) => {
	const db = await getDb();

	await db.runAsync(`DELETE FROM transactions WHERE id = ?`, [id]);
};
