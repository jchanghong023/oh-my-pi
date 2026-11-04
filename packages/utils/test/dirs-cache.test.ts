import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCacheRoot } from "@oh-my-pi/pi-natives/offline-root";
import {
	__resetDirsFromEnvForTests,
	getAgentCacheDir,
	getAgentDbPath,
	getAgentDir,
	getConfigRootDir,
	getDocumentConversionCacheDir,
	getDocsRsCacheDir,
	getFastembedCacheDir,
	getGithubCacheDbPath,
	getHistoryDbPath,
	getKnowledgeDbPath,
	getLogsDir,
	getModelDbPath,
	getNativeGrammarsDir,
	getNativesDir,
	getPluginCacheRoot,
	getPluginsDir,
	getSessionsDir,
	getStatsDbPath,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";

const keys = [
	"OMP_CACHE_DIR",
	"OMP_CONFIG_ROOT",
	"OMP_WIKI_DIR",
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

	it("does not treat the removed Wiki-only root as an alias for configuration or performance data", () => {
		const wiki = path.join(temp, "standalone-wiki");
		process.env.OMP_WIKI_DIR = wiki;
		__resetDirsFromEnvForTests();
		expect(getConfigRootDir()).toBe(path.join(temp, "persistent"));
		expect(getAgentDir()).toBe(path.join(temp, "persistent", "agent"));
		expect(getKnowledgeDbPath()).toBe(path.join(temp, "persistent", "agent", "knowledge.db"));
		expect(fs.existsSync(wiki)).toBe(false);
	});

	it("routes caches, logs and stats to the explicit root without moving persistent data", () => {
		const root = path.join(temp, "cache-root");
		const selectedRoot = process.platform === "linux" ? path.join(root, String(process.getuid!())) : root;
		process.env.OMP_CACHE_DIR = root;
		__resetDirsFromEnvForTests();
		const persistent = path.join(temp, "persistent");
		expect(resolveCacheRoot()).toBe(selectedRoot);
		expect(getConfigRootDir()).toBe(persistent);
		expect(getAgentDir()).toBe(path.join(persistent, "agent"));
		expect(getAgentDbPath()).toBe(path.join(persistent, "agent", "agent.db"));
		expect(getHistoryDbPath()).toBe(path.join(persistent, "agent", "history.db"));
		expect(getModelDbPath()).toBe(path.join(persistent, "agent", "models.db"));
		expect(getSessionsDir()).toBe(path.join(persistent, "agent", "sessions"));
		expect(getPluginsDir()).toBe(path.join(persistent, "plugins"));
		expect(getAgentCacheDir()).toBe(path.join(selectedRoot, "agent", "cache"));
		expect(getDocumentConversionCacheDir()).toBe(path.join(selectedRoot, "agent", "cache", "document-conversions"));
		expect(getAgentCacheDir(path.join(temp, "custom-agent"))).toBe(path.join(selectedRoot, "agent", "cache"));
		expect(getDocumentConversionCacheDir(path.join(temp, "custom-agent"))).toBe(
			path.join(selectedRoot, "agent", "cache", "document-conversions"),
		);
		expect(getPluginCacheRoot()).toBe(path.join(selectedRoot, "plugins", "cache"));
		expect(getDocsRsCacheDir()).toBe(path.join(selectedRoot, "webcache"));
		expect(getFastembedCacheDir()).toBe(path.join(selectedRoot, "cache", "fastembed"));
		expect(getStatsDbPath()).toBe(path.join(selectedRoot, "stats.db"));
		expect(getLogsDir()).toBe(path.join(selectedRoot, "logs"));
		expect(getNativesDir()).toBe(path.join(selectedRoot, "natives"));
		expect(getNativeGrammarsDir()).toBe(path.join(selectedRoot, "natives", "grammars"));
		expect(getKnowledgeDbPath()).toBe(path.join(selectedRoot, "knowledge.db"));
		expect(getKnowledgeDbPath(path.join(temp, "other-agent"))).toBe(path.join(selectedRoot, "knowledge.db"));
		process.env.OMP_GITHUB_CACHE_DB = path.join(temp, "github.db");
		expect(getGithubCacheDbPath()).toBe(path.join(temp, "github.db"));
	});

	it("uses the existing profile layout beneath the selected root", () => {
		const root = path.join(temp, "cache");
		const selectedRoot = process.platform === "linux" ? path.join(root, String(process.getuid!())) : root;
		process.env.OMP_CACHE_DIR = root;
		setProfile("work");
		const profileRoot = path.join(selectedRoot, "profiles", "work");
		expect(resolveCacheRoot("work")).toBe(profileRoot);
		expect(getAgentCacheDir()).toBe(path.join(profileRoot, "agent", "cache"));
		expect(getPluginCacheRoot()).toBe(path.join(profileRoot, "plugins", "cache"));
		expect(getStatsDbPath()).toBe(path.join(profileRoot, "stats.db"));
		expect(getNativesDir()).toBe(path.join(profileRoot, "natives"));
		expect(getAgentDbPath()).toBe(path.join(temp, "persistent", "profiles", "work", "agent", "agent.db"));
		setProfile(undefined);
		expect(getAgentCacheDir()).toBe(path.join(selectedRoot, "agent", "cache"));
	});

	it("keeps existing paths without a cache selection and honors custom agent directories", () => {
		const custom = path.join(temp, "custom-agent");
		process.env.PI_CODING_AGENT_DIR = custom;
		__resetDirsFromEnvForTests();
		expect(resolveCacheRoot()).toBeUndefined();
		expect(getAgentCacheDir()).toBe(path.join(custom, "cache"));
		expect(getAgentCacheDir(path.join(temp, "other"))).toBe(path.join(temp, "other", "cache"));
		expect(getDocumentConversionCacheDir()).toBe(path.join(custom, "cache", "document-conversions"));
		expect(getPluginCacheRoot()).toBe(path.join(getPluginsDir(), "cache"));
		expect(getStatsDbPath()).toBe(path.join(temp, "persistent", "stats.db"));
		expect(getNativesDir()).toBe(path.join(temp, "persistent", "natives"));
	});

	it("preserves migrated XDG cache paths when no cache root is selected", () => {
		if (process.platform !== "linux" && process.platform !== "darwin") return;
		delete process.env.OMP_CONFIG_ROOT;
		const xdg = path.join(temp, "xdg");
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
		process.env.XDG_CACHE_HOME = xdg;
		__resetDirsFromEnvForTests();
		expect(getDocumentConversionCacheDir()).toBe(path.join(xdg, "omp", "cache", "document-conversions"));
		expect(getFastembedCacheDir()).toBe(path.join(xdg, "omp", "cache", "fastembed"));
		expect(getNativesDir()).toBe(path.join(xdg, "omp", "natives"));
		expect(getAgentCacheDir()).toBe(path.join(getAgentDir(), "cache"));
		expect(getPluginCacheRoot()).toBe(path.join(getPluginsDir(), "cache"));
	});

	it("selects the implicit root only in Linux offline mode", () => {
		process.env.OMP_OFFLINE = " Yes ";
		const expected = process.platform === "linux" ? path.join("/dev/shm", `omp-${process.getuid!()}`) : undefined;
		expect(resolveCacheRoot()).toBe(expected);
		process.env.OMP_OFFLINE = "false";
		expect(resolveCacheRoot()).toBeUndefined();
		process.env.OMP_CACHE_DIR = "relative";
		expect(resolveCacheRoot()).toBeUndefined();
	});

	it("honors PI_NATIVES_DIR ahead of the selected root", () => {
		const root = path.join(temp, "cache");
		const selectedRoot = process.platform === "linux" ? path.join(root, String(process.getuid!())) : root;
		const native = path.join(temp, "native");
		process.env.OMP_CACHE_DIR = root;
		__resetDirsFromEnvForTests();
		process.env.PI_NATIVES_DIR = native;
		expect(getNativesDir()).toBe(native);
		delete process.env.PI_NATIVES_DIR;
		expect(getNativesDir()).toBe(path.join(selectedRoot, "natives"));
	});

	it("expands a trimmed home-relative cache selection ahead of offline defaults", () => {
		process.env.OMP_CACHE_DIR = "  ~/omp-cache-contract  ";
		process.env.OMP_OFFLINE = " On ";
		const root = path.join(os.homedir(), "omp-cache-contract");
		const selected = process.platform === "linux" ? path.join(root, String(process.getuid!())) : root;
		expect(resolveCacheRoot("work")).toBe(path.join(selected, "profiles", "work"));
	});

	it("does not migrate or reset persistent state when the selected cache disappears or changes", () => {
		const persistent = path.join(temp, "persistent");
		const config = path.join(persistent, "agent", "config.yml");
		const session = path.join(persistent, "agent", "sessions", "saved.jsonl");
		fs.mkdirSync(path.dirname(session), { recursive: true });
		fs.writeFileSync(config, "temperature: 0.4\n");
		fs.writeFileSync(session, "persistent session evidence\n");
		const first = path.join(temp, "first-cache");
		process.env.OMP_CACHE_DIR = first;
		__resetDirsFromEnvForTests();
		const oldKnowledge = getKnowledgeDbPath();
		fs.mkdirSync(path.dirname(oldKnowledge), { recursive: true });
		fs.writeFileSync(oldKnowledge, "old knowledge bytes");
		fs.rmSync(first, { recursive: true });
		process.env.OMP_CACHE_DIR = path.join(temp, "second-cache");
		__resetDirsFromEnvForTests();
		expect(getKnowledgeDbPath()).not.toBe(oldKnowledge);
		expect(fs.existsSync(getKnowledgeDbPath())).toBe(false);
		expect(fs.existsSync(process.env.OMP_CACHE_DIR)).toBe(false);
		expect(fs.readFileSync(config, "utf8")).toBe("temperature: 0.4\n");
		expect(fs.readFileSync(session, "utf8")).toBe("persistent session evidence\n");
		expect(getAgentDbPath()).toBe(path.join(persistent, "agent", "agent.db"));
	});
});
