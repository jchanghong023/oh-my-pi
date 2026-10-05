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
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { getAgentDir, isRecord, logger, normalizePathForComparison, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { ModelRegistry } from "../../config/model-registry";
import { getRoleInfo } from "../../config/model-roles";
import type { AuthStorage } from "../../session/auth-storage";
import type { AgentSession } from "../../session/agent-session";
import type { SessionStats } from "../../session/agent-session-types";
import { getLatestCompactionEntry } from "../../session/session-context";
import type { MCPManager } from "../../mcp";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { IrcBus } from "../../irc/bus";
import { resolveToCwd } from "../../tools/path-utils";
import { SessionManager } from "../../session/session-manager";
import { selectRpcEntries } from "./rpc-compat";
import { pageRpcMessages } from "./rpc-messages";
import { RpcForkHost } from "./rpc-fork-host";
import { RpcForkConfigController, type RpcForkServiceContext } from "./rpc-fork-config";
import { RpcForkManageController } from "./rpc-fork-manage";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { RPC_PROJECT_HOST_ACTIONS, RpcCommandCatalogService } from "./rpc-project-commands";
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
	readonly createSession: (sessionManager?: SessionManager) => Promise<RpcProjectCreatedSession>;
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

/** Read-only historical operations do not require or implicitly create a loaded session. */
const SESSION_HISTORY_COMMANDS = new Set([
	"get_messages",
	"get_messages_page",
	"get_entries",
	"get_tree",
	"get_branch_messages",
	"get_last_assistant_text",
	"get_session_stats",
]);

/** Commands routed to a session host; must carry `sessionId` in project mode. */
const SESSION_LEVEL_COMMANDS = new Set<string>([
	"prompt",
	"steer",
	"follow_up",
	"remove_queued_message",
	"promote_queued_message",
	"predict_word_feedback",
	"predict_word",
	"set_ask_dialog",
	"cancel_subagent",
	"steer_subagent",
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
	"live_start",
	"live_stop",
	"live_mute",
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
const INTERACTION_REQUEST_TYPES = new Set([
	"extension_ui_request",
	"permission_request",
	"ask_request",
	"host_tool_call",
	"host_uri_request",
]);
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
	#pendingHostUriSchemes: unknown[] | undefined;
	readonly #configForkHost: RpcForkHost;
	/** Interaction identity → exact owning instance; never a global current session. */
	readonly #interactions = new Map<string, { sessionId: string; sessionGeneration: string }>();
	/** Host tool definitions to re-apply to sessions created later. */
	#pendingHostTools: unknown[] | undefined;
	/** Input ordering and cancellation belong to one loaded session instance. */
	readonly #inputGates = new Map<string, RpcUserInputGate>();
	readonly #commandInputs = new WeakMap<object, RpcCommand & { sessionId?: string; sessionGeneration?: string }>();
	readonly #mcpManagers = new Map<string, MCPManager>();
	readonly #metadataUnsubscribers = new Map<string, () => void>();
	readonly #staleSessions = new Set<string>();
	#negotiatedV3 = false;
	#disposed = false;

	constructor(options: RpcProjectModeOptions, output: RpcOutput) {
		this.#options = options;
		this.#output = output;
		this.#processInstanceId = `omp-${randomUUID()}`;
		this.#container = new RpcProjectSessionContainer({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			createSession: options.createSession,
			onChanged: revision => this.#emitProjectFrame({ type: "sessions_changed", revision }),
		});
		this.#catalogService = new RpcCommandCatalogService({
			cwd: options.cwd,
			getSettings: () => options.settings,
			getMcpManager: session => this.#mcpManagers.get((session as AgentSession).sessionId),
		});
		this.#skillsService = new RpcProjectSkillService({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			getSettings: () => options.settings,
			refreshSessions: () => this.#refreshSessionsSkills(),
			isSkillInUse: filePath =>
				[...this.#sessionHosts.values()].some(
					host =>
						(host.session.isBusyForSnapshot ||
							host.session.hasAdmittedSubmission ||
							host.isWaitingInteraction()) &&
						host.session.skills.some(
							skill => normalizePathForComparison(skill.filePath) === normalizePathForComparison(filePath),
						),
				),
			emit: frame => {
				this.#emitProjectFrame(frame);
				this.#catalogService.invalidate();
				this.#emitProjectFrame({ type: "command_catalog_changed", revision: this.#catalogService.revision });
			},
		});
		this.#rolesService = new RpcProjectModelRoleService({
			getSettings: () => options.settings,
			getModelRegistry: () => options.modelRegistry,
			emit: frame => this.#emitProjectFrame(frame),
			// Loaded sessions own Settings clones (cloneForCwd at creation); a
			// persisted user role must reach them deterministically instead of
			// racing the shared instance's watcher debounce (O26: 保存后后续
			// 角色解析采用其有效配置).
			reloadSessionSettings: async () => {
				for (const [, host] of this.#sessionHosts) {
					try {
						await host.session.settings.reloadFromDisk();
					} catch (error) {
						logger.warn("RPC model role session settings reload failed", {
							sessionId: host.session.sessionId,
							error: String(error),
						});
					}
				}
			},
		});
		this.#subagentDirectory = new RpcProjectSubagentDirectory({
			resolveSessionFile: sessionId => this.#resolveSessionFile(sessionId),
			liveSnapshots: sessionId => {
				const registry = this.#sessionHosts.get(sessionId)?.subagentRegistry;
				return registry ? registry.getSubagents() : [];
			},
			sendIrcMessage: async message => IrcBus.global().send(message),
			senderId: sessionId => this.#container.getLoaded(sessionId)?.session.getAgentId(),
		});
		// Host tool/URI definitions are project-wide; their request bridges are
		// session-owned so calls and cancellation retain instance attribution.
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

	acceptInput(command: RpcCommand & { sessionId?: string; sessionGeneration?: string }): void {
		if (!this.#negotiatedV3 || typeof command.sessionId !== "string") return;
		const record = this.#container.getLoaded(command.sessionId);
		if (!record || command.sessionGeneration !== record.sessionGeneration) return;
		let input = command;
		if (command.type === ("execute_command" as string)) {
			const raw = command as unknown as Record<string, unknown>;
			input = {
				id: command.id,
				type: "prompt",
				message: typeof raw.text === "string" ? raw.text : "",
				inputMode: "auto",
				sessionId: record.sessionId,
				sessionGeneration: record.sessionGeneration,
			};
			this.#commandInputs.set(command, input);
		}
		this.#inputGates.get(record.sessionId)?.accept(input);
	}

	/** Emit a project-level frame (no session stamp). */
	#emitProjectFrame(frame: object): void {
		if (this.#disposed || (!this.#negotiatedV3 && (!isRecord(frame) || frame.type !== "response"))) return;
		this.#output({ ...(frame as Record<string, unknown>), processInstanceId: this.#processInstanceId });
	}

	/** Build + start the per-session host, wiring project stamps and shared bridges. */
	async #attachSessionHost(record: RpcProjectSessionRecord, created: RpcProjectCreatedSession): Promise<void> {
		const inputGate = new RpcUserInputGate();
		this.#inputGates.set(record.sessionId, inputGate);
		if (created.mcpManager) this.#mcpManagers.set(record.sessionId, created.mcpManager);
		const sessionOutput: RpcOutput = frame => {
			if (!this.#negotiatedV3) return;
			if (isRecord(frame)) {
				const terminal = frame.type === "prompt_result" || frame.type === "notice" || frame.type === "response";
				// Terminal frames are debts owed for accepted work: a prompt_result is
				// emitted from a deferred macrotask, and close/EOF teardown can
				// unregister this record's host before that fires — dropping it would
				// leave the client waiting on a result that was already settled.
				if (!terminal && this.#sessionHosts.get(record.sessionId)?.session !== record.session) return;
				try {
					this.#assertRecordIdentity(record);
				} catch {
					if (!terminal) return;
				}
				if (INTERACTION_REQUEST_TYPES.has(String(frame.type)) && typeof frame.id === "string" && frame.id) {
					this.#interactions.set(frame.id, {
						sessionId: record.sessionId,
						sessionGeneration: record.sessionGeneration,
					});
				}
				this.#output({
					...frame,
					processInstanceId: this.#processInstanceId,
					sessionId: record.sessionId,
					sessionGeneration: record.sessionGeneration,
				});
				if (
					[
						"agent_start",
						"agent_end",
						"message_end",
						"model_changed",
						"thinking_level_changed",
						"prompt_result",
					].includes(String(frame.type)) ||
					INTERACTION_REQUEST_TYPES.has(String(frame.type))
				)
					this.#container.notifyChanged();
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
			inputGate,
		});
		this.#sessionHosts.set(record.sessionId, sessionHost);
		try {
			// Bind real teardown ownership before startup can await client interaction.
			created.setHost?.({
				get isStreaming() {
					return record.session.isStreaming;
				},
				hasPendingAsyncWork: () => record.session.isBusyForSnapshot || record.session.hasAdmittedSubmission,
				isWaitingInteraction: () => sessionHost.isWaitingInteraction(),
				dispose: reason => sessionHost.dispose(reason),
			});
			if (this.#negotiatedV3) sessionHost.forkHost.activate();
			this.#metadataUnsubscribers.set(
				record.sessionId,
				record.session.subscribeCommandMetadataChanged(() => {
					if (
						this.#disposed ||
						this.#container.get(record.sessionId) !== record ||
						this.#staleSessions.has(record.sessionId)
					)
						return;
					this.#catalogService.invalidate();
					this.#emitProjectFrame({
						type: "command_catalog_changed",
						revision: this.#catalogService.revision,
						sessionId: record.sessionId,
						sessionGeneration: record.sessionGeneration,
					});
				}),
			);
			if (this.#pendingHostTools) {
				const tools = normalizeHostToolDefinitions(this.#pendingHostTools as never);
				const rpcTools = sessionHost.hostToolBridge.setTools(tools);
				await record.session.refreshRpcHostTools(rpcTools);
				this.#assertRecordIdentity(record);
			}
			if (this.#pendingHostUriSchemes) sessionHost.hostUriBridge.setSchemes(this.#pendingHostUriSchemes as never);
			await sessionHost.initializeExtensions();
			this.#assertRecordIdentity(record);
			await sessionHost.start();
			this.#assertRecordIdentity(record);
		} catch (error) {
			await sessionHost.dispose("session_attachment_failed").catch(cleanup => {
				logger.error("RPC attachment cleanup failed", { sessionId: record.sessionId, error: String(cleanup) });
			});
			this.#metadataUnsubscribers.get(record.sessionId)?.();
			this.#metadataUnsubscribers.delete(record.sessionId);
			this.#sessionHosts.delete(record.sessionId);
			this.#inputGates.delete(record.sessionId);
			this.#mcpManagers.delete(record.sessionId);
			throw error;
		}
	}

	readonly #sessionHosts = new Map<string, RpcSessionHost>();
	readonly #pendingSkillRefresh = new Set<string>();
	/** In-flight host attachments keyed by session id (concurrent create/resume coalescing). */
	readonly #attaching = new Map<string, Promise<void>>();
	/** sessionId → session file for not-loaded sessions (populated lazily by #prefetchSessionFile). */
	readonly #sessionFileCache = new Map<string, string>();

	/** Attach the session host exactly once per session id. */
	async #ensureAttached(record: RpcProjectSessionRecord, created?: RpcProjectCreatedSession): Promise<void> {
		const pending = this.#attaching.get(record.sessionId);
		if (pending) return pending;
		if (this.#sessionHosts.has(record.sessionId)) return;
		if (!created) throw Object.assign(new Error("Session host is not attached"), { code: "busy" });
		record.state = "loading";
		record.busy = true;
		const task = this.#attachSessionHost(record, created)
			.then(() => {
				if (this.#disposed || this.#container.get(record.sessionId) !== record) {
					throw Object.assign(new Error("Session attachment was cancelled"), { code: "busy" });
				}
				record.state = "loaded";
			})
			.catch(error => {
				// Rollback can close the failed construction; no attached host is
				// left, and this record is never returned as a loaded instance.
				if (this.#container.get(record.sessionId) === record && !this.#staleSessions.has(record.sessionId))
					record.state = "loaded";
				throw error;
			})
			.finally(() => {
				record.busy = false;
				this.#attaching.delete(record.sessionId);
			});
		this.#attaching.set(record.sessionId, task);
		await task;
	}

	/** Resolve (and cache) a session's main file, loaded or saved; false when unknown. */
	async #prefetchSessionFile(sessionId: string): Promise<boolean> {
		const loaded = this.#container.get(sessionId);
		if (loaded) return true;
		this.#sessionFileCache.delete(sessionId);
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
		if (options.name !== undefined && !options.name.trim()) {
			throw Object.assign(new Error("Session name cannot be empty"), { code: "invalid_params" });
		}
		const match =
			options.model &&
			this.#options.modelRegistry
				.getAvailable("all")
				.find(model => model.provider === options.model?.provider && model.id === options.model?.modelId);
		if (options.model && !match)
			throw Object.assign(new Error("Requested model is unavailable"), { code: "invalid_params" });
		const created = await this.#options.createSession();
		if (match) {
			try {
				await created.session.setModelTemporary(match);
			} catch (error) {
				await created.session.dispose();
				throw error;
			}
		}
		const record = await this.#container.adoptCreated(created, options);
		try {
			await this.#ensureAttached(record, created);
		} catch (error) {
			await this.#container.delete(record.sessionId, { cancelRunning: true });
			throw error;
		}
		this.#assertRecordIdentity(record);
		const summary = this.#container.buildSummary(record);
		return { record, summary };
	}

	/** Resume (or return the already-loaded instance of) a persisted session. */
	async resumeSession(
		sessionId: string,
	): Promise<{ record: RpcProjectSessionRecord; summary: RpcProjectSessionSummary }> {
		const existing = this.#container.get(sessionId);
		if (existing && this.#sessionHosts.has(sessionId)) {
			await this.#ensureAttached(existing);
			if (existing.state !== "loaded" || existing.busy)
				throw Object.assign(new Error("Session lifecycle is busy"), { code: "busy" });
			this.#assertRecordIdentity(existing);
			return { record: existing, summary: this.#container.buildSummary(existing) };
		}
		const { record, created } = await this.#container.resumeWithFactory(sessionId, async () => {
			const file = await this.#container.findSessionFileById(sessionId);
			if (!file) throw Object.assign(new Error("Session no longer exists"), { code: "not_found" });
			const manager = await SessionManager.open(file, this.#options.sessionDir, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
				initialCwd: this.#options.cwd,
			});
			if (
				manager.getSessionId() !== sessionId ||
				normalizePathForComparison(manager.getCwd()) !== normalizePathForComparison(this.#options.cwd)
			) {
				throw Object.assign(new Error("Session identity/project changed"), { code: "scope_not_allowed" });
			}
			return this.#options.createSession(manager);
		});
		try {
			await this.#ensureAttached(record, created);
		} catch (error) {
			if (this.#container.get(record.sessionId) === record && record.state === "loaded") {
				await this.#container.close(record.sessionId, { cancelRunning: true });
			}
			throw error;
		}
		this.#assertRecordIdentity(record);
		return { record, summary: this.#container.buildSummary(record) };
	}

	/** Route a session-level command: strip project fields, check generation, delegate. */
	async #createIndependentBranch(
		command: RpcCommand & { sessionId?: string; sessionGeneration?: string },
	): Promise<RpcResponse> {
		const source = await this.#requireLoadedSession(command as unknown as Record<string, unknown>);
		const host = this.#getSessionHost(source.sessionId)!;
		const reason = command.type === "fork" ? "fork" : "branch";
		const entryId = "entryId" in command ? command.entryId : undefined;
		const selected = typeof entryId === "string" ? source.session.sessionManager.getEntry(entryId) : undefined;
		if (reason === "branch" && (selected?.type !== "message" || selected.message.role !== "user")) {
			return this.#errorResponse(command.id, command.type, "branch requires a valid user entryId", "invalid_params");
		}
		if (
			reason === "fork" &&
			entryId !== undefined &&
			(typeof entryId !== "string" || !entryId || selected?.type !== "message")
		) {
			return this.#errorResponse(command.id, command.type, "fork entryId must identify a message", "invalid_params");
		}
		const assertIdle = (): void => {
			this.#assertRecordIdentity(source);
			if (
				source.session.isBusyForSnapshot ||
				source.session.hasAdmittedSubmission ||
				source.session.hasPendingAsyncWork() ||
				host.getRunState() !== "idle"
			) {
				throw Object.assign(new Error("A branch snapshot requires an idle source session"), { code: "busy" });
			}
		};
		assertIdle();
		const content =
			selected?.type === "message" && selected.message.role === "user" ? selected.message.content : undefined;
		const selectedText =
			typeof content === "string"
				? content
				: (content
						?.filter(part => part.type === "text")
						.map(part => part.text)
						.join("") ?? "");
		const selectedImages = Array.isArray(content) ? content.filter(part => part.type === "image") : [];
		const sourceFile = source.session.sessionFile;
		if (!sourceFile)
			return this.#errorResponse(command.id, command.type, "Source session is not persisted", "persistence_failed");
		source.busy = true;
		let manager: SessionManager | undefined;
		let created: RpcProjectCreatedSession | undefined;
		let transferred = false;
		let record: RpcProjectSessionRecord | undefined;
		try {
			const hook = await source.session.extensionRunner?.emit({
				type: "session_before_branch",
				reason,
				entryId: typeof entryId === "string" ? entryId : (source.session.sessionManager.getLeafId() ?? ""),
			});
			this.#assertRecordIdentity(source);
			if (isRecord(hook) && hook.cancel === true) {
				return this.#successResponse(command.id, command.type, { cancelled: true, selectedText, selectedImages });
			}
			await source.session.sessionManager.flush();
			assertIdle();
			if (reason === "fork" && entryId === undefined) {
				manager = await SessionManager.forkFrom(
					sourceFile,
					this.#options.cwd,
					this.#options.sessionDir,
					undefined,
					{
						copyArtifacts: true,
						requireStableSessionIdentity: true,
					},
				);
				assertIdle();
			} else {
				const leafId = reason === "fork" ? source.session.getForkLeafId(entryId as string) : selected!.parentId;
				if (leafId === null) {
					manager = SessionManager.create(this.#options.cwd, this.#options.sessionDir);
					manager.requireStableSessionIdentity();
					await manager.newSession({ parentSession: sourceFile });
					assertIdle();
				} else {
					// This reader owns no source writer. Mutate it only onto the
					// new snapshot, never branch the original live manager.
					manager = await SessionManager.open(sourceFile, this.#options.sessionDir, undefined, {
						suppressBreadcrumb: true,
						throwIfMissing: true,
						initialCwd: this.#options.cwd,
					});
					assertIdle();
					if (manager.getSessionId() !== source.sessionId)
						throw Object.assign(new Error("Source changed while reading"), { code: "stale_session" });
					manager.requireStableSessionIdentity();
					manager.createBranchedSession(leafId, { copyArtifacts: true });
				}
			}
			this.#assertRecordIdentity(source);
			manager.requireStableSessionIdentity();
			// Branching keeps the current runtime model, even when the selected
			// historical prefix predates its last model-change entry.
			if (source.session.model)
				manager.appendModelChange(`${source.session.model.provider}/${source.session.model.id}`);
			manager.appendThinkingLevelChange(source.session.thinkingLevel, source.session.configuredThinkingLevel());
			created = await this.#options.createSession(manager);
			this.#assertRecordIdentity(source);
			if (isRecord(hook) && hook.skipConversationRestore === true) {
				created.session.agent.replaceMessages(source.session.agent.state.messages);
			}
			transferred = true;
			record = await this.#container.adoptCreated(created);
			await this.#ensureAttached(record, created);
			this.#assertRecordIdentity(source);
			this.#assertRecordIdentity(record);
			await record.session.extensionRunner?.emit({
				type: "session_branch",
				reason,
				previousSessionFile: sourceFile,
			});
			this.#assertRecordIdentity(source);
			this.#assertRecordIdentity(record);
			return this.#successResponse(command.id, command.type, {
				...this.#container.buildSummary(record),
				cancelled: false,
				selectedText,
				selectedImages,
			});
		} catch (error) {
			if (created && !transferred) await created.session.dispose();
			else if (!created && manager && manager.getSessionId() !== source.sessionId) await manager.close();
			if (manager && manager.getSessionId() !== source.sessionId) {
				await this.#container
					.delete(record?.sessionId ?? manager.getSessionId(), { cancelRunning: true })
					.catch(cleanup => {
						logger.error("RPC branch rollback failed", { error: String(cleanup) });
					});
			}
			throw error;
		} finally {
			source.busy = false;
		}
	}

	async handleSessionCommand(
		command: RpcCommand & { sessionId?: string; sessionGeneration?: string },
	): Promise<RpcResponse> {
		this.#requireV3(command.id, command.type);
		if (command.type === "branch" || command.type === "fork") return this.#createIndependentBranch(command);
		if (["new_session", "switch_session", "open_session", "set_session_name"].includes(command.type)) {
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
		if (record) this.#assertRecordIdentity(record);
		if (SESSION_HISTORY_COMMANDS.has(command.type)) {
			if (record?.state === "loaded" && this.#getSessionHost(sessionId)) {
				return this.#getSessionHost(sessionId)!.handleCommand(command as RpcCommand);
			}
			return this.#readSavedHistory(command);
		}
		if (!record) {
			const saved = await this.#container.findSessionFileById(sessionId);
			return this.#errorResponse(
				command.id,
				command.type,
				saved ? `Session not loaded: ${sessionId}` : `Unknown session: ${sessionId}`,
				saved ? "session_not_loaded" : "not_found",
			);
		}
		const host = this.#getSessionHost(sessionId);
		if (!host) {
			return this.#errorResponse(command.id, command.type, `Session not loaded: ${sessionId}`, "session_not_loaded");
		}
		if (record.state !== "loaded" || record.busy) {
			return this.#errorResponse(command.id, command.type, `Session is ${record.state}: ${sessionId}`, "busy");
		}
		if (typeof command.sessionGeneration !== "string" || !command.sessionGeneration) {
			return this.#errorResponse(
				command.id,
				command.type,
				"This command requires sessionGeneration",
				"invalid_params",
			);
		}
		if (command.sessionGeneration !== record.sessionGeneration) {
			return this.#errorResponse(
				command.id,
				command.type,
				`Session generation mismatch for ${sessionId}: the instance was reloaded`,
				"stale_session",
			);
		}
		if (
			command.type === "prompt" &&
			this.#pendingSkillRefresh.has(sessionId) &&
			this.#canRefreshSkills(record, host)
		) {
			record.busy = true;
			try {
				await host.refreshSkills();
				this.#assertRecordIdentity(record);
				this.#pendingSkillRefresh.delete(sessionId);
			} finally {
				record.busy = false;
			}
		}
		// The frame object is passed through as-is (routing fields included):
		// RpcUserInputGate keys acceptance on object identity, so a rebuilt
		// "stock" copy would never match and every ordered user input would
		// be cancelled as stale. The session host ignores the extra fields.
		const response = await host.handleCommand(command as RpcCommand);
		const cancelledInput =
			host.isShutdownRequested() &&
			["prompt", "abort_and_prompt", "steer", "follow_up"].includes(command.type) &&
			record.session.sessionManager.getSessionId() === record.sessionId;
		if (!cancelledInput) this.#assertRecordIdentity(record);
		return response;
	}

	/** Answer a project-level command. Zero-session-safe unless stated otherwise. */
	async handleProjectCommand(command: Record<string, unknown>): Promise<RpcResponse> {
		const type = String(command.type);
		const id = typeof command.id === "string" ? command.id : undefined;
		const record = async (): Promise<RpcSessionHost | undefined> => {
			if (command.sessionId === undefined) return undefined;
			const rec = await this.#requireLoadedSession(command);
			return this.#getSessionHost(rec.sessionId);
		};
		switch (type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 3) {
					return this.#errorResponse(id, type, "Project mode requires protocol version 3", "unsupported");
				}
				this.activateV3();
				return this.#successResponse(id, type, { protocolVersion: 3, capabilities: RPC_PROJECT_CAPABILITIES });
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
				this.#checkOptional(command, "cursor", "string");
				this.#checkOptional(command, "limit", "number");
				if (
					command.loadState !== undefined &&
					command.loadState !== "loaded" &&
					command.loadState !== "not_loaded"
				) {
					return this.#errorResponse(id, type, "Invalid loadState", "invalid_params");
				}
				const page = await this.#container.list({
					cursor: typeof command.cursor === "string" ? command.cursor : undefined,
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
				await this.#requireLoadedSession(command);
				this.#checkOptional(command, "cancelRunning", "boolean");
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
				this.#requireRevision(command);
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
				this.#requireRevision(command);
				this.#checkOptional(command, "cancelRunning", "boolean");
				if (this.#container.get(sessionId)) await this.#requireLoadedSession(command);
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
				if (command.view !== "management" && command.view !== "effective") {
					return this.#errorResponse(
						id,
						type,
						"list_skills requires view management or effective",
						"invalid_params",
					);
				}
				if (command.view === "effective" && !sessionHost) {
					return this.#errorResponse(id, type, "Effective skills require a loaded session", "invalid_params");
				}
				this.#checkOptional(command, "cursor", "string");
				this.#checkOptional(command, "limit", "number");
				const result = await this.#skillsService.list({
					view: command.view,
					sessionId: sessionHost?.session.sessionId,
					sessionSkills: sessionHost?.session.skills,
					cursor: command.cursor as string | undefined,
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
			case "delete_skill": {
				this.#requireV3(id, type);
				const result = await this.#skillsService.delete(
					this.#skillMutationInput(command, ["skillId", "expectedRevision"]) as never,
				);
				return this.#successResponse(id, type, result);
			}
			case "reload_skills": {
				this.#requireV3(id, type);
				if (command.scope !== "project" && command.scope !== "user") {
					return this.#errorResponse(id, type, "reload_skills requires scope user or project", "invalid_params");
				}
				const result = await this.#skillsService.reload(command.scope);
				this.#catalogService.invalidate();
				this.#emitProjectFrame({ type: "command_catalog_changed", revision: this.#catalogService.revision });
				return this.#successResponse(id, type, result);
			}
			case "set_skill_source_enabled":
			case "set_skill_ignored": {
				this.#requireV3(id, type);
				this.#requireRevision(command);
				if (command.scope !== "user")
					return this.#errorResponse(
						id,
						type,
						"Only user-scoped skill configuration writes are supported",
						"scope_not_allowed",
					);
				const response = await this.#configForkHost.handleCommand(command as never);
				if (response) {
					if (response.success) {
						this.#catalogService.invalidate();
						this.#emitProjectFrame({ type: "command_catalog_changed", revision: this.#catalogService.revision });
						await this.#refreshSessionsSkills();
					}
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
				if (sessionId !== undefined) {
					const rec = await this.#requireLoadedSession(command);
					const host = this.#getSessionHost(rec.sessionId);
					if (host) {
						const model = host.session.model;
						sessionInfo = {
							sessionId: rec.sessionId,
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
				if (command.scope !== "user")
					return this.#errorResponse(id, type, 'Model roles require scope "user"', "scope_not_allowed");
				this.#requireRevision(command);
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
						this.#checkOptional(selectionRaw.model, "thinkingLevel", "string");
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
				if (typeof command.roleId !== "string" || !command.roleId) {
					return this.#errorResponse(id, type, "roleId is required", "invalid_params");
				}
				const result = await this.#rolesService.setRole({
					roleId: command.roleId,
					scope: "user",
					selection,
					expectedRevision: command.expectedRevision as string,
				});
				return this.#successResponse(id, type, result);
			}
			case "get_available_models": {
				this.#requireV3(id, type);
				const sessionHost = await record();
				await this.#options.modelRegistry.awaitBackgroundRefresh();
				let models = sessionHost
					? sessionHost.session.getAvailableModels()
					: this.#options.modelRegistry.getAvailable("all");
				if (command.roleId !== undefined) {
					if (
						typeof command.roleId !== "string" ||
						!command.roleId ||
						!(await this.#rolesService.listRoles()).roles.some(role => role.roleId === command.roleId)
					) {
						return this.#errorResponse(id, type, "Unknown roleId", "invalid_params");
					}
					models = models.filter(getRoleInfo(command.roleId, this.#options.settings).accepts);
				}
				return this.#successResponse(id, type, { models });
			}
			case "set_host_tools": {
				this.#requireV3(id, type);
				const tools = Array.isArray(command.tools) ? command.tools : [];
				const normalized = normalizeHostToolDefinitions(tools as never);
				this.#pendingHostTools = tools;
				for (const [, host] of this.#sessionHosts) {
					const rpcTools = host.hostToolBridge.setTools(normalized);
					await host.session.refreshRpcHostTools(rpcTools);
				}
				return this.#successResponse(id, type, { toolNames: normalized.map(tool => tool.name) });
			}
			case "set_host_uri_schemes": {
				this.#requireV3(id, type);
				const schemes = Array.isArray(command.schemes) ? command.schemes : [];
				this.#pendingHostUriSchemes = schemes;
				for (const [, host] of this.#sessionHosts) host.hostUriBridge.setSchemes(schemes as never);
				return this.#successResponse(id, type, {
					schemes: schemes.map(scheme => (isRecord(scheme) ? String(scheme.scheme) : String(scheme))),
				});
			}
			case "get_subagents": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				this.#checkOptional(command, "status", "string");
				this.#checkOptional(command, "cursor", "string");
				this.#checkOptional(command, "limit", "number");
				if (command.status !== undefined && command.status !== "running" && command.status !== "finished") {
					return this.#errorResponse(id, type, "Invalid subagent status", "invalid_params");
				}
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
					cursor: command.cursor as string | undefined,
					limit: typeof command.limit === "number" ? command.limit : undefined,
				});
				return this.#successResponse(id, type, result);
			}
			case "get_subagent_messages": {
				this.#requireV3(id, type);
				const sessionId = command.sessionId;
				const subagentId = command.subagentId;
				this.#checkOptional(command, "fromByte", "number");
				this.#checkOptional(command, "maxBytes", "number");
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
				await this.#requireLoadedSession(command);
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
				// controllers with zero sessions. Gated like every explicit
				// case above: these are fork v3 business commands.
				this.#requireV3(id, type);
				if (type === "set_settings" || type === "unset_settings") {
					this.#requireRevision(command);
					if (command.scope !== "user")
						return this.#errorResponse(
							id,
							type,
							"Only user-scoped settings writes are supported",
							"scope_not_allowed",
						);
				}
				const forkResponse = await this.#configForkHost.handleCommand(command as never);
				if (forkResponse) return forkResponse;
				return this.#errorResponse(id, type, `Unknown command: ${type}`);
			}
		}
	}

	#skillMutationInput(command: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
		this.#requireRevision(command);
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
		this.#checkOptional(command, "catalogRevision", "string");
		const record = command.sessionId === undefined ? undefined : await this.#requireLoadedSession(command);
		const host = record ? this.#getSessionHost(record.sessionId)! : undefined;
		// Catalog resolution is async; without holding the session's input gate a
		// later-arriving plain prompt enters the ordered arm first and this
		// command's synthetic prompt overtakes it in reverse arrival order
		// (§14.4). The gate is re-entrant for the synthetic prompt dispatched
		// below, so the whole section keeps one arrival order.
		const runOrdered = async (): Promise<RpcResponse> => {
			const resolution = await this.#catalogService.resolve(text.trimStart(), host?.session);
			if (command.catalogRevision !== undefined && command.catalogRevision !== this.#catalogService.revision) {
				return this.#errorResponse(id, type, "Command catalog changed; query it again", "revision_conflict");
			}
			if (resolution.kind === "unknown") {
				return this.#errorResponse(id, type, `Unknown command: ${text.trim().split(/\s+/)[0]}`, "invalid_params");
			}
			const name = resolution.name;
			const args =
				text
					.trimStart()
					.match(/^\/\S+\s*([\s\S]*)$/)?.[1]
					?.trim() ?? "";
			if (resolution.kind === "builtin") {
				if (name === "new") {
					const { summary } = await this.createSession({});
					return this.#successResponse(id, type, {
						hostAction: { kind: "focus_session", payload: { session: summary } },
					});
				}
				if (name === "resume") {
					if (!args) return this.#successResponse(id, type, { hostAction: { kind: "select_session" } });
					const { summary } = await this.resumeSession(args);
					return this.#successResponse(id, type, {
						hostAction: { kind: "focus_session", payload: { session: summary } },
					});
				}
				const hostAction = name && RPC_PROJECT_HOST_ACTIONS.get(name);
				if (hostAction && (!args || !resolution.spec?.handle || name === "move")) {
					const catalog = await this.#catalogService.buildCatalog(host?.session);
					if (catalog.find(entry => entry.name === name)?.scope === "session" && !record) {
						return this.#errorResponse(id, type, "This action requires a loaded session", "invalid_params");
					}
					if (name === "move" && !args)
						return this.#errorResponse(id, type, "Usage: /move <path>", "invalid_params");
					return this.#successResponse(id, type, {
						hostAction: {
							kind: hostAction,
							payload: {
								...(record ? { sessionId: record.sessionId, sessionGeneration: record.sessionGeneration } : {}),
								...(name === "move" ? { projectRoot: resolveToCwd(args, this.#options.cwd) } : { args }),
								...(name === "skills" ? { panel: "skills" } : {}),
							},
						},
					});
				}
				if (name === "wt")
					return this.#errorResponse(
						id,
						type,
						"Worktree moves require a different project process",
						"unsupported",
					);
				if (name === "login") {
					if (!record) return this.#errorResponse(id, type, "Login requires a loaded session", "invalid_params");
					if (!args)
						return this.#successResponse(id, type, {
							hostAction: { kind: "select_login_provider", payload: { sessionId: record.sessionId } },
						});
					const response = await this.handleSessionCommand({
						id,
						type: "login",
						providerId: args,
						sessionId: record.sessionId,
						sessionGeneration: record.sessionGeneration,
					});
					return response.success
						? this.#successResponse(id, type, { completed: true, agentInvoked: false })
						: { ...response, command: type };
				}
				if (!resolution.spec?.handle)
					return this.#errorResponse(
						id,
						type,
						"This business command has no RPC-capable OMP handler",
						"unsupported",
					);
			}
			if (!record || !host)
				return this.#errorResponse(id, type, "This command requires a loaded session", "invalid_params");
			// Reuse the exact prompt accepted at frame arrival. An unaccepted frame
			// stays unaccepted so the shared gate cancels it, rather than reordering it.
			const syntheticPrompt = this.#commandInputs.get(command) ?? {
				id,
				type: "prompt",
				sessionId: record.sessionId,
				sessionGeneration: record.sessionGeneration,
				message: text,
				inputMode: "auto",
			};
			const response = await this.handleSessionCommand(syntheticPrompt as never);
			return response.success
				? this.#successResponse(id, type, "data" in response ? response.data : undefined)
				: this.#errorResponse(id, type, response.error, response.code);
		};
		if (!record || !host) return runOrdered();
		return this.#inputGates.get(record.sessionId)!.enqueue(runOrdered);
	}

	/**
	 * Release one session's host-side bookkeeping after the container tore the
	 * record down: best-effort host dispose, then drop the host, pending skill
	 * refresh, and interaction-routing entries owned by this session.
	 */
	async #teardownSessionHost(sessionId: string, reason: string): Promise<void> {
		const host = this.#getSessionHost(sessionId);
		if (host) await host.dispose(reason);
		this.#metadataUnsubscribers.get(sessionId)?.();
		this.#metadataUnsubscribers.delete(sessionId);
		this.#mcpManagers.delete(sessionId);
		this.#staleSessions.delete(sessionId);
		this.#sessionHosts.delete(sessionId);
		this.#pendingSkillRefresh.delete(sessionId);
		this.#inputGates.delete(sessionId);
		for (const [interactionId, owner] of this.#interactions) {
			if (owner.sessionId === sessionId) this.#interactions.delete(interactionId);
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
		try {
			const result = await this.#container.delete(sessionId, { cancelRunning, expectedRevision });
			await this.#teardownSessionHost(sessionId, "session_deleted");
			this.#sessionFileCache.delete(sessionId);
			return result;
		} catch (error) {
			if (!this.#container.get(sessionId)) await this.#teardownSessionHost(sessionId, "session_closed");
			throw error;
		}
	}

	#resolveSessionFile(sessionId: string): string | undefined {
		const loaded = this.#container.get(sessionId);
		if (loaded?.session.sessionFile) return loaded.session.sessionFile;
		return this.#sessionFileCache.get(sessionId);
	}

	#canRefreshSkills(record: RpcProjectSessionRecord, host: RpcSessionHost): boolean {
		return (
			record.state === "loaded" &&
			!record.busy &&
			!host.session.isBusyForSnapshot &&
			!host.session.hasAdmittedSubmission &&
			!host.isWaitingInteraction()
		);
	}

	async #refreshSessionsSkills(): Promise<{ adopted: string[]; pending: string[] }> {
		const adopted: string[] = [];
		const pending: string[] = [];
		for (const [sessionId, host] of this.#sessionHosts) {
			const record = this.#container.get(sessionId);
			if (!record || !this.#canRefreshSkills(record, host) || this.#staleSessions.has(sessionId)) {
				this.#pendingSkillRefresh.add(sessionId);
				pending.push(sessionId);
				continue;
			}
			record.busy = true;
			try {
				this.#assertRecordIdentity(record);
				await host.refreshSkills();
				this.#assertRecordIdentity(record);
				this.#pendingSkillRefresh.delete(sessionId);
				adopted.push(sessionId);
			} catch (error) {
				logger.warn("RPC skill adoption deferred", { sessionId, error: String(error) });
				this.#pendingSkillRefresh.add(sessionId);
				pending.push(sessionId);
			} finally {
				record.busy = false;
			}
		}
		return { adopted, pending };
	}

	/** Route a side-channel frame to the session that issued the request. */
	handleControlFrame(parsed: unknown): boolean {
		if (!isRecord(parsed)) return false;
		const type = String(parsed.type);
		if (
			INTERACTION_RESPONSE_TYPES.has(type) ||
			["host_tool_result", "host_tool_update", "host_uri_result"].includes(type)
		) {
			const targetId = type === "ask_pause" ? parsed.targetId : parsed.id;
			const owner = typeof targetId === "string" ? this.#interactions.get(targetId) : undefined;
			const record = owner ? this.#container.getLoaded(owner.sessionId) : undefined;
			const host = owner ? this.#getSessionHost(owner.sessionId) : undefined;
			if (
				!owner ||
				!record ||
				!host ||
				record.sessionGeneration !== owner.sessionGeneration ||
				parsed.sessionId !== owner.sessionId ||
				parsed.sessionGeneration !== owner.sessionGeneration
			) {
				this.#emitProjectFrame(
					this.#errorResponse(
						typeof parsed.id === "string" ? parsed.id : undefined,
						type,
						"Unknown, stale, or wrong-session interaction",
						"stale_session",
					),
				);
				return true;
			}
			const handled = host.handleControlFrame(parsed);
			if (handled && type !== "ask_pause" && type !== "host_tool_update")
				this.#interactions.delete(targetId as string);
			if (handled) this.#container.notifyChanged();
			return handled;
		}
		return false;
	}

	/** Fail-close everything (stdin EOF / process shutdown). */
	async dispose(reason: string): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		// Fail pending startup/control waits before container abort/flush awaits them.
		const hostDisposals = [...this.#sessionHosts.values()].map(host => host.dispose(reason));
		await this.#container.disposeAll(reason);
		await Promise.allSettled([...hostDisposals, ...this.#attaching.values()]);
		for (const unsubscribe of this.#metadataUnsubscribers.values()) unsubscribe();
		this.#metadataUnsubscribers.clear();
		this.#mcpManagers.clear();
		this.#staleSessions.clear();
		this.#sessionHosts.clear();
		this.#pendingSkillRefresh.clear();
		this.#inputGates.clear();
		this.#sessionFileCache.clear();
		this.#interactions.clear();
	}

	#assertRecordIdentity(record: RpcProjectSessionRecord): void {
		if (this.#disposed) throw Object.assign(new Error("Project is disposing"), { code: "busy" });
		const current = this.#container.get(record.sessionId);
		if (
			current === record &&
			record.session.sessionManager.getSessionId() === record.sessionId &&
			normalizePathForComparison(record.session.sessionManager.getCwd()) ===
				normalizePathForComparison(this.#options.cwd) &&
			!this.#staleSessions.has(record.sessionId)
		)
			return;
		if (current === record && !this.#staleSessions.has(record.sessionId)) {
			this.#staleSessions.add(record.sessionId);
			record.state = "closing";
			this.#inputGates.get(record.sessionId)?.accept({ type: "abort" });
			this.#emitProjectFrame({
				type: "notice",
				level: "error",
				source: "session-identity",
				code: "stale_session",
				terminal: true,
				message: `Session ${record.sessionId} lost its original identity; this instance is unavailable`,
				sessionId: record.sessionId,
				sessionGeneration: record.sessionGeneration,
			});
			this.#container.notifyChanged();
			void this.#getSessionHost(record.sessionId)
				?.dispose("stale_session")
				.catch(error => {
					logger.error("RPC stale host cleanup failed", { sessionId: record.sessionId, error: String(error) });
				});
		}
		throw Object.assign(new Error("Session identity changed"), { code: "stale_session" });
	}

	async #requireLoadedSession(command: Record<string, unknown>): Promise<RpcProjectSessionRecord> {
		if (typeof command.sessionId !== "string" || !command.sessionId) {
			throw Object.assign(new Error("This command requires sessionId"), { code: "invalid_params" });
		}
		const known = this.#container.get(command.sessionId);
		if (known) this.#assertRecordIdentity(known);
		const record = this.#container.getLoaded(command.sessionId);
		if (!record || !this.#getSessionHost(record.sessionId)) {
			const saved = await this.#container.findSessionFileById(command.sessionId);
			throw Object.assign(new Error(`Session not loaded: ${command.sessionId}`), {
				code: saved ? "session_not_loaded" : "not_found",
			});
		}
		if (record.busy) throw Object.assign(new Error("Session lifecycle transition is in progress"), { code: "busy" });
		if (typeof command.sessionGeneration !== "string" || !command.sessionGeneration) {
			throw Object.assign(new Error("This command requires sessionGeneration"), { code: "invalid_params" });
		}
		if (command.sessionGeneration !== record.sessionGeneration) {
			throw Object.assign(new Error("Session generation mismatch"), { code: "stale_session" });
		}
		return record;
	}

	#checkOptional(command: Record<string, unknown>, key: string, type: string): void {
		if (command[key] !== undefined && typeof command[key] !== type) {
			throw Object.assign(new Error(`${key} must be a ${type}`), { code: "invalid_params" });
		}
	}

	#requireRevision(command: Record<string, unknown>): void {
		if (typeof command.expectedRevision !== "string" || !command.expectedRevision) {
			throw Object.assign(new Error("This write requires expectedRevision"), { code: "invalid_params" });
		}
	}

	async #readSavedHistory(command: RpcCommand & { sessionId?: string }): Promise<RpcResponse> {
		const sessionId = command.sessionId!;
		const file = await this.#container.findSessionFileById(sessionId);
		if (!file) return this.#errorResponse(command.id, command.type, "Unknown session", "not_found");
		// Opening acquires neither a writer nor a lease; never close/flush this
		// read-only projection (those operations can persist a migration).
		const manager = await SessionManager.open(file, this.#options.sessionDir, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
			initialCwd: this.#options.cwd,
		});
		const header = manager.getHeader();
		if (
			manager.getSessionId() !== sessionId ||
			!header ||
			normalizePathForComparison(header.cwd) !== normalizePathForComparison(this.#options.cwd)
		) {
			return this.#errorResponse(command.id, command.type, "Session identity/project changed", "scope_not_allowed");
		}
		const messages = manager.buildSessionContext().messages;
		const revision = `history-${createHash("sha256")
			.update(JSON.stringify([sessionId, manager.getLeafId(), manager.getEntries()]))
			.digest("hex")}`;
		let data: object;
		switch (command.type) {
			case "get_messages":
				data = { messages };
				break;
			case "get_messages_page":
				data = pageRpcMessages(
					messages,
					{
						sessionId,
						leafId: manager.getLeafId(),
						messageCount: messages.length,
						revision: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
					},
					command,
				);
				break;
			case "get_entries":
				data = selectRpcEntries(manager.getEntries(), manager.getLeafId(), command.since);
				break;
			case "get_tree":
				data = { tree: manager.getTree(), leafId: manager.getLeafId() };
				break;
			case "get_branch_messages":
				data = {
					messages: manager.getEntries().flatMap(entry => {
						if (entry.type !== "message" || entry.message.role !== "user") return [];
						const content = entry.message.content;
						const text =
							typeof content === "string"
								? content
								: content
										.filter(part => part.type === "text")
										.map(part => part.text)
										.join("");
						return text ? [{ entryId: entry.id, text }] : [];
					}),
				};
				break;
			case "get_last_assistant_text": {
				const message = messages.findLast(message => message.role === "assistant");
				data = {
					text:
						message?.role === "assistant"
							? message.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("")
							: undefined,
				};
				break;
			}
			case "get_session_stats": {
				// History-range query (§14.4): message-derived totals only, no
				// running container. Model-usage entries outside the active
				// transcript window mirror the live tracker's window rule.
				const branch = manager.getBranch();
				const latestCompaction = getLatestCompactionEntry(branch);
				const compactionIndex = latestCompaction ? branch.lastIndexOf(latestCompaction) : -1;
				const resetIndex = branch.reduce(
					(latest, entry, index) => (entry.type === "reset_boundary" ? index : latest),
					-1,
				);
				let startIndex = 0;
				if (resetIndex > compactionIndex) startIndex = resetIndex + 1;
				else if (latestCompaction) {
					const firstKeptIndex = branch.findIndex(entry => entry.id === latestCompaction.firstKeptEntryId);
					startIndex = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex + 1;
					while (
						startIndex > 0 &&
						!["message", "custom_message", "branch_summary", "compaction", "reset_boundary"].includes(
							branch[startIndex - 1]!.type,
						)
					)
						startIndex--;
				}
				const modelUsage = branch
					.slice(startIndex)
					.filter(
						(entry): entry is Extract<(typeof branch)[number], { type: "model_usage" }> =>
							entry.type === "model_usage",
					)
					.map(entry => entry.usage);
				data = savedSessionStats(sessionId, file, messages, modelUsage);
				break;
			}
			default:
				return this.#errorResponse(command.id, command.type, "Unsupported historical query", "unsupported");
		}
		return this.#successResponse(command.id, command.type, { ...data, revision });
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
 * Message-derived {@link SessionStats} for a saved, not-loaded session
 * (§14.4: `get_session_stats` is an H-range query and must not instantiate a
 * running container). Mirrors the SessionStatsTracker message loop; the live
 * `contextUsage` estimate has no persisted equivalent and stays absent.
 */
function savedSessionStats(
	sessionId: string,
	sessionFile: string,
	messages: readonly AgentMessage[],
	modelUsage: readonly Usage[],
): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let toolCalls = 0;
	let input = 0;
	let output = 0;
	let reasoning = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let cost = 0;
	let premiumRequests = 0;
	let creditCost = 0;
	let committedCreditCost = 0;
	let committedAcuCost = 0;
	let hasCredits = false;
	const routedModels: Record<string, number> = {};
	const addUsage = (usage: Usage): void => {
		input += usage.input;
		output += usage.output;
		reasoning += usage.reasoningTokens ?? 0;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		totalTokens += usage.totalTokens;
		premiumRequests += usage.premiumRequests ?? 0;
		cost += usage.cost.total;
		const credits = usage.credits;
		if (credits !== undefined) {
			hasCredits = true;
			creditCost += credits.cost ?? 0;
			committedCreditCost += credits.committedCost ?? 0;
			committedAcuCost += credits.acuCost ?? 0;
		}
	};
	const taskUsage = (details: unknown): Usage | undefined => {
		if (!isRecord(details)) return undefined;
		const usage = Reflect.get(details, "usage");
		return isRecord(usage) &&
			isRecord(usage.cost) &&
			typeof usage.input === "number" &&
			typeof usage.totalTokens === "number" &&
			typeof usage.cost.total === "number"
			? (usage as unknown as Usage)
			: undefined;
	};
	for (const message of messages) {
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.toolName === "task") {
				const usage = taskUsage(message.details);
				if (usage) addUsage(usage);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			for (const content of message.content) {
				if (content.type === "toolCall") toolCalls++;
			}
			if (message.usage) {
				addUsage(message.usage);
				if (message.upstreamModel !== undefined) {
					routedModels[message.upstreamModel] = (routedModels[message.upstreamModel] ?? 0) + 1;
				}
			}
		}
	}
	for (const usage of modelUsage) addUsage(usage);
	return {
		sessionFile,
		sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: messages.length,
		tokens: {
			input,
			output,
			reasoning,
			cacheRead,
			cacheWrite,
			total: totalTokens,
		},
		cost,
		premiumRequests,
		...(hasCredits
			? { credits: { cost: creditCost, committedCost: committedCreditCost, acuCost: committedAcuCost } }
			: {}),
		...(Object.keys(routedModels).length > 0 ? { routedModels } : {}),
	};
}

/**
 * Run in project RPC mode: many sessions of one project in this process.
 * Returns only on process exit (stdin EOF or fatal output failure).
 */
export async function runRpcProjectMode(options: RpcProjectModeOptions): Promise<never> {
	options = { ...options, cwd: resolveEquivalentPath(options.cwd) };
	const input = options.input ?? claimRpcInput();
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	const hostRef: { host?: RpcProjectHost } = {};
	const inFlight = new Map<string, { acknowledged: boolean; terminal: boolean }>();
	// Bun on Windows writes a piped process.stdout with a blocking WriteFile on the
	// JS thread and never reports backpressure, so a client that stops reading
	// stdout froze the whole worker, stdin reader included. An fd write stream
	// writes from the threadpool and reports backpressure, letting the writer spool.
	const stdout = process.platform === "win32" ? fs.createWriteStream("", { fd: 1, autoClose: false }) : process.stdout;
	const outputWriter = new RpcOutputWriter(stdout, failure => {
		logger.error("RPC project output delivery failed", { error: String(failure) });
		void hostRef.host?.dispose("RPC output delivery failed").finally(() => process.exit(1));
	});
	const output: RpcOutput = obj => {
		if (isRecord(obj) && obj.type === "prompt_result" && typeof obj.id === "string") {
			const request = inFlight.get(obj.id);
			if (request) {
				request.terminal = true;
				if (request.acknowledged) inFlight.delete(obj.id);
			}
		}
		const stamped =
			isRecord(obj) && hostRef.host ? { ...obj, processInstanceId: hostRef.host.processInstanceId } : obj;
		outputWriter.write(frameEncoder.encodeFrames(stamped));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};

	const host = new RpcProjectHost(options, output);
	hostRef.host = host;

	outputWriter.write(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [3],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			mode: "rpc-ui-project",
			projectIdentity: { projectRoot: options.cwd },
			processInstanceId: host.processInstanceId,
			capabilities: RPC_PROJECT_CAPABILITIES,
		}),
	);

	const backgroundTasks = new Set<Promise<void>>();
	// Only a session's own state transitions serialize. Admission, model calls,
	// shell and side answers do not hold its queue, and never another session's.
	const projectBackgroundedTypes = new Set([
		"bash",
		"predict_word",
		"prompt",
		"steer",
		"follow_up",
		"abort_and_prompt",
		"steer_subagent",
		"btw",
		"btw_cancel",
		"live_start",
		"execute_command",
	]);
	const dispatch = async (parsed: Record<string, unknown>): Promise<void> => {
		const type = String(parsed.type ?? "");
		if (!type) return;
		const sessionGeneration = typeof parsed.sessionGeneration === "string" ? parsed.sessionGeneration : undefined;
		let response: RpcResponse;
		try {
			if (PROJECT_LEVEL_COMMANDS.has(type)) {
				response = await host.handleProjectCommand(parsed);
			} else if (SESSION_LEVEL_COMMANDS.has(type)) {
				response = await host.handleSessionCommand(parsed as never);
			} else {
				response = errorFrame(parsed.id, type, `Unknown command: ${type}`, "unsupported");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code =
				error instanceof RpcProjectGateError ? "unsupported" : (projectErrorCodeOf(error) ?? "execution_failed");
			response = errorFrame(parsed.id, type, message, code);
		}
		output({
			...response,
			...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
			...(SESSION_HISTORY_COMMANDS.has(type) || type === "resume_session" || type === "rename_session"
				? typeof parsed.sessionId === "string" && response.success && host.container.getLoaded(parsed.sessionId)
					? { sessionGeneration: host.container.getLoaded(parsed.sessionId)!.sessionGeneration }
					: {}
				: sessionGeneration
					? { sessionGeneration }
					: {}),
		});
		if (typeof parsed.id === "string") {
			const request = inFlight.get(parsed.id);
			if (request) {
				request.acknowledged = true;
				const data: Record<string, unknown> | undefined =
					"data" in response && isRecord(response.data) ? response.data : undefined;
				const invokesAgent =
					response.success &&
					(type === "prompt" ||
						type === "abort_and_prompt" ||
						(type === "execute_command" && data?.agentInvoked === true)) &&
					data?.agentInvoked !== false;
				if (!invokesAgent || request.terminal) inFlight.delete(parsed.id);
			}
		}
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

	const serialTails = new Map<string, Promise<void>>();
	let disconnected = false;
	const track = (task: Promise<void>): void => {
		backgroundTasks.add(task);
		void task.then(
			() => backgroundTasks.delete(task),
			() => backgroundTasks.delete(task),
		);
	};
	const queueSerial = (parsed: Record<string, unknown>): void => {
		const key = typeof parsed.sessionId === "string" ? parsed.sessionId : "project";
		const previous = serialTails.get(key) ?? Promise.resolve();
		const start = (): Promise<void> => {
			if (disconnected) {
				inFlight.delete(String(parsed.id));
				return Promise.resolve();
			}
			if (projectBackgroundedTypes.has(String(parsed.type))) {
				track(dispatch(parsed));
				return Promise.resolve();
			}
			return dispatch(parsed);
		};
		const next = previous.then(start, start);
		serialTails.set(key, next);
		track(next);
		const clear = (): void => {
			if (serialTails.get(key) === next) serialTails.delete(key);
		};
		void next.then(clear, clear);
	};

	await readRpcInputFrames(
		input,
		parsed => {
			if (host.handleControlFrame(parsed)) return;
			if (
				!isRecord(parsed) ||
				typeof parsed.type !== "string" ||
				!parsed.type ||
				typeof parsed.id !== "string" ||
				!parsed.id
			) {
				output(
					errorFrame(
						isRecord(parsed) ? parsed.id : undefined,
						isRecord(parsed) ? String(parsed.type ?? "parse") : "parse",
						"Project requests require non-empty string id and type",
						"invalid_params",
					),
				);
				return;
			}
			if (inFlight.has(parsed.id)) {
				output(errorFrame(parsed.id, parsed.type, "Request id is already in flight", "invalid_params"));
				return;
			}
			inFlight.set(parsed.id, { acknowledged: false, terminal: false });
			host.acceptInput(parsed as never);
			queueSerial(parsed);
		},
		message => output(errorFrame(undefined, "parse", `Failed to parse command: ${message}`)),
	);

	// stdin closed — the project host is gone. Dispose every session (their
	// disposals flush persistence), then exit cleanly.
	disconnected = true;
	await host.dispose("RPC client disconnected");
	await Promise.allSettled(backgroundTasks);
	// prompt_result reports are deferred to setImmediate so they land after
	// their command's response; every immediate scheduled by the settled tasks
	// above runs before this one resolves (FIFO), so their frames reach the
	// writer before close() seals it — otherwise process.exit(0) below would
	// drop results the client is still owed.
	await new Promise<void>(resolve => setImmediate(resolve));
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
			"stale_revision",
			"stale_cursor",
			"permission_denied",
			"persistence_failed",
			"execution_failed",
		];
		return (allowed as readonly string[]).includes(code) ? (code as RpcProjectErrorCode) : undefined;
	}
	return undefined;
}
