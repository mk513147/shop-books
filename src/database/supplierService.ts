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

export const getOrCreateSupplier = async (name: string) => {
	const db = await getDb();

	const existing = await db.getFirstAsync<{ id: number }>(
		`SELECT id FROM suppliers WHERE name = ? LIMIT 1`,
		[name],
	);

	if (existing) {
		return existing.id;
	}

	const result = await db.runAsync(
		`INSERT INTO suppliers (name, createdAt)
     VALUES (?, ?)`,
		[name, new Date().toISOString()],
	);

	return result.lastInsertRowId;
};
