import * as SQLite from "expo-sqlite";

let database: SQLite.SQLiteDatabase | null = null;

export const getDb = async (): Promise<SQLite.SQLiteDatabase> => {
	if (!database) {
		database = await SQLite.openDatabaseAsync("shopbooks.db");
	}

	return database;
};
