import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capabilityFs from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	disableProvider,
	disableUserSource,
	enableProvider,
	enableUserSource,
	initializeWithSettings,
	getCapability,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	clearClaudePluginRootsCache,
	getPreloadedPluginRoots,
	injectPluginDirRoots,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
	preloadPluginRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { __resetDirsFromEnvForTests, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";

const clearFsCache = capabilityFs.clearCache;

describe("parseClaudePluginsRegistry", () => {
	test("returns null for invalid JSON", () => {
		expect(parseClaudePluginsRegistry("not json")).toBeNull();
	});

	test("returns null for missing version", () => {
		const content = JSON.stringify({ plugins: {} });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for missing plugins", () => {
		const content = JSON.stringify({ version: 2 });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for null plugins", () => {
		const content = JSON.stringify({ version: 2, plugins: null });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});
});

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("listClaudePluginRoots", () => {
	let tempDir: string;
	let testAgentDir: string;
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalClaudeConfigDir: string | undefined;
	let releaseSettings: () => void;

	beforeEach(async () => {
		releaseSettings = initializeWithSettings(Settings.isolated());
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
		testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-agent-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		// Point the agent dir at a temp dir so user-scope discovery (native MCP
		// config, skills, etc.) cannot read the real ~/.omp/agent profile.
		setAgentDir(testAgentDir);
		enableProvider("claude-plugins");
		disableUserSource("claude-plugins");
		disableUserSource("claude");
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		// setAgentDir() clears the profile env vars and snapshots the agent dir,
		// so restore every env var it can touch before rebuilding the resolver.
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		enableProvider("claude-plugins");
		disableUserSource("claude-plugins");
		disableUserSource("claude");
		__resetDirsFromEnvForTests();
		releaseSettings();
		await removeWithRetries(tempDir);
		await removeWithRetries(testAgentDir);
	});

	test("returns empty roots when no registry file exists", async () => {
		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("skips Claude registry and settings IO by default while preserving native and injected roots", async () => {
		const project = path.join(tempDir, "project");
		const claudeDir = path.join(tempDir, "relocated-claude");
		const registry = path.join(claudeDir, "plugins", "installed_plugins.json");
		const claudeSettings = [
			path.join(claudeDir, "settings.json"),
			path.join(project, ".claude", "settings.json"),
			path.join(project, ".claude", "settings.local.json"),
		];
		const userRegistry = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
		const projectRegistry = path.join(project, ".omp", "plugins", "installed_plugins.json");
		const injected = path.join(tempDir, "injected-plugin");
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		await Promise.all(
			[registry, ...claudeSettings, userRegistry, projectRegistry].map(file =>
				fs.mkdir(path.dirname(file), { recursive: true }),
			),
		);
		await fs.mkdir(injected, { recursive: true });
		await fs.writeFile(registry, "malformed");
		for (const file of claudeSettings) {
			await fs.writeFile(file, JSON.stringify({ enabledPlugins: { "native@fixture": false } }));
		}
		for (const [file, id, scope] of [
			[userRegistry, "native@fixture", "user"],
			[projectRegistry, "project@fixture", "project"],
		] as const) {
			await fs.writeFile(
				file,
				JSON.stringify({
					version: 2,
					plugins: { [id]: [{ scope, installPath: path.join(tempDir, id), version: "1" }] },
				}),
			);
		}
		const readSpy = vi.spyOn(capabilityFs, "readFile");
		const statSpy = vi.spyOn(nodeFs.promises, "stat");
		const forbidden = new Set([registry, ...claudeSettings].map(file => path.resolve(file)));
		const hasForbiddenCall = (calls: readonly (readonly unknown[])[]) =>
			calls.some(([file]) => typeof file === "string" && forbidden.has(path.resolve(file)));
		try {
			await injectPluginDirRoots(tempDir, [injected], project);
			const disabled = await listClaudePluginRoots(tempDir, project);
			expect(disabled.roots.map(root => root.id)).toEqual(
				expect.arrayContaining(["native@fixture", "project@fixture"]),
			);
			expect(disabled.roots.some(root => root.origin === "plugin-dir" && root.path === injected)).toBe(true);
			expect(disabled.roots.some(root => root.origin === "claude")).toBe(false);
			expect(disabled.warnings).toEqual([]);
			expect(hasForbiddenCall(readSpy.mock.calls)).toBe(false);
			expect(hasForbiddenCall(statSpy.mock.calls)).toBe(false);

			enableUserSource("claude-plugins");
			const enabled = await listClaudePluginRoots(tempDir, project);
			expect(enabled.warnings).toContain(`Failed to parse Claude Code plugin registry: ${registry}`);
			expect(hasForbiddenCall(statSpy.mock.calls)).toBe(true);
			expect(enabled).not.toBe(disabled);

			readSpy.mockClear();
			statSpy.mockClear();
			disableUserSource("claude-plugins");
			const disabledAgain = await listClaudePluginRoots(tempDir, project);
			expect(disabledAgain).toBe(disabled);
			expect(disabledAgain.warnings).toEqual([]);
			expect(hasForbiddenCall(readSpy.mock.calls)).toBe(false);
			expect(hasForbiddenCall(statSpy.mock.calls)).toBe(false);
		} finally {
			await injectPluginDirRoots(tempDir, []);
		}
	});

	test("startup preloads can exclude Claude before a later settings-selected preload", async () => {
		const registry = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
		const plugin = path.join(tempDir, "claude-plugin");
		const injected = path.join(tempDir, "explicit-plugin");
		await fs.mkdir(path.dirname(registry), { recursive: true });
		await fs.mkdir(injected, { recursive: true });
		await fs.writeFile(
			registry,
			JSON.stringify({
				version: 2,
				plugins: { "claude@fixture": [{ scope: "user", installPath: plugin, version: "1" }] },
			}),
		);
		enableUserSource("claude-plugins");
		const statSpy = vi.spyOn(nodeFs.promises, "stat");
		try {
			await preloadPluginRoots(tempDir, tempDir, { includeClaude: false });
			await injectPluginDirRoots(tempDir, [injected], tempDir, { includeClaude: false });
			expect(getPreloadedPluginRoots().some(root => root.path === injected)).toBe(true);
			expect(getPreloadedPluginRoots().some(root => root.origin === "claude")).toBe(false);
			expect(statSpy.mock.calls.some(([file]) => typeof file === "string" && path.resolve(file) === registry)).toBe(
				false,
			);

			await preloadPluginRoots(tempDir, tempDir);
			expect(getPreloadedPluginRoots().some(root => root.id === "claude@fixture")).toBe(true);
			expect(getPreloadedPluginRoots().some(root => root.path === injected)).toBe(true);
			expect(statSpy.mock.calls.some(([file]) => typeof file === "string" && path.resolve(file) === registry)).toBe(
				true,
			);
		} finally {
			disableUserSource("claude-plugins");
			await injectPluginDirRoots(tempDir, []);
		}
	});

	test("explicit capability providers enable registry discovery, but a disabled provider wins", async () => {
		const registry = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
		const plugin = path.join(tempDir, "fixture-plugin");
		await fs.mkdir(path.dirname(registry), { recursive: true });
		await fs.mkdir(path.join(plugin, "skills", "probe"), { recursive: true });
		await fs.writeFile(
			path.join(plugin, "skills", "probe", "SKILL.md"),
			"---\nname: probe\ndescription: Probe\n---\nBody\n",
		);
		await fs.writeFile(
			registry,
			JSON.stringify({
				version: 2,
				plugins: { "probe@fixture": [{ scope: "user", installPath: plugin, version: "1" }] },
			}),
		);
		await listClaudePluginRoots(tempDir, tempDir);
		const selected = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["claude-plugins"] });
		expect(selected.all.map(skill => skill.name)).toContain("probe");
		disableProvider("claude-plugins");
		const disabled = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["claude-plugins"] });
		expect(disabled.all.map(skill => skill.name)).not.toContain("probe");
		expect((await listClaudePluginRoots(tempDir, tempDir)).roots.some(root => root.origin === "claude")).toBe(false);
	});

	test("all plugin capability consumers skip the foreign registry, cache and enabledPlugins layers by default", async () => {
		const claudeDir = path.join(tempDir, ".claude");
		const pluginDir = path.join(claudeDir, "plugins");
		const cache = path.join(pluginDir, "cache", "poison");
		const settingsFiles = [
			path.join(claudeDir, "settings.json"),
			path.join(tempDir, ".claude", "settings.local.json"),
		];
		await fs.mkdir(cache, { recursive: true });
		await fs.writeFile(path.join(pluginDir, "installed_plugins.json"), "invalid registry");
		for (const file of settingsFiles) await fs.writeFile(file, '{"enabledPlugins":{"poison@market":true}}');
		const reads = vi.spyOn(capabilityFs, "readFile");
		const stats = vi.spyOn(nodeFs.promises, "stat");
		const walks = vi.spyOn(nodeFs.promises, "readdir");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		for (const id of ["skills", "rules", "slash-commands", "hooks", "tools", "mcps"]) {
			const capability = getCapability(id);
			if (!capability) throw new Error(`Missing capability ${id}`);
			const provider = capability.providers.find(candidate => candidate.id === "claude-plugins");
			if (!provider) throw new Error(`Missing plugin provider for ${id}`);
			const result = await provider.load({ cwd: tempDir, home: tempDir, repoRoot: null });
			expect(result.items, id).toEqual([]);
			expect(result.warnings ?? [], id).toEqual([]);
		}
		const agents = await discoverAgents(tempDir, tempDir);
		expect(agents.agents.map(agent => agent.name)).toContain("task");
		expect(agents.agents.map(agent => agent.name)).not.toContain("poison");
		const forbidden = (file: unknown) =>
			typeof file === "string" &&
			(path.resolve(file) === pluginDir ||
				path.resolve(file).startsWith(`${pluginDir}${path.sep}`) ||
				settingsFiles.includes(path.resolve(file)));
		expect(reads.mock.calls.filter(([file]) => forbidden(file))).toEqual([]);
		expect(stats.mock.calls.filter(([file]) => forbidden(file))).toEqual([]);
		expect(walks.mock.calls.filter(([file]) => forbidden(file))).toEqual([]);
		expect(warn.mock.calls.filter(([message]) => String(message).includes("plugin registry"))).toEqual([]);
	});

	test.each(["claude-plugins", "claude", "*", "all"])(
		"enabledProviders %s opts in without leaking roots to a disabled scope",
		async selector => {
			const registry = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
			await fs.mkdir(path.dirname(registry), { recursive: true });
			await fs.writeFile(
				registry,
				JSON.stringify({
					version: 2,
					plugins: {
						"scoped@fixture": [{ scope: "user", installPath: path.join(tempDir, "scoped-plugin"), version: "1" }],
					},
				}),
			);
			const disabled = await listClaudePluginRoots(tempDir, tempDir);
			expect(disabled.roots).toEqual([]);
			const release = initializeWithSettings(Settings.isolated({ enabledProviders: [selector] }));
			try {
				expect((await listClaudePluginRoots(tempDir, tempDir)).roots.map(root => root.id)).toEqual([
					"scoped@fixture",
				]);
				disableProvider("claude-plugins");
				expect((await listClaudePluginRoots(tempDir, tempDir)).roots).toEqual([]);
			} finally {
				release();
			}
			expect((await listClaudePluginRoots(tempDir, tempDir)).roots).toEqual([]);
		},
	);

	test("native project priority and explicit Claude-format plugin directories survive the foreign-source default", async () => {
		const project = path.join(tempDir, "project");
		const explicit = path.join(tempDir, "explicit");
		for (const [root, name, description] of [
			[path.join(tempDir, "user-native"), "shared-probe", "User native"],
			[path.join(tempDir, "project-native"), "shared-probe", "Project native"],
			[explicit, "explicit-probe", "Explicit Claude manifest"],
		]) {
			await fs.mkdir(path.join(root!, "skills", name!), { recursive: true });
			await fs.writeFile(
				path.join(root!, "skills", name!, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${description}\n---\nFixture\n`,
			);
		}
		await fs.mkdir(path.join(explicit, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(explicit, ".claude-plugin", "plugin.json"), '{"name":"explicit-fixture"}');
		for (const [registry, scope, root] of [
			[path.join(tempDir, ".omp", "plugins", "installed_plugins.json"), "user", path.join(tempDir, "user-native")],
			[
				path.join(project, ".omp", "plugins", "installed_plugins.json"),
				"project",
				path.join(tempDir, "project-native"),
			],
		]) {
			await fs.mkdir(path.dirname(registry!), { recursive: true });
			await fs.writeFile(
				registry!,
				JSON.stringify({
					version: 2,
					plugins: {
						"native@fixture": [{ scope, installPath: root, version: "1" }],
					},
				}),
			);
		}
		try {
			await injectPluginDirRoots(tempDir, [explicit, explicit], project);
			const roots = await listClaudePluginRoots(tempDir, project);
			expect(roots.roots.find(root => root.origin === "plugin-dir")).toMatchObject({
				path: explicit,
				plugin: "explicit-fixture",
			});
			const result = await loadCapability<Skill>("skills", { cwd: project });
			expect(result.items.filter(skill => skill.name === "shared-probe")).toHaveLength(1);
			expect(result.items.find(skill => skill.name === "shared-probe")?.frontmatter?.description).toBe(
				"Project native",
			);
			expect(result.items.filter(skill => skill.name === "explicit-probe")).toHaveLength(1);
			expect(result.items.find(skill => skill.name === "explicit-probe")?.frontmatter?.description).toBe(
				"Explicit Claude manifest",
			);
			expect(roots.roots.some(root => root.origin === "claude")).toBe(false);
		} finally {
			await injectPluginDirRoots(tempDir, []);
		}
	});

	test("logs registry warnings once per cached computation", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		const registryPath = path.join(pluginsDir, "installed_plugins.json");
		await fs.writeFile(registryPath, "not json");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const first = await listClaudePluginRoots(tempDir);
		const second = await listClaudePluginRoots(tempDir);

		expect(first.warnings).toEqual([`Failed to parse Claude Code plugin registry: ${registryPath}`]);
		expect(second).toBe(first);
		expect(warnSpy.mock.calls.filter(([message]) => message === first.warnings[0])).toHaveLength(1);
	});

	test("logs registry warnings once for concurrent callers", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		const registryPath = path.join(pluginsDir, "installed_plugins.json");
		await fs.writeFile(registryPath, "not json");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const results = await Promise.all([
			listClaudePluginRoots(tempDir),
			listClaudePluginRoots(tempDir),
			listClaudePluginRoots(tempDir),
		]);

		const message = `Failed to parse Claude Code plugin registry: ${registryPath}`;
		for (const result of results) expect(result.warnings).toEqual([message]);
		expect(warnSpy.mock.calls.filter(([m]) => m === message)).toHaveLength(1);
	});

	test("parses plugin with user scope", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"test-plugin@test-market": [
					{
						scope: "user",
						installPath: "/path/to/test-plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0]).toEqual({
			id: "test-plugin@test-market",
			marketplace: "test-market",
			plugin: "test-plugin",
			version: "1.0.0",
			path: "/path/to/test-plugin",
			scope: "user",
			origin: "claude",
		});
	});

	test("reads the user plugin registry from CLAUDE_CONFIG_DIR", async () => {
		enableUserSource("claude-plugins");
		const relocated = path.join(tempDir, "relocated-claude");
		const pluginsDir = path.join(relocated, "plugins");
		process.env.CLAUDE_CONFIG_DIR = relocated;
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"relocated@market": [
						{
							scope: "user",
							installPath: "/path/to/relocated",
							version: "1.0.0",
						},
					],
				},
			}),
		);

		const result = await listClaudePluginRoots(tempDir);

		expect(result.roots).toEqual([
			{
				id: "relocated@market",
				marketplace: "market",
				plugin: "relocated",
				version: "1.0.0",
				path: "/path/to/relocated",
				scope: "user",
				origin: "claude",
			},
		]);
	});

	test("isolates local and project plugins to their canonical project", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const projectA = path.join(tempDir, "project-a");
		const projectB = path.join(tempDir, "project-b");
		const projectBAlias = path.join(tempDir, "project-b-alias");
		const projectBSubdir = path.join(projectB, "packages", "app");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(projectA, ".git"), { recursive: true }),
			fs.mkdir(path.join(projectB, ".git"), { recursive: true }),
			fs.mkdir(projectBSubdir, { recursive: true }),
		]);
		// A junction needs no symlink privilege on Windows.
		await fs.symlink(projectB, projectBAlias, process.platform === "win32" ? "junction" : "dir");

		const entry = (scope: "user" | "project" | "local", installPath: string, projectPath?: string) => ({
			scope,
			installPath,
			projectPath,
			version: "1.0.0",
			installedAt: "2025-01-01T00:00:00Z",
			lastUpdated: "2025-01-01T00:00:00Z",
		});
		const registry = {
			version: 2,
			plugins: {
				"user-plugin@market": [entry("user", "/plugins/user")],
				"active-local-plugin@market": [entry("local", "/plugins/active-local", projectB)],
				"foreign-local-plugin@market": [entry("local", "/plugins/foreign-local", projectA)],
				"active-project-plugin@market": [entry("project", "/plugins/active-project", projectB)],
				"foreign-project-plugin@market": [entry("project", "/plugins/foreign-project", projectA)],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir, path.join(projectBAlias, "packages", "app"));

		expect(result.roots.map(root => root.id)).toEqual([
			"user-plugin@market",
			"active-local-plugin@market",
			"active-project-plugin@market",
		]);
		expect(result.roots.filter(root => root.id !== "user-plugin@market").map(root => root.scope)).toEqual([
			"project",
			"project",
		]);
	});

	test("hides a plugin the user switched off with enabledPlugins in project settings", async () => {
		enableUserSource("claude-plugins");
		// Contract: a plugin Claude Code would not load in this project (enabledPlugins:false in
		// .claude/settings.local.json) must not contribute skills/MCP/commands here either.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const project = path.join(tempDir, "project");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(project, ".claude"), { recursive: true }),
			fs.mkdir(path.join(project, ".git"), { recursive: true }),
		]);
		const entry = (installPath: string) => ({
			scope: "user",
			installPath,
			version: "1.0.0",
			installedAt: "2025-01-01T00:00:00Z",
			lastUpdated: "2025-01-01T00:00:00Z",
		});
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"kept@market": [entry("/plugins/kept")],
					"muted@market": [entry("/plugins/muted")],
					"muted-then-restored@market": [entry("/plugins/restored")],
				},
			}),
		);
		// settings.json turns two off; settings.local.json turns one of them back on (local wins).
		await fs.writeFile(
			path.join(project, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "muted@market": false, "muted-then-restored@market": false } }),
		);
		await fs.writeFile(
			path.join(project, ".claude", "settings.local.json"),
			JSON.stringify({ enabledPlugins: { "muted-then-restored@market": true } }),
		);

		const inProject = await listClaudePluginRoots(tempDir, project);
		expect(inProject.roots.map(root => root.id).sort()).toEqual(["kept@market", "muted-then-restored@market"]);

		// The switch is per project: elsewhere the same user-scope install still loads.
		const elsewhere = path.join(tempDir, "elsewhere");
		await fs.mkdir(path.join(elsewhere, ".git"), { recursive: true });
		const outside = await listClaudePluginRoots(tempDir, elsewhere);
		expect(outside.roots.map(root => root.id).sort()).toEqual([
			"kept@market",
			"muted-then-restored@market",
			"muted@market",
		]);
	});

	test("enabledPlugins:true opts a local-scope install into a project with a different projectPath", async () => {
		enableUserSource("claude-plugins");
		// Contract: Claude Code loads a plugin wherever enabledPlugins says true, regardless of
		// which directory the local-scope install was recorded under. Without this, a plugin
		// installed from a parent directory never loads from the child project it is enabled in.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const parent = path.join(tempDir, "clients");
		const child = path.join(parent, "acme");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(child, ".claude"), { recursive: true }),
			fs.mkdir(path.join(child, ".git"), { recursive: true }),
		]);
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"acme@market": [
						{
							scope: "local",
							installPath: "/plugins/acme",
							projectPath: parent,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		const before = await listClaudePluginRoots(tempDir, child);
		expect(before.roots).toEqual([]);

		clearClaudePluginRootsCache();
		clearFsCache();
		await fs.writeFile(
			path.join(child, ".claude", "settings.local.json"),
			JSON.stringify({ enabledPlugins: { "acme@market": true } }),
		);
		const after = await listClaudePluginRoots(tempDir, child);
		expect(after.roots.map(root => root.id)).toEqual(["acme@market"]);
		expect(after.roots[0]?.scope).toBe("project");
	});

	test("handles multiple entries per plugin ID", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"multi-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/v2",
						version: "2.0.0",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
					{
						scope: "project",
						projectPath: tempDir,
						installPath: "/path/to/v1",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir, tempDir);
		// Should return both entries, not just the first one
		expect(result.roots).toHaveLength(2);
		expect(result.roots[0].version).toBe("2.0.0");
		expect(result.roots[0].scope).toBe("user");
		expect(result.roots[1].version).toBe("1.0.0");
		expect(result.roots[1].scope).toBe("project");
	});

	test("warns on invalid plugin ID format", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"invalid-no-at-symbol": [
					{
						scope: "user",
						installPath: "/path/to/invalid",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("Invalid plugin ID format");
	});

	test("warns on entry without installPath", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-path@market": [
					{
						scope: "user",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("has no installPath");
	});

	test("caches results for same home directory", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry: {
			version: number;
			plugins: Record<
				string,
				Array<{ scope: string; installPath: string; version: string; installedAt: string; lastUpdated: string }>
			>;
		} = {
			version: 2,
			plugins: {
				"cached-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/cached",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// First call
		const result1 = await listClaudePluginRoots(tempDir);
		expect(result1.roots).toHaveLength(1);

		// Modify the file
		registry.plugins["new-plugin@market"] = [
			{
				scope: "user",
				installPath: "/path/to/new",
				version: "1.0.0",
				installedAt: "2025-01-01T00:00:00Z",
				lastUpdated: "2025-01-01T00:00:00Z",
			},
		];
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// Second call should return cached result (still 1 plugin)
		const result2 = await listClaudePluginRoots(tempDir);
		expect(result2.roots).toHaveLength(1);

		// After clearing cache, should see new plugin
		clearClaudePluginRootsCache();
		clearFsCache(); // Also clear fs cache so the file is re-read
		const result3 = await listClaudePluginRoots(tempDir);
		expect(result3.roots).toHaveLength(2);
	});

	test("isolates cached OMP plugin roots by home when Claude config is shared", async () => {
		enableUserSource("claude-plugins");
		const sharedClaudeConfig = path.join(tempDir, "shared-claude");
		const firstHome = path.join(tempDir, "first-home");
		const secondHome = path.join(tempDir, "second-home");
		process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;
		for (const [home, pluginId] of [
			[firstHome, "first@market"],
			[secondHome, "second@market"],
		] as const) {
			const pluginsDir = path.join(home, ".omp", "plugins");
			await fs.mkdir(pluginsDir, { recursive: true });
			await fs.writeFile(
				path.join(pluginsDir, "installed_plugins.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						[pluginId]: [
							{
								scope: "user",
								installPath: `/path/to/${pluginId.split("@")[0]}`,
								version: "1.0.0",
							},
						],
					},
				}),
			);
		}

		const first = await listClaudePluginRoots(firstHome);
		const second = await listClaudePluginRoots(secondHome);

		expect(first.roots.map(root => root.id)).toEqual(["first@market"]);
		expect(second.roots.map(root => root.id)).toEqual(["second@market"]);
	});

	test("derives the namespace from the plugin name, not the Claude cache version segment (#12151)", async () => {
		// Claude Code's own plugin cache keeps marketplace/plugin/version as
		// three separate path segments (`.../cache/<marketplace>/<plugin>/<version>/skills/...`),
		// unlike OMP's single joined `<marketplace>___<plugin>___<version>` cache
		// directory. Deriving the namespace from the path segment owning `skills/`
		// would read the shared version ("1.0.0" → "1-0-0") for both plugins here,
		// colliding them together instead of keeping their own plugin identities.
		const marketRoot = path.join(tempDir, ".claude", "plugins", "cache", "test-market");
		const pluginARoot = path.join(marketRoot, "plugin-a", "1.0.0");
		const pluginBRoot = path.join(marketRoot, "plugin-b", "1.0.0");
		const ompRegistryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");

		await Promise.all([
			fs.mkdir(path.join(pluginARoot, "skills", "shared-skill"), { recursive: true }),
			fs.mkdir(path.join(pluginBRoot, "skills", "shared-skill"), { recursive: true }),
			fs.mkdir(path.dirname(ompRegistryPath), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(pluginARoot, "skills", "shared-skill", "SKILL.md"),
				"---\nname: shared-skill\ndescription: Plugin A's skill.\n---\nPlugin A body\n",
			),
			fs.writeFile(
				path.join(pluginBRoot, "skills", "shared-skill", "SKILL.md"),
				"---\nname: shared-skill\ndescription: Plugin B's skill.\n---\nPlugin B body\n",
			),
			fs.writeFile(
				ompRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"plugin-a@test-market": [{ scope: "user", installPath: pluginARoot, version: "1.0.0" }],
						"plugin-b@test-market": [{ scope: "user", installPath: pluginBRoot, version: "1.0.0" }],
					},
				}),
			),
		]);

		const { skills, warnings } = await loadSkills({ cwd: tempDir });
		const names = skills
			.map(skill => skill.name)
			.filter(name => name === "shared-skill" || name.endsWith("/shared-skill"))
			.sort();
		// "plugin-a" is admitted first (bare); "plugin-b" is namespaced by its
		// own plugin name, never by the version segment both share.
		expect(names).toEqual(["plugin-b/shared-skill", "shared-skill"]);
		expect(warnings.some(warning => warning.message.includes("1-0-0"))).toBe(false);
	});

	test("loads OMP user skills without opting into foreign Claude skills", async () => {
		const ompPluginPath = path.join(tempDir, "plugins", "omp-owned");
		const claudePluginPath = path.join(tempDir, "plugins", "claude-owned");
		const ompRegistryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
		const claudeRegistryPath = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
		await Promise.all([
			fs.mkdir(path.join(ompPluginPath, "skills", "omp-demo"), { recursive: true }),
			fs.mkdir(path.join(claudePluginPath, "skills", "claude-demo"), { recursive: true }),
			fs.mkdir(path.dirname(ompRegistryPath), { recursive: true }),
			fs.mkdir(path.dirname(claudeRegistryPath), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(ompPluginPath, "skills", "omp-demo", "SKILL.md"),
				"---\nname: omp-demo\ndescription: OMP skill\n---\nBody\n",
			),
			fs.writeFile(
				path.join(claudePluginPath, "skills", "claude-demo", "SKILL.md"),
				"---\nname: claude-demo\ndescription: Claude skill\n---\nBody\n",
			),
			fs.writeFile(
				ompRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"omp-owned@market": [{ scope: "user", installPath: ompPluginPath, version: "1.0.0" }],
					},
				}),
			),
			fs.writeFile(
				claudeRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"claude-owned@market": [{ scope: "user", installPath: claudePluginPath, version: "1.0.0" }],
					},
				}),
			),
		]);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });

		expect(result.all.find(skill => skill.name === "omp-demo")?._source.provider).toBe("claude-plugins");
		expect(result.all.find(skill => skill.name === "claude-demo")).toBeUndefined();
	});

	test("loadSkills surfaces omp-installed plugin skills without enabling the Claude source", async () => {
		// Regression (#10743): #10666 fixed allowedRoots() to keep user-scope roots
		// with origin !== "claude", but isSourceEnabled() in extensibility/skills.ts
		// re-dropped them via isUserSourceEnabled("claude-plugins"). The origin now
		// rides SourceMeta, so the foreign gate applies only to claude-origin roots.
		const ompPluginPath = path.join(tempDir, "plugins", "omp-owned");
		const claudePluginPath = path.join(tempDir, "plugins", "claude-owned");
		const ompRegistryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
		const claudeRegistryPath = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
		await Promise.all([
			fs.mkdir(path.join(ompPluginPath, "skills", "omp-demo"), { recursive: true }),
			fs.mkdir(path.join(claudePluginPath, "skills", "claude-demo"), { recursive: true }),
			fs.mkdir(path.dirname(ompRegistryPath), { recursive: true }),
			fs.mkdir(path.dirname(claudeRegistryPath), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(ompPluginPath, "skills", "omp-demo", "SKILL.md"),
				"---\nname: omp-demo\ndescription: OMP skill\n---\nBody\n",
			),
			fs.writeFile(
				path.join(claudePluginPath, "skills", "claude-demo", "SKILL.md"),
				"---\nname: claude-demo\ndescription: Claude skill\n---\nBody\n",
			),
			fs.writeFile(
				ompRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"omp-owned@market": [{ scope: "user", installPath: ompPluginPath, version: "1.0.0" }],
					},
				}),
			),
			fs.writeFile(
				claudeRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"claude-owned@market": [{ scope: "user", installPath: claudePluginPath, version: "1.0.0" }],
					},
				}),
			),
		]);

		// enabledProviders unset (beforeEach disables the claude-plugins/claude
		// user sources): the omp-origin skill must still load; the claude-origin
		// one must stay opt-in.
		const { skills } = await loadSkills({ cwd: tempDir });

		expect(skills.map(s => s.name)).toContain("omp-demo");
		expect(skills.map(s => s.name)).not.toContain("claude-demo");
	});

	test("dashboard marks omp-origin plugin capabilities active without enabling the Claude source (#12776)", async () => {
		// Regression (#12776): the loader exempts ~/.omp/plugins marketplace roots
		// (origin !== "claude") from the foreign user opt-in gate, but the
		// /extensions dashboard's resolveState re-dropped them as "user-opt-in".
		// The omp-origin skill AND rule must render active; the claude-origin skill
		// must stay opt-in disabled. The rule proves origin now rides the
		// non-skill _source built by loadFilesFromDir, not just skills.
		const ompPluginPath = path.join(tempDir, "plugins", "omp-owned");
		const claudePluginPath = path.join(tempDir, "plugins", "claude-owned");
		const ompRegistryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
		const claudeRegistryPath = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
		await Promise.all([
			fs.mkdir(path.join(ompPluginPath, "skills", "omp-demo"), { recursive: true }),
			fs.mkdir(path.join(ompPluginPath, "rules"), { recursive: true }),
			fs.mkdir(path.join(claudePluginPath, "skills", "claude-demo"), { recursive: true }),
			fs.mkdir(path.dirname(ompRegistryPath), { recursive: true }),
			fs.mkdir(path.dirname(claudeRegistryPath), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(ompPluginPath, "skills", "omp-demo", "SKILL.md"),
				"---\nname: omp-demo\ndescription: OMP skill\n---\nBody\n",
			),
			fs.writeFile(path.join(ompPluginPath, "rules", "omp-rule.md"), "---\ndescription: OMP rule\n---\nBody\n"),
			fs.writeFile(
				path.join(claudePluginPath, "skills", "claude-demo", "SKILL.md"),
				"---\nname: claude-demo\ndescription: Claude skill\n---\nBody\n",
			),
			fs.writeFile(
				ompRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"omp-owned@market": [{ scope: "user", installPath: ompPluginPath, version: "1.0.0" }],
					},
				}),
			),
			fs.writeFile(
				claudeRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"claude-owned@market": [{ scope: "user", installPath: claudePluginPath, version: "1.0.0" }],
					},
				}),
			),
		]);

		const extensions = await loadAllExtensions(tempDir);
		const ompSkill = extensions.find(e => e.id === "skill:omp-demo");
		const ompRule = extensions.find(e => e.id === "rule:omp-rule");
		const claudeSkill = extensions.find(e => e.id === "skill:claude-demo");

		expect(ompSkill?.state).toBe("active");
		expect(ompRule?.state).toBe("active");
		// The management view includes opted-out sources, but marks them disabled.
		expect(claudeSkill?.state).toBe("disabled");
		expect(claudeSkill?.disabledReason).toBe("user-opt-in");
	});

	for (const catalogDir of [".claude-plugin", ".omp-plugin"]) {
		test(`marketplace-root ${catalogDir} entry limits shared skills to declared paths`, async () => {
			const pluginPath = path.join(tempDir, "plugins", "anthropic-skills");
			const registryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
			await Promise.all([
				fs.mkdir(path.join(pluginPath, "skills", "xlsx"), { recursive: true }),
				fs.mkdir(path.join(pluginPath, "skills", "skill-creator"), { recursive: true }),
				fs.mkdir(path.dirname(registryPath), { recursive: true }),
				fs.mkdir(path.join(pluginPath, catalogDir), { recursive: true }),
			]);
			await Promise.all([
				fs.writeFile(
					path.join(pluginPath, "skills", "xlsx", "SKILL.md"),
					"---\nname: xlsx\ndescription: Spreadsheet skill\n---\nBody\n",
				),
				fs.writeFile(
					path.join(pluginPath, "skills", "skill-creator", "SKILL.md"),
					"---\nname: skill-creator\ndescription: Skill creation skill\n---\nBody\n",
				),
				fs.writeFile(
					path.join(pluginPath, catalogDir, "marketplace.json"),
					JSON.stringify({
						name: "anthropic-agent-skills",
						owner: { name: "Anthropic" },
						plugins: [
							{
								name: "document-skills",
								source: "./",
								strict: false,
								skills: ["./skills/xlsx"],
							},
							{
								name: "example-skills",
								source: "./",
								strict: false,
								skills: ["./skills/skill-creator"],
							},
						],
					}),
				),
				fs.writeFile(
					registryPath,
					JSON.stringify({
						version: 2,
						plugins: {
							"document-skills@anthropic-agent-skills": [
								{ scope: "user", installPath: pluginPath, version: "1.0.0" },
							],
						},
					}),
				),
			]);

			const result = await loadCapability<Skill>("skills", { cwd: tempDir });

			expect(result.all.find(skill => skill.name === "xlsx")).toMatchObject({
				name: "xlsx",
				frontmatter: { description: "Spreadsheet skill" },
			});
			expect(result.all.find(skill => skill.name === "skill-creator")).toBeUndefined();
		});
	}

	test("defaults scope to user when not specified", async () => {
		enableUserSource("claude-plugins");
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-scope@market": [
					{
						installPath: "/path/to/no-scope",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("user");
	});
});
