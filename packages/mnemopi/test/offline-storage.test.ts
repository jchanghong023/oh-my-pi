import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../src/db";

it("creates the parent and writes to the requested Mnemopi database path", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopi-storage-"));
	const databasePath = path.join(root, "memory", "external.db");
	try {
		const db = openDatabase(databasePath, { pageSize: 4096 });
		try {
			db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
		} finally {
			db.close();
		}
		expect(fs.existsSync(databasePath)).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
