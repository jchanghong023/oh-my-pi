import { Database } from "bun:sqlite";

/** Keep Bun's SQLite copy from closing POSIX locks owned by the live native writer. */
export function readSqliteTables(dbPath: string, tables: readonly string[]): unknown[] {
	const child = Bun.spawnSync(
		[
			process.execPath,
			"--eval",
			`import { Database } from "bun:sqlite";
const db = new Database(process.argv[1], { readonly: true, strict: true });
try {
	console.log(JSON.stringify(JSON.parse(process.argv[2]).map(table =>
		db.query("SELECT rowid,* FROM " + table + " ORDER BY rowid").all())));
} finally { db.close(); }`,
			dbPath,
			JSON.stringify(tables),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (child.exitCode !== 0) throw new Error(`SQLite inspection failed: ${child.stderr.toString()}`);
	return JSON.parse(child.stdout.toString());
}

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
