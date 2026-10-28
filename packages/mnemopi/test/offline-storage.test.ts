import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modules = Object.fromEntries(
	(
		[
			["config", "../src/config.ts"],
			["db", "../src/db.ts"],
			["banks", "../src/core/banks.ts"],
			["blobs", "../src/core/content-sanitizer.ts"],
			["cost", "../src/core/cost-log.ts"],
			["triples", "../src/core/triples.ts"],
			["plugins", "../src/core/plugins.ts"],
			["streaming", "../src/core/streaming.ts"],
			["beam", "../src/core/beam/index.ts"],
			["memory", "../src/core/memory.ts"],
			["diagnose", "../src/diagnose.ts"],
			["dirs", "../../utils/src/dirs.ts"],
		] as const
	).map(([name, relative]) => [name, new URL(relative, import.meta.url).href]),
);

// Every case imports after the child environment is installed, keeping module-load
// constants, utils' profile resolver, and the parent test process isolated.
function runIsolated(offline: string, script: string): void {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-offline-storage-"));
	try {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"--eval",
				`import assert from "node:assert/strict";
				import * as fs from "node:fs";
				import * as os from "node:os";
				import * as path from "node:path";
				const modules = ${JSON.stringify(modules)};
				const root = ${JSON.stringify(root)};
				${script}`,
			],
			env: {
				...process.env,
				HOME: join(root, "home"),
				USERPROFILE: join(root, "home"),
				OMP_CONFIG_ROOT: join(root, "persistent"),
				OMP_OFFLINE: offline,
				OMP_PROFILE: "memory-regression",
				PI_PROFILE: "",
				MNEMOPI_DATA_DIR: join(root, "outside-data"),
				MNEMOPI_BLOB_DIR: join(root, "outside-blobs"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("isolated memory storage routing", () => {
	it.each(["false", "true"])("preserves defaults and explicit paths with OMP_OFFLINE=%s", offline => {
		runIsolated(
			offline,
			`const config = await import(modules.config);
			assert.equal(config.DEFAULT_DATA_DIR, path.join(os.homedir(), ".hermes", "mnemopi", "data"));
			assert.equal(config.FASTEMBED_CACHE_DIR, path.join(os.homedir(), ".hermes", "cache", "fastembed"));
			assert.equal(config.MODEL_CACHE_DIR, path.join(os.homedir(), ".hermes", "mnemopi", "models"));
			assert.equal(config.dataDir(), process.env.MNEMOPI_DATA_DIR);
			const blobs = await import(modules.blobs);
			assert.equal(blobs.blobRoot(), process.env.MNEMOPI_BLOB_DIR);
			const cost = await import(modules.cost);
			assert.equal(cost.DEFAULT_LOG_DIR, path.join(os.homedir(), ".mnemopi", "data"));
			const { DEFAULT_PLUGIN_DIR } = await import(modules.plugins);
			assert.equal(DEFAULT_PLUGIN_DIR, path.join(os.homedir(), ".hermes", "mnemopi", "plugins"));
			const { BankManager } = await import(modules.banks);
			assert.equal(new BankManager(process.env.MNEMOPI_DATA_DIR).dataDir, process.env.MNEMOPI_DATA_DIR);
			const { openDatabase } = await import(modules.db);
			const externalPath = path.join(root, "external.db");
			const db = openDatabase(externalPath);
			try { assert.equal(db.query("PRAGMA database_list").get().file, externalPath); }
			finally { db.close(); }`,
		);
	});
});
