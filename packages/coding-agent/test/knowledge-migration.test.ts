import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { KnowledgeIndexEngine } from "../src/knowledge/engine";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function profile(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-migration-"));
	directories.push(directory);
	return directory;
}

async function seed(agentDir: string, marker: string): Promise<void> {
	const engine = new KnowledgeIndexEngine({ agentDir });
	engine.close();
	const db = new Database(path.join(agentDir, "knowledge.db"), { strict: true });
	try {
		db.run("CREATE TABLE migration_test_marker(value TEXT NOT NULL)");
		db.query("INSERT INTO migration_test_marker(value) VALUES (?)").run(marker);
	} finally {
		db.close();
	}
}

function marker(databasePath: string): string {
	const db = new Database(databasePath, { readonly: true, strict: true });
	try {
		return (db.query("SELECT value FROM migration_test_marker").get() as { value: string }).value;
	} finally {
		db.close();
	}
}

async function legacyProfile(value: string): Promise<string> {
	const agentDir = await profile();
	await seed(agentDir, value);
	await fs.rename(path.join(agentDir, "knowledge.db"), path.join(agentDir, "docs.db"));
	return agentDir;
}

describe("legacy knowledge database adoption", () => {
	it("snapshots committed WAL frames while retaining the original database", async () => {
		const agentDir = await legacyProfile("before-wal");
		const source = path.join(agentDir, "docs.db");
		const destination = path.join(agentDir, "knowledge.db");
		const writer = new Database(source, { strict: true });
		try {
			writer.run("PRAGMA journal_mode=WAL");
			writer.run("PRAGMA wal_autocheckpoint=0");
			writer.run("UPDATE migration_test_marker SET value='committed-in-wal'");
			expect((await fs.stat(`${source}-wal`)).size).toBeGreaterThan(0);
			const engine = new KnowledgeIndexEngine({ agentDir });
			try {
				expect(engine.databasePath).toBe(destination);
				expect(engine.list()).toEqual([]);
				expect(marker(destination)).toBe("committed-in-wal");
				expect(marker(source)).toBe("committed-in-wal");
				expect(await Bun.file(source).exists()).toBe(true);
			} finally {
				engine.close();
			}
		} finally {
			writer.close();
		}
	});

	it("does not replace or merge an existing destination", async () => {
		const agentDir = await legacyProfile("legacy-only");
		const destinationProfile = await profile();
		await seed(destinationProfile, "destination-only");
		await fs.copyFile(path.join(destinationProfile, "knowledge.db"), path.join(agentDir, "knowledge.db"));
		const engine = new KnowledgeIndexEngine({ agentDir });
		try {
			expect(marker(engine.databasePath)).toBe("destination-only");
			expect(marker(path.join(agentDir, "docs.db"))).toBe("legacy-only");
		} finally {
			engine.close();
		}
	});

	it("surfaces snapshot errors without deleting the legacy source or creating a destination", async () => {
		const agentDir = await profile();
		const source = path.join(agentDir, "docs.db");
		const contents = "not a SQLite database";
		await fs.writeFile(source, contents);
		expect(() => new KnowledgeIndexEngine({ agentDir })).toThrow();
		expect(await fs.readFile(source, "utf8")).toBe(contents);
		expect(await Bun.file(path.join(agentDir, "knowledge.db")).exists()).toBe(false);
	});

	it("isolates migrations between agent profiles", async () => {
		const a = await legacyProfile("profile-a");
		const b = await legacyProfile("profile-b");
		const first = new KnowledgeIndexEngine({ agentDir: a });
		const second = new KnowledgeIndexEngine({ agentDir: b });
		try {
			expect(marker(first.databasePath)).toBe("profile-a");
			expect(marker(second.databasePath)).toBe("profile-b");
			expect(marker(path.join(a, "docs.db"))).toBe("profile-a");
			expect(marker(path.join(b, "docs.db"))).toBe("profile-b");
		} finally {
			first.close();
			second.close();
		}
	});

	it("publishes a complete snapshot to simultaneous openers", async () => {
		const agentDir = await legacyProfile("concurrent-snapshot");
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const workers: Worker[] = [];
		try {
			for (let index = 0; index < 4; index++) {
				workers.push(
					new Worker(
						`
					import { parentPort, workerData } from "node:worker_threads";
					import { Database } from "bun:sqlite";
					import { KnowledgeIndexEngine } from ${JSON.stringify(import.meta.resolve("../src/knowledge/engine"))};
					const gate = new Int32Array(workerData.gate);
					parentPort.postMessage("ready");
					if (Atomics.wait(gate, 0, 0, 10000) === "timed-out") throw new Error("Migration barrier timed out");
					const engine = new KnowledgeIndexEngine({ agentDir: workerData.agentDir });
					try {
						const db = new Database(engine.databasePath, { readonly: true, strict: true });
						try { parentPort.postMessage({ marker: db.query("SELECT value FROM migration_test_marker").get().value, indexes: engine.list() }); }
						finally { db.close(); }
					} finally { engine.close(); }
					`,
						{ eval: true, workerData: { agentDir, gate: gate.buffer } },
					),
				);
			}
			const ready = await Promise.all(workers.map(worker => once(worker, "message")));
			expect(ready).toEqual(workers.map(() => ["ready"]));
			const results = workers.map(worker => once(worker, "message"));
			Atomics.store(gate, 0, 1);
			Atomics.notify(gate, 0);
			expect(await Promise.all(results)).toEqual(
				workers.map(() => [{ marker: "concurrent-snapshot", indexes: [] }]),
			);
			expect(marker(path.join(agentDir, "docs.db"))).toBe("concurrent-snapshot");
		} finally {
			Atomics.store(gate, 0, 1);
			Atomics.notify(gate, 0);
			await Promise.all(workers.map(worker => worker.terminate()));
		}
	}, 30_000);
});
