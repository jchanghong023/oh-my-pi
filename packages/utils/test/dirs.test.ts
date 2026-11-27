import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nativePath from "@oh-my-pi/pi-natives/path";
import { resolvePersistentRoot } from "@oh-my-pi/pi-natives/offline-root";
import {
	__resetDirsFromEnvForTests,
	__resetProjectDirCacheForTests,
	directoryExists,
	getAgentDir,
	getBunStubDir,
	getConfigRootDir,
	getDocumentConversionCacheDir,
	getDaemonDir,
	getLogsDir,
	getModelDbPath,
	getPluginsDir,
	getPuppeteerDir,
	getSessionsDir,
	directoryIsMissing,
	getLogPath,
	getProjectDir,
	getTestTempDir,
	localDay,
	relativePathWithinNormalizedRoot,
	relativePathWithinRoot,
	resolveEquivalentPath,
	setProfile,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";
describe("persistent root lexical identity", () => {
	it("canonicalizes redundant separators without changing the original environment", () => {
		const root = path.resolve("fixture", "data-root");
		for (const override of [
			root,
			`${root}${path.sep}`,
			`${root}${path.sep.repeat(3)}`,
			`${root}${path.sep}nested${path.sep}..${path.sep}`,
		]) {
			const env = { OMP_CONFIG_ROOT: override, PI_CONFIG_DIR: ".legacy" };
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

	it("expands home-relative roots and falls back to the home config for unqualified overrides", () => {
		const home = path.resolve("fixture", "home");
		const homeEnv = process.platform === "win32" ? { USERPROFILE: home } : { HOME: home };
		expect(resolvePersistentRoot(homeEnv)).toBe(path.join(home, ".omp"));
		const legacyEnv = { ...homeEnv, PI_CONFIG_DIR: `legacy${path.sep.repeat(3)}` };
		expect(resolvePersistentRoot({ ...legacyEnv, OMP_CONFIG_ROOT: "relative/root" })).toBe(path.join(home, "legacy"));
		if (process.platform === "win32") {
			expect(resolvePersistentRoot({ ...legacyEnv, OMP_CONFIG_ROOT: "\\drive-relative" })).toBe(
				path.join(home, "legacy"),
			);
		}
		expect(resolvePersistentRoot({ ...homeEnv, OMP_CONFIG_ROOT: "~/data-root///" })).toBe(
			path.join(home, "data-root"),
		);
	});
});

const originalProjectDir = fs.realpathSync(process.cwd()).replace(/^\/private(?=\/)/, "");

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});
describe("project directory state", () => {
	it("enters an accessible fallback when process.cwd fails", () => {
		__resetProjectDirCacheForTests();
		const originalPwd = process.env.PWD;
		const cwd = spyOn(process, "cwd").mockImplementation(() => {
			throw new Error("cwd unavailable");
		});
		process.env.PWD = os.tmpdir();
		try {
			getProjectDir();
			cwd.mockRestore();
			expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(getProjectDir()));
		} finally {
			cwd.mockRestore();
			if (originalPwd === undefined) delete process.env.PWD;
			else process.env.PWD = originalPwd;
		}
	});

	it.skipIf(process.platform !== "win32")(
		"surfaces a native path-expansion failure instead of relocating the process",
		() => {
			__resetProjectDirCacheForTests();
			const before = process.cwd();
			spyOn(nativePath, "expandWindowsLongPath").mockImplementation(() => {
				throw new Error("stale addon");
			});
			expect(() => getProjectDir()).toThrow("stale addon");
			expect(process.cwd()).toBe(before);
		},
	);

	it("keeps forgiving probe defaults and propagates denied stat in strict mode", async () => {
		const stat = spyOn(fs.promises, "stat").mockRejectedValue(
			Object.assign(new Error("operation not permitted"), { code: "EACCES" }),
		);
		try {
			const blocked = path.join(os.tmpdir(), "blocked");
			for (const probe of [directoryExists, directoryIsMissing]) {
				expect(await probe(blocked)).toBe(false);
				await expect(probe(blocked, { strict: true })).rejects.toMatchObject({ code: "EACCES" });
			}
		} finally {
			stat.mockRestore();
		}
	});

	it("treats a child whose name starts with two dots as inside, and a parent or sibling as outside", () => {
		const root = path.resolve("containment-root");
		expect(relativePathWithinNormalizedRoot(root, path.join(root, "..hidden", "file"))).toBe(
			path.join("..hidden", "file"),
		);
		expect(relativePathWithinNormalizedRoot(root, root)).toBe("");
		expect(relativePathWithinNormalizedRoot(root, path.dirname(root))).toBeNull();
		expect(relativePathWithinNormalizedRoot(root, path.join(root, "..", "sibling"))).toBeNull();
	});

	it("normalizes each containment operand only once", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dirs-containment-"));
		const candidate = path.join(root, "child");
		fs.mkdirSync(candidate);
		const realpath = spyOn(fs, "realpathSync");
		try {
			expect(relativePathWithinRoot(root, candidate)).toBe("child");
			expect(realpath).toHaveBeenCalledTimes(2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the previous directory when chdir fails", () => {
		const chdir = spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});

		expect(() => setProjectDir("/blocked/project")).toThrow("operation not permitted");
		expect(getProjectDir()).toBe(originalProjectDir);
		chdir.mockRestore();
	});
});

describe("dated log path", () => {
	it("names log files with the local day, matching the rotating sink", () => {
		// Local 2026-05-31 02:30: in UTC+8 the UTC day is still 2026-05-30, so a
		// toISOString()-derived name points at a file the local-day rotating
		// sink (logger/rotating-file.ts) never creates.
		const date = new Date(2026, 4, 31, 2, 30);
		expect(localDay(date)).toBe("2026-05-31");
		expect(path.basename(getLogPath(date, 123))).toBe("omp.2026-05-31.123.log");
	});

	it("keeps the local-day key under a forced non-UTC timezone", () => {
		// On a UTC runner `toISOString()` and the local day agree, so the
		// in-process assertion above cannot catch a revert there. Run the probe
		// in a UTC+8 child process, where the two days differ for this fixture.
		const probe = path.join(import.meta.dir, "fixtures", "local-day-probe.ts");
		const proc = Bun.spawnSync([process.execPath, probe], {
			env: { ...process.env, TZ: "Asia/Shanghai" },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode === 2) return; // TZ not honored on this platform
		if (proc.exitCode !== 0) console.error(proc.stderr.toString());
		expect(proc.exitCode).toBe(0);
	});
});

it("keeps profile data, caches, and shared runtime state under the explicit root despite initialized XDG paths", () => {
	const keys = [
		"OMP_CONFIG_ROOT",
		"OMP_CACHE_DIR",
		"OMP_OFFLINE",
		"PI_CODING_AGENT_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	] as const;
	const originalEnv = new Map(keys.map(key => [key, process.env[key]] as const));
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "omp-root-xdg-"));
	try {
		const root = path.join(fixture, "config");
		const xdg = path.join(fixture, "xdg");
		fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
		process.env.OMP_CONFIG_ROOT = root;
		delete process.env.OMP_CACHE_DIR;
		delete process.env.OMP_OFFLINE;
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.OMP_PROFILE = "";
		process.env.XDG_DATA_HOME = xdg;
		process.env.XDG_STATE_HOME = xdg;
		process.env.XDG_CACHE_HOME = xdg;
		__resetDirsFromEnvForTests();

		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		expect(getPluginsDir()).toBe(path.join(root, "plugins"));
		expect(getLogsDir()).toBe(path.join(root, "logs"));
		expect(getPuppeteerDir()).toBe(path.join(root, "puppeteer"));
		expect(getSessionsDir()).toBe(path.join(root, "agent", "sessions"));
		expect(getBunStubDir()).toBe(path.join(root, "cache", "bun-stub"));
		expect(getModelDbPath()).toBe(path.join(root, "agent", "models.db"));
		expect(getDocumentConversionCacheDir()).toBe(path.join(root, "agent", "cache", "document-conversions"));
		expect(getDaemonDir()).toBe(path.join(root, "run", "daemon"));

		setProfile("work");
		const profileRoot = path.join(root, "profiles", "work");
		expect(getConfigRootDir()).toBe(profileRoot);
		expect(getLogsDir()).toBe(path.join(profileRoot, "logs"));
		expect(getSessionsDir()).toBe(path.join(profileRoot, "agent", "sessions"));
		expect(getBunStubDir()).toBe(path.join(profileRoot, "cache", "bun-stub"));
		expect(getModelDbPath()).toBe(path.join(profileRoot, "agent", "models.db"));
		expect(getDaemonDir()).toBe(path.join(root, "run", "daemon"));
	} finally {
		for (const [key, value] of originalEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

describe("getTestTempDir", () => {
	it("scopes temp directories by numeric uid when available and falls back to username on platforms without getuid", () => {
		const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
		spyOn(os, "tmpdir").mockReturnValue("/tmp/shared");
		spyOn(os, "userInfo").mockReturnValue({
			username: "alice",
			uid: -1,
			gid: -1,
			shell: null,
			homedir: "/Users/alice",
		});
		try {
			Object.defineProperty(process, "getuid", {
				value: () => 1001,
				configurable: true,
				writable: true,
			});
			expect(getTestTempDir("omp-test-logs")).toBe(path.join("/tmp/shared", "omp-test-logs-1001"));

			Object.defineProperty(process, "getuid", {
				value: undefined,
				configurable: true,
				writable: true,
			});
			expect(getTestTempDir("omp-test-logs")).toBe(path.join("/tmp/shared", "omp-test-logs-alice"));
		} finally {
			if (originalGetuid) {
				Object.defineProperty(process, "getuid", originalGetuid);
			} else {
				Reflect.deleteProperty(process, "getuid");
			}
		}
	});
});

describe("resolveEquivalentPath", () => {
	it("falls back to the lexical project path when realpath fails", () => {
		const inputPath = path.resolve("/sessions/link-project");
		const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
		expect(realpathSpy).toHaveBeenCalledWith(inputPath);
	});

	it("resolves a missing path through its deepest existing ancestor only when asked", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-through-missing-"));
		try {
			const real = path.join(temp, "real");
			const link = path.join(temp, "link");
			fs.mkdirSync(real);
			try {
				fs.symlinkSync(real, link, "junction");
			} catch {
				return; // Symlinks unavailable on this host.
			}
			const missing = path.join(link, "sub", "new.ts");
			expect(resolveEquivalentPath(missing)).toBe(missing);
			expect(resolveEquivalentPath(missing, { throughMissing: true })).toBe(
				path.join(fs.realpathSync(real), "sub", "new.ts"),
			);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});
