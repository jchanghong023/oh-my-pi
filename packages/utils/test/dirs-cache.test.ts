import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCacheRoot } from "@oh-my-pi/pi-natives/offline-root";
import {
	__resetDirsFromEnvForTests,
	getAgentCacheDir,
	getAgentDir,
	getBunStubDir,
	getDocumentConversionCacheDir,
	getFastembedCacheDir,
	getModelDbPath,
	getNativeGrammarsDir,
	getNativesDir,
	getPluginCacheRoot,
	getPluginsDir,
	getStatsDbPath,
	getWebKitHostPath,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";

const keys = [
	"OMP_CACHE_DIR",
	"OMP_CONFIG_ROOT",
	"OMP_OFFLINE",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_NATIVES_DIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"OMP_GITHUB_CACHE_DB",
] as const;

describe("cache root", () => {
	let temp: string;
	let saved: Partial<Record<(typeof keys)[number], string>>;

	beforeEach(() => {
		saved = {};
		for (const key of keys) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cache-test-"));
		process.env.OMP_CONFIG_ROOT = path.join(temp, "persistent");
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		fs.rmSync(temp, { recursive: true, force: true });
	});

	it("ignores the retired cache override and honors custom agent directories", () => {
		process.env.OMP_CACHE_DIR = path.join(temp, "ignored");
		const custom = path.join(temp, "custom-agent");
		process.env.PI_CODING_AGENT_DIR = custom;
		__resetDirsFromEnvForTests();
		expect(resolveCacheRoot()).toBeUndefined();
		expect(getAgentCacheDir()).toBe(path.join(custom, "cache"));
		expect(getModelDbPath()).toBe(path.join(custom, "models.db"));
		expect(getAgentCacheDir(path.join(temp, "other"))).toBe(path.join(temp, "other", "cache"));
		expect(getDocumentConversionCacheDir()).toBe(path.join(custom, "cache", "document-conversions"));
		expect(getPluginCacheRoot()).toBe(path.join(getPluginsDir(), "cache"));
		expect(getStatsDbPath()).toBe(path.join(temp, "persistent", "stats.db"));
		expect(getNativesDir()).toBe(path.join(temp, "persistent", "natives"));
	});

	it("relocates WebKit with the persistent root and preserves the shared default when unset", () => {
		expect(getWebKitHostPath("linux")).toBe(path.join(temp, "persistent", "lib", "abkit", "ABHost"));
		setProfile("work");
		expect(getWebKitHostPath("linux")).toBe(
			path.join(temp, "persistent", "profiles", "work", "lib", "abkit", "ABHost"),
		);
		setProfile(undefined);
		delete process.env.OMP_CONFIG_ROOT;
		__resetDirsFromEnvForTests();
		expect(getWebKitHostPath("linux")).toBe(path.join(os.homedir(), ".o2", "lib", "abkit", "ABHost"));
	});

	it("preserves migrated XDG cache paths when no cache root is selected", () => {
		if (process.platform !== "linux" && process.platform !== "darwin") return;
		delete process.env.OMP_CONFIG_ROOT;
		const xdg = path.join(temp, "xdg");
		const xdgData = path.join(temp, "xdg-data");
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
		fs.mkdirSync(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_CACHE_HOME = xdg;
		process.env.XDG_DATA_HOME = xdgData;
		__resetDirsFromEnvForTests();
		expect(getBunStubDir()).toBe(path.join(xdg, "omp", "cache", "bun-stub"));
		expect(getModelDbPath()).toBe(path.join(xdgData, "omp", "models.db"));
		expect(getDocumentConversionCacheDir()).toBe(path.join(xdg, "omp", "cache", "document-conversions"));
		expect(getFastembedCacheDir()).toBe(path.join(xdg, "omp", "cache", "fastembed"));
		expect(getNativesDir()).toBe(path.join(xdg, "omp", "natives"));
		expect(getAgentCacheDir()).toBe(path.join(getAgentDir(), "cache"));
		expect(getPluginCacheRoot()).toBe(path.join(getPluginsDir(), "cache"));
		if (process.platform === "linux") {
			process.env.OMP_OFFLINE = "1";
			__resetDirsFromEnvForTests();
			expect(getBunStubDir()).toBe(path.join(xdg, "omp", "cache", "bun-stub"));
			expect(getModelDbPath()).toBe(path.join("/dev/shm", `omp-${process.getuid!()}`, "agent", "models.db"));
		}
	});

	it("uses the implicit Linux offline root for data caches but not the executable Bun stub", () => {
		process.env.OMP_OFFLINE = " Yes ";
		process.env.OMP_CACHE_DIR = path.join(temp, "ignored");
		const expected = process.platform === "linux" ? path.join("/dev/shm", `omp-${process.getuid!()}`) : undefined;
		expect(resolveCacheRoot()).toBe(expected);
		__resetDirsFromEnvForTests();
		const persistent = path.join(temp, "persistent");
		const root = expected ?? persistent;
		expect(getBunStubDir()).toBe(path.join(persistent, "cache", "bun-stub"));
		expect(getModelDbPath()).toBe(path.join(root, "agent", "models.db"));
		expect(getNativeGrammarsDir()).toBe(path.join(root, "natives", "grammars"));
		setProfile("work");
		expect(getBunStubDir()).toBe(path.join(persistent, "profiles", "work", "cache", "bun-stub"));
		expect(getModelDbPath()).toBe(path.join(root, "profiles", "work", "agent", "models.db"));
		expect(getNativeGrammarsDir()).toBe(path.join(root, "profiles", "work", "natives", "grammars"));
		process.env.OMP_OFFLINE = "false";
		expect(resolveCacheRoot()).toBeUndefined();
	});

	it("honors PI_NATIVES_DIR ahead of the company cache root", () => {
		const native = path.join(temp, "native");
		process.env.OMP_OFFLINE = "1";
		const root = resolveCacheRoot() ?? path.join(temp, "persistent");
		__resetDirsFromEnvForTests();
		process.env.PI_NATIVES_DIR = native;
		expect(getNativesDir()).toBe(native);
		delete process.env.PI_NATIVES_DIR;
		expect(getNativesDir()).toBe(path.join(root, "natives"));
	});
});
