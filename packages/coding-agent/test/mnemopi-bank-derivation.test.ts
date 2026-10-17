import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeMnemopiBankScope, extendRecallWithLegacyBanks } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

// Set up a fixture filesystem we can reuse across the two regression
// suites — same shape as `~/.omp/memories/mnemopi/` on a real install.
let rootDir: TempDir;
let dbDir: string;
let banksDir: string;
let mainDbPath: string;

beforeAll(async () => {
	rootDir = await TempDir.create("@mnemopi-bank-derivation-");
	dbDir = rootDir.join("mnemopi");
	banksDir = path.join(dbDir, "banks");
	await fs.mkdir(banksDir, { recursive: true });
	mainDbPath = path.join(dbDir, "mnemopi.db");
});

afterAll(async () => {
	await Bun.sleep(0);
	await rootDir.remove();
});

// Schema mirrors the subset of `packages/mnemopi/src/core/beam/schema.ts`
// that this code path needs to probe. We deliberately do not run the
// full schema setup — the cwd-probing query only touches working_memory.
function createBankFixture(bank: string, metadataRows: readonly Record<string, unknown>[]): void {
	const bankDir = path.join(banksDir, bank);
	const dbPath = path.join(bankDir, "mnemopi.db");
	fsSync.mkdirSync(bankDir, { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS working_memory (
				id TEXT PRIMARY KEY,
				content TEXT,
				metadata_json TEXT
			)
		`);
		using insert = db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)");
		for (const [index, meta] of metadataRows.entries()) {
			insert.run(`row-${bank}-${index}`, "content", JSON.stringify(meta));
		}
	} finally {
		db.close();
	}
}

describe("computeMnemopiBankScope (#2412)", () => {
	// Regression: same cwd must hash to the same bank no matter what the
	// ambient git layout looks like. The previous derivation walked
	// `git.repo.resolveSync(cwd)?.repoRoot ?? path.resolve(cwd)`, so a
	// disappearing/appearing ancestor `.git` repointed the same conversation
	// directory to a different bank and stranded its memories.
	it("returns the same per-project bank for one cwd regardless of git state", async () => {
		const baseDir = await TempDir.create("@mnemopi-stable-bank-");
		try {
			const project = baseDir.join("projects", "omp-workstation");
			await fs.mkdir(project, { recursive: true });
			const withoutGit = computeMnemopiBankScope(undefined, project, "per-project").bank;

			// Plant an ancestor `.git` marker — the old code path resolved
			// `project` to `baseDir/projects` via this file, producing a
			// `projects-<hash>` bank id distinct from the cwd-derived one.
			await fs.mkdir(baseDir.join("projects"), { recursive: true });
			await fs.writeFile(baseDir.join("projects", ".git"), "gitdir: /dev/null\n");
			const withAncestorGit = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(withAncestorGit).toBe(withoutGit);

			await removeWithRetries(baseDir.join("projects", ".git"));
			const afterGitRemoved = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(afterGitRemoved).toBe(withoutGit);
		} finally {
			await Bun.sleep(0);
			await baseDir.remove();
		}
	});

	it("derives different banks for different cwds (sanity)", () => {
		const a = computeMnemopiBankScope(undefined, "/projects/repo-a", "per-project").bank;
		const b = computeMnemopiBankScope(undefined, "/projects/repo-b", "per-project").bank;
		expect(a).not.toBe(b);
	});

	it("per-project-tagged opens both the project bank and the shared default", () => {
		const scope = computeMnemopiBankScope(undefined, "/projects/repo", "per-project-tagged");
		expect(scope.retainBank).toBe(scope.bank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain("default");
	});

	it("global ignores the cwd entirely", () => {
		const here = computeMnemopiBankScope(undefined, "/projects/here", "global");
		const there = computeMnemopiBankScope(undefined, "/elsewhere", "global");
		expect(here).toEqual(there);
		expect(here.bank).toBe("default");
	});
});

describe("extendRecallWithLegacyBanks (#2412)", () => {
	it("adds a sibling bank only when all working_memory rows tag the active cwd", () => {
		const activeCwd = path.join(rootDir.path(), "projects", "myrepo");
		createBankFixture("legacy-A", [{ session_id: "old", cwd: activeCwd }]);
		createBankFixture("unrelated-B", [{ session_id: "other", cwd: path.join(rootDir.path(), "other", "place") }]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, activeCwd);
		expect(extended).toContain("active-bank");
		expect(extended).toContain("legacy-A");
		expect(extended).not.toContain("unrelated-B");
	});

	it("skips mixed-cwd legacy banks because recall cannot filter rows by cwd", () => {
		const childCwd = path.join(rootDir.path(), "projects", "safe-child");
		createBankFixture("mixed-cwd-legacy", [
			{ cwd: childCwd },
			{ cwd: path.join(rootDir.path(), "projects", "sibling-child") },
		]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, childCwd);
		expect(extended).not.toContain("mixed-cwd-legacy");
	});
});

describe("extendRecallWithLegacyBanks edge cases", () => {
	it("ignores banks already in the recall set", () => {
		const cwd = path.join(rootDir.path(), "projects", "already-in-set");
		createBankFixture("already-in-set", [{ cwd }]);
		const extended = extendRecallWithLegacyBanks(["already-in-set"], mainDbPath, cwd);
		expect(extended).toEqual(["already-in-set"]);
	});

	it("returns the input unchanged when banks/ does not exist", () => {
		const missingRoot = rootDir.join("no-such-mnemopi", "mnemopi.db");
		const out = extendRecallWithLegacyBanks(["one"], missingRoot, "/home/user/anywhere");
		expect(out).toEqual(["one"]);
	});

	it("tolerates a corrupt bank database without throwing", async () => {
		const corruptDir = path.join(banksDir, "corrupt-C");
		await fs.mkdir(corruptDir, { recursive: true });
		await fs.writeFile(path.join(corruptDir, "mnemopi.db"), "not a sqlite file");
		const out = extendRecallWithLegacyBanks(["active"], mainDbPath, path.join(rootDir.path(), "some", "cwd"));
		expect(out).toContain("active");
		expect(out).not.toContain("corrupt-C");
	});

	// An unfinalized prepared statement makes close() fail silently (the probe swallows
	// it), leaving the bank database open until GC; on Windows that blocks deleting it.
	const canObserveOpenFiles = process.platform === "win32" || fsSync.existsSync("/proc/self/fd");
	it.skipIf(!canObserveOpenFiles)("closes every legacy bank database it probes", () => {
		const cwd = path.join(rootDir.path(), "projects", "fd-leak");
		createBankFixture("fd-leak-A", [{ cwd }]);
		createBankFixture("fd-leak-B", [{ cwd }]);
		// Legacy banks follow readdir order, which is filesystem-dependent.
		expect([...extendRecallWithLegacyBanks(["active"], mainDbPath, cwd)].sort()).toEqual([
			"active",
			"fd-leak-A",
			"fd-leak-B",
		]);
		const probed = ["fd-leak-A", "fd-leak-B"].map(bank => path.join(banksDir, bank, "mnemopi.db"));
		if (process.platform === "win32") {
			// Windows refuses to delete a file another handle still holds open.
			for (const dbPath of probed) fsSync.rmSync(dbPath);
			return;
		}
		const open = fsSync
			.readdirSync("/proc/self/fd")
			.map(fd => {
				try {
					return fsSync.readlinkSync(`/proc/self/fd/${fd}`);
				} catch {
					return "";
				}
			})
			.filter(target => probed.includes(target));
		expect(open).toEqual([]);
	});
});

// Use a real Linux child so neither offline environment nor filesystem/SQLite
// instrumentation can leak into other test files.
describe.skipIf(process.platform !== "linux")("offline legacy bank path confinement (P2-19)", () => {
	for (const scoping of ["per-project", "per-project-tagged"] as const) {
		for (const fixture of ["banks-link", "database-link", "local", "memory", "permission"] as const) {
			const behavior =
				fixture === "local"
					? "recalls local banks"
					: fixture === "memory"
						? "keeps in-memory recall without probing cwd banks"
						: fixture === "permission"
							? "skips an inaccessible legacy bank and recalls healthy banks"
							: `rejects ${fixture} before reading old memory`;
			it(`${scoping}: ${behavior}`, async () => {
				const isolated = await TempDir.create("@mnemopi-offline-bank-path-");
				try {
					const result = Bun.spawnSync({
						cmd: [
							process.execPath,
							"--eval",
							`
							import assert from "node:assert/strict";
							import { Database } from "bun:sqlite";
							import { mock, spyOn } from "bun:test";
							import * as fs from "node:fs";
							import * as path from "node:path";
							import { getOfflineShmState } from ${JSON.stringify(new URL("../../natives/native/offline-root.js", import.meta.url).href)};
							import { Settings } from ${JSON.stringify(new URL("../src/config/settings.ts", import.meta.url).href)};
							import { getMemoriesDir } from ${JSON.stringify(new URL("../../utils/src/dirs.ts", import.meta.url).href)};
							const state = getOfflineShmState();
							assert.ok(state);
							try {
								const agentDir = path.join(state.runtimeRoot, "agent");
								const memoryDir = path.join(getMemoriesDir(agentDir), "mnemopi");
								const banks = path.join(memoryDir, "banks");
								const fixture = ${JSON.stringify(fixture)};
								const scoping = ${JSON.stringify(scoping)};
								const settings = Settings.isolated({
									"mnemopi.scoping": scoping,
									"mnemopi.llmMode": "none",
									"mnemopi.noEmbeddings": true,
									...(fixture === "memory" ? { "mnemopi.dbPath": ":memory:" } : {}),
								});
								const cwd = settings.getCwd();
								const legacyBank = "legacy-offline-bank";
								const externalBanks = path.join(process.env.OMP_CONFIG_ROOT, "agent", "memories", "mnemopi", "banks");
								const externalDb = path.join(externalBanks, legacyBank, "mnemopi.db");
								const candidate = path.join(banks, legacyBank, "mnemopi.db");
								const fixtureDb = fixture === "local" || fixture === "permission" ? candidate : externalDb;
								fs.mkdirSync(path.dirname(fixtureDb), { recursive: true });
								const db = new Database(fixtureDb, { create: true });
								try {
									db.exec("CREATE TABLE working_memory (metadata_json TEXT)");
									using insert = db.prepare("INSERT INTO working_memory VALUES (?)");
									insert.run(JSON.stringify({ cwd }));
								} finally {
									db.close(true);
								}
								if (fixture === "banks-link") {
									fs.mkdirSync(memoryDir, { recursive: true });
									fs.symlinkSync(externalBanks, banks);
								} else if (fixture === "database-link") {
									fs.mkdirSync(path.dirname(candidate), { recursive: true });
									fs.symlinkSync(externalDb, candidate);
								} else if (fixture === "memory") {
									fs.symlinkSync(externalBanks, path.join(cwd, "banks"));
								}
								const blockedDb = path.join(banks, "inaccessible-bank", "mnemopi.db");
								if (fixture === "permission") {
									fs.mkdirSync(path.dirname(blockedDb), { recursive: true });
									fs.writeFileSync(blockedDb, "must not be opened");
								}
								const sqliteOpens = [];
								const NativeDatabase = Database;
								mock.module("bun:sqlite", () => ({
									Database: class extends NativeDatabase {
										constructor(filename, options) {
											sqliteOpens.push(filename);
											super(filename, options);
										}
									},
								}));
								// Load the consumer after replacing SQLite's constructor so every open is observable.
								const { loadMnemopiConfig, computeMnemopiBankScope } = await import(${JSON.stringify(new URL("../src/mnemopi/config.ts", import.meta.url).href)});
								const originalLstat = fs.lstatSync;
								let permissionChecks = 0;
								const lstat = spyOn(fs, "lstatSync").mockImplementation((target, ...args) => {
									if (fixture === "permission" && target === blockedDb) {
										permissionChecks++;
										const error = new Error("legacy bank permission denied");
										error.code = "EACCES";
										throw error;
									}
									return originalLstat(target, ...args);
								});
								const readdir = spyOn(fs, "readdirSync");
								const prepare = spyOn(NativeDatabase.prototype, "prepare");
								let config;
								let failure;
								let directoryReads = 0;
								let sqliteProbes = 0;
								let cwdBankChecks = 0;
								try {
									config = loadMnemopiConfig(settings, agentDir);
								} catch (error) {
									failure = error;
								} finally {
									directoryReads = readdir.mock.calls.filter(([directory]) =>
										directory === banks || directory === path.join(cwd, "banks")).length;
									cwdBankChecks = lstat.mock.calls.filter(([target]) =>
										target === path.join(cwd, "banks") ||
										target.startsWith(path.join(cwd, "banks") + path.sep)).length;
									sqliteProbes = prepare.mock.calls.length;
									lstat.mockRestore();
									readdir.mockRestore();
									prepare.mockRestore();
								}
								assert.equal(sqliteOpens.includes(externalDb), false,
									"must never open a legacy database outside the runtime root");
								if (fixture === "local" || fixture === "permission") {
									assert.equal(failure, undefined);
									const scope = computeMnemopiBankScope(undefined, cwd, scoping);
									assert.deepEqual(config.recallBanks, [...scope.recallBanks, legacyBank]);
									if (fixture === "permission") {
										assert.ok(permissionChecks > 0, "must exercise the candidate guard permission failure");
										assert.equal(sqliteOpens.includes(blockedDb), false);
									}
								} else if (fixture === "memory") {
									assert.equal(failure, undefined);
									assert.equal(config.dbPath, ":memory:");
									const scope = computeMnemopiBankScope(undefined, cwd, scoping);
									assert.deepEqual(config.recallBanks, scope.recallBanks);
									assert.equal(directoryReads, 0, "in-memory storage must not scan disk banks");
									assert.equal(cwdBankChecks, 0, "in-memory storage must not inspect cwd banks");
									assert.deepEqual(sqliteOpens, []);
								} else {
									if (fixture === "banks-link") {
										assert.equal(directoryReads, 0,
											"must reject the banks link before enumerating old memory");
									}
									assert.equal(sqliteProbes, 0,
										"must reject the complete candidate path before probing old SQLite memory");
									assert.deepEqual(sqliteOpens, [],
										"must reject unsafe paths before opening SQLite");
									assert.ok(failure instanceof Error, "unsafe legacy memory paths must be rejected");
								}
							} finally {
								fs.rmSync(path.dirname(state.runtimeRoot), { recursive: true, force: true });
							}
							`,
						],
						cwd: isolated.path(),
						env: {
							...process.env,
							HOME: isolated.join("home"),
							USERPROFILE: isolated.join("home"),
							OMP_CONFIG_ROOT: isolated.join("persistent"),
							OMP_OFFLINE: "1",
							OMP_PROFILE: "",
							PI_PROFILE: "",
							PI_CODING_AGENT_DIR: "",
						},
						timeout: 30_000,
						stdout: "pipe",
						stderr: "pipe",
					});
					expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
						exitCode: 0,
						stderr: "",
					});
				} finally {
					await isolated.remove();
				}
			});
		}
	}
});
