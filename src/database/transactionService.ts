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
