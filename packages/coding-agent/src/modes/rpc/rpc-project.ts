/**
 * RPC project mode (rpc-ui-protocol.md §4/§13/§14): one OMP process hosting
 * MANY sessions for one project (`omp --mode rpc-ui --rpc-project`, project
 * root fixed by the startup cwd).
 *
 * Transport (framing, negotiation, the stdin loop, the output writer) is
 * shared with the single-session shell in rpc-mode.ts. Everything else is the
 * project layer built here:
 * - a ready frame announcing project identity, process instance id and
 *   capabilities; business commands are gated behind a v3 negotiation;
 * - command routing: project-level commands (session lifecycle, catalogs,
 *   model roles, skills, config) answered with zero sessions loaded;
 *   session-level commands carry `sessionId` (+ `sessionGeneration`) and are
 *   routed — with those fields stripped — to that session's
 *   {@link RpcSessionHost}, so both modes share one command implementation;
 * - every frame leaving a session is stamped with processInstanceId,
 *   sessionId and sessionGeneration; side-channel responses
 *   (extension_ui_response / permission_response / ask_response) are routed
 *   back through an interaction-id → session map;
 * - host tools and URI schemes are registered once on shared bridges and
 *   re-applied to every session (and to sessions created later).
 */
import { getAgentDir, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { ModelRegistry } from "../../config/model-registry";
import type { AuthStorage } from "../../session/auth-storage";
import type { AgentSession } from "../../session/agent-session";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { IrcBus } from "../../irc/bus";
import { RpcHostToolBridge } from "./host-tools";
import { RpcHostUriBridge } from "./host-uris";
import { RpcForkHost } from "./rpc-fork-host";
import { RPC_SUPPORTED_PROTOCOL_VERSIONS, isNegotiableRpcProtocolVersion } from "./rpc-fork-types";
import { RpcForkConfigController, type RpcForkServiceContext } from "./rpc-fork-config";
import { RpcForkManageController } from "./rpc-fork-manage";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { RpcCommandCatalogService } from "./rpc-project-commands";
import { RpcProjectModelRoleService } from "./rpc-project-models";
import {
	RPC_PROJECT_CAPABILITIES,
	type RpcProjectCommandDescriptor,
	type RpcProjectCompletionResult,
	type RpcProjectErrorCode,
	type RpcProjectSessionSummary,
	type RpcRevision,
} from "./rpc-project-types";
import {
	RpcProjectSessionContainer,
	type RpcProjectCreatedSession,
	type RpcProjectSessionRecord,
} from "./rpc-project-sessions";
import { RpcProjectSkillService } from "./rpc-project-skills";
import { RpcProjectSubagentDirectory } from "./rpc-project-subagents";
import { RpcOutputWriter } from "./rpc-output";
import { normalizeHostToolDefinitions, RpcSessionHost, RpcUserInputGate, type RpcOutput } from "./rpc-session-host";
import type { RpcCommand, RpcResponse } from "./rpc-types";

/** Options for {@link runRpcProjectMode}. */
export interface RpcProjectModeOptions {
	/** Project root: fixed by the startup cwd; never changes per process. */
	readonly cwd: string;
	/** Directory where this project's session JSONL files live. */
	readonly sessionDir: string;
	/** Process-wide settings instance (all layers merged). */
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly authStorage?: AuthStorage;
	/** Factory creating one fresh AgentSession wired to this project. */
	readonly createSession: () => Promise<RpcProjectCreatedSession>;
	readonly headless?: boolean;
	readonly input?: ReadableStream<Uint8Array>;
}

/** Project-level commands answered without a session (rpc-ui-protocol.md §14.9). */
const PROJECT_LEVEL_COMMANDS = new Set<string>([
	"negotiate_protocol",
	"create_session",
	"list_sessions",
	"resume_session",
	"close_session",
	"rename_session",
	"delete_session",
	"get_available_commands",
	"complete_command",
	"execute_command",
	"list_skills",
	"set_skill_enabled",
	"copy_skill",
	"delete_skill",
	"reload_skills",
	"set_skill_source_enabled",
	"set_skill_ignored",
	"get_model_roles",
	"set_model_role",
	"get_settings",
	"set_settings",
	"unset_settings",
	"list_providers",
	"upsert_provider",
	"delete_provider",
	"set_model_enabled",
	"test_model",
	"list_mcp_servers",
	"upsert_mcp_server",
	"delete_mcp_server",
	"set_mcp_server_disabled",
	"mcp_reconnect",
	"list_agent_definitions",
	"upsert_agent_definition",
	"delete_agent_definition",
	"get_usage",
	"get_stats_summary",
	"get_available_models",
	"set_host_tools",
	"set_host_uri_schemes",
	"get_subagents",
	"get_subagent_messages",
	"control_subagent",
]);

/** Commands routed to a session host; must carry `sessionId` in project mode. */
const SESSION_LEVEL_COMMANDS = new Set<string>([
	"prompt",
	"steer",
	"follow_up",
	"remove_queued_message",
	"abort",
	"abort_and_prompt",
	"new_session",
	"switch_session",
	"open_session",
	"branch",
	"fork",
	"get_state",
	"set_fast_mode",
	"get_entries",
	"get_tree",
	"set_todos",
	"set_subagent_subscription",
	"set_event_filter",
	"set_model",
	"cycle_model",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_cache_warming",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"goal",
	"btw",
	"btw_cancel",
	"get_btw_history",
	"handoff",
	"get_messages",
	"get_messages_page",
	"get_login_providers",
	"login",
	// Fork (v3) commands that operate on the caller's session.
	"set_approval_mode",
	"get_queue",
	"remove_queued",
	"reorder_queue",
	"clear_queue",
	"get_jobs",
	"cancel_job",
	"search_paths",
	"submit_feedback",
	"read_plan",
	"set_plan_mode",
	"get_plan_state",
	"list_plans",
	"approve_plan",
]);

/** Side-channel frames whose id routes back to the issuing session. */
const INTERACTION_REQUEST_TYPES = new Set(["extension_ui_request", "permission_request", "ask_request"]);
const INTERACTION_RESPONSE_TYPES = new Set([
	"extension_ui_response",
	"permission_response",
	"ask_response",
	"ask_pause",
]);

/** Project host wiring shared by the transport and every session. */
class RpcProjectHost {
	readonly #options: RpcProjectModeOptions;
	readonly #output: RpcOutput;
	readonly #processInstanceId: string;
	readonly #container: RpcProjectSessionContainer;
	readonly #catalogService: RpcCommandCatalogService;
	readonly #skillsService: RpcProjectSkillService;
	readonly #rolesService: RpcProjectModelRoleService;
	readonly #subagentDirectory: RpcProjectSubagentDirectory;
	readonly #hostToolBridge: RpcHostToolBridge;
	readonly #hostUriBridge: RpcHostUriBridge;
	readonly #configForkHost: RpcForkHost;
	/** interaction/permission/ask request id → owning sessionId. */
	readonly #interactions = new Map<string, string>();
	/** Host tool definitions to re-apply to sessions created later. */
	#pendingHostTools: unknown[] | undefined;
	/** Shared user-input ordering gate (upstream PR #13027): accept at frame
	 * arrival, ordered arms run inside each session host. */
	readonly inputGate = new RpcUserInputGate();
	#negotiatedV3 = false;
	#disposed = false;

	constructor(options: RpcProjectModeOptions, output: RpcOutput) {
		this.#options = options;
		this.#output = output;
		this.#processInstanceId = `omp-${Date.now().toString(36)}-${process.pid.toString(36)}`;
		this.#container = new RpcProjectSessionContainer({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			createSession: options.createSession,
			onChanged: revision => this.#emitProjectFrame({ type: "sessions_changed", revision }),
		});
		this.#catalogService = new RpcCommandCatalogService({
			cwd: options.cwd,
			getSettings: () => options.settings,
		});
		this.#skillsService = new RpcProjectSkillService({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			getSettings: () => options.settings,
			refreshSessions: () => this.#refreshSessionsSkills(),
			emit: frame => this.#emitProjectFrame(frame),
		});
		this.#rolesService = new RpcProjectModelRoleService({
			getSettings: () => options.settings,
			getModelRegistry: () => options.modelRegistry,
			emit: frame => this.#emitProjectFrame(frame),
		});
		this.#subagentDirectory = new RpcProjectSubagentDirectory({
			resolveSessionFile: sessionId => this.#resolveSessionFile(sessionId),
			liveSnapshots: sessionId => {
				const registry = this.#sessionHosts.get(sessionId)?.subagentRegistry;
				return registry ? registry.getSubagents() : [];
			},
			sendIrcMessage: async message => IrcBus.global().send(message),
			projectSessionDir: options.sessionDir,
		});
		this.#hostToolBridge = new RpcHostToolBridge(frame => output(frame));
		this.#hostUriBridge = new RpcHostUriBridge(frame => output(frame));
		// Project-level fork host answering config/manage commands at zero
		// sessions. Its context carries a service projection, never a real
		// AgentSession: nothing registered here touches context.session.
		const serviceContext: RpcForkServiceContext = {
			settings: options.settings,
			modelRegistry: options.modelRegistry,
			authStorage: options.authStorage,
			cwd: options.cwd,
			agentDir: getAgentDir(),
		};
		this.#configForkHost = new RpcForkHost({
			session: undefined as unknown as AgentSession,
			emit: frame => this.#emitProjectFrame(frame),
			success: (id, command, data) => this.#successResponse(id, command, data),
			error: (id, command, message, code) => this.#errorResponse(id, command, message, code),
		});
		new RpcForkConfigController(this.#configForkHost, serviceContext);
		new RpcForkManageController(this.#configForkHost, serviceContext, undefined, { agentDir: getAgentDir() });
		this.#configForkHost.activate();
	}

	get processInstanceId(): string {
		return this.#processInstanceId;
	}

	get container(): RpcProjectSessionContainer {
		return this.#container;
	}

	get negotiatedV3(): boolean {
		return this.#negotiatedV3;
	}

	activateV3(): void {
		this.#negotiatedV3 = true;
		for (const [, sessionHost] of this.#sessionHosts) sessionHost.forkHost.activate();
	}

	/** Emit a project-level frame (no session stamp). */
	#emitProjectFrame(frame: object): void {
		if (this.#disposed) return;
		this.#output({ ...(frame as Record<string, unknown>), processInstanceId: this.#processInstanceId });
	}

	/** Build + start the per-session host, wiring project stamps and shared bridges. */
	async #attachSessionHost(record: RpcProjectSessionRecord, created: RpcProjectCreatedSession): Promise<void> {
		const sessionOutput: RpcOutput = frame => {
			if (isRecord(frame)) {
				if (INTERACTION_REQUEST_TYPES.has(String(frame.type)) && typeof frame.id === "string" && frame.id) {
					this.#interactions.set(frame.id, record.sessionId);
				}
				this.#output({
					...frame,
					processInstanceId: this.#processInstanceId,
					sessionId: record.sessionId,
					sessionGeneration: record.sessionGeneration,
				});
				return;
			}
			this.#output(frame);
		};
		const sessionHost = new RpcSessionHost({
			session: record.session,
			output: sessionOutput,
			subagentEventBus: created.subagentEventBus,
			headless: this.#options.headless,
			setToolUIContext: created.setToolUIContext as (uiContext: ExtensionUIContext, hasUI: boolean) => void,
			projectMode: true,
			sharedBridges: { hostToolBridge: this.#hostToolBridge, hostUriBridge: this.#hostUriBridge },
			inputGate: this.inputGate,
		});
		if (this.#negotiatedV3) sessionHost.forkHost.activate();
		await sessionHost.initializeExtensions();
		await sessionHost.start();
		if (this.#pendingHostTools) {
			try {
				const tools = normalizeHostToolDefinitions(this.#pendingHostTools as never);
				const rpcTools = this.#hostToolBridge.setTools(tools);
				await record.session.refreshRpcHostTools(rpcTools);
			} catch (error) {
				console.error(`[rpc-project] failed to apply host tools to session ${record.sessionId}:`, error);
			}
		}
		created.setHost({
			get isStreaming() {
				return record.session.isStreaming;
			},
			hasPendingAsyncWork: () => record.session.hasPendingAsyncWork(),
			isWaitingInteraction: () => sessionHost.isWaitingInteraction(),
			dispose: reason => sessionHost.dispose(reason),
		});
		this.#sessionHosts.set(record.sessionId, sessionHost);
	}

	readonly #sessionHosts = new Map<string, RpcSessionHost>();
	readonly #pendingSkillRefresh = new Set<string>();
	/** In-flight host attachments keyed by session id (concurrent create/resume coalescing). */
	readonly #attaching = new Map<string, Promise<void>>();
	/** sessionId → session file for not-loaded sessions (populated lazily by #prefetchSessionFile). */
	readonly #sessionFileCache = new Map<string, string>();

	/** Attach the session host exactly once per session id. */
	async #ensureAttached(record: RpcProjectSessionRecord, created?: RpcProjectCreatedSession): Promise<void> {
		if (this.#sessionHosts.has(record.sessionId)) return;
		const pending = this.#attaching.get(record.sessionId);
		if (pending) return pending;
		if (!created) return;
		const task = this.#attachSessionHost(record, created).finally(() => {
			this.#attaching.delete(record.sessionId);
		});
		this.#attaching.set(record.sessionId, task);
		await task;
	}

	/** Resolve (and cache) a session's main file, loaded or saved; false when unknown. */
	async #prefetchSessionFile(sessionId: string): Promise<boolean> {
		const loaded = this.#container.get(sessionId);
		if (loaded) return true;
		if (this.#sessionFileCache.has(sessionId)) return true;
		const file = await this.#container.findSessionFileById(sessionId);
		if (!file) return false;
		this.#sessionFileCache.set(sessionId, file);
		return true;
	}

	#getSessionHost(sessionId: string): RpcSessionHost | undefined {
		return this.#sessionHosts.get(sessionId);
	}

	/** Create a session end-to-end: container record + attached host. */
	async createSession(options: { name?: string; model?: { provider: string; modelId: string } }): Promise<{
		record: RpcProjectSessionRecord;
		summary: RpcProjectSessionSummary;
	}> {
		const created = await this.#options.createSession();
		let record: RpcProjectSessionRecord;
		try {
			record = await this.#container.adoptCreated(created, options);
		} catch (error) {
			await created.session.dispose().catch(() => {});
			throw error;
		}
		if (options.model) {
			// Temporary per-session model choice: never persisted (R6).
			try {
				const models = record.session.getAvailableModels();
				const match = models.find(
					model => model.provider === options.model?.provider && model.id === options.model?.modelId,
				);
				if (match) await record.session.setModelTemporary(match);
			} catch {
				// Invalid model for this session: creation still succeeds; the
				// first prompt will surface the model error honestly.
			}
		}
		await this.#ensureAttached(record, created);
		const summary = this.#container.buildSummary(record);
		return { record, summary };
	}

	/** Resume (or return the already-loaded instance of) a persisted session. */
	async resumeSession(
		sessionId: string,
	): Promise<{ record: RpcProjectSessionRecord; summary: RpcProjectSessionSummary }> {
		const existing = this.#container.get(sessionId);
		if (existing && this.#sessionHosts.has(sessionId)) {
			return { record: existing, summary: this.#container.buildSummary(existing) };
		}
		const { record, created } = await this.#container.resumeWithFactory(sessionId, () =>
			this.#options.createSession(),
		);
		await this.#ensureAttached(record, created);
		return { record, summary: this.#container.buildSummary(record) };
	}

	/** Route a session-level command: strip project fields, check generation, delegate. */
	async handleSessionCommand(
		command: RpcCommand & { sessionId?: string; sessionGeneration?: string },
	): Promise<RpcResponse> {
		if (["new_session", "switch_session", "open_session", "branch", "fork"].includes(command.type)) {
			return this.#errorResponse(
				command.id,
				command.type,
				"Use project session lifecycle commands; replacing a loaded session is unsupported",
				"unsupported",
			);
		}
		const sessionId = command.sessionId;
		if (typeof sessionId !== "string" || !sessionId) {
			return this.#errorResponse(
				command.id,
				command.type,
				"This command requires a sessionId in project mode",
				"invalid_params",
			);
		}
		const record = this.#container.get(sessionId);
		if (!record) {
			return this.#errorResponse(command.id, command.type, `Unknown session: ${sessionId}`, "not_found");
		}
		const host = this.#getSessionHost(sessionId);
		if (!host) {
			return this.#errorResponse(command.id, command.type, `Session not loaded: ${sessionId}`, "session_not_loaded");
		}
		if (record.state !== "loaded") {
			return this.#errorResponse(command.id, command.type, `Session is ${record.state}: ${sessionId}`, "busy");
		}
		if (command.sessionGeneration !== undefined && command.sessionGeneration !== record.sessionGeneration) {
			return this.#errorResponse(
				command.id,
				command.type,
				`Session generation mismatch for ${sessionId}: the instance was reloaded`,
				"stale_session",
			);
		}
		if (command.type === "prompt" && !host.session.isStreaming && this.#pendingSkillRefresh.has(sessionId)) {
			await host.refreshSkills();
			this.#pendingSkillRefresh.delete(sessionId);
		}
		// The frame object is passed through as-is (routing fields included):
		// RpcUserInputGate keys acceptance on object identity, so a rebuilt
		// "stock" copy would never match and every ordered user input would
		// be cancelled as stale. The session host ignores the extra fields.
		return host.handleCommand(command as RpcCommand);
	}

	/** Answer a project-level command. Zero-session-safe unless stated otherwise. */
	async handleProjectCommand(command: Record<string, unknown>): Promise<RpcResponse> {
		const type = String(command.type);
		const id = typeof command.id === "string" ? command.id : undefined;
		const record = async (): Promise<RpcSessionHost | undefined> => {
			const sessionId = command.sessionId;
			if (typeof sessionId !== "string") return undefined;
			return this.#getSessionHost(sessionId);
		};
		switch (type) {
			case "negotiate_protocol": {
				const version = command.protocolVersion;
				if (typeof version !== "number" || !isNegotiableRpcProtocolVersion(version)) {
					return this.#errorResponse(id, type, `Unsupported RPC protocol version: ${String(version)}`);
				}
				if (version === 3) this.activateV3();
				return this.#successResponse(id, type, { protocolVersion: version });
			}
			case "create_session": {
				this.#requireV3(id, type);
				const { summary } = await this.createSession({
					name: typeof command.name === "string" ? command.name : undefined,
					model:
						isRecord(command.model) &&
						typeof command.model.provider === "string" &&
						typeof command.model.modelId === "string"
							? { provider: command.model.provider, modelId: command.model.modelId }
							: undefined,
				});
				return this.#successResponse(id, type, summary);
			}
			case "list_sessions": {
				this.#requireV3(id, type);
				const page = await this.#container.list({
					cursor: typeof command.cursor === "number" ? command.cursor : undefined,
					limit: typeof command.limit === "number" ? command.limit : undefined,
					loadState:
						command.loadState === "loaded" || command.loadState === "not_loaded" ? command.loadState : undefined,
				});
				return this.#successResponse(id, type, page);
			}
			case "resume_session": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				if (typeof sessionId !== "string" || !sessionId)
					return this.#errorResponse(id, type, "resume_session requires sessionId", "invalid_params");
				const { summary } = await this.resumeSession(sessionId);
				return this.#successResponse(id, type, summary);
			}
			case "close_session": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				if (typeof sessionId !== "string")
					return this.#errorResponse(id, type, "close_session requires sessionId", "invalid_params");
				const result = await this.#closeSession(sessionId, command.cancelRunning === true);
				return this.#successResponse(id, type, { sessionId, state: result.state, revision: result.revision });
			}
			case "rename_session": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				const name = command.name;
				if (typeof sessionId !== "string")
					return this.#errorResponse(id, type, "rename_session requires sessionId", "invalid_params");
				if (typeof name !== "string")
					return this.#errorResponse(id, type, "rename_session requires name", "invalid_params");
				const { summary } = await this.#container.rename(
					sessionId,
					name,
					typeof command.expectedRevision === "string" ? command.expectedRevision : undefined,
				);
				return this.#successResponse(id, type, summary);
			}
			case "delete_session": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				if (typeof sessionId !== "string")
					return this.#errorResponse(id, type, "delete_session requires sessionId", "invalid_params");
				const result = await this.#deleteSession(
					sessionId,
					command.cancelRunning === true,
					typeof command.expectedRevision === "string" ? command.expectedRevision : undefined,
				);
				return this.#successResponse(id, type, { sessionId, deleted: true, revision: result.revision });
			}
			case "get_available_commands": {
				this.#requireV3(id, type);
				const sessionHost = await record();
				const commands = await this.#catalogService.buildCatalog(sessionHost?.session);
				const revision = this.#catalogService.revision;
				const descriptors: RpcProjectCommandDescriptor[] = commands;
				return this.#successResponse(id, type, { commands: descriptors, revision });
			}
			case "complete_command": {
				this.#requireV3(id, type);
				const text = command.text;
				const cursor = command.cursor;
				if (typeof text !== "string")
					return this.#errorResponse(id, type, "complete_command requires text", "invalid_params");
				if (typeof cursor !== "number")
					return this.#errorResponse(id, type, "complete_command requires cursor", "invalid_params");
				const sessionHost = await record();
				const result: RpcProjectCompletionResult = await this.#catalogService.complete({
					text,
					cursor,
					sessionLike: sessionHost?.session,
				});
				return this.#successResponse(id, type, result);
			}
			case "execute_command": {
				this.#requireV3(id, type);
				return this.#executeCommand(command, id, type);
			}
			case "list_skills": {
				this.#requireV3(id, type);
				const sessionHost = await record();
				const result = await this.#skillsService.list({
					view: command.view === "effective" ? "effective" : "management",
					sessionSkills: sessionHost?.session.skills,
					cursor: typeof command.cursor === "number" ? command.cursor : undefined,
					limit: typeof command.limit === "number" ? command.limit : undefined,
				});
				return this.#successResponse(id, type, result);
			}
			case "set_skill_enabled": {
				this.#requireV3(id, type);
				const result = await this.#skillsService.setEnabled(
					this.#skillMutationInput(command, ["skillId", "enabled", "scope", "expectedRevision"]) as never,
				);
				return this.#successResponse(id, type, result);
			}
			case "copy_skill": {
				this.#requireV3(id, type);
				const result = await this.#skillsService.copy(
					this.#skillMutationInput(command, ["skillId", "targetScope", "targetName", "expectedRevision"]) as never,
				);
				return this.#successResponse(id, type, result);
			}
			case "delete_skill": {
				this.#requireV3(id, type);
				const result = await this.#skillsService.delete(
					this.#skillMutationInput(command, ["skillId", "expectedRevision"]) as never,
				);
				return this.#successResponse(id, type, result);
			}
			case "reload_skills": {
				this.#requireV3(id, type);
				const result = await this.#skillsService.reload(command.scope === "project" ? "project" : "user");
				this.#catalogService.invalidate();
				this.#emitProjectFrame({ type: "command_catalog_changed", revision: this.#catalogService.revision });
				return this.#successResponse(id, type, result);
			}
			case "set_skill_source_enabled":
			case "set_skill_ignored": {
				this.#requireV3(id, type);
				const response = await this.#configForkHost.handleCommand(command as never);
				if (response) {
					this.#catalogService.invalidate();
					return response;
				}
				return this.#errorResponse(id, type, `Unknown command: ${type}`);
			}
			case "get_model_roles": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				let sessionInfo:
					| { sessionId: string; sessionGeneration: string; model?: { provider: string; modelId: string } }
					| undefined;
				if (typeof sessionId === "string") {
					const rec = this.#container.get(sessionId);
					const host = this.#getSessionHost(sessionId);
					if (rec && host) {
						const model = host.session.model;
						sessionInfo = {
							sessionId,
							sessionGeneration: rec.sessionGeneration,
							model: model ? { provider: model.provider, modelId: model.id } : undefined,
						};
					}
				}
				const result = await this.#rolesService.listRoles({ sessionInfo });
				return this.#successResponse(id, type, result);
			}
			case "set_model_role": {
				this.#requireV3(id, type);
				const selectionRaw = command.selection;
				type RoleSelection =
					| { kind: "auto" }
					| { kind: "model"; model: { provider: string; modelId: string; thinkingLevel?: string } }
					| null;
				let selection: RoleSelection | undefined;
				if (selectionRaw === null) selection = null;
				else if (isRecord(selectionRaw)) {
					if (selectionRaw.kind === "auto") selection = { kind: "auto" };
					else if (
						selectionRaw.kind === "model" &&
						isRecord(selectionRaw.model) &&
						typeof selectionRaw.model.provider === "string" &&
						typeof selectionRaw.model.modelId === "string"
					) {
						selection = {
							kind: "model",
							model: {
								provider: selectionRaw.model.provider,
								modelId: selectionRaw.model.modelId,
								...(typeof selectionRaw.model.thinkingLevel === "string"
									? { thinkingLevel: selectionRaw.model.thinkingLevel }
									: {}),
							},
						};
					}
				}
				if (selection === undefined) {
					return this.#errorResponse(id, type, "set_model_role requires a valid selection", "invalid_params");
				}
				if (command.scope !== "user") {
					return this.#errorResponse(id, type, 'Model roles require scope "user"', "scope_not_allowed");
				}
				const result = await this.#rolesService.setRole({
					roleId: String(command.roleId ?? ""),
					scope: "user",
					selection,
					expectedRevision: typeof command.expectedRevision === "string" ? command.expectedRevision : undefined,
				});
				return this.#successResponse(id, type, result);
			}
			case "get_available_models": {
				this.#requireV3(id, type);
				// With a session: delegate for the session's filtered list.
				const sessionHost = await record();
				if (sessionHost) {
					// Identity-preserving delegation (see handleSessionCommand).
					return sessionHost.handleCommand(command as RpcCommand);
				}
				await this.#options.modelRegistry.awaitBackgroundRefresh();
				return this.#successResponse(id, type, { models: this.#options.modelRegistry.getAvailable() });
			}
			case "set_host_tools": {
				this.#requireV3(id, type);
				const tools = Array.isArray(command.tools) ? command.tools : [];
				const normalized = normalizeHostToolDefinitions(tools as never);
				this.#pendingHostTools = tools;
				const rpcTools = this.#hostToolBridge.setTools(normalized);
				for (const [sessionId, host] of this.#sessionHosts) {
					try {
						await host.session.refreshRpcHostTools(rpcTools);
					} catch (error) {
						console.error(`[rpc-project] failed to apply host tools to session ${sessionId}:`, error);
					}
				}
				return this.#successResponse(id, type, { toolNames: normalized.map(tool => tool.name) });
			}
			case "set_host_uri_schemes": {
				this.#requireV3(id, type);
				const schemes = Array.isArray(command.schemes) ? command.schemes : [];
				this.#hostUriBridge.setSchemes(schemes as never);
				return this.#successResponse(id, type, {
					schemes: schemes.map(scheme => (isRecord(scheme) ? String(scheme.scheme) : String(scheme))),
				});
			}
			case "get_subagents": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				if (typeof sessionId !== "string")
					return this.#errorResponse(
						id,
						type,
						"get_subagents requires sessionId in project mode",
						"invalid_params",
					);
				if (!(await this.#prefetchSessionFile(sessionId))) {
					return this.#errorResponse(id, type, `Unknown session: ${sessionId}`, "not_found");
				}
				const result = await this.#subagentDirectory.list(sessionId, {
					status: command.status === "running" || command.status === "finished" ? command.status : undefined,
					cursor: command.cursor as number | string | undefined,
					limit: typeof command.limit === "number" ? command.limit : undefined,
				});
				return this.#successResponse(id, type, result);
			}
			case "get_subagent_messages": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				const subagentId = command.subagentId;
				if (typeof sessionId !== "string" || typeof subagentId !== "string") {
					return this.#errorResponse(
						id,
						type,
						"get_subagent_messages requires sessionId and subagentId",
						"invalid_params",
					);
				}
				if (!(await this.#prefetchSessionFile(sessionId))) {
					return this.#errorResponse(id, type, `Unknown session: ${sessionId}`, "not_found");
				}
				const result = await this.#subagentDirectory.messages(sessionId, subagentId, {
					fromByte: typeof command.fromByte === "number" ? command.fromByte : undefined,
					maxBytes: typeof command.maxBytes === "number" ? command.maxBytes : undefined,
				});
				return this.#successResponse(id, type, result);
			}
			case "control_subagent": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				const subagentId = command.subagentId;
				const action = command.action;
				if (typeof sessionId !== "string" || typeof subagentId !== "string") {
					return this.#errorResponse(
						id,
						type,
						"control_subagent requires sessionId and subagentId",
						"invalid_params",
					);
				}
				if (action !== "send_message" && action !== "stop") {
					return this.#errorResponse(id, type, `Unsupported control action: ${String(action)}`, "invalid_params");
				}
				const rec = this.#container.get(sessionId);
				if (
					rec &&
					typeof command.sessionGeneration === "string" &&
					command.sessionGeneration !== rec.sessionGeneration
				) {
					return this.#errorResponse(id, type, "Session generation mismatch", "stale_session");
				}
				if (!(await this.#prefetchSessionFile(sessionId))) {
					return this.#errorResponse(id, type, `Unknown session: ${sessionId}`, "not_found");
				}
				const result = await this.#subagentDirectory.control(
					sessionId,
					subagentId,
					action,
					typeof command.message === "string" ? command.message : undefined,
				);
				return this.#successResponse(id, type, result);
			}
			default: {
				// Config/manage fork surface (settings, providers, MCP, agent
				// definitions, usage, stats) answered by the project-level
				// controllers with zero sessions.
				const forkResponse = await this.#configForkHost.handleCommand(command as never);
				if (forkResponse) return forkResponse;
				return this.#errorResponse(id, type, `Unknown command: ${type}`);
			}
		}
	}

	#skillMutationInput(command: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
		const input: Record<string, unknown> = {};
		for (const key of keys) if (key in command) input[key] = command[key];
		return input;
	}

	/**
	 * `execute_command`: strict dispatch — unknown commands never reach the
	 * model; builtin/skill commands reuse the session host's prompt pipeline
	 * with inputMode "auto" (one shared implementation for both entries).
	 */
	async #executeCommand(command: Record<string, unknown>, id: string | undefined, type: string): Promise<RpcResponse> {
		const text = command.text;
		if (typeof text !== "string" || !text.trim()) {
			return this.#errorResponse(id, type, "execute_command requires non-empty text", "invalid_params");
		}
		const sessionId = command.sessionId;
		const host = typeof sessionId === "string" ? this.#getSessionHost(sessionId) : undefined;
		if (!host) {
			return this.#errorResponse(
				id,
				type,
				"execute_command requires the sessionId of a loaded session",
				"invalid_params",
			);
		}
		const resolution = await this.#catalogService.resolve(text, host.session);
		if (resolution.kind === "unknown") {
			return this.#errorResponse(id, type, `Unknown command: ${text.trim().split(/\s+/)[0]}`, "invalid_params");
		}
		// Route through the shared strict-dispatch prompt path; the response is
		// re-labeled for the command the client actually sent. The synthetic
		// prompt is accepted into the input gate here (the execute_command
		// frame itself is not a user-input type), so ordering — and a racing
		// abort invalidating it — applies exactly as for a direct prompt.
		const syntheticPrompt = {
			id,
			type: "prompt",
			sessionId: typeof sessionId === "string" ? sessionId : undefined,
			sessionGeneration: typeof command.sessionGeneration === "string" ? command.sessionGeneration : undefined,
			message: text,
			inputMode: "auto",
		};
		this.inputGate.accept(syntheticPrompt as RpcCommand);
		const promptResponse = await this.handleSessionCommand(syntheticPrompt as never);
		if (isRecord(promptResponse) && promptResponse.command === "prompt") {
			return { ...promptResponse, command: type } as RpcResponse;
		}
		return promptResponse;
	}

	/**
	 * Release one session's host-side bookkeeping after the container tore the
	 * record down: best-effort host dispose, then drop the host, pending skill
	 * refresh, and interaction-routing entries owned by this session.
	 */
	async #teardownSessionHost(sessionId: string, reason: string): Promise<void> {
		const host = this.#getSessionHost(sessionId);
		if (host) await host.dispose(reason).catch(() => {});
		this.#sessionHosts.delete(sessionId);
		this.#pendingSkillRefresh.delete(sessionId);
		for (const [interactionId, owner] of this.#interactions) {
			if (owner === sessionId) this.#interactions.delete(interactionId);
		}
	}

	async #closeSession(
		sessionId: string,
		cancelRunning: boolean,
	): Promise<{ state: "unloaded"; revision: RpcRevision }> {
		const result = await this.#container.close(sessionId, { cancelRunning });
		await this.#teardownSessionHost(sessionId, "session_closed");
		return result;
	}

	async #deleteSession(
		sessionId: string,
		cancelRunning: boolean,
		expectedRevision: string | undefined,
	): Promise<{ revision: RpcRevision }> {
		const result = await this.#container.delete(sessionId, { cancelRunning, expectedRevision });
		await this.#teardownSessionHost(sessionId, "session_deleted");
		return result;
	}

	#resolveSessionFile(sessionId: string): string | undefined {
		const loaded = this.#container.get(sessionId);
		if (loaded?.session.sessionFile) return loaded.session.sessionFile;
		return this.#sessionFileCache.get(sessionId);
	}

	async #refreshSessionsSkills(): Promise<{ adopted: string[]; pending: string[] }> {
		const adopted: string[] = [];
		const pending: string[] = [];
		for (const [sessionId, host] of this.#sessionHosts) {
			if (host.session.isStreaming) {
				this.#pendingSkillRefresh.add(sessionId);
				pending.push(sessionId);
				continue;
			}
			await host.refreshSkills().then(
				() => {
					this.#pendingSkillRefresh.delete(sessionId);
					adopted.push(sessionId);
				},
				() => {
					this.#pendingSkillRefresh.add(sessionId);
					pending.push(sessionId);
				},
			);
		}
		return { adopted, pending };
	}

	/** Route a side-channel frame to the session that issued the request. */
	handleControlFrame(parsed: unknown): boolean {
		if (!isRecord(parsed)) return false;
		const type = String(parsed.type);
		if (type === "host_tool_result") {
			this.#hostToolBridge.handleResult(parsed as never);
			return true;
		}
		if (type === "host_tool_update") {
			this.#hostToolBridge.handleUpdate(parsed as never);
			return true;
		}
		if (type === "host_uri_result") {
			this.#hostUriBridge.handleResult(parsed as never);
			return true;
		}
		if (INTERACTION_RESPONSE_TYPES.has(type)) {
			const targetId =
				typeof parsed.id === "string"
					? parsed.id
					: typeof parsed.targetId === "string"
						? parsed.targetId
						: undefined;
			if (!targetId) return false;
			const sessionId = this.#interactions.get(targetId);
			const host = sessionId ? this.#getSessionHost(sessionId) : undefined;
			if (!host) {
				console.error(`[rpc-project] dropping ${type} for unknown interaction ${targetId}`);
				return true;
			}
			return host.handleControlFrame(parsed);
		}
		return false;
	}

	/** Fail-close everything (stdin EOF / process shutdown). */
	async dispose(reason: string): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#container.disposeAll(reason);
		for (const [, host] of this.#sessionHosts) await host.dispose(reason).catch(() => {});
		this.#sessionHosts.clear();
		this.#pendingSkillRefresh.clear();
		this.#hostToolBridge.close(`${reason} before host tool execution completed`);
		this.#hostUriBridge.clear(`${reason} before host URI request completed`);
		this.#interactions.clear();
	}

	#requireV3(id: string | undefined, type: string): void {
		if (this.#negotiatedV3) return;
		throw new RpcProjectGateError(id, type, "Negotiate protocol version 3 before using project commands");
	}

	#successResponse(id: string | undefined, command: string, data?: object | null): RpcResponse {
		return {
			id,
			type: "response",
			command,
			success: true,
			...(data === undefined ? {} : { data }),
		} as RpcResponse;
	}

	#errorResponse(id: string | undefined, command: string, message: string, code?: string): RpcResponse {
		return {
			id,
			type: "response",
			command,
			success: false,
			error: message,
			...(code === undefined ? {} : { code }),
		} as RpcResponse;
	}
}

/** Thrown by the v3 gate; carries the command identity for the error frame. */
class RpcProjectGateError extends Error {
	constructor(
		readonly id: string | undefined,
		readonly command: string,
		message: string,
	) {
		super(message);
		this.name = "RpcProjectGateError";
	}
}

/**
 * Run in project RPC mode: many sessions of one project in this process.
 * Returns only on process exit (stdin EOF or fatal output failure).
 */
export async function runRpcProjectMode(options: RpcProjectModeOptions): Promise<never> {
	const input = options.input ?? claimRpcInput();
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	const hostRef: { host?: RpcProjectHost } = {};
	const outputWriter = new RpcOutputWriter(process.stdout, failure => {
		logger.error("RPC project output delivery failed", { error: String(failure) });
		void hostRef.host?.dispose("RPC output delivery failed").finally(() => process.exit(1));
	});
	const output: RpcOutput = obj => {
		outputWriter.write(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};

	const host = new RpcProjectHost(options, output);
	hostRef.host = host;

	outputWriter.write(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: RPC_SUPPORTED_PROTOCOL_VERSIONS,
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			mode: "rpc-ui-project",
			projectIdentity: { projectRoot: options.cwd },
			processInstanceId: host.processInstanceId,
			capabilities: RPC_PROJECT_CAPABILITIES,
		}),
	);

	const backgroundTasks = new Set<Promise<void>>();
	// Long-holding commands dispatch in the background so later frames can
	// overtake them (mirrors the single-session transport in rpc-mode.ts): a
	// `bash` runs for a long time, a `prompt`/`steer`/`follow_up`/`steer_subagent`
	// holds its response until admission. Backgrounding lets an `abort` (or
	// get_state) reach the session while such a command is still settling.
	const projectBackgroundedTypes = new Set(["bash", "predict_word", "prompt", "steer", "follow_up", "steer_subagent"]);
	const dispatch = async (parsed: Record<string, unknown>): Promise<void> => {
		const type = String(parsed.type ?? "");
		if (!type) return;
		if (projectBackgroundedTypes.has(type)) {
			// Session-bound background command; route like any session command.
			const task = host
				.handleSessionCommand(parsed as never)
				.catch((error: unknown): RpcResponse => {
					const message = error instanceof Error ? error.message : String(error);
					return errorFrame(parsed.id, type, message);
				})
				.then(output);
			backgroundTasks.add(task);
			void task.then(
				() => backgroundTasks.delete(task),
				() => backgroundTasks.delete(task),
			);
			return;
		}
		let response: RpcResponse;
		try {
			if (PROJECT_LEVEL_COMMANDS.has(type)) {
				response = await host.handleProjectCommand(parsed);
			} else if (SESSION_LEVEL_COMMANDS.has(type)) {
				response = await host.handleSessionCommand(parsed as never);
			} else {
				response = errorFrame(parsed.id, type, `Unknown command: ${type}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = error instanceof RpcProjectGateError ? "unsupported" : projectErrorCodeOf(error);
			response = errorFrame(parsed.id, type, message, code);
		}
		output(response);
	};

	const errorFrame = (id: unknown, command: string, message: string, code?: string): RpcResponse =>
		({
			id: typeof id === "string" ? id : undefined,
			type: "response",
			command,
			success: false,
			error: message,
			...(code === undefined ? {} : { code }),
		}) as RpcResponse;

	// Serial command queue; control frames overtake (they resolve pending
	// interactions that a running command may be waiting on).
	let tail: Promise<void> = Promise.resolve();
	const queueSerial = (parsed: Record<string, unknown>): void => {
		tail = tail.then(
			() => dispatch(parsed),
			() => dispatch(parsed),
		);
	};

	await readRpcInputFrames(
		input,
		parsed => {
			if (host.handleControlFrame(parsed)) return;
			// Sequence user input at frame-arrival time (upstream PR #13027):
			// an abort arriving now invalidates earlier input still queued
			// behind the serial tail or a session host's input gate.
			host.inputGate.accept(parsed as RpcCommand);
			queueSerial(parsed as Record<string, unknown>);
		},
		message => output(errorFrame(undefined, "parse", `Failed to parse command: ${message}`)),
	);

	// stdin closed — the project host is gone. Dispose every session (their
	// disposals flush persistence), then exit cleanly.
	await tail.catch(() => {});
	await host.dispose("RPC client disconnected");
	await Promise.allSettled(backgroundTasks);
	await outputWriter.close();
	process.exit(0);
}

function projectErrorCodeOf(error: unknown): RpcProjectErrorCode | undefined {
	if (isRecord(error) && typeof error.code === "string") {
		const code = error.code;
		const allowed: readonly RpcProjectErrorCode[] = [
			"invalid_params",
			"not_found",
			"session_not_loaded",
			"stale_session",
			"busy",
			"unsupported",
			"scope_not_allowed",
			"revision_conflict",
			"stale_cursor",
			"permission_denied",
			"persistence_failed",
			"execution_failed",
		];
		return (allowed as readonly string[]).includes(code) ? (code as RpcProjectErrorCode) : undefined;
	}
	return undefined;
}
