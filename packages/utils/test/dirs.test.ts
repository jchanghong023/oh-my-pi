import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nativePath from "@oh-my-pi/pi-natives/path";
import {
	__resetDirsFromEnvForTests,
	__resetProjectDirCacheForTests,
	getAgentDir,
	getBaseConfigRoot,
	getConfigRootDir,
	getDocumentConversionCacheDir,
	getGlobalDaemonRuntimeRoot,
	getLogsDir,
	getPluginsDir,
	getProfileRootDir,
	getWorktreesDir,
	getPuppeteerDir,
	getSessionsDir,
	directoryIsMissing,
	getLogPath,
	getProjectDir,
	localDay,
	relativePathWithinRoot,
	setProfile,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";

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

	it("treats denied stat as probeable rather than missing", async () => {
		const stat = spyOn(fs.promises, "stat").mockRejectedValue(
			Object.assign(new Error("operation not permitted"), { code: "EACCES" }),
		);
		try {
			expect(await directoryIsMissing(path.join(os.tmpdir(), "blocked"))).toBe(false);
		} finally {
			stat.mockRestore();
		}
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

describe("OMP_CONFIG_ROOT relocation", () => {
	const ENV_KEYS = [
		"OMP_CONFIG_ROOT",
		"PI_CONFIG_DIR",
		"PI_CODING_AGENT_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	] as const;
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(() => {
		originalEnv = {};
		for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
		for (const key of ENV_KEYS) delete process.env[key];
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
	});

	it("defaults to ~/.omp under the home directory", () => {
		expect(getBaseConfigRoot()).toBe(path.join(os.homedir(), ".omp"));
		expect(getAgentDir()).toBe(path.join(os.homedir(), ".omp", "agent"));
	});

	it("relocates the base root and every derived directory", () => {
		const root = path.join(os.tmpdir(), "omp-config-root-fixture");
		process.env.OMP_CONFIG_ROOT = root;
		__resetDirsFromEnvForTests();

		expect(getBaseConfigRoot()).toBe(root);
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		expect(getPluginsDir()).toBe(path.join(root, "plugins"));
		expect(getLogsDir()).toBe(path.join(root, "logs"));
		expect(getWorktreesDir()).toBe(path.join(root, "wt"));
	});

	it("expands a home-relative root for derived agent state", () => {
		process.env.OMP_CONFIG_ROOT = "~/omp-config-root-fixture";
		__resetDirsFromEnvForTests();

		expect(getBaseConfigRoot()).toBe(path.join(os.homedir(), "omp-config-root-fixture"));
		expect(getAgentDir()).toBe(path.join(os.homedir(), "omp-config-root-fixture", "agent"));
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"keeps data, caches, and global runtime state inside the explicit root despite initialized XDG paths",
		() => {
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "omp-root-xdg-"));
			const root = path.join(fixture, "config");
			const xdg = path.join(fixture, "xdg");
			fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
			process.env.OMP_CONFIG_ROOT = root;
			process.env.XDG_DATA_HOME = xdg;
			process.env.XDG_STATE_HOME = xdg;
			process.env.XDG_CACHE_HOME = xdg;
			__resetDirsFromEnvForTests();
			try {
				expect(getPluginsDir()).toBe(path.join(root, "plugins"));
				expect(getLogsDir()).toBe(path.join(root, "logs"));
				expect(getPuppeteerDir()).toBe(path.join(root, "puppeteer"));
				expect(getSessionsDir()).toBe(path.join(root, "agent", "sessions"));
				expect(getDocumentConversionCacheDir()).toBe(path.join(root, "agent", "cache", "document-conversions"));
				expect(getGlobalDaemonRuntimeRoot()).toBe(path.join(root, "run", "daemons", "global"));

				setProfile("work");
				expect(getLogsDir()).toBe(path.join(root, "profiles", "work", "logs"));
				expect(getSessionsDir()).toBe(path.join(root, "profiles", "work", "agent", "sessions"));
				expect(getGlobalDaemonRuntimeRoot()).toBe(path.join(root, "run", "daemons", "global"));
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		},
	);

	it("anchors named profiles under the relocated root", () => {
		const root = path.join(os.tmpdir(), "omp-config-root-fixture");
		process.env.OMP_CONFIG_ROOT = root;
		__resetDirsFromEnvForTests();

		expect(getProfileRootDir("work")).toBe(path.join(root, "profiles", "work"));
	});

	it("ignores a relative value instead of re-anchoring onto cwd", () => {
		process.env.OMP_CONFIG_ROOT = path.join("relative", "omp");
		__resetDirsFromEnvForTests();

		expect(getBaseConfigRoot()).toBe(path.join(os.homedir(), ".omp"));
	});

	it("wins over the PI_CONFIG_DIR name for the root location", () => {
		const root = path.join(os.tmpdir(), "omp-config-root-fixture");
		process.env.OMP_CONFIG_ROOT = root;
		process.env.PI_CONFIG_DIR = ".omp-alt";
		__resetDirsFromEnvForTests();

		expect(getBaseConfigRoot()).toBe(root);
	});
});
