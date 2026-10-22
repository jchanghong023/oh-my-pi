import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getMarketplacesRegistryPath, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { Settings, withActiveSettings } from "../../config/settings";
import { hookCapability } from "../../capability/hook";
import { mcpCapability, type MCPServer } from "../../capability/mcp";
import { slashCommandCapability, type SlashCommand } from "../../capability/slash-command";
import type { EffectiveExtensionRoots, LoadContext } from "../../capability/types";
import { loadCapability, isUserSourceEnabled, type Hook } from "../../discovery";
import { classifyAgentPluginRoot } from "../../discovery/agent-plugin-format";
import { listClaudePluginRoots, type ClaudePluginRoot } from "../../discovery/helpers";
import { listOmpExtensionRoots } from "../../discovery/omp-extension-roots";
import { buildPluginDirRoot } from "../../discovery/plugin-dir-roots";
import { getInstalledPlugins } from "../../extensibility/plugins/loader";
import { parseMarketplaceCatalog } from "../../extensibility/plugins/marketplace/fetcher";
import { expandTilde } from "../../tools/path-utils";
import { loadSkillCatalog, type Skill } from "../../extensibility/skills";
import { cfgDisabledExtensions, cfgExtensions, cfgSkills } from "../../extensibility/settings";
import type { AgentSession } from "../../session/agent-session";
import { discoverAgents } from "../../task/discovery";
import { LegacyProtocol as L } from "./schema";
import type { SubagentRuntimeConfig } from "./schema/vendor/subagent-runtime-config";
import type { ModelSelection } from "./schema/vendor/model-selection";

export interface ZCodeCatalogOptions {
	settings?: Settings;
	session?: AgentSession;
	sessionId?: string;
	agentDir?: string;
	configScope?: L.ZCodePluginScope;
	/** 测试注入:替换 agent 目录发现调用(默认真实 discoverAgents)。 */
	discoverAgents?: typeof discoverAgents;
}
interface Inventory {
	plugins: L.ZCodePluginInfo[];
	diagnostics: L.ZCodePluginDiagnostic[];
	skills: readonly Skill[];
	marketplaces: L.ZCodePluginMarketplaceSummary[];
	availablePlugins: L.ZCodeAvailablePluginSummary[];
	agents: Array<{ name: string; filePath?: string }>;
}
interface Root extends ClaudePluginRoot {
	manifest?: Record<string, unknown>;
	enabledSource?: L.ZCodePluginScope;
	metadataError?: "missing" | "unreadable" | "invalid";
}
function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function publicFailure(error: unknown): string {
	if (error instanceof SyntaxError) return "Malformed JSON";
	if (isRecord(error) && typeof error.code === "string") return `Resource unavailable (${error.code})`;
	return "Resource could not be read or validated";
}

/** Read-only adapter. Native discovery and the resident runtime remain the resource owners. */
export class ZCodeCatalogs {
	readonly #resident = new WeakMap<AgentSession, Promise<Inventory>>();
	/** Capture at runtime initialization, not when a later Picker first opens. */
	async captureSession(cwd: string, options: ZCodeCatalogOptions & { session: AgentSession }): Promise<void> {
		await this.#inventory(cwd, options);
	}
	/** Resolve only canonical authored references; this method performs no runtime admission. */
	async prepareReferences(
		cwd: string,
		text: string,
		options: ZCodeCatalogOptions,
	): Promise<{ text: string; reminder?: string }> {
		if (!text.includes("plugin://") && !text.includes("[$") && !/(?:^|\s)\$[\w.-]+/.test(text)) return { text };
		const inventory = await this.#inventory(cwd, options);
		const references = await this.pluginReferences(cwd, options);
		const selected = new Map<string, L.ZCodePluginReferenceCatalogEntry>();
		for (const match of text.matchAll(/\[(?:\\.|[^\\\]])*\]\(plugin:\/\/([A-Za-z0-9@._/-]+)\)/g)) {
			const id = match[1]!;
			const plugin = references.plugins.find(item => item.pluginId === id);
			// 用户裁定(2026-10-22):插件引用不支持。未知/禁用/歧义插件一律
			// fail-open 跳过引用本身,不拒绝整条用户输入;正文照常执行。
			if (!plugin || !plugin.enabled || plugin.conflictingPluginIds.length) continue;
			selected.set(id, plugin);
		}
		const resolvedText = text
			.replace(/\[\$((?:\\.|[^\\\]])*)\]\(((?:\\.|[^)])*)\)/g, (_original, _label: string, destination: string) => {
				const resource = destination.replace(/\\([\\>])/g, "$1");
				const skill = inventory.skills.find(item => path.resolve(item.filePath) === path.resolve(cwd, resource));
				if (!skill) throw new Error("Referenced skill is unavailable in this runtime");
				return `/skill:${skill.name}`;
			})
			.replace(/(^|\s)\$([\w.-]+)(?=$|\s)/g, (original, prefix: string, name: string) => {
				const skill = inventory.skills.find(item => item.name === name);
				return skill ? `${prefix}/skill:${skill.name}` : original;
			});
		if (!selected.size) return { text: resolvedText };
		const identifiers = [...selected.values()].map(plugin => ({
			pluginId: plugin.pluginId,
			name: plugin.name,
			marketplace: plugin.marketplace,
			skillQualifiedNames: plugin.skillQualifiedNames,
			mcpServerNames: plugin.mcpServerNames,
			subagentNames: plugin.subagentNames,
		}));
		return {
			text: resolvedText,
			reminder: `<plugin_reference>\n${JSON.stringify(identifiers).replaceAll("<", "\\u003c")}\n</plugin_reference>`,
		};
	}
	async #inventory(cwd: string, options: ZCodeCatalogOptions): Promise<Inventory> {
		if (options.sessionId && !options.session) throw new Error("Resource catalog requires a resident session");
		if (options.session) {
			let inventory = this.#resident.get(options.session);
			if (!inventory) {
				inventory = this.#discover(cwd, { ...options, configScope: undefined });
				this.#resident.set(options.session, inventory);
			}
			return inventory;
		}
		return this.#discover(cwd, options);
	}
	async #discover(cwd: string, options: ZCodeCatalogOptions): Promise<Inventory> {
		const settings =
			options.session?.settings ??
			options.settings ??
			(await Settings.loadIsolated({ cwd, agentDir: options.agentDir, readOnly: true }));
		return withActiveSettings(settings, () => this.#discoverScoped(cwd, options, settings));
	}
	async #discoverScoped(cwd: string, options: ZCodeCatalogOptions, settings: Settings): Promise<Inventory> {
		const agentDir = options.agentDir ?? settings.getAgentDir() ?? getAgentDir();
		const extensionRoots: EffectiveExtensionRoots = options.session?.effectiveExtensionRoots ?? {
			explicit: [],
			mode: "merge",
			configured: cfgExtensions.get(settings),
			configuredLevel: settings.extensionsSourceLevel(),
		};
		const context: LoadContext = { cwd, home: os.homedir(), repoRoot: null, agentDir, extensionRoots };
		const diagnostics: L.ZCodePluginDiagnostic[] = [];
		const report = (code: string, message: string, pluginId?: string) =>
			diagnostics.push({ code, message, severity: "warning", ...(pluginId ? { pluginId } : {}) });
		const registry = await listClaudePluginRoots(context.home, cwd, { includeDisabled: true });
		for (const _warning of registry.warnings)
			report("registry_invalid", "Native plugin registry contains an invalid or unreadable entry");
		const roots: Root[] = registry.roots.map(root => ({ ...root }));
		try {
			for (const plugin of await getInstalledPlugins(cwd)) {
				if (roots.some(root => path.resolve(root.path) === path.resolve(plugin.path))) continue;
				roots.push({
					id: plugin.name,
					plugin: plugin.manifest.name ?? plugin.name,
					marketplace: "npm",
					path: plugin.path,
					scope: plugin.scope,
					version: plugin.version,
					origin: "omp",
					enabled: plugin.enabled,
					manifest: { ...plugin.manifest },
					metadataError: plugin.metadataError,
					enabledSource: plugin.enabledSource === "project" ? "workspace" : "user",
				});
			}
		} catch (error) {
			report("package_inventory_unavailable", publicFailure(error));
		}
		try {
			for (const root of await listOmpExtensionRoots(context)) {
				if (roots.some(item => path.resolve(item.path) === path.resolve(root.path))) continue;
				// This is the native explicit-root identity, not an invented marketplace install.
				roots.push({ ...buildPluginDirRoot(root.path), scope: root.level, enabled: true });
			}
		} catch (error) {
			report("extension_inventory_unavailable", publicFailure(error));
		}
		const loadOptions = { cwd, agentDir, extensionRoots, disabledExtensions: cfgDisabledExtensions.get(settings) };
		// discoverAgents 是发现 Promise.all 中唯一没有兜底的调用:agent 目录/扩展根解析抛错
		// 会拒绝整条 inventory,进而拒绝会话绑定与用户输入(memory disabled 用例 timeline 无
		// DONE 的候选根因,findings 第 7 条)。按同文件其他发现节的模式降级为 diagnostic。
		let agents: Awaited<ReturnType<typeof discoverAgents>>["agents"] = [];
		try {
			agents = (await (options.discoverAgents ?? discoverAgents)(cwd, context.home, extensionRoots)).agents;
		} catch (error) {
			report("agent_inventory_unavailable", publicFailure(error));
		}
		const [skillCatalog, mcps, commands, hooks] = await Promise.all([
			loadSkillCatalog({ ...cfgSkills.get(settings), ...loadOptions }, "inventory"),
			loadCapability<MCPServer>(mcpCapability.id, loadOptions),
			loadCapability<SlashCommand>(slashCommandCapability.id, loadOptions),
			loadCapability<Hook>(hookCapability.id, loadOptions),
		]);
		for (const warning of skillCatalog.warnings)
			report(
				"skill_unavailable",
				warning.message.includes("description")
					? "A native skill is missing its required description"
					: "A native skill could not be admitted",
			);
		for (const warning of [...mcps.warnings, ...commands.warnings, ...hooks.warnings]) {
			if (warning)
				report(
					"component_unavailable",
					"A native plugin component could not be admitted; inspect native discovery diagnostics locally",
				);
		}
		const activeSkills = options.session?.skills ?? skillCatalog.skills.filter(skill => !skill.disabledReason);
		const plugins: L.ZCodePluginInfo[] = [];
		for (const root of roots) {
			const scope = root.scope === "project" ? "workspace" : "user";
			if (options.configScope && options.configScope !== scope) continue;
			let manifest = root.manifest ?? {};
			let available = root.metadataError === undefined;
			let missing = root.metadataError === "missing";
			if (root.metadataError)
				report(`package_${root.metadataError}`, `Native package metadata is ${root.metadataError}`, root.id);
			try {
				await fs.access(root.path);
				const classified = await classifyAgentPluginRoot(root.path);
				if (classified.kind === "invalid") {
					available = false;
					report("manifest_invalid", "Native Agent Plugin manifest failed validation", root.id);
				} else if (classified.kind === "standard") {
					manifest = { ...classified.manifest };
				} else if (!root.manifest) {
					for (const file of [
						path.join(root.path, ".claude-plugin", "plugin.json"),
						path.join(root.path, ".omp-plugin", "plugin.json"),
						path.join(root.path, "package.json"),
					]) {
						try {
							const data: unknown = JSON.parse(await fs.readFile(file, "utf8"));
							if (!isRecord(data)) throw new SyntaxError("Invalid manifest object");
							const nativeManifest = data.omp ?? data.pi;
							manifest =
								file.endsWith("package.json") && isRecord(nativeManifest)
									? { ...data, ...nativeManifest }
									: data;
							break;
						} catch (error) {
							if (!isEnoent(error)) throw error;
						}
					}
				}
			} catch (error) {
				available = false;
				missing = isEnoent(error);
				report(missing ? "package_missing" : "manifest_invalid", publicFailure(error), root.id);
			}
			const enabled =
				available &&
				root.enabled !== false &&
				!(
					root.origin === "claude" &&
					root.scope === "user" &&
					!isUserSourceEnabled("claude-plugins", context) &&
					!isUserSourceEnabled("claude", context)
				);
			if (available && root.enabled !== false && !enabled)
				report("source_not_enabled", "Foreign user plugin source is not opted in", root.id);
			const ownedSkills = skillCatalog.skills.filter(skill => inside(root.path, skill.filePath));
			const ownedCommands = commands.items.filter(item => inside(root.path, item.path));
			const ownedAgents = agents.filter(item => item.filePath && inside(root.path, item.filePath));
			const ownedMcp = mcps.items.filter(item => inside(root.path, item._source.path));
			const ownedHooks = hooks.items.filter(item => inside(root.path, item.path));
			const components: L.ZCodePluginComponentGroup[] = [
				{ kind: "skill", items: ownedSkills.map(item => ({ name: item.name, description: item.description })) },
				{ kind: "command", items: ownedCommands.map(item => ({ name: item.name })) },
				{ kind: "agent", items: ownedAgents.map(item => ({ name: item.name, description: item.description })) },
				{ kind: "mcp", items: ownedMcp.map(item => ({ name: item.name })) },
				{ kind: "hook", items: ownedHooks.map(item => ({ name: item.name })) },
			];
			if (ownedHooks.length)
				report(
					"hook_review_unavailable",
					"Native file hooks do not expose workspace declaration trust grants; catalog reads never execute or grant trust",
					root.id,
				);
			plugins.push({
				id: root.id,
				name: stringField(manifest.name) ?? root.plugin,
				description: stringField(manifest.description),
				version: stringField(manifest.version) ?? root.version,
				enabled,
				source: root.origin,
				marketplace: root.marketplace,
				rootSource: scope,
				enabledSource: root.enabledSource ?? scope,
				rootPath: root.path,
				skillCount: ownedSkills.length,
				skillRootCount: ownedSkills.length ? 1 : 0,
				commandRootCount: ownedCommands.length ? 1 : 0,
				components: components.filter(group => group.items.length > 0),
				mcpServerNames: ownedMcp.filter(item => item.enabled !== false).map(item => item.name),
				...(missing ? { packageStatus: "missing" as const } : {}),
			});
		}
		const marketplaces: L.ZCodePluginMarketplaceSummary[] = [];
		const availablePlugins: L.ZCodeAvailablePluginSummary[] = [];
		// Read cached catalogs only. No fetch/update/auth path is reachable from a listing.
		try {
			const raw: unknown = JSON.parse(await fs.readFile(getMarketplacesRegistryPath(), "utf8"));
			if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.marketplaces))
				throw new SyntaxError("Invalid marketplace registry");
			for (const entry of raw.marketplaces) {
				if (
					!isRecord(entry) ||
					typeof entry.name !== "string" ||
					typeof entry.catalogPath !== "string" ||
					typeof entry.sourceType !== "string"
				) {
					report("marketplace_registry_invalid", "Native marketplace registry contains an invalid entry");
					continue;
				}
				try {
					const catalogPath = path.resolve(expandTilde(entry.catalogPath));
					const catalog = parseMarketplaceCatalog(await fs.readFile(catalogPath, "utf8"), catalogPath);
					marketplaces.push({
						id: entry.name,
						name: entry.name,
						source: { type: entry.sourceType },
						description: catalog.metadata?.description,
						pluginCount: catalog.plugins.length,
					});
					for (const item of catalog.plugins) {
						const id = `${item.name}@${entry.name}`;
						availablePlugins.push({
							id,
							name: item.name,
							marketplace: entry.name,
							description: item.description,
							version: item.version,
							installed: plugins.some(plugin => plugin.id === id),
						});
					}
				} catch (error) {
					report("marketplace_catalog_unavailable", publicFailure(error));
					marketplaces.push({
						id: entry.name,
						name: entry.name,
						source: { type: entry.sourceType },
						pluginCount: 0,
						refreshFailure: {
							code: "cached_catalog_unavailable",
							failedAt: new Date().toISOString(),
							message: publicFailure(error),
						},
					});
				}
			}
		} catch (error) {
			if (!isEnoent(error)) report("marketplace_registry_unavailable", publicFailure(error));
		}
		return { plugins, diagnostics, skills: activeSkills, marketplaces, availablePlugins, agents };
	}
	async plugins(cwd: string, options: ZCodeCatalogOptions = {}): Promise<L.ZCodePluginsListResult> {
		const inventory = await this.#inventory(cwd, options);
		return L.zcodePluginsListResultSchema.parse({ plugins: inventory.plugins, diagnostics: inventory.diagnostics });
	}
	async overview(cwd: string, options: ZCodeCatalogOptions = {}): Promise<L.ZCodePluginsOverviewResult> {
		const { plugins, diagnostics, marketplaces, availablePlugins } = await this.#inventory(cwd, options);
		return L.zcodePluginsOverviewResultSchema.parse({
			marketplaces,
			availablePlugins,
			restorableBuiltins: [],
			diagnostics,
			installedPlugins: plugins.map(plugin => ({
				id: plugin.id,
				name: plugin.name,
				marketplace: plugin.marketplace,
				description: plugin.description,
				version: plugin.version,
				enabled: plugin.enabled,
				scope: plugin.rootSource,
				componentTypes: plugin.components?.map(group => group.kind),
			})),
			capability: { supported: true },
		});
	}
	async pluginReferences(
		cwd: string,
		options: ZCodeCatalogOptions = {},
	): Promise<L.ZCodePluginsReferenceCatalogResult> {
		const inventory = await this.#inventory(cwd, options);
		return L.zcodePluginsReferenceCatalogResultSchema.parse({
			authority: options.session ? "session" : "workspace",
			plugins: inventory.plugins.map(plugin => ({
				pluginId: plugin.id,
				name: plugin.name,
				marketplace: plugin.marketplace,
				description: plugin.description,
				enabled: plugin.enabled,
				conflictingPluginIds: plugin.enabled
					? inventory.plugins
							.filter(other => other.enabled && other.name === plugin.name && other.id !== plugin.id)
							.map(other => other.id)
					: [],
				skillQualifiedNames: inventory.skills
					.filter(skill => inside(plugin.rootPath, skill.filePath))
					.map(skill => skill.name),
				mcpServerNames: plugin.mcpServerNames,
				subagentNames: inventory.agents
					.filter(agent => agent.filePath && inside(plugin.rootPath, agent.filePath))
					.map(agent => agent.name),
			})),
		});
	}
	async skillReferences(cwd: string, options: ZCodeCatalogOptions = {}): Promise<L.ZCodeSkillsReferenceCatalogResult> {
		const inventory = await this.#inventory(cwd, options);
		return L.zcodeSkillsReferenceCatalogResultSchema.parse({
			authority: options.session ? "session" : "workspace",
			skills: inventory.skills.map(skill => ({
				id: skill.name,
				name: skill.name,
				description: skill.description,
				path: skill.filePath,
				enabled: true,
				scope: skill._source?.pluginName ? "plugin" : skill._source?.level === "project" ? "workspace" : "user",
				...(skill._source?.pluginName ? { pluginName: skill._source.pluginName } : {}),
			})),
		});
	}
	/**
	 * I20:把 Host 子代理模型覆盖(subagents/readRuntimeConfig)映射到 OMP agent 名。
	 * 内置覆盖键是 ZCode CLI 的内置 subagent 名,对应 OMP 的等价内置:general-purpose
	 * (通用 worker)→ task,Explore(只读探索)→ scout。插件覆盖键是稳定身份
	 * plugin:<pluginId>:<裸名小写>(vendor subagents-types.createPluginAgentStateId),
	 * 按 pluginId + agent 文件归属匹配本地目录;对 OMP 不可见的插件静默跳过。
	 */
	async mapSubagentModelSelectionOverrides(
		cwd: string,
		options: ZCodeCatalogOptions,
		config: SubagentRuntimeConfig,
	): Promise<Record<string, ModelSelection>> {
		if (config.kind !== "ready") return {};
		const inventory = await this.#inventory(cwd, options);
		const mapped: Record<string, ModelSelection> = {};
		if (config.builtInModelSelectionOverrides["general-purpose"])
			mapped.task = config.builtInModelSelectionOverrides["general-purpose"];
		if (config.builtInModelSelectionOverrides.Explore) mapped.scout = config.builtInModelSelectionOverrides.Explore;
		for (const [agentId, selection] of Object.entries(config.pluginAgentModelSelectionOverrides)) {
			const [, pluginId, ...rest] = agentId.split(":");
			const name = rest.join(":");
			if (!pluginId || !name) continue;
			const plugin = inventory.plugins.find(item => item.id === pluginId);
			if (!plugin) continue;
			const agent = inventory.agents.find(
				item =>
					item.filePath !== undefined &&
					inside(plugin.rootPath, item.filePath) &&
					item.name.toLowerCase() === name,
			);
			if (agent) mapped[agent.name] = selection;
		}
		return mapped;
	}
}
