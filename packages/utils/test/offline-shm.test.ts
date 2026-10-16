import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureOfflineShmDirectory,
	getOfflineShmState as resolveOfflineShmState,
	resolvePersistentRoot,
} from "@oh-my-pi/pi-natives/offline-root";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getAgentDbPath,
	getAuthBrokerSnapshotCachePath,
	getBaseConfigRoot,
	getCommitCacheDbPath,
	getConfigRootDir,
	getGithubCacheDbPath,
	getGlobalDaemonRuntimeRoot,
	getJudgmentCacheDbPath,
	getLogsDir,
	getNativesDir,
	getOfflineShmState,
	getPluginsDir,
	getPredictStateDir,
	getProjectAgentDir,
	getSessionsDir,
	getStatsDbPath,
	getWorktreesDir,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

const ENV_KEYS = [
	"OMP_OFFLINE",
	"OMP_CONFIG_ROOT",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"PI_NATIVES_DIR",
	"OMP_GITHUB_CACHE_DB",
	"OMP_COMMIT_CACHE_DB",
	"OMP_JUDGMENT_CACHE_DB",
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
	"OMP_WORKTREE_DIR",
	"TMPDIR",
	"TMP",
	"TEMP",
] as const;

describe("persistent root lexical identity", () => {
	it("canonicalizes redundant separators without changing the original environment", () => {
		const root = path.resolve("fixture", "data-root");
		for (const override of [
			root,
			`${root}${path.sep}`,
			`${root}${path.sep.repeat(3)}`,
			`${root}${path.sep}nested${path.sep}..${path.sep}`,
		]) {
			const env = { OMP_CONFIG_ROOT: override };
			expect(resolvePersistentRoot(env)).toBe(root);
			expect(env.OMP_CONFIG_ROOT).toBe(override);
		}
	});

	it("preserves filesystem roots, including Windows drive and UNC roots", () => {
		const roots = [path.parse(process.cwd()).root];
		if (process.platform === "win32") roots.push("C:\\", "\\\\server\\share\\");
		for (const root of roots) {
			expect(resolvePersistentRoot({ OMP_CONFIG_ROOT: `${root}${path.sep.repeat(3)}` })).toBe(root);
		}
	});

	it("canonicalizes the default-root result and tilde-expanded overrides", () => {
		const home = path.resolve("fixture", "home");
		const homeEnv = process.platform === "win32" ? { USERPROFILE: home } : { HOME: home };
		expect(resolvePersistentRoot({ ...homeEnv, PI_CONFIG_DIR: `data-root${path.sep.repeat(3)}` })).toBe(
			path.join(home, "data-root"),
		);
		expect(resolvePersistentRoot({ ...homeEnv, OMP_CONFIG_ROOT: "~/data-root///" })).toBe(
			path.join(home, "data-root"),
		);
	});
});

// Fixtures never prepare the persistent root. An empty runtime domain must stay empty.
describe.skipIf(process.platform !== "linux")("offline shm directory routing", () => {
	let originalEnv: Record<string, string | undefined>;
	let persistentRoot: string;
	const domains = new Set<string>();

	beforeEach(() => {
		originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		for (const key of ENV_KEYS) delete process.env[key];
		persistentRoot = path.join(os.homedir(), `omp-offline-test-${crypto.randomUUID()}`, "data-root");
		process.env.OMP_CONFIG_ROOT = persistentRoot;
		process.env.OMP_OFFLINE = "1";
		const state = resolveOfflineShmState()!;
		domains.add(path.dirname(state.runtimeRoot));
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		for (const domain of domains) fs.rmSync(domain, { recursive: true, force: true });
		domains.clear();
	});

	function withExternalDirectory(run: (directory: string) => void): void {
		const directory = fs.mkdtempSync("/tmp/omp-offline-owned-path-");
		try {
			run(directory);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}

	it("accepts only the four trimmed case-insensitive true values", () => {
		for (const value of ["1", " true ", "YeS", "\tON\n"]) {
			expect(resolveOfflineShmState({ OMP_CONFIG_ROOT: persistentRoot, OMP_OFFLINE: value })).toBeDefined();
		}
		const lstat = spyOn(fs, "lstatSync");
		for (const value of [undefined, "", " ", "0", "false", "2", "truthy", "1yes"]) {
			expect(resolveOfflineShmState({ OMP_CONFIG_ROOT: persistentRoot, OMP_OFFLINE: value })).toBeUndefined();
		}
		expect(lstat).not.toHaveBeenCalled();
	});

	it("does not map or initialize directories on another platform", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const lstat = spyOn(fs, "lstatSync");
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
			expect(resolveOfflineShmState({ OMP_OFFLINE: "1" })).toBeUndefined();
			expect(lstat).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	it("keeps non-offline root and explicit agent-directory behavior unchanged", () => {
		process.env.OMP_OFFLINE = "false";
		process.env.PI_CODING_AGENT_DIR = "/nfs/custom-agent";
		__resetDirsFromEnvForTests();
		expect(getOfflineShmState()).toBeUndefined();
		expect(getBaseConfigRoot()).toBe(persistentRoot);
		expect(getAgentDir()).toBe("/nfs/custom-agent");
		expect(getSessionsDir()).toBe("/nfs/custom-agent/sessions");
	});

	it("resolves original root precedence lexically with the existing default directory name", () => {
		expect(resolvePersistentRoot({ OMP_CONFIG_ROOT: " ~/custom/data ", PI_CONFIG_DIR: ".other" })).toBe(
			path.join(os.homedir(), "custom", "data"),
		);
		for (const value of [undefined, "", " ", "relative/path"]) {
			expect(resolvePersistentRoot({ OMP_CONFIG_ROOT: value, PI_CONFIG_DIR: ".other" })).toBe(
				path.join(os.homedir(), ".other"),
			);
		}
		expect(resolvePersistentRoot({ OMP_CONFIG_ROOT: persistentRoot, PI_CONFIG_DIR: ".other" })).toBe(persistentRoot);
		expect(resolvePersistentRoot({ HOME: "/fixture/home", OMP_CONFIG_ROOT: "~/custom" })).toBe(
			"/fixture/home/custom",
		);
		expect(resolvePersistentRoot({ HOME: "/fixture/home", PI_CONFIG_DIR: ".renamed" })).toBe(
			"/fixture/home/.renamed",
		);
	});

	it("never probes or copies the original root or XDG homes during initialization", () => {
		process.env.XDG_DATA_HOME = "/nfs/inaccessible-data";
		process.env.XDG_STATE_HOME = "/nfs/inaccessible-state";
		process.env.XDG_CACHE_HOME = "/nfs/inaccessible-cache";
		const exists = spyOn(fs, "existsSync");
		const read = spyOn(fs, "readFileSync");
		const realpath = spyOn(fs, "realpathSync");
		const copy = spyOn(fs, "cpSync");
		const lstat = spyOn(fs, "lstatSync");
		__resetDirsFromEnvForTests();
		getPredictStateDir("/nfs/custom-agent", "ngram");
		expect(exists).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(realpath).not.toHaveBeenCalled();
		expect(copy).not.toHaveBeenCalled();
		for (const [target] of lstat.mock.calls) expect(String(target).startsWith("/dev/shm")).toBe(true);
		expect(process.env.OMP_CONFIG_ROOT).toBe(persistentRoot);
	});

	it("preserves basename and isolates identically named roots and hosts", () => {
		const first = getOfflineShmState()!;
		const second = resolveOfflineShmState({
			OMP_OFFLINE: "1",
			OMP_CONFIG_ROOT: `${persistentRoot}-other/data-root`,
		})!;
		domains.add(path.dirname(second.runtimeRoot));
		expect(path.basename(first.runtimeRoot)).toBe("data-root");
		expect(path.basename(second.runtimeRoot)).toBe("data-root");
		expect(first.runtimeRoot).not.toBe(second.runtimeRoot);
		const hostname = spyOn(os, "hostname").mockReturnValue("another-host");
		const third = getOfflineShmState()!;
		domains.add(path.dirname(third.runtimeRoot));
		expect(third.domainId).not.toBe(first.domainId);
		hostname.mockRestore();
		// An unowned existing root is rejected below; uid participates in the same identity digest.
	});

	it("shares one runtime domain across equivalent persistent-root spellings", () => {
		const first = getOfflineShmState()!;
		for (const override of [`${persistentRoot}/`, `${persistentRoot}///`, `${persistentRoot}/nested/../`]) {
			process.env.OMP_CONFIG_ROOT = override;
			const state = getOfflineShmState()!;
			domains.add(path.dirname(state.runtimeRoot));
			expect(state).toEqual(first);
			expect(process.env.OMP_CONFIG_ROOT).toBe(override);
		}
	});

	it("keeps profile layout and ignores self-data overrides without touching original env", () => {
		for (const key of [
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"PI_CODING_AGENT_DIR",
			"PI_NATIVES_DIR",
			"OMP_GITHUB_CACHE_DB",
			"OMP_COMMIT_CACHE_DB",
			"OMP_JUDGMENT_CACHE_DB",
			"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
		]) {
			process.env[key] = `/nfs/override/${key}`;
		}
		process.env.OMP_PROFILE = "work";
		process.env.PI_PROFILE = "ignored";
		__resetDirsFromEnvForTests();
		const state = getOfflineShmState()!;
		const root = path.join(state.runtimeRoot, "profiles", "work");
		expect(getBaseConfigRoot()).toBe(state.runtimeRoot);
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		for (const target of [
			getLogsDir(),
			getSessionsDir(),
			getAgentDbPath("/nfs/explicit-agent"),
			getPluginsDir("/nfs/home"),
			getNativesDir(),
			getGithubCacheDbPath(),
			getCommitCacheDbPath(),
			getJudgmentCacheDbPath(),
			getAuthBrokerSnapshotCachePath(),
		]) {
			expect(target.startsWith(`${root}${path.sep}`)).toBe(true);
		}
		expect(getGlobalDaemonRuntimeRoot().startsWith(`${state.runtimeRoot}${path.sep}`)).toBe(true);
		expect(process.env.OMP_CONFIG_ROOT).toBe(persistentRoot);
		expect(process.env.PI_NATIVES_DIR).toBe("/nfs/override/PI_NATIVES_DIR");
		setProfile(undefined);
		expect(getAgentDir()).toBe(path.join(state.runtimeRoot, "agent"));
		setAgentDir("/nfs/explicit-agent");
		expect(getAgentDir()).toBe(path.join(state.runtimeRoot, "agent"));
	});

	for (const legacyState of ["absent", "symlink", "non-private"] as const) {
		for (const inheritedAgent of [false, true]) {
			it(`leaves an unselected legacy profile untouched (${legacyState}, inherited=${inheritedAgent})`, () => {
				const root = getOfflineShmState()!.runtimeRoot;
				const legacy = path.join(root, "profiles", "legacy");
				ensureOfflineShmDirectory("profiles");
				if (legacyState === "symlink") fs.symlinkSync(os.tmpdir(), legacy);
				else if (legacyState === "non-private") {
					fs.mkdirSync(legacy, { mode: 0o700 });
					fs.chmodSync(legacy, 0o755);
				}
				process.env.OMP_PROFILE = "";
				process.env.PI_PROFILE = "legacy";
				if (inheritedAgent) process.env.PI_CODING_AGENT_DIR = path.join(legacy, "agent");
				const lstat = spyOn(fs, "lstatSync");
				const mkdir = spyOn(fs, "mkdirSync");
				__resetDirsFromEnvForTests();
				expect(getConfigRootDir()).toBe(root);
				expect(getAgentDir()).toBe(path.join(root, "agent"));
				for (const calls of [lstat.mock.calls, mkdir.mock.calls]) {
					for (const [target] of calls) {
						expect(String(target) === legacy || String(target).startsWith(`${legacy}${path.sep}`)).toBe(false);
					}
				}
				expect(fs.existsSync(legacy)).toBe(legacyState !== "absent");
			});
		}
	}

	it("preserves project paths and explicit managed-worktree placement", () => {
		process.env.OMP_WORKTREE_DIR = "/nfs/project-worktrees";
		expect(getWorktreesDir()).toBe("/nfs/project-worktrees");
		expect(getProjectAgentDir("/nfs/project")).toBe("/nfs/project/.omp");
	});

	for (const profile of [undefined, "work"]) {
		for (const cached of [false, true]) {
			it(`rejects restored root-owned files and directories (${profile ?? "default"}, cached=${cached})`, () => {
				setProfile(profile);
				const root = getConfigRootDir();
				const statsPath = path.join(root, "stats.db");
				const logsPath = path.join(root, "logs");
				if (cached) {
					expect(getStatsDbPath()).toBe(statsPath);
					fs.writeFileSync(getStatsDbPath(), "owned data");
					fs.mkdirSync(getLogsDir(), { recursive: true });
					expect(getLogsDir()).toBe(logsPath);
					fs.unlinkSync(statsPath);
					fs.rmdirSync(logsPath);
				}
				withExternalDirectory(external => {
					const sentinel = path.join(external, "sentinel");
					fs.writeFileSync(sentinel, "external data");
					fs.symlinkSync(sentinel, statsPath);
					fs.symlinkSync(external, logsPath);
					expect(() => fs.writeFileSync(getStatsDbPath(), "overwritten")).toThrow("Unsafe offline shm path");
					expect(() => {
						const directory = getLogsDir();
						fs.mkdirSync(directory, { recursive: true });
						fs.writeFileSync(path.join(directory, "sentinel"), "overwritten");
					}).toThrow("Unsafe offline shm path");
					expect(fs.readFileSync(sentinel, "utf8")).toBe("external data");
					expect(fs.readdirSync(external)).toEqual(["sentinel"]);
				});
			});
		}
	}

	for (const scenario of ["default", "profile", "explicit-default", "custom", "profile-custom", "external"] as const) {
		for (const cached of [false, true]) {
			it(`rejects a restored agent database leaf (${scenario}, cached=${cached})`, () => {
				if (scenario.startsWith("profile")) setProfile("work");
				const custom = scenario === "custom" || scenario === "profile-custom";
				const agentDir = custom ? path.join(getConfigRootDir(), "restored-agent") : getAgentDir();
				const argument =
					custom || scenario === "explicit-default"
						? agentDir
						: scenario === "external"
							? "/nfs/ignored-agent"
							: undefined;
				const database = path.join(agentDir, "agent.db");
				if (cached) {
					expect(getAgentDbPath(argument)).toBe(database);
					fs.writeFileSync(getAgentDbPath(argument), "owned data");
					expect(getAgentDbPath(argument)).toBe(database);
					fs.unlinkSync(database);
				} else if (custom) {
					fs.mkdirSync(agentDir, { mode: 0o700 });
				}
				withExternalDirectory(external => {
					const sentinel = path.join(external, "sentinel.db");
					fs.writeFileSync(sentinel, "external data");
					fs.symlinkSync(sentinel, database);
					expect(() => fs.writeFileSync(getAgentDbPath(argument), "overwritten")).toThrow(
						"Unsafe offline shm path",
					);
					expect(fs.readFileSync(sentinel, "utf8")).toBe("external data");
				});
			});
		}
	}

	it("rejects restored links in profile-independent base-domain paths", () => {
		setProfile("work");
		const directory = getGlobalDaemonRuntimeRoot();
		expect(directory).toBe(path.join(getBaseConfigRoot(), "run", "daemons", "global"));
		fs.mkdirSync(path.dirname(directory), { recursive: true });
		withExternalDirectory(external => {
			const sentinel = path.join(external, "sentinel");
			fs.writeFileSync(sentinel, "external data");
			fs.symlinkSync(external, directory);
			expect(() => {
				fs.mkdirSync(getGlobalDaemonRuntimeRoot(), { recursive: true });
				fs.writeFileSync(path.join(getGlobalDaemonRuntimeRoot(), "sentinel"), "overwritten");
			}).toThrow("Unsafe offline shm path");
			expect(fs.readFileSync(sentinel, "utf8")).toBe("external data");
			expect(fs.readdirSync(external)).toEqual(["sentinel"]);
		});
	});

	it("preserves non-offline writes through explicitly selected owned-path links", () => {
		withExternalDirectory(external => {
			process.env.OMP_OFFLINE = "false";
			process.env.OMP_CONFIG_ROOT = path.join(external, "root");
			__resetDirsFromEnvForTests();
			const sentinel = path.join(external, "sentinel");
			fs.writeFileSync(sentinel, "external data");
			fs.mkdirSync(getAgentDir(), { recursive: true });
			const database = getAgentDbPath();
			fs.symlinkSync(sentinel, database);
			expect(getAgentDbPath()).toBe(database);
			fs.writeFileSync(getAgentDbPath(), "non-offline write");
			expect(fs.readFileSync(sentinel, "utf8")).toBe("non-offline write");
		});
	});

	it("routes default, named and explicit temporary prefixes inside the active profile", async () => {
		setProfile("temporary");
		for (const prefix of [undefined, "@omp-owned-", "/nfs/project/staging-"]) {
			const directory = await TempDir.create(prefix);
			try {
				expect(directory.absolute().startsWith(`${getConfigRootDir()}/tmp/`)).toBe(true);
			} finally {
				await directory.remove();
			}
		}
		const syncDirectory = TempDir.createSync("@omp-sync-");
		expect(syncDirectory.absolute().startsWith(`${getConfigRootDir()}/tmp/`)).toBe(true);
		syncDirectory.removeSync();
		expect(process.env.TMPDIR).toBe(path.join(getConfigRootDir(), "tmp"));
	});

	it("reuses state without restore and leaves existing runtime content intact", () => {
		const state = getOfflineShmState()!;
		const marker = path.join(state.runtimeRoot, "existing.json");
		fs.writeFileSync(marker, "runtime");
		__resetDirsFromEnvForTests();
		expect(getOfflineShmState()).toEqual(state);
		expect(fs.readFileSync(marker, "utf8")).toBe("runtime");
		expect(fs.existsSync(persistentRoot)).toBe(false);
	});

	it("inherits the original root and deterministic domain in an independent child", () => {
		setProfile("child-profile");
		const helper = new URL("../../natives/native/offline-root.js", import.meta.url).href;
		const result = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`import {getOfflineShmState} from ${JSON.stringify(helper)}; console.log(JSON.stringify({state:getOfflineShmState(),original:process.env.OMP_CONFIG_ROOT}));`,
			],
			{ env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const child = JSON.parse(result.stdout.toString());
		expect(child.state).toEqual(getOfflineShmState());
		expect(child.original).toBe(persistentRoot);
	});

	it("keeps explicit logger directories and failure fallback inside shm", () => {
		const logger = new URL("../src/logger.ts", import.meta.url).href;
		const dirs = new URL("../src/dirs.ts", import.meta.url).href;
		const probe = `
			import * as fs from "node:fs";
			// Import after preparing failure state to exercise the logger's lazy initialization boundary.
			import {getConfigRootDir,getLogsDir,getOfflineShmState} from ${JSON.stringify(dirs)};
			fs.writeFileSync(getLogsDir(), "blocked primary directory");
			const logger = await import(${JSON.stringify(logger)});
			logger.setTransports({file: "/nfs/forbidden-log"});
			logger.error("offline-fallback-probe");
			logger.flush();
			console.log(JSON.stringify({log:logger.getCurrentLogPath(),root:getConfigRootDir(),original:getOfflineShmState().persistentRoot}));
		`;
		const result = Bun.spawnSync([process.execPath, "-e", probe], {
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const child = JSON.parse(result.stdout.toString());
		expect(child.log.startsWith(`${child.root}/fallback-logs/`)).toBe(true);
		expect(fs.readFileSync(child.log, "utf8")).toContain("offline-fallback-probe");
		expect(child.original).toBe(persistentRoot);
	});

	it("rejects symlink and non-private roots without modifying their permissions", () => {
		const state = getOfflineShmState()!;
		fs.chmodSync(state.runtimeRoot, 0o755);
		expect(() => getOfflineShmState()).toThrow("private directory");
		expect(fs.statSync(state.runtimeRoot).mode & 0o777).toBe(0o755);
		fs.rmSync(state.runtimeRoot, { recursive: true });
		fs.symlinkSync(os.tmpdir(), state.runtimeRoot);
		expect(() => getOfflineShmState()).toThrow("Unsafe offline shm directory");
	});

	it("rejects an unowned existing runtime root", () => {
		const state = getOfflineShmState()!;
		const lstat = fs.lstatSync;
		spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
			const stat = Reflect.apply(lstat, fs, [target, ...args]);
			return String(target) === state.runtimeRoot
				? new Proxy(stat, {
						get: (object, key) => (key === "uid" ? process.getuid!() + 1 : Reflect.get(object, key)),
					})
				: stat;
		}) as typeof fs.lstatSync);
		expect(() => getOfflineShmState()).toThrow("owned, private directory");
	});

	it("rejects unsafe profile roots and traversal", () => {
		ensureOfflineShmDirectory("profiles");
		const profile = path.join(getOfflineShmState()!.runtimeRoot, "profiles", "unsafe");
		fs.symlinkSync(os.tmpdir(), profile);
		expect(() => setProfile("unsafe")).toThrow("Unsafe offline shm directory");
		const nonPrivate = path.join(getOfflineShmState()!.runtimeRoot, "profiles", "non-private");
		fs.mkdirSync(nonPrivate, { mode: 0o700 });
		fs.chmodSync(nonPrivate, 0o755);
		expect(() => setProfile("non-private")).toThrow("private directory");
		expect(fs.statSync(nonPrivate).mode & 0o777).toBe(0o755);
		expect(() => ensureOfflineShmDirectory("../outside")).toThrow("inside the runtime root");
	});

	it("reports missing or unwritable shm and allocation failures without falling back", () => {
		const lstat = fs.lstatSync;
		const stat = spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
			if (String(target) === "/dev/shm") throw Object.assign(new Error("missing shm"), { code: "ENOENT" });
			return Reflect.apply(lstat, fs, [target, ...args]);
		}) as typeof fs.lstatSync);
		expect(() => getOfflineShmState()).toThrow("Cannot initialize offline shm directory");
		stat.mockRestore();
		const access = spyOn(fs, "accessSync").mockImplementation(() => {
			throw new Error("permission denied");
		});
		expect(() => getOfflineShmState()).toThrow("permission denied");
		access.mockRestore();
		spyOn(fs, "mkdirSync").mockImplementation(() => {
			throw Object.assign(new Error("no space"), { code: "ENOSPC" });
		});
		expect(() => getOfflineShmState()).toThrow("no space");
		expect(process.env.OMP_CONFIG_ROOT).toBe(persistentRoot);
	});
});
