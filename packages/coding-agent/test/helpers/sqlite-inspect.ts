import { Database } from "bun:sqlite";

export function withSqliteDatabase<T>(
	dbPath: string,
	callback: (db: Database) => T,
	options: { readonly?: boolean } = {},
): T {
	const db = new Database(dbPath, { strict: true, ...options });
	try {
		if (!options.readonly) db.run("PRAGMA foreign_keys=ON");
		return callback(db);
	} finally {
		db.close();
	}
}

export function readTableSql(dbPath: string, tableName: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
			| { sql?: string | null }
			| undefined;
		return row?.sql ?? null;
	} finally {
		db.close();
	}
}
