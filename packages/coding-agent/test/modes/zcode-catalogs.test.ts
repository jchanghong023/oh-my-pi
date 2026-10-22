import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getAgentDir, getPluginsDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { clearPluginRootsAndCaches } from "../../src/discovery/helpers";
import { ZCodeCatalogs } from "../../src/modes/zcode/catalogs";
import { LegacyProtocol as L } from "../../src/modes/zcode/schema";

const roots: string[] = [];
const envKeys = ["OMP_CONFIG_ROOT", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"] as const;
let savedEnv: Array<string | undefined>;
beforeEach(async () => {
	savedEnv = envKeys.map(key => process.env[key]);
	const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-catalog-profile-"));
	roots.push(configRoot);
	for (const key of envKeys) delete process.env[key];
	process.env.OMP_CONFIG_ROOT = configRoot;
	process.env.OMP_PROFILE = "catalog-test";
	__resetDirsFromEnvForTests();
});
afterEach(async () => {
	clearPluginRootsAndCaches();
	for (const [index, key] of envKeys.entries()) {
		const value = savedEnv[index];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__resetDirsFromEnvForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(scope: "project" | "user" = "project") {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-catalog-"));
	roots.push(cwd);
	await fs.mkdir(path.join(cwd, ".git"));
	const plugin = path.join(cwd, "package");
	await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
	await fs.mkdir(path.join(plugin, "skills", "sample"), { recursive: true });
	await fs.writeFile(
		path.join(plugin, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "sample-plugin", description: "Real native package", version: "1.0.0" }),
	);
	await fs.writeFile(
		path.join(plugin, "skills", "sample", "SKILL.md"),
		"---\nname: sample\ndescription: Real discovered skill\n---\nRead this actual resource.\n",
	);
	const pluginsDir = scope === "project" ? path.join(cwd, ".omp", "plugins") : getPluginsDir();
	await fs.mkdir(pluginsDir, { recursive: true });
	const registry = path.join(pluginsDir, "installed_plugins.json");
	await fs.writeFile(
		registry,
		JSON.stringify({
			version: 2,
			plugins: {
				"sample-plugin@test-market": [{ installPath: plugin, version: "1.0.0", scope, enabled: true }],
			},
		}),
	);
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir: getAgentDir(),
		readOnly: true,
		overrides: { "skills.enableClaudeProject": true },
	});
	return { cwd, plugin, registry, settings, catalogs: new ZCodeCatalogs() };
}

describe("native profile catalog settings", () => {
	it("reads the active profile registry without creating workspace runtime state", async () => {
		const f = await fixture("user");
		const registryBefore = await fs.readFile(f.registry, "utf8");
		const result = await f.catalogs.plugins(f.cwd, { settings: f.settings, configScope: "user" });
		expect(result.plugins.find(item => item.id === "sample-plugin@test-market")).toMatchObject({
			enabled: true,
			rootSource: "user",
			source: "omp",
		});
		const references = await f.catalogs.skillReferences(f.cwd, { settings: f.settings });
		expect(references.skills.some(item => item.name === "sample" && item.pluginName === "sample-plugin")).toBe(true);
		expect(await fs.readFile(f.registry, "utf8")).toBe(registryBefore);
		expect(await fs.readdir(f.cwd)).toEqual([".git", "package"]);
	});
	it("keeps disabled skills in plugin inventory but excludes them from executable references", async () => {
		const f = await fixture();
		const settings = await Settings.loadIsolated({
			cwd: f.cwd,
			agentDir: getAgentDir(),
			readOnly: true,
			overrides: { disabledExtensions: ["skill:sample"] },
		});
		const listed = await f.catalogs.plugins(f.cwd, { settings });
		expect(listed.plugins.find(item => item.id === "sample-plugin@test-market")?.components).toContainEqual({
			kind: "skill",
			items: [{ name: "sample", description: "Real discovered skill" }],
		});
		expect((await f.catalogs.skillReferences(f.cwd, { settings })).skills.some(item => item.name === "sample")).toBe(
			false,
		);
		const refs = await f.catalogs.pluginReferences(f.cwd, { settings });
		expect(refs.plugins.find(item => item.pluginId === "sample-plugin@test-market")?.skillQualifiedNames).toEqual([]);
		await expect(
			f.catalogs.prepareReferences(
				f.cwd,
				`Use [$Sample](${path.join(f.plugin, "skills", "sample", "SKILL.md").replaceAll("\\", "\\\\")})`,
				{ settings },
			),
		).rejects.toThrow("unavailable");
	});
	it("applies the configured master skill switch without dropping installed plugin metadata", async () => {
		const f = await fixture();
		const settings = await Settings.loadIsolated({
			cwd: f.cwd,
			agentDir: getAgentDir(),
			readOnly: true,
			overrides: { "skills.enabled": false },
		});
		expect((await f.catalogs.skillReferences(f.cwd, { settings })).skills).toEqual([]);
		const listed = await f.catalogs.plugins(f.cwd, { settings });
		expect(listed.plugins.find(item => item.id === "sample-plugin@test-market")).toMatchObject({
			enabled: true,
			skillCount: 1,
		});
	});
});

describe("native ZCode resource catalogs", () => {
	it("projects real installed identity and skill names through strict public schemas", async () => {
		const f = await fixture();
		const refs = L.zcodePluginsReferenceCatalogResultSchema.parse(
			await f.catalogs.pluginReferences(f.cwd, { settings: f.settings }),
		);
		const plugin = refs.plugins.find(item => item.pluginId === "sample-plugin@test-market");
		expect(plugin).toMatchObject({ enabled: true, marketplace: "test-market", name: "sample-plugin" });
		expect(plugin?.skillQualifiedNames).toContain("sample");
		expect(JSON.stringify(refs)).not.toContain(f.plugin);
		const skills = L.zcodeSkillsReferenceCatalogResultSchema.parse(
			await f.catalogs.skillReferences(f.cwd, { settings: f.settings }),
		);
		expect(skills.skills.some(skill => skill.name === "sample" && skill.pluginName === "sample-plugin")).toBe(true);
		const listed = L.zcodePluginsListResultSchema.parse(
			await f.catalogs.plugins(f.cwd, { settings: f.settings, configScope: "workspace" }),
		);
		expect(listed.plugins.find(item => item.id === "sample-plugin@test-market")?.components).toContainEqual({
			kind: "skill",
			items: [{ name: "sample", description: "Real discovered skill" }],
		});
		expect(await fs.readdir(path.join(f.cwd, ".omp"))).toEqual(["plugins"]);
		const overview = L.zcodePluginsOverviewResultSchema.parse(
			await f.catalogs.overview(f.cwd, { settings: f.settings, configScope: "workspace" }),
		);
		expect(overview.installedPlugins.some(item => item.id === "sample-plugin@test-market")).toBe(true);
		const prepared = await f.catalogs.prepareReferences(
			f.cwd,
			`Use [@Sample](plugin://sample-plugin@test-market) and [$Sample](${path.join(f.plugin, "skills", "sample", "SKILL.md").replaceAll("\\", "\\\\")})`,
			{ settings: f.settings },
		);
		expect(prepared.text).toContain("/skill:sample");
		expect(prepared.reminder).toContain("<plugin_reference>");
		expect(prepared.reminder).toContain("sample-plugin@test-market");
		expect(prepared.reminder).not.toContain(f.plugin);
		expect(
			(await f.catalogs.plugins(f.cwd, { settings: f.settings, configScope: "user" })).plugins.some(
				item => item.id === "sample-plugin@test-market",
			),
		).toBe(false);
		// 用户裁定(2026-10-22):插件引用不支持——未知插件 fail-open,不再拒绝整条输入。
		const absent = await f.catalogs.prepareReferences(f.cwd, "Use [@Absent](plugin://absent@test-market)", {
			settings: f.settings,
		});
		expect(absent.text).toContain("plugin://absent@test-market");
		expect(absent.reminder).toBeUndefined();
	});
	it("retains disabled and malformed packages without enabling or importing them", async () => {
		const f = await fixture();
		await fs.writeFile(
			f.registry,
			JSON.stringify({
				version: 2,
				plugins: {
					"sample-plugin@test-market": [
						{ installPath: f.plugin, version: "1.0.0", scope: "project", enabled: false },
					],
				},
			}),
		);
		await fs.writeFile(path.join(f.plugin, ".claude-plugin", "plugin.json"), "{broken secret=DO_NOT_DISCLOSE");
		clearPluginRootsAndCaches([f.registry]);
		const result = await f.catalogs.plugins(f.cwd, { settings: f.settings });
		expect(result.plugins.find(item => item.id === "sample-plugin@test-market")?.enabled).toBe(false);
		expect(
			result.diagnostics.some(
				item => item.pluginId === "sample-plugin@test-market" && item.code === "manifest_invalid",
			),
		).toBe(true);
		expect(JSON.stringify(result.diagnostics)).not.toContain("DO_NOT_DISCLOSE");
	});
	it("retains declared npm packages that have not been materialized", async () => {
		const f = await fixture();
		await fs.writeFile(
			path.join(f.cwd, ".omp", "plugins", "package.json"),
			JSON.stringify({ dependencies: { "missing-native-plugin": "1.0.0" } }),
		);
		const result = await f.catalogs.plugins(f.cwd, { settings: f.settings });
		expect(result.plugins.find(item => item.id === "missing-native-plugin")).toMatchObject({
			enabled: false,
			packageStatus: "missing",
		});
		expect(
			result.diagnostics.some(item => item.pluginId === "missing-native-plugin" && item.code === "package_missing"),
		).toBe(true);
	});
	it("rejects session authority without a resident runtime rather than discovering workspace fallback", async () => {
		const f = await fixture();
		await expect(f.catalogs.skillReferences(f.cwd, { sessionId: "cold", settings: f.settings })).rejects.toThrow(
			"resident",
		);
		await expect(f.catalogs.pluginReferences(f.cwd, { sessionId: "cold", settings: f.settings })).rejects.toThrow(
			"resident",
		);
	});
	it("degrades agent discovery failure to a diagnostic instead of rejecting the inventory", async () => {
		const f = await fixture();
		// discoverAgents 抛错此前会拒绝整条 #inventory(会话绑定/用户输入关键路径,findings 第 7 条);
		// 现按其他发现节的模式降级为 diagnostic,插件/技能目录照常返回。
		const failing = async () => {
			throw new Error("agent discovery exploded");
		};
		const listed = await f.catalogs.plugins(f.cwd, { settings: f.settings, discoverAgents: failing });
		expect(listed.plugins.some(item => item.id === "sample-plugin@test-market")).toBe(true);
		expect(listed.diagnostics.some(item => item.code === "agent_inventory_unavailable")).toBe(true);
		const skills = await f.catalogs.skillReferences(f.cwd, { settings: f.settings });
		expect(skills.skills.some(item => item.name === "sample")).toBe(true);
	});
	it("maps host subagent model overrides to the equivalent OMP agents", async () => {
		const f = await fixture();
		await fs.mkdir(path.join(f.plugin, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(f.plugin, "agents", "judge.md"),
			"---\nname: judge\ndescription: Plugin judge agent\n---\nJudge body.\n",
		);
		const mapped = await f.catalogs.mapSubagentModelSelectionOverrides(
			f.cwd,
			{ settings: f.settings },
			{
				kind: "ready",
				profiles: [],
				builtInModelSelectionOverrides: {
					"general-purpose": { providerId: "host-p", modelId: "worker-m" },
					Explore: { providerId: "host-e", modelId: "explore-m" },
				},
				pluginAgentModelSelectionOverrides: {
					"plugin:sample-plugin@test-market:judge": { providerId: "host-q", modelId: "judge-m" },
					"plugin:invisible-plugin@nowhere:ghost": { providerId: "host-q", modelId: "ghost-m" },
				},
			},
		);
		// 内置 general-purpose/Explore → OMP task/scout;插件覆盖按稳定身份匹配本地目录内 agent;
		// 对 OMP 不可见的插件(ghost)静默跳过。
		expect(mapped).toEqual({
			task: { providerId: "host-p", modelId: "worker-m" },
			scout: { providerId: "host-e", modelId: "explore-m" },
			judge: { providerId: "host-q", modelId: "judge-m" },
		});
	});
	it("returns no overrides for the built-in fallback configuration", async () => {
		const f = await fixture();
		expect(
			await f.catalogs.mapSubagentModelSelectionOverrides(
				f.cwd,
				{ settings: f.settings },
				{ kind: "built-in-fallback" },
			),
		).toEqual({});
	});
});
