/**
 * Fork-extension management surface, B tier (requirement 5.6, rpc-ui-protocol.md).
 *
 * MCP CRUD wraps `mcp/config-writer.ts` over the user (`<agentDir>/mcp.json`)
 * and project (`<cwd>/.omp/mcp.json`) files; connection status is a best-effort
 * cache fed by the session event bus (`mcp:connection-status`). Skill toggles
 * write the existing `skills.enable*` / `skills.ignoredSkills` keys. Agent
 * definitions read through `task/discovery.ts` and write project-scope
 * frontmatter files. Usage/statistics wrap `authStorage.usage` and the
 * `@oh-my-pi/omp-stats` aggregator (`omp usage --json` / `omp stats` parity).
 *
 * The controller is session-optional: it holds the narrow
 * {@link RpcForkServiceContext} slice it actually needs (see rpc-fork-config),
 * so project mode (`omp --mode rpc-ui --rpc-project`) can answer every command
 * here with ZERO sessions loaded. Session-backed callers keep the historical
 * constructor shape and are converted via {@link serviceContextFromSession}.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isRecord } from "@oh-my-pi/pi-utils";
import type { EventBus } from "../../utils/event-bus";
import {
	addMCPServer,
	getMCPServer,
	listMCPServers,
	readDisabledServers,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import type { MCPServerConfig } from "../../mcp/types";
import { isMcpConnectionStatusEvent, type McpConnectionStatusEvent } from "../../mcp/startup-events";
import type { MCPFailureClass } from "../../mcp/errors";
import { loadSkills } from "../../extensibility/skills";
import {
	cfgSkillsEnableAgentsProject,
	cfgSkillsEnableAgentsUser,
	cfgSkillsEnableClaudeProject,
	cfgSkillsEnableClaudeUser,
	cfgSkillsEnableCodexUser,
	cfgSkillsEnablePiProject,
	cfgSkillsEnablePiUser,
	cfgSkillsIgnoredSkills,
} from "../../extensibility/settings";
import type { AnySetting } from "../../config/registry";
import { discoverAgents } from "../../task/discovery";
import type { AuthStorage } from "../../session/auth-storage";
import type { AgentSession } from "../../session/agent-session";
import { asRpcForkServiceContext, type RpcForkServiceContext } from "./rpc-fork-config";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

/** Render an unknown thrown value as the wire error message. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface CachedMcpStatus {
	status: "connected" | "failed" | "reconnecting";
	failureClass?: MCPFailureClass | "unknown";
	error?: string;
}

/** Agent definition file names are also file names — no traversal, no frontmatter tricks. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class RpcForkManageController {
	readonly #statusCache = new Map<string, CachedMcpStatus>();
	readonly #unsubscribe: () => void;
	readonly #agentDir: string;
	readonly #ctx: RpcForkServiceContext;

	constructor(
		private readonly host: RpcForkHost,
		session: AgentSession | RpcForkServiceContext,
		eventBus?: EventBus,
		options?: { agentDir?: string },
	) {
		this.#ctx = asRpcForkServiceContext(session);
		this.#agentDir = options?.agentDir ?? this.#ctx.agentDir ?? getAgentDir();
		this.#unsubscribe = eventBus ? this.#subscribeMcpStatus(eventBus) : () => {};
		host.registerCommand("list_mcp_servers", command => this.#listMcpServers(command));
		host.registerCommand("upsert_mcp_server", command => this.#upsertMcpServer(command));
		host.registerCommand("delete_mcp_server", command => this.#deleteMcpServer(command));
		host.registerCommand("set_mcp_server_disabled", command => this.#setMcpServerDisabled(command));
		host.registerCommand("mcp_reconnect", command => this.#mcpReconnect(command));
		host.registerCommand("list_skills", command => this.#listSkills(command));
		host.registerCommand("set_skill_source_enabled", command => this.#setSkillSourceEnabled(command));
		host.registerCommand("set_skill_ignored", command => this.#setSkillIgnored(command));
		host.registerCommand("list_agent_definitions", command => this.#listAgentDefinitions(command));
		host.registerCommand("upsert_agent_definition", command => this.#upsertAgentDefinition(command));
		host.registerCommand("delete_agent_definition", command => this.#deleteAgentDefinition(command));
		host.registerCommand("get_usage", command => this.#getUsage(command));
		host.registerCommand("get_stats_summary", command => this.#getStatsSummary(command));
		host.registerDisposer(() => this.#unsubscribe());
	}

	#authStorage(): AuthStorage {
		return this.#ctx.authStorage ?? this.#ctx.modelRegistry.authStorage;
	}

	#mcpPaths(): { userPath: string; projectPath: string } {
		return {
			userPath: path.join(this.#agentDir, "mcp.json"),
			projectPath: path.join(this.#ctx.cwd, ".omp", "mcp.json"),
		};
	}

	#subscribeMcpStatus(eventBus: EventBus): () => void {
		return eventBus.on("mcp:connection-status", data => {
			if (!isMcpConnectionStatusEvent(data)) return;
			const event: McpConnectionStatusEvent = data;
			if (event.type === "connected") {
				this.#statusCache.set(event.serverName, { status: "connected" });
			} else if (event.type === "failed") {
				this.#statusCache.set(event.serverName, {
					status: "failed",
					failureClass: "unknown",
					error: event.error,
				});
			} else if (event.type === "reconnecting") {
				this.#statusCache.set(event.serverName, { status: "reconnecting" });
			}
		});
	}

	async #listMcpServers(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { userPath, projectPath } = this.#mcpPaths();
		const disabled = await readDisabledServers(userPath).catch(() => [] as string[]);
		const servers = [];
		for (const [scope, filePath] of [
			["project", projectPath],
			["user", userPath],
		] as const) {
			const names = await listMCPServers(filePath).catch(() => []);
			for (const name of names) {
				const config = await getMCPServer(filePath, name).catch(() => undefined);
				const cached = this.#statusCache.get(name);
				servers.push({
					name,
					scope,
					...(config ? { config } : {}),
					disabled: disabled.includes(name),
					connection: cached?.status ?? "unknown",
					...(cached?.error ? { error: cached.error } : {}),
				});
			}
		}
		return this.host.context.success(command.id, "list_mcp_servers", { servers });
	}

	async #upsertMcpServer(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { name, config, scope } = command as { name?: unknown; config?: unknown; scope?: unknown };
		if (typeof name !== "string" || !name || !isRecord(config)) {
			return this.host.context.error(command.id, "upsert_mcp_server", "name and config are required");
		}
		if (scope !== "user" && scope !== "project") {
			return this.host.context.error(command.id, "upsert_mcp_server", `Invalid scope: ${String(scope)}`);
		}
		const { userPath, projectPath } = this.#mcpPaths();
		const filePath = scope === "user" ? userPath : projectPath;
		const existing = await getMCPServer(filePath, name).catch(() => undefined);
		try {
			if (existing) {
				await updateMCPServer(filePath, name, config as unknown as MCPServerConfig);
			} else {
				await addMCPServer(filePath, name, config as unknown as MCPServerConfig);
			}
		} catch (error) {
			return this.host.context.error(command.id, "upsert_mcp_server", errorMessage(error));
		}
		this.emitSettingsChanged(scope);
		return this.host.context.success(command.id, "upsert_mcp_server", {
			name,
			scope,
		});
	}

	async #deleteMcpServer(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { name, scope } = command as { name?: unknown; scope?: unknown };
		if (typeof name !== "string" || !name) {
			return this.host.context.error(command.id, "delete_mcp_server", "name is required");
		}
		if (scope !== "user" && scope !== "project") {
			return this.host.context.error(command.id, "delete_mcp_server", `Invalid scope: ${String(scope)}`);
		}
		const { userPath, projectPath } = this.#mcpPaths();
		const filePath = scope === "user" ? userPath : projectPath;
		try {
			await removeMCPServer(filePath, name);
		} catch (error) {
			return this.host.context.error(command.id, "delete_mcp_server", errorMessage(error));
		}
		this.emitSettingsChanged(scope);
		return this.host.context.success(command.id, "delete_mcp_server", { name });
	}

	async #setMcpServerDisabled(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { name, disabled } = command as { name?: unknown; disabled?: unknown };
		if (typeof name !== "string" || typeof disabled !== "boolean") {
			return this.host.context.error(command.id, "set_mcp_server_disabled", "name and disabled are required");
		}
		try {
			await setServerDisabled(this.#mcpPaths().userPath, name, disabled);
		} catch (error) {
			return this.host.context.error(command.id, "set_mcp_server_disabled", errorMessage(error));
		}
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "set_mcp_server_disabled", { name, disabled });
	}

	async #mcpReconnect(command: RpcForkCommandBase): Promise<RpcResponse> {
		const name = (command as { name?: unknown }).name;
		if (typeof name !== "string" || !name) {
			return this.host.context.error(command.id, "mcp_reconnect", "name is required");
		}
		const { userPath, projectPath } = this.#mcpPaths();
		const configured =
			(await getMCPServer(userPath, name).catch(() => undefined)) ??
			(await getMCPServer(projectPath, name).catch(() => undefined));
		if (!configured) {
			return this.host.context.error(
				command.id,
				"mcp_reconnect",
				`Unknown MCP server: ${name}`,
				"unknown_mcp_server",
			);
		}
		// The session-owned MCPManager is not reachable from the RPC layer, so an
		// immediate reconnect cannot be forced here; connections re-establish on
		// their next use (the manager's own reconnect ladder) or in new sessions.
		this.#statusCache.set(name, { status: "reconnecting" });
		return this.host.context.success(command.id, "mcp_reconnect", {
			name,
			triggered: false,
			detail: "Reconnect deferred: the connection re-establishes on next use or in a new session",
		});
	}

	emitSettingsChanged(scope: "user" | "project"): void {
		this.host.context.emit({ type: "settings_changed", scope });
	}

	async #listSkills(command: RpcForkCommandBase): Promise<RpcResponse> {
		const result = await loadSkills({ cwd: this.#ctx.cwd });
		return this.host.context.success(command.id, "list_skills", {
			skills: result.skills.map(skill => ({
				name: skill.name,
				description: skill.description,
				source: skill.source,
				filePath: skill.filePath,
				...(skill.hide ? { hidden: true } : {}),
			})),
			warnings: result.warnings,
		});
	}

	async #setSkillSourceEnabled(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { source, enabled } = command as { source?: unknown; enabled?: unknown };
		if (typeof source !== "string" || typeof enabled !== "boolean") {
			return this.host.context.error(command.id, "set_skill_source_enabled", "source and enabled are required");
		}
		const [provider, level] = source.split(":", 2);
		const key = SKILL_SOURCE_KEYS[`${provider ?? ""}:${level === "project" ? "project" : "user"}`];
		if (!key) {
			return this.host.context.error(
				command.id,
				"set_skill_source_enabled",
				`Unsupported skill source: ${source} (expected provider:user|project like "claude:user")`,
				"unsupported_source",
			);
		}
		key.set(this.#ctx.settings, enabled);
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "set_skill_source_enabled", { source, enabled });
	}

	async #setSkillIgnored(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { name, ignored } = command as { name?: unknown; ignored?: unknown };
		if (typeof name !== "string" || typeof ignored !== "boolean") {
			return this.host.context.error(command.id, "set_skill_ignored", "name and ignored are required");
		}
		cfgSkillsIgnoredSkills.setMember(this.#ctx.settings, name, { member: ignored });
		this.emitSettingsChanged("user");
		return this.host.context.success(command.id, "set_skill_ignored", { name, ignored });
	}

	async #listAgentDefinitions(command: RpcForkCommandBase): Promise<RpcResponse> {
		const result = await discoverAgents(this.#ctx.cwd);
		return this.host.context.success(command.id, "list_agent_definitions", {
			agents: result.agents.map(agent => ({
				name: agent.name,
				description: agent.description,
				source: agent.source,
				...(agent.filePath ? { filePath: agent.filePath } : {}),
				...(agent.tools ? { tools: agent.tools } : {}),
				...(agent.model ? { model: agent.model } : {}),
			})),
			projectAgentsDir: result.projectAgentsDir,
		});
	}

	async #upsertAgentDefinition(command: RpcForkCommandBase): Promise<RpcResponse> {
		const definition = (command as { definition?: unknown }).definition;
		if (!isRecord(definition) || typeof definition.name !== "string" || typeof definition.description !== "string") {
			return this.host.context.error(
				command.id,
				"upsert_agent_definition",
				'definition must include at least "name" and "description"',
			);
		}
		// The name doubles as the definition file name, so it must not traverse
		// out of the agents directory.
		if (!AGENT_NAME_PATTERN.test(definition.name)) {
			return this.host.context.error(
				command.id,
				"upsert_agent_definition",
				"definition.name must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/",
			);
		}
		if (definition.tools !== undefined) {
			if (!Array.isArray(definition.tools) || !definition.tools.every(tool => typeof tool === "string")) {
				return this.host.context.error(
					command.id,
					"upsert_agent_definition",
					"definition.tools must be an array of strings",
				);
			}
		}
		const projectDir = path.join(this.#ctx.cwd, ".omp", "agents");
		await fs.mkdir(projectDir, { recursive: true });
		// Frontmatter values are emitted as JSON double-quoted scalars: legal YAML
		// that cannot break out of the document regardless of description content.
		const tools = definition.tools as string[] | undefined;
		const frontmatter: string[] = [
			`name: ${JSON.stringify(definition.name)}`,
			`description: ${JSON.stringify(definition.description)}`,
		];
		if (tools && tools.length > 0) {
			frontmatter.push(`tools: [${tools.map(tool => JSON.stringify(tool)).join(", ")}]`);
		}
		if (typeof definition.model === "string") frontmatter.push(`model: ${JSON.stringify(definition.model)}`);
		const body = typeof definition.systemPrompt === "string" ? definition.systemPrompt : definition.description;
		const filePath = path.join(projectDir, `${definition.name}.md`);
		await fs.writeFile(filePath, `---\n${frontmatter.join("\n")}\n---\n\n${body}\n`, "utf-8");
		this.emitSettingsChanged("project");
		return this.host.context.success(command.id, "upsert_agent_definition", { name: definition.name, filePath });
	}

	async #deleteAgentDefinition(command: RpcForkCommandBase): Promise<RpcResponse> {
		const name = (command as { name?: unknown }).name;
		if (typeof name !== "string" || !name) {
			return this.host.context.error(command.id, "delete_agent_definition", "name is required");
		}
		const result = await discoverAgents(this.#ctx.cwd);
		const agent = result.agents.find(candidate => candidate.name === name);
		if (!agent?.filePath || agent.source === "bundled") {
			return this.host.context.error(
				command.id,
				"delete_agent_definition",
				`No deletable definition file for agent: ${name}`,
				"agent_not_deletable",
			);
		}
		await fs.unlink(agent.filePath);
		this.emitSettingsChanged("project");
		return this.host.context.success(command.id, "delete_agent_definition", { name, filePath: agent.filePath });
	}

	async #getUsage(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { provider, days, history } = command as { provider?: unknown; days?: unknown; history?: unknown };
		const authStorage = this.#authStorage();
		const sinceMs = typeof days === "number" && days > 0 ? Date.now() - days * 86_400_000 : undefined;
		if (history === true) {
			const entries = authStorage.usage.history({
				sinceMs,
				provider: typeof provider === "string" ? provider : undefined,
			});
			return this.host.context.success(command.id, "get_usage", { history: entries });
		}
		const reports =
			(await authStorage.usage.reports({
				baseUrlResolver: candidate => this.#ctx.modelRegistry.getProviderBaseUrl(candidate),
			})) ?? [];
		const filtered = typeof provider === "string" ? reports.filter(report => report.provider === provider) : reports;
		const trimmed = filtered.map(({ raw: _raw, ...rest }) => rest);
		return this.host.context.success(command.id, "get_usage", {
			generatedAt: Date.now(),
			reports: trimmed,
		});
	}

	async #getStatsSummary(command: RpcForkCommandBase): Promise<RpcResponse> {
		const range = (command as { range?: unknown }).range;
		const { syncAllSessions, refreshRollups, getDashboardStats } = await import("@oh-my-pi/omp-stats");
		await syncAllSessions();
		await refreshRollups();
		const stats = await getDashboardStats(typeof range === "string" && range ? range : null);
		return this.host.context.success(command.id, "get_stats_summary", { stats });
	}
}

const SKILL_SOURCE_KEYS: Record<string, AnySetting | undefined> = {
	"codex:user": cfgSkillsEnableCodexUser,
	"claude:user": cfgSkillsEnableClaudeUser,
	"claude:project": cfgSkillsEnableClaudeProject,
	"pi:user": cfgSkillsEnablePiUser,
	"pi:project": cfgSkillsEnablePiProject,
	"agents:user": cfgSkillsEnableAgentsUser,
	"agents:project": cfgSkillsEnableAgentsProject,
};
