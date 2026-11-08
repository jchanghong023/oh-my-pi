import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage, SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readTableSql } from "./helpers/sqlite-inspect";

const LEGACY_TIMESTAMP = 1_700_000_000;

function readSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function readSettingsRows(dbPath: string): Array<{ key: string; value: string; updated_at: number }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key ASC").all() as Array<{
			key: string;
			value: string;
			updated_at: number;
		}>;
	} finally {
		db.close();
	}
}

describe("AgentStorage SQLite compatibility", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		AgentStorage.close();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	it("creates fresh storage without unixepoch defaults", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-fresh-");
		const dbPath = path.join(tempDir.path(), "agent.db");

		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("openai/gpt-5");

		expect(storage.getModelUsageOrder()).toEqual(["openai/gpt-5"]);
		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(readTableSql(dbPath, "settings")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "settings")).toContain("strftime('%s','now')");
		expect(readTableSql(dbPath, "model_usage")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "model_usage")).toContain("strftime('%s','now')");
	});

	it("migrates legacy settings and model usage schemas away from unixepoch defaults", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-legacy-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (4);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("theme", '"dark"', LEGACY_TIMESTAMP);
		legacyDb
			.prepare("INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ?)")
			.run("anthropic/claude-sonnet-4-5", LEGACY_TIMESTAMP);
		legacyDb.close();

		const storage = await AgentStorage.open(dbPath);

		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(readTableSql(dbPath, "settings")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "settings")).toContain("strftime('%s','now')");
		expect(readTableSql(dbPath, "model_usage")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "model_usage")).toContain("strftime('%s','now')");
		expect(storage.getSettings()).toEqual({ theme: "dark" });
		expect(storage.getModelUsageOrder()).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(readSettingsRows(dbPath)).toEqual([{ key: "theme", value: '"dark"', updated_at: LEGACY_TIMESTAMP }]);
	});

	it.each([6, 7])("opens schema v%s without deleting unmanaged tables or native data", async version => {
		tempDir = TempDir.createSync("@omp-agent-storage-preserved-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const seed = new Database(dbPath);
		seed.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE model_perf (
				model_key TEXT PRIMARY KEY,
				samples REAL NOT NULL DEFAULT 0,
				output_tokens REAL NOT NULL DEFAULT 0,
				gen_ms REAL NOT NULL DEFAULT 0,
				ttft_samples REAL NOT NULL DEFAULT 0,
				ttft_ms REAL NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE unmanaged_extension_data (value TEXT NOT NULL);
			INSERT INTO unmanaged_extension_data(value) VALUES ('preserved');
			INSERT INTO model_perf(model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms)
			VALUES ('openai/gpt-5', 2, 200, 2000, 2, 100);
		`);
		seed.prepare("INSERT INTO schema_version(version) VALUES (?)").run(version);
		seed
			.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)")
			.run("theme", '"dark"', LEGACY_TIMESTAMP);
		seed
			.prepare("INSERT INTO model_usage(model_key, last_used_at) VALUES (?, ?)")
			.run("openai/gpt-5", LEGACY_TIMESTAMP);
		seed.close();

		const storage = await AgentStorage.open(dbPath);
		expect(storage.getSettings()).toEqual({ theme: "dark" });
		expect(storage.getModelUsageOrder()).toEqual(["openai/gpt-5"]);
		expect(storage.getModelPerf().get("openai/gpt-5")).toEqual({ samples: 2, tps: 100, ttftMs: 50 });
		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(readSettingsRows(dbPath)).toEqual([{ key: "theme", value: '"dark"', updated_at: LEGACY_TIMESTAMP }]);
		const inspect = new Database(dbPath, { readonly: true });
		try {
			expect(inspect.prepare("SELECT value FROM unmanaged_extension_data").all()).toEqual([{ value: "preserved" }]);
		} finally {
			inspect.close();
		}
	});

	it("clears migrated settings rows", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-clear-settings-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const seed = new Database(dbPath);
		seed.exec(`
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
		`);
		seed
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("theme", '"dark"', LEGACY_TIMESTAMP);
		seed.close();

		const storage = await AgentStorage.open(dbPath);
		expect(storage.getSettings()).toEqual({ theme: "dark" });
		storage.clearMigratedSettings();
		expect(storage.getSettings()).toBeNull();
		expect(readSettingsRows(dbPath)).toEqual([]);
	});
});
