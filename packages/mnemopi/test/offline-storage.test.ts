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
			["offline", "../../natives/native/offline-root.js"],
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
	it.skipIf(process.platform !== "linux")("keeps owned APIs in shm without restoring a legacy database", () => {
		runIsolated(
			" on ",
			`const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			assert.ok(state);
			try {
				const legacyDb = path.join(process.env.HOME, ".hermes", "mnemopi", "data", "triples.db");
				fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
				// A copy/open of this old NFS database would fail, not silently appear empty.
				fs.writeFileSync(legacyDb, "legacy data must never be opened or copied");
				const config = await import(modules.config);
				const { getMemoriesDir, getFastembedCacheDir } = await import(modules.dirs);
				const memoryRoot = path.join(getMemoriesDir(), "mnemopi");
				assert.ok(memoryRoot.startsWith(state.runtimeRoot + path.sep));
				assert.equal(config.DEFAULT_DATA_DIR, memoryRoot);
				assert.equal(config.dataDir(), memoryRoot);
				assert.equal(config.dbPath(), path.join(memoryRoot, "mnemopi.db"));
				assert.equal(config.FASTEMBED_CACHE_DIR, getFastembedCacheDir());
				assert.equal(config.MODEL_CACHE_DIR, path.join(memoryRoot, "models"));
				assert.equal(config.resolveMemoryDbPath(":memory:"), ":memory:");
				assert.equal(config.dataDir({ ...process.env, OMP_PROFILE: "second" }),
					path.join(state.runtimeRoot, "profiles", "second", "agent", "memories", "mnemopi"));

				const { openDatabase } = await import(modules.db);
				const externalDb = path.join(root, "outside-db", "owned.db");
				const ownedDb = openDatabase(externalDb);
				try {
					assert.equal(ownedDb.query("PRAGMA database_list").get().file, path.join(memoryRoot, "owned.db"));
				} finally { ownedDb.close(); }
				const hostDb = path.join(state.runtimeRoot, "host", "host.db");
				assert.equal(config.resolveMemoryDbPath(hostDb), hostDb);
				const { BeamMemory } = await import(modules.beam);
				const beam = new BeamMemory({ dbPath: hostDb });
				try {
					assert.equal(beam.dbPath, hostDb);
					assert.equal(beam.db.query("PRAGMA database_list").get().file, hostDb);
				} finally { beam.close(); }
				const outsideBeam = new BeamMemory({ dbPath: path.join(root, "outside-db", "beam.db") });
				try { assert.equal(outsideBeam.dbPath, path.join(memoryRoot, "beam.db")); }
				finally { outsideBeam.close(); }
				const { Mnemopi } = await import(modules.memory);
				const facade = new Mnemopi({ dbPath: externalDb, noEmbeddings: true, llmEnabled: false, reconcile: false });
				try { assert.equal(facade.dbPath, path.join(memoryRoot, "owned.db")); }
				finally { facade.close(); }

				const banks = await import(modules.banks);
				assert.equal(banks.DEFAULT_DATA_DIR, config.DEFAULT_DATA_DIR);
				assert.equal(banks.BANKS_DIR, path.join(memoryRoot, "banks"));
				const manager = new banks.BankManager(process.env.MNEMOPI_DATA_DIR);
				assert.equal(manager.dataDir, memoryRoot);
				assert.equal(manager.createBank("regression"), path.join(memoryRoot, "banks", "regression", "mnemopi.db"));
				const hostBanks = new banks.BankManager(path.dirname(hostDb));
				assert.equal(hostBanks.dataDir, path.dirname(hostDb));

				const blobs = await import(modules.blobs);
				assert.equal(blobs.blobRoot(), path.join(memoryRoot, "blobs"));
				const blob = Buffer.from("offline owned blob");
				const hash = blobs.storeBlob(blob);
				assert.deepEqual(fs.readFileSync(path.join(blobs.blobRoot(), hash.slice(0, 2), hash.slice(0, 4), hash)), blob);
				const hostBlobs = path.join(state.runtimeRoot, "host", "blobs");
				assert.equal(blobs.blobRoot({ ...process.env, MNEMOPI_BLOB_DIR: hostBlobs }), hostBlobs);

				const cost = await import(modules.cost);
				assert.equal(cost.DEFAULT_LOG_DIR, memoryRoot);
				assert.equal(cost.DEFAULT_LOG_DB, path.join(memoryRoot, "cost_log.db"));
				cost.logCost("offline", 2, 3, 0.25);
				assert.equal(cost.getCostStats("offline").total_calls, 1);
				const externalCost = path.join(root, "outside-cost", "cost.db");
				cost.logCost("explicit", 1, 2, 0.5, "model", externalCost);
				assert.equal(cost.getCostStats("explicit", externalCost).total_calls, 1);
				assert.equal(fs.existsSync(path.join(memoryRoot, "cost.db")), true);
				const inMemoryCost = cost.getConn(":memory:");
				try { assert.equal(inMemoryCost.query("PRAGMA database_list").get().file, ""); }
				finally { inMemoryCost.close(); }

				const triples = await import(modules.triples);
				assert.equal(triples.resolveDefaultTripleDb(), path.join(memoryRoot, "triples.db"));
				const store = new triples.TripleStore();
				try { assert.deepEqual(store.exportAll(), []); }
				finally { store.close(); }
				assert.equal(fs.readFileSync(legacyDb, "utf8"), "legacy data must never be opened or copied");
				const { DEFAULT_PLUGIN_DIR, PluginManager } = await import(modules.plugins);
				assert.equal(DEFAULT_PLUGIN_DIR, path.join(memoryRoot, "plugins"));
				assert.equal(new PluginManager(path.join(root, "outside-plugins")).pluginDir, DEFAULT_PLUGIN_DIR);

				const { DeltaSync, SyncCheckpoint } = await import(modules.streaming);
				const inMemory = openDatabase(":memory:");
				try {
					const sync = new DeltaSync({ db: inMemory });
					assert.equal(sync.checkpointDir, path.join(memoryRoot, "sync_checkpoints"));
					sync.saveCheckpoint(new SyncCheckpoint({ peerId: "peer", lastRowid: 7 }));
					assert.equal(sync.getCheckpoint("peer").lastRowid, 7);
					const explicitSync = new DeltaSync({ db: inMemory }, path.join(root, "outside-checkpoints"));
					assert.equal(explicitSync.checkpointDir, sync.checkpointDir);
					const hostCheckpointDir = path.join(state.runtimeRoot, "host", "checkpoints");
					assert.equal(new DeltaSync({ db: inMemory }, hostCheckpointDir).checkpointDir, hostCheckpointDir);
				} finally { inMemory.close(); }
				const { inspectDatabase } = await import(modules.diagnose);
				const diagnostic = inspectDatabase({ dbPath: path.join(root, "outside-db", "diagnostic.db") });
				assert.equal(diagnostic.entries.find(entry => entry.check === "db_path").detail,
					path.join(memoryRoot, "diagnostic.db"));

				for (const outside of ["outside-data", "outside-blobs", "outside-db", "outside-cost", "outside-plugins", "outside-checkpoints", "persistent"]) {
					assert.equal(fs.existsSync(path.join(root, outside)), false, outside + " must remain untouched");
				}
			} finally {
				fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
			}`,
		);
	});

	it.skipIf(process.platform !== "linux")(
		"rejects restored directory and database links before touching external SQLite files",
		() => {
			runIsolated(
				"true",
				`import { Database } from "bun:sqlite";
			const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			assert.ok(state);
			try {
				const config = await import(modules.config);
				const { openDatabase } = await import(modules.db);
				const { BeamMemory } = await import(modules.beam);
				const { Mnemopi } = await import(modules.memory);
				const memoryRoot = config.dataDir();
				for (const scope of ["default", "host"]) {
					for (const kind of ["directory", "leaf"]) {
						for (const liveWal of [false, true]) {
							const external = path.join(root, scope + "-" + kind + "-" + liveWal);
							fs.mkdirSync(external, { recursive: true });
							const sentinelPath = path.join(external, "mnemopi.db");
							const sentinel = new Database(sentinelPath);
							try {
								sentinel.exec("PRAGMA journal_mode=WAL");
								sentinel.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('untouched')");
								if (!liveWal) sentinel.close();
								const snapshot = fs.readFileSync(sentinelPath);
								const walPath = sentinelPath + "-wal";
								const walSnapshot = liveWal ? fs.readFileSync(walPath) : undefined;
								if (!liveWal) assert.equal(fs.existsSync(walPath), false);
								const directory = scope === "default" ? memoryRoot : path.join(state.runtimeRoot, "host", "linked-memory");
								const dbPath = path.join(directory, "mnemopi.db");
								const link = kind === "directory" ? directory : dbPath;
								fs.mkdirSync(path.dirname(link), { recursive: true });
								fs.symlinkSync(kind === "directory" ? external : sentinelPath, link);
								try {
									assert.throws(() => config.resolveMemoryDbPath(dbPath), /symbolic links are not allowed/);
									assert.throws(() => openDatabase(dbPath), /symbolic links are not allowed/);
									assert.throws(() => new BeamMemory({ dbPath }), /symbolic links are not allowed/);
									assert.throws(() => new Mnemopi({ dbPath, noEmbeddings: true, llmEnabled: false, reconcile: false }),
										/symbolic links are not allowed/);
									if (scope === "default") {
										assert.throws(() => config.dbPath(), /symbolic links are not allowed/);
										assert.throws(() => openDatabase(), /symbolic links are not allowed/);
										if (kind === "directory") {
											assert.throws(() => config.dataDir(), /symbolic links are not allowed/);
											assert.throws(() => config.resolveMemoryPath(path.join(root, "ignored-external")),
												/symbolic links are not allowed/);
										}
									} else if (kind === "directory") {
										assert.throws(() => config.resolveMemoryPath(directory), /symbolic links are not allowed/);
									}
									if (kind === "directory") {
										assert.throws(() => openDatabase(path.join(directory, "created.db")), /symbolic links are not allowed/);
										assert.equal(fs.existsSync(path.join(external, "created.db")), false);
									}
									assert.deepEqual(fs.readFileSync(sentinelPath), snapshot);
									if (liveWal) assert.deepEqual(fs.readFileSync(walPath), walSnapshot);
									else assert.equal(fs.existsSync(walPath), false);
									if (liveWal) assert.equal(sentinel.query("SELECT value FROM sentinel").get().value, "untouched");
								} finally {
									fs.unlinkSync(link);
								}
							} finally {
								if (liveWal) sentinel.close();
							}
						}
					}
				}
				const nested = path.join(state.runtimeRoot, "host", "owned", "nested", "memory.db");
				const normal = openDatabase(nested);
				try {
					normal.exec("CREATE TABLE owned (value TEXT); INSERT INTO owned VALUES ('local')");
					assert.equal(normal.query("SELECT value FROM owned").get().value, "local");
					assert.equal(normal.query("PRAGMA database_list").get().file, nested);
				} finally { normal.close(); }
				const inMemory = openDatabase(":memory:");
				try { assert.equal(inMemory.query("PRAGMA database_list").get().file, ""); }
				finally { inMemory.close(); }
			} finally {
				fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
			}`,
			);
		},
	);

	it.skipIf(process.platform !== "linux")("validates the runtime selected by a supplied environment", () => {
		runIsolated(
			"true",
			`const config = await import(modules.config);
			const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			const env = { ...process.env, OMP_CONFIG_ROOT: path.join(root, "fixture-persistent"), OMP_PROFILE: "fixture" };
			const fixture = getOfflineShmState(env);
			assert.ok(state);
			assert.ok(fixture);
			try {
				const memoryRoot = path.join(fixture.runtimeRoot, "profiles", "fixture", "agent", "memories", "mnemopi");
				assert.equal(config.dataDir(env), memoryRoot);
				const external = path.join(root, "fixture-external");
				fs.mkdirSync(external);
				fs.writeFileSync(path.join(external, "mnemopi.db"), "untouched");
				fs.mkdirSync(path.dirname(memoryRoot), { recursive: true });
				fs.symlinkSync(external, memoryRoot);
				assert.throws(() => config.dataDir(env), /symbolic links are not allowed/);
				assert.throws(() => config.resolveMemoryPath(memoryRoot, "", env), /symbolic links are not allowed/);
				assert.throws(() => config.dbPath(env), /symbolic links are not allowed/);
				assert.deepEqual(fs.readdirSync(external), ["mnemopi.db"]);
				assert.equal(fs.readFileSync(path.join(external, "mnemopi.db"), "utf8"), "untouched");
				assert.equal(fs.existsSync(env.OMP_CONFIG_ROOT), false);
			} finally {
				fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
				fs.rmSync(path.dirname(fixture.runtimeRoot), { recursive: true, force: true });
			}`,
		);
	});

	it("preserves nonoffline defaults and explicit external paths", () => {
		runIsolated(
			"false",
			`const config = await import(modules.config);
			const { getOfflineShmState } = await import(modules.offline);
			assert.equal(getOfflineShmState(), undefined);
			assert.equal(config.DEFAULT_DATA_DIR, path.join(os.homedir(), ".hermes", "mnemopi", "data"));
			assert.equal(config.FASTEMBED_CACHE_DIR, path.join(os.homedir(), ".hermes", "cache", "fastembed"));
			assert.equal(config.MODEL_CACHE_DIR, path.join(os.homedir(), ".hermes", "mnemopi", "models"));
			assert.equal(config.dataDir(), process.env.MNEMOPI_DATA_DIR);
			assert.equal(config.resolveMemoryDbPath(path.join(root, "external.db")), path.join(root, "external.db"));
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
