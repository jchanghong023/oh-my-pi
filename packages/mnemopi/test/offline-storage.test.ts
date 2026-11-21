import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

it("writes to the requested Mnemopi database path in offline mode", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopi-offline-storage-"));
	const databasePath = path.join(root, "memory", "external.db");
	try {
		const moduleUrl = new URL("../src/db.ts", import.meta.url).href;
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"--eval",
				`import { openDatabase } from ${JSON.stringify(moduleUrl)};
				const db = openDatabase(${JSON.stringify(databasePath)});
				try { db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)"); }
				finally { db.close(); }`,
			],
			env: {
				...process.env,
				OMP_CONFIG_ROOT: path.join(root, "persistent"),
				OMP_CACHE_DIR: path.join(root, "cache"),
				OMP_OFFLINE: "1",
			},
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(fs.existsSync(databasePath)).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
