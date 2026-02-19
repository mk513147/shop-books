import { getDb } from "./db";

export const addTransaction = async (transaction: any) => {
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

export const checkExistingEntry = async (date: string, type: string) => {
	const db = await getDb();

	const result = await db.getFirstAsync(
		`
    SELECT id FROM transactions
    WHERE date = ? AND type = ?
    LIMIT 1
    `,
		[date, type],
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
