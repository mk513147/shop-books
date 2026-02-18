import { getDb } from "./db";

export const addSupplier = async (name: string) => {
	const db = await getDb();

	const result = await db.runAsync(
		`INSERT INTO suppliers (name, createdAt)
     VALUES (?, ?)`,
		[name, new Date().toISOString()],
	);

	return result;
};

export const getSuppliers = async () => {
	const db = await getDb();

	const result = await db.getAllAsync(`SELECT * FROM suppliers`);

	return result;
};
