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
				const { runDiagnostics } = await import(modules.diagnose);
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
									const diagnostic = runDiagnostics({ dbPath });
									assert.equal(diagnostic.database, dbPath);
									assert.ok(diagnostic.checks_failed > 0);
									assert.equal(diagnostic.entries.find(entry => entry.check === "open_or_inspect").status, "ERROR");
									assert.equal(diagnostic.entries.some(entry => entry.check === "integrity_check"), false);
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

	it.skipIf(process.platform !== "linux")(
		"reports rejected diagnostic paths as JSON without opening or owning a database",
		() => {
			runIsolated(
				"true",
				`import { Database } from "bun:sqlite";
			import { fileURLToPath } from "node:url";
			const config = await import(modules.config);
			const { runDiagnostics } = await import(modules.diagnose);
			const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			assert.ok(state);
			const db = new Database(":memory:");
			try {
				const memoryRoot = config.dataDir();
				const external = path.join(root, "diagnostic-external");
				fs.mkdirSync(external);
				const sentinel = path.join(external, "mnemopi.db");
				fs.writeFileSync(sentinel, "diagnostics must not open external data");
				const linkedData = path.join(state.runtimeRoot, "host", "linked-data");
				fs.mkdirSync(path.dirname(linkedData), { recursive: true });
				fs.symlinkSync(external, linkedData);
				const unopenedDb = path.join(state.runtimeRoot, "host", "unopened.db");
				const assertFailure = (summary, database) => {
					assert.equal(summary.database, database);
					assert.ok(summary.checks_failed > 0);
					assert.equal(summary.entries.find(entry => entry.check === "open_or_inspect").status, "ERROR");
					assert.equal(summary.entries.some(entry => entry.check === "integrity_check"), false);
				};
				assertFailure(runDiagnostics({ dbPath: unopenedDb, dataDir: linkedData }), unopenedDb);
				assert.equal(fs.existsSync(unopenedDb), false);
				assertFailure(runDiagnostics({ db, dbPath: ":memory:", dataDir: linkedData }), ":memory:");
				assert.equal(db.query("SELECT COUNT(*) AS count FROM sqlite_master").get().count, 0);
				const healthy = runDiagnostics({ db, dbPath: ":memory:", dataDir: memoryRoot });
				assert.equal(healthy.checks_failed, 0);
				assert.equal(healthy.entries.find(entry => entry.check === "integrity_check").status, "OK");
				assert.equal(db.query("SELECT 1 AS value").get().value, 1);

				fs.mkdirSync(memoryRoot, { recursive: true });
				const defaultDb = path.join(memoryRoot, config.DEFAULT_DB_FILENAME);
				fs.symlinkSync(sentinel, defaultDb);
				assertFailure(runDiagnostics(), defaultDb);
				const cli = Bun.spawnSync({
					cmd: [process.execPath, fileURLToPath(modules.diagnose)],
					env: process.env,
					stdout: "pipe",
					stderr: "pipe",
				});
				assert.equal(cli.exitCode, 1);
				assert.equal(cli.stderr.toString(), "");
				assertFailure(JSON.parse(cli.stdout.toString()), defaultDb);
				assert.deepEqual(fs.readdirSync(external), ["mnemopi.db"]);
				assert.equal(fs.readFileSync(sentinel, "utf8"), "diagnostics must not open external data");
				assert.equal(fs.existsSync(process.env.OMP_CONFIG_ROOT), false);
			} finally {
				db.close();
				fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
			}`,
			);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"rejects linked bank roots and operation paths before filesystem access",
		() => {
			runIsolated(
				"true",
				`const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			assert.ok(state);
			try {
				const config = await import(modules.config);
				const { BankManager } = await import(modules.banks);
				for (const scope of ["default", "host"]) {
					const dataDir = scope === "default" ? config.dataDir() : path.join(state.runtimeRoot, "host", "bank-data");
					const manager = new BankManager(dataDir);
					const external = path.join(root, "external-banks-" + scope);
					const victim = path.join(external, "victim");
					fs.mkdirSync(victim, { recursive: true });
					const sentinel = path.join(victim, "sentinel");
					fs.writeFileSync(sentinel, "untouched");
					fs.rmdirSync(manager.banksDir);
					fs.symlinkSync(external, manager.banksDir);
					assert.throws(() => new BankManager(dataDir), /symbolic links are not allowed/);
					assert.throws(() => manager.createBank("created"), /symbolic links are not allowed/);
					assert.throws(() => manager.deleteBank("victim"), /symbolic links are not allowed/);
					assert.throws(() => manager.renameBank("victim", "renamed"), /symbolic links are not allowed/);
					assert.deepEqual(fs.readdirSync(external), ["victim"]);
					assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
					fs.unlinkSync(manager.banksDir);
					fs.mkdirSync(manager.banksDir);
					fs.symlinkSync(victim, path.join(manager.banksDir, "victim"));
					const source = manager.createBank("source");
					assert.equal(source, path.join(dataDir, "banks", "source", "mnemopi.db"));
					assert.throws(() => manager.createBank("victim"), /symbolic links are not allowed/);
					assert.throws(() => manager.deleteBank("victim"), /symbolic links are not allowed/);
					assert.throws(() => manager.renameBank("victim", "renamed"), /symbolic links are not allowed/);
					assert.throws(() => manager.renameBank("source", "victim"), /symbolic links are not allowed/);
					fs.symlinkSync(path.join(external, "missing"), path.join(manager.banksDir, "dangling"));
					assert.throws(() => manager.createBank("dangling"), /symbolic links are not allowed/);
					assert.throws(() => manager.renameBank("source", "dangling"), /symbolic links are not allowed/);
					assert.equal(fs.existsSync(source), true);
					assert.deepEqual(fs.readdirSync(external), ["victim"]);
					assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
				}
			} finally {
				fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
			}`,
			);
		},
	);

	it.skipIf(process.platform !== "linux")("rejects linked blob shards and existing or dangling blob leaves", () => {
		runIsolated(
			"true",
			`const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			assert.ok(state);
			try {
				const blobs = await import(modules.blobs);
				const bytes = Buffer.from("blob symlink regression");
				const hash = blobs.computeSha256(bytes);
				const blobRoot = blobs.blobRoot();
				for (const kind of ["shard", "leaf", "dangling"]) {
					const external = path.join(root, "external-blob-" + kind);
					fs.mkdirSync(external);
					const sentinel = path.join(external, "sentinel");
					fs.writeFileSync(sentinel, "untouched");
					const blobPath = path.join(blobRoot, hash.slice(0, 2), hash.slice(0, 4), hash);
					const link = kind === "shard" ? path.join(blobRoot, hash.slice(0, 2)) : blobPath;
					fs.mkdirSync(path.dirname(link), { recursive: true });
					fs.symlinkSync(kind === "shard" ? external : kind === "leaf" ? sentinel : path.join(external, "missing"), link);
					assert.throws(() => blobs.storeBlob(bytes), /symbolic links are not allowed/);
					assert.deepEqual(fs.readdirSync(external), ["sentinel"]);
					assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
					fs.rmSync(blobRoot, { recursive: true, force: true });
				}
				assert.equal(blobs.storeBlob(bytes), hash);
				assert.deepEqual(fs.readFileSync(path.join(blobRoot, hash.slice(0, 2), hash.slice(0, 4), hash)), bytes);
			} finally {
				fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
			}`,
		);
	});

	it.skipIf(process.platform !== "linux")(
		"rejects linked checkpoint files and peer paths escaping the runtime",
		() => {
			runIsolated(
				"true",
				`const { getOfflineShmState } = await import(modules.offline);
			const state = getOfflineShmState();
			assert.ok(state);
			const { openDatabase } = await import(modules.db);
			const { DeltaSync, SyncCheckpoint } = await import(modules.streaming);
			const db = openDatabase(":memory:");
			try {
				const sync = new DeltaSync({ db });
				const external = path.join(root, "external-checkpoint");
				const original = new SyncCheckpoint({ peerId: "peer", lastRowid: 99 }).toJson();
				fs.writeFileSync(external, original);
				const checkpoint = new SyncCheckpoint({ peerId: "peer", lastRowid: 7 });
				for (const suffix of [".working_memory.json", ".episodic_memory.json", ".json"]) {
					for (const dangling of [false, true]) {
						const target = dangling ? external + "-missing" : external;
						const link = path.join(sync.checkpointDir, "peer" + suffix);
						fs.symlinkSync(target, link);
						const table = suffix === ".episodic_memory.json" ? "episodic_memory" : "working_memory";
						assert.throws(() => sync.getCheckpoint("peer", table), /symbolic links are not allowed/);
						if (suffix !== ".json") {
							assert.throws(() => sync.saveCheckpoint(checkpoint, table), /symbolic links are not allowed/);
						}
						assert.equal(fs.readFileSync(external, "utf8"), original);
						assert.equal(fs.existsSync(external + "-missing"), false);
						fs.unlinkSync(link);
					}
				}
				const externalDir = path.join(root, "external-checkpoints");
				fs.mkdirSync(externalDir);
				fs.symlinkSync(externalDir, path.join(sync.checkpointDir, "linked"));
				assert.throws(() => sync.getCheckpoint("linked/peer"), /symbolic links are not allowed/);
				assert.throws(() => sync.saveCheckpoint(new SyncCheckpoint({ peerId: "linked/peer" })),
					/symbolic links are not allowed/);
				assert.deepEqual(fs.readdirSync(externalDir), []);
				const escapingPeer = path.relative(sync.checkpointDir, path.join(root, "escaped-peer"));
				assert.throws(() => sync.getCheckpoint(escapingPeer), /must remain inside the runtime root/);
				assert.throws(() => sync.saveCheckpoint(new SyncCheckpoint({ peerId: escapingPeer })),
					/must remain inside the runtime root/);
				assert.equal(fs.existsSync(path.join(root, "escaped-peer.working_memory.json")), false);
				sync.saveCheckpoint(checkpoint);
				assert.equal(sync.getCheckpoint("peer").lastRowid, 7);
			} finally {
				db.close();
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
