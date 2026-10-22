import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getAgentDir, getBlobsDir } from "@oh-my-pi/pi-utils/dirs";
import { Settings, withActiveSettings } from "../../config/settings";
import { AgentRegistry, type AgentRef } from "../../registry/agent-registry";
import {
	createAgentSession,
	discoverAuthStorage,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
} from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { PromptOptions } from "../../session/agent-session-types";
import { readSessionInfo, type SessionInfo } from "../../session/session-listing";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "../../session/session-loader";
import { BlobStore } from "../../session/blob-store";
import type { SessionEntry } from "../../session/session-entries";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { collectSubSessions } from "../../session/sub-sessions";
import type { AsyncJob } from "../../async/job-manager";
import { ZCodeModelIoRetention } from "./model-io";
import { parseZCodeThinkingLevel, toZCodeReasoningLevel } from "./provider-config";
import { ToolRestrictions } from "../../session/tool-restrictions";
import type { CustomMessage } from "../../session/messages";
import type { AuthStorage } from "../../session/auth-storage";
import { createAuthStorageSettingsSync } from "../../session/auth-broker-config";
import type { MCPManager } from "../../mcp";
import { cfgMcpEnableProjectConfig, cfgMcpStartupTimeoutMs } from "../../mcp/settings";
import {
	prepareZCodeMcpManager,
	persistZCodeMcpConfiguration,
	restoreZCodeMcpConfiguration,
	forgetZCodeMcpConfiguration,
	zcodeMcpConfigurationIdentity,
	type ZCodeMcpConfigurationReference,
} from "./tool-config";
import { createExecutionPolicies, type ZCodeExecutionPolicies } from "./execution-policies";
import type { LegacyProtocol } from "./schema";
import type { ModelExecution, ModelExecutionSelectionFallbackReason } from "./schema/vendor/model-execution";
import type { ModelSelection } from "./schema/vendor/model-selection";
import { highspeedMessageMetaSchema, type HighspeedMessageMeta } from "./schema/vendor/highspeed";
import type {
	OffPeakControlParams,
	OffPeakControlResult,
	OffPeakLifecycleNotification,
} from "./schema/vendor/off-peak-execution";

import { adoptZCodeMemoryPreference, type ZCodeAdoptedMemory } from "./memory-telemetry";
import { cfgMemoryBackend } from "../../memory-backend/settings";
import { makeActorTranscriptStore, seedActorTranscript } from "./workflows/actor-transcript";
import type { AgentDefinition } from "../../task/types";
export type ZCodeCustomPrompt = Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">;
export type ZCodeExecutionSubmission = ModelExecution & { selection: ModelSelection; offPeakTaskId?: string };
type ZCodeInputOptions = PromptOptions & { inputId: string; highspeedMeta?: HighspeedMessageMeta };

/** Rebuild card facts from the selected native branch, never from the resident model. */
export function readHighspeedInputFacts(entries: readonly SessionEntry[]): Map<string, HighspeedMessageMeta> {
	const facts = new Map<string, HighspeedMessageMeta>();
	for (const entry of entries) {
		if (entry.type === "reset_boundary") facts.clear();
		if (
			entry.type !== "custom" ||
			(entry.customType !== "session_input" && entry.customType !== "input_highspeed_metrics") ||
			!entry.data ||
			typeof entry.data !== "object" ||
			!("inputId" in entry.data) ||
			typeof entry.data.inputId !== "string" ||
			!("highspeed" in entry.data)
		)
			continue;
		if (entry.customType === "session_input" && (!("state" in entry.data) || entry.data.state !== "admitted"))
			continue;
		if (entry.customType === "input_highspeed_metrics" && !facts.has(entry.data.inputId)) continue;
		const parsed = highspeedMessageMetaSchema.safeParse(entry.data.highspeed);
		if (parsed.success) facts.set(entry.data.inputId, parsed.data);
	}
	return facts;
}
export type ZCodeSessionCreateOptions = CreateAgentSessionOptions & {
	sessionId?: string;
	mcpServers?: readonly LegacyProtocol.ZCodeProtocolMcpServer[];
	toolAllowlist?: readonly string[];
	toolDenylist?: readonly string[];
	memoryEnabled?: boolean;
};
interface ZCodeSessionConfiguration {
	version: 1;
	mcp: ZCodeMcpConfigurationReference;
	toolAllowlist?: readonly string[];
	toolDenylist?: readonly string[];
	memory?: ZCodeAdoptedMemory;
}

export interface ZCodeSessionRecord {
	readonly id: string;
	readonly cwd: string;
	readonly session: AgentSession;
	readonly creationResult: CreateAgentSessionResult;
	readonly settings: Settings;
	readonly registry: AgentRegistry;
	readonly toolRestrictions: ToolRestrictions;
	readonly configuration: ZCodeSessionConfiguration;
	readonly resolveRequestAuth: NonNullable<CreateAgentSessionOptions["resolveRequestAuth"]>;
	readonly memory: ZCodeAdoptedMemory;
	/** Bind all runtime work to this session tree, across asynchronous boundaries. */
	run<T>(fn: () => T): T;
}

export interface ZCodeNativeChild {
	readonly root?: ZCodeSessionRecord;
	readonly agentId: string;
	readonly ref?: AgentRef;
	readonly session?: AgentSession;
	readonly file: string;
}

export interface ZCodeSessionManagerOptions {
	cwd: string;
	agentDir?: string;
	sessionDir?: string;
	sessionOptions?: CreateAgentSessionOptions;
	modelIoRetention?: (cwd: string) => boolean;
	onModelIoError?: (error: Error, sessionId: string) => void;
	onWorkflowActor?: (record: ZCodeSessionRecord) => Promise<void>;
	workflowInteractionUI?: (parentId: string) => CreateAgentSessionOptions["createInteractionUI"];
	memoryPreference?: (sessionId: string, cwd: string) => Promise<boolean | undefined>;
	onSessionClosed?: (sessionId: string) => void;
	runtimeTools?: (sessionId: string, cwd: string) => NonNullable<CreateAgentSessionOptions["customTools"]>;
	getAgentDefinitions?: (sessionId: string) => readonly AgentDefinition[];
	resolveRequestAuth?: (
		sessionId: string,
		cwd: string,
		model: Model,
		signal?: AbortSignal,
		context?: Parameters<NonNullable<CreateAgentSessionOptions["resolveRequestAuth"]>>[2],
	) => Promise<
		| {
				apiKey?: string;
				headers?: Record<string, string>;
		  }
		| undefined
	>;
	transformRequestPayload?: (
		sessionId: string,
		cwd: string,
		payload: unknown,
		model?: Model,
		signal?: AbortSignal,
		context?: Parameters<NonNullable<CreateAgentSessionOptions["transformRequestPayload"]>>[3],
	) => unknown | Promise<unknown>;
	onOffPeakEvent?: (notification: OffPeakLifecycleNotification) => void;
	onSelectionFallback?: (
		sessionId: string,
		inputId: string,
		fallback: { target: ModelSelection; reason: ModelExecutionSelectionFallbackReason },
	) => void;
}

export interface ZCodeInputSubmission {
	inputId: string;
	/** Resolves only at AgentSession's authoritative admission boundary. */
	admitted: Promise<void>;
	/** The actual prompt call, not an adapter execution queue. */
	completion: Promise<boolean>;
}

/** One process owner, many independent main sessions; OMP retains execution and persistence ownership. */
export class ZCodeSessionManager {
	readonly #records = new Map<string, ZCodeSessionRecord>();
	readonly #opening = new Map<string, Promise<ZCodeSessionRecord>>();
	readonly #closing = new Map<string, Promise<void>>();
	readonly #commandJournalReads = new Map<string, Set<Promise<readonly SessionEntry[]>>>();
	readonly #deletions = new Map<string, Promise<void>>();
	readonly #options: ZCodeSessionManagerOptions;
	readonly #agentDir: string;
	readonly #sessionDir: string;
	readonly #storage = new FileSessionStorage();
	readonly #modelIo = new Map<string, { cwd: string; capture: ZCodeModelIoRetention; unsubscribe: () => void }>();
	readonly #modelIoPreferences = new Map<string, boolean>();
	readonly #resources = new Map<string, { authStorage?: AuthStorage; mcpManager?: MCPManager }>();
	readonly #starting = new Set<AbortController>();
	readonly #executions = new Map<
		string,
		{ controller: AbortController; policy: ZCodeExecutionPolicies; completion: Promise<boolean> }
	>();
	#disposed = false;

	constructor(options: ZCodeSessionManagerOptions) {
		this.#options = options;
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#sessionDir = options.sessionDir ?? SessionManager.getDefaultSessionDir(options.cwd, this.#agentDir);
	}

	get(id: string): ZCodeSessionRecord | undefined {
		// 绑定完成前仅保留内部清理所有权，不能作为就绪会话暴露。
		if (this.#opening.has(id)) return undefined;
		return this.#records.get(id);
	}

	/** Native scoped UI identifies nested actors even while readiness hides their live record. */
	isNestedSession(id: string): boolean {
		return this.#records.get(id)?.creationResult.interactionUI !== undefined;
	}

	/** Resolve the native tree owner; viewing a child must never create a second runtime. */
	async nativeChild(id: string): Promise<ZCodeNativeChild | undefined> {
		if (this.#records.has(id)) return undefined;
		for (const root of this.#records.values()) {
			for (const ref of root.registry.list()) {
				if (ref.kind !== "sub" || ref.session?.sessionId !== id) continue;
				const file = ref.session.sessionManager.getSessionFile() ?? ref.sessionFile;
				if (file) return { root, agentId: ref.id, ref, session: ref.session, file };
			}
		}
		for (const info of await this.list()) {
			const children = await collectSubSessions(info.path);
			for (const [key, child] of Object.entries(children)) {
				if (child.header?.id !== id) continue;
				if (child.malformedRecords) throw new Error("Subagent history identity is invalid");
				const file = path.join(info.path.slice(0, -6), `${key}.jsonl`);
				const root = this.get(info.id);
				const candidate = root?.registry.get(child.agentId);
				const ref =
					candidate &&
					(candidate.session?.sessionId === id ||
						(candidate.sessionFile && path.resolve(candidate.sessionFile) === path.resolve(file)))
						? candidate
						: undefined;
				return { root, agentId: child.agentId, ref, session: ref?.session ?? undefined, file };
			}
		}
		return undefined;
	}

	/** Direct descendants and progress→session identity derive from the native journal and registry. */
	async childIdentities(id: string): Promise<Record<string, string>> {
		const info = await this.#find(id);
		const children = await collectSubSessions(info.path, key => {
			throw new Error(`Subagent history is unreadable: ${key}`);
		});
		const identities: Record<string, string> = {};
		for (const child of Object.values(children)) {
			if (child.parent !== null) continue;
			if (!child.header?.id || child.malformedRecords) throw new Error("Subagent history identity is invalid");
			identities[child.agentId] = child.header.id;
		}
		const native = await this.nativeChild(id);
		const root = this.get(id) ?? native?.root;
		const parentId = native?.agentId ?? root?.registry.list().find(ref => ref.session === root?.session)?.id ?? "Main";
		for (const ref of root?.registry.list() ?? []) {
			if (ref.kind === "sub" && (ref.parentId ?? "Main") === parentId && ref.session)
				identities[ref.id] = ref.session.sessionId;
		}
		return identities;
	}

	/** Existing-only lookup; a cold child never acquires a runtime or a writer lease. */
	async getAsyncJob(sessionId: string, workId: string): Promise<AsyncJob | undefined> {
		const visibleJob = (record: ZCodeSessionRecord) =>
			record.run(() => {
				const job = record.session.asyncJobManager?.getJob(workId);
				if (!job || job.foreground) return undefined;
				const tree = record.session.getAsyncJobTree({ recentLimit: Number.POSITIVE_INFINITY });
				return tree && [...tree.running, ...tree.recent].some(item => item.id === workId) ? job : undefined;
			});
		const direct = this.get(sessionId);
		const directJob = direct && visibleJob(direct);
		if (directJob) return directJob;

		// 冷子会话不在 #records 中，但后台工作仍由存活祖先的共享 manager 持有。
		// 必须同时确认原始 session 身份和 agent owner，不能按碰巧相同的 workId 跨树读取。
		for (const record of this.#records.values()) {
			const job = visibleJob(record);
			if (!job?.ownerId) continue;
			const ref = record.registry.get(job.ownerId);
			if (ref?.session?.sessionId === sessionId) return job;
			if (ref?.session) continue;
			const file = record.session.sessionManager.getSessionFile();
			if (!file) continue;
			const children = await collectSubSessions(file);
			if (this.get(record.id) !== record || record.registry.get(job.ownerId) !== ref) continue;
			if (
				Object.entries(children).some(
					([key, child]) =>
						child.header?.id === sessionId &&
						child.agentId === job.ownerId &&
						(!ref?.sessionFile ||
							path.resolve(ref.sessionFile) === path.resolve(file.slice(0, -6), `${key}.jsonl`)),
				)
			) {
				return visibleJob(record) === job ? job : undefined;
			}
		}
		return undefined;
	}

	async create(options: ZCodeSessionCreateOptions = {}): Promise<ZCodeSessionRecord> {
		this.#assertOpen();
		// A recreation waits outside #opening: the earlier deletion must never wait back on it.
		const deletion = options.sessionId ? this.#deletions.get(options.sessionId) : undefined;
		if (deletion) {
			await deletion;
			this.#assertOpen();
		}
		const key = options.sessionId ?? `creating-${crypto.randomUUID()}`;
		if (this.#opening.has(key) || this.#records.has(key)) throw new Error(`Session identity already active: ${key}`);
		const opening = (async () => {
			const cwd = path.resolve(options.cwd ?? this.#options.cwd);
			await this.#assertDirectory(cwd);
			if (options.sessionId && (await this.list()).some(info => info.id === options.sessionId)) {
				throw new Error(`Session identity already exists: ${options.sessionId}`);
			}
			this.#assertOpen();
			if (options.sessionId && this.#deletions.get(options.sessionId) === deletion) {
				this.#deletions.delete(options.sessionId);
			}
			const manager = SessionManager.create(cwd, this.#sessionDir, this.#storage, { sessionId: options.sessionId });
			return this.#host(manager, options);
		})();
		this.#opening.set(key, opening);
		try {
			return await opening;
		} finally {
			this.#opening.delete(key);
		}
	}

	async resume(
		id: string,
		options: Pick<
			ZCodeSessionCreateOptions,
			"additionalDirectories" | "mcpServers" | "toolAllowlist" | "toolDenylist"
		> = {},
	): Promise<ZCodeSessionRecord> {
		this.#assertOpen();
		const closing = this.#closing.get(id);
		if (closing) await closing;
		const live = this.get(id);
		if (live) {
			if (
				options.mcpServers !== undefined &&
				zcodeMcpConfigurationIdentity(options.mcpServers) !== live.configuration.mcp.identity
			) {
				throw new Error("Live session MCP configuration cannot be replaced by resume");
			}
			for (const key of ["toolAllowlist", "toolDenylist"] as const) {
				if (
					options[key] !== undefined &&
					JSON.stringify(options[key]) !== JSON.stringify(live.configuration[key])
				) {
					throw new Error("Live session tool policy cannot be replaced by resume");
				}
			}
			return live;
		}
		const pending = this.#opening.get(id);
		if (pending) return pending;
		const opening = (async () => {
			// 身份解析也属于同一次 opening；放在 flight 外 await 会错过已完成并清除的旧 flight，
			// 从而在同进程再次打开已由首个请求持有的 session 并触发 writer lease 冲突。
			// 子会话执行权属于原生 lifecycle；普通 resume 会建立第二个 root 并抢占 writer。
			if (await this.nativeChild(id)) throw new Error("Native child sessions are read-only; control them from their parent");
			const info = await this.#find(id);
			await this.#assertDirectory(info.cwd);
			const manager = await SessionManager.open(info.path, this.#sessionDir, this.#storage, {
				throwIfMissing: true,
				suppressBreadcrumb: true,
				initialCwd: info.cwd,
				runtimeOwnership: true,
			});
			if (manager.getSessionId() !== id || manager.getCwd() !== info.cwd) {
				await manager.close();
				throw new Error("Session identity or bound working directory changed during restore");
			}
			return this.#host(manager, options);
		})();
		this.#opening.set(id, opening);
		try {
			return await opening;
		} finally {
			this.#opening.delete(id);
		}
	}

	async createSelectionSideSession(parentId: string): Promise<ZCodeSessionRecord> {
		this.#assertOpen();
		const parent = this.get(parentId);
		if (parent) await parent.session.sessionManager.flush();
		const info = await this.#find(parentId);
		const manager = await SessionManager.forkFrom(info.path, info.cwd, this.#sessionDir, this.#storage, {
			suppressBreadcrumb: true,
		});
		manager.appendCustomEntry("zcode_fork_boundary", {
			sessionId: manager.getSessionId(),
			entryId: manager.getBranch().at(-1)?.id,
		});
		await manager.flush();
		return this.#host(
			manager,
			{
				model: parent?.session.model,
				thinkingLevel: parent?.session.thinkingLevel,
				additionalDirectories: parent?.session.sessionManager.getHeader()?.additionalDirectories,
			},
			parent?.settings,
		);
	}

	/** Workflow actors use the same native factory and isolated runtime ownership as main sessions. */
	async createWorkflowActor(
		parent: ZCodeSessionRecord,
		options: {
			sessionId: string;
			model?: Model;
			thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
			requireExisting?: boolean;
			systemPrompt?: CreateAgentSessionOptions["systemPrompt"];
			customTools?: CreateAgentSessionOptions["customTools"];
			agentId: string;
			agentDisplayName?: string;
			seed?: { sessionId: string; messageCount: number };
		},
	): Promise<ZCodeSessionRecord> {
		this.#assertOpen();
		const live = this.get(options.sessionId);
		if (live) return live;
		if (this.#opening.has(options.sessionId)) return this.#opening.get(options.sessionId)!;
		const opening = (async () => {
			if (options.seed) await this.get(options.seed.sessionId)?.session.sessionManager.flush();
			const existing = (await this.list()).find(info => info.id === options.sessionId);
			// journal 已绑定的 actor 丢失上下文时必须失败，不能用同 ID 新建空会话伪装恢复。
			if (options.requireExisting && !existing) throw new Error("Persisted workflow actor session is unavailable");
			if (existing && existing.cwd !== parent.cwd) throw new Error("Workflow actor working directory changed");
			const manager = existing
				? await SessionManager.open(existing.path, this.#sessionDir, this.#storage, {
						throwIfMissing: true,
						suppressBreadcrumb: true,
						initialCwd: parent.cwd,
						runtimeOwnership: true,
					})
				: SessionManager.create(parent.cwd, this.#sessionDir, this.#storage, { sessionId: options.sessionId });
			try {
				if (options.seed)
					await seedActorTranscript({
						seed: { sourceSessionId: options.seed.sessionId, messageCount: options.seed.messageCount },
						store: makeActorTranscriptStore(this),
						target: manager,
						targetSessionId: options.sessionId,
					});
			} catch (error) {
				await manager.close();
				throw error;
			}
			// Native delivered input retains the per-turn restrictions through queue promotion.
			const currentInput = parent.session.state.messages.findLast(message => message.role === "user") as
				| (AgentMessage & { toolDenylist?: readonly string[] })
				| undefined;
			const restricted = this.#options.sessionOptions?.restrictToolNames === true;
			const actorTools = restricted
				? (options.customTools ?? []).filter(tool => tool.name === "submit_result" || tool.name === "escalate")
				: options.customTools;
			const record = await this.#host(
				manager,
				{
					...options,
					...(restricted
						? {
								allowRestrictedCustomTools: true,
								toolNames: [
									...new Set([
										...(this.#options.sessionOptions?.toolNames ?? []),
										...(actorTools ?? []).map(tool => tool.name),
									]),
								],
							}
						: {}),
					customTools: actorTools,
					cwd: parent.cwd,
					model: options.model ?? parent.session.model,
					thinkingLevel: options.thinkingLevel ?? parent.session.thinkingLevel,
					additionalDirectories: parent.session.sessionManager.getHeader()?.additionalDirectories,
					mcpServers: restoreZCodeMcpConfiguration(
						parent.session.modelRegistry.authStorage,
						parent.configuration.mcp,
					),
					toolAllowlist: parent.configuration.toolAllowlist
						? [...parent.configuration.toolAllowlist, ...(actorTools ?? []).map(tool => tool.name)]
						: undefined,
					toolDenylist: [
						...new Set([...(parent.configuration.toolDenylist ?? []), ...(currentInput?.toolDenylist ?? [])]),
					],
					memoryEnabled: parent.memory.memoryEnabled,
					resolveRequestAuth: parent.resolveRequestAuth,
					createInteractionUI: this.#options.workflowInteractionUI?.(parent.id),
					interactionParentSessionId: parent.id,
					parentTaskPrefix: options.agentId,
					taskDepth: 1,
					autoTitle: false,
				},
				parent.settings,
			);
			await this.#options.onWorkflowActor?.(record);
			this.#assertOpen();
			if (this.#records.get(record.id) !== record) throw new Error("Workflow actor closed during binding");
			return record;
		})();
		this.#opening.set(options.sessionId, opening);
		try {
			return await opening;
		} finally {
			this.#opening.delete(options.sessionId);
		}
	}

	disposeHeldQueue(id: string, expectedIds: string[], disposition: "clearQueueAndSend" | "keepQueueAndSend"): void {
		const record = this.#require(id);
		record.run(() => record.session.disposeHeldQueue(expectedIds, disposition));
	}

	async #host(
		manager: SessionManager,
		options: ZCodeSessionCreateOptions,
		inheritedSettings?: Settings,
	): Promise<ZCodeSessionRecord> {
		let result: CreateAgentSessionResult | undefined;
		let capture: ZCodeModelIoRetention | undefined;
		let settings: Settings | undefined;
		let ownedAuthStorage: AuthStorage | undefined;
		let ownedMcpManager: MCPManager | undefined;
		const controller = new AbortController();
		this.#starting.add(controller);
		try {
			this.#assertOpen();
			manager.acquireRuntimeOwnership();
			const cwd = manager.getCwd();
			settings = inheritedSettings
				? await inheritedSettings.cloneForCwd(cwd)
				: await Settings.loadIsolated({ cwd, agentDir: this.#agentDir });
			const sessionSettings = settings;
			const registry = new AgentRegistry();
			const run = <T>(fn: () => T): T =>
				AgentRegistry.runScoped(registry, () => withActiveSettings(sessionSettings, fn));
			capture = new ZCodeModelIoRetention({
				sessionId: manager.getSessionId(),
				artifacts: () => manager.getArtifactManager(),
				onError: error => {
					if (this.#options.onModelIoError) this.#options.onModelIoError(error, manager.getSessionId());
					else process.stderr.write(`Model IO capture failed: ${error.message}\n`);
				},
			});
			capture.setEnabled(this.#modelIoPreferences.get(cwd) ?? this.#options.modelIoRetention?.(cwd) ?? false);
			const captureForSession = capture;
			const supplied = { ...this.#options.sessionOptions, ...options };
			const resolveRequestAuth: NonNullable<CreateAgentSessionOptions["resolveRequestAuth"]> = (model, signal, context) =>
				supplied.interactionParentSessionId && supplied.resolveRequestAuth
					? supplied.resolveRequestAuth(model, signal, context)
					: this.#options.resolveRequestAuth
						? this.#options.resolveRequestAuth(manager.getSessionId(), cwd, model, signal, context)
						: (supplied.resolveRequestAuth?.(model, signal, context) ?? Promise.resolve(undefined));
			const authStorage =
				supplied.authStorage ??
				supplied.modelRegistry?.authStorage ??
				(ownedAuthStorage = await discoverAuthStorage(this.#agentDir, { settings, cwd }));
			const stored = manager
				.getEntries()
				.findLast(entry => entry.type === "custom" && entry.customType === "zcode_session_configuration");
			const previous = stored?.type === "custom" ? (stored.data as ZCodeSessionConfiguration) : undefined;
			const mcpServers =
				options.mcpServers ?? (previous ? restoreZCodeMcpConfiguration(authStorage, previous.mcp) : undefined);
			const toolAllowlist = options.toolAllowlist ?? previous?.toolAllowlist;
			const toolDenylist = options.toolDenylist ?? previous?.toolDenylist;
			if (previous?.memory) cfgMemoryBackend.override(sessionSettings, previous.memory.backend);
			const memory = adoptZCodeMemoryPreference(
				sessionSettings,
				options.memoryEnabled ??
					previous?.memory?.memoryEnabled ??
					(await this.#options.memoryPreference?.(manager.getSessionId(), cwd)),
			);
			const toolRestrictions = new ToolRestrictions({ allowlist: toolAllowlist, denylist: toolDenylist });
			if (supplied.enableMCP !== false && !supplied.restrictToolNames) {
				ownedMcpManager = await run(() =>
					prepareZCodeMcpManager({
						cwd,
						servers: mcpServers,
						authStorage,
						signal: controller.signal,
						discoverOptions: {
							enableProjectConfig: cfgMcpEnableProjectConfig.get(sessionSettings),
							startupTimeoutMs: cfgMcpStartupTimeoutMs.get(sessionSettings),
							filterExa: true,
							extensionRoots: supplied.extensionRoots?.(),
						},
					}),
				);
			} else if (mcpServers?.length) throw new Error("MCP servers cannot be enabled in a restricted session");
			// The Host creates a durable session, unlike the TUI's lazy draft. SDK startup
			// may read its journal, so materialize it under the existing writer lease first.
			await manager.ensureOnDisk();
			result = await run(() =>
				createAgentSession({
					...this.#options.sessionOptions,
					...options,
					cwd,
					agentDir: this.#agentDir,
					settings,
					settingsManager: undefined,
					sessionManager: manager,
					agentRegistry: registry,
					agentId: supplied.agentId ?? "Main",
					bindProcessState: false,
					getAgentDefinitions: this.#options.getAgentDefinitions
						? () => this.#options.getAgentDefinitions!(manager.getSessionId())
						: supplied.getAgentDefinitions,
					// Register human-input tools before attaching the non-terminal Host UI.
					interactivePrompts: true,
					parentTaskPrefix: supplied.parentTaskPrefix,
					taskDepth: supplied.taskDepth ?? 0,
					authStorage,
					toolRestrictions,
					toolNames: toolAllowlist === undefined ? supplied.toolNames : [...toolAllowlist],
					customTools: [
						...(supplied.customTools ?? []),
						...(supplied.interactionParentSessionId && supplied.restrictToolNames
							? []
							: (this.#options.runtimeTools?.(manager.getSessionId(), cwd) ?? [])),
					],
					mcpManager: ownedMcpManager,
					ownMcpManager: true,
					mcpTools: ownedMcpManager?.getTools(),
					onPayload: async (payload, model, signal) => {
						await supplied.onPayload?.(payload, model, signal);
						await captureForSession.onPayload?.(payload, model, signal);
					},
					onResponse: async (response, model, signal) => {
						await supplied.onResponse?.(response, model, signal);
						await captureForSession.onResponse?.(response, model, signal);
					},
					onModelResponse: async (message, model, signal) => {
						await supplied.onModelResponse?.(message, model, signal);
						captureForSession.onModelResponse(message, model, signal);
					},
					resolveRequestAuth,
					transformRequestPayload: async (payload, model, signal, context) => {
						const mapped = supplied.transformRequestPayload
							? await supplied.transformRequestPayload(payload, model, signal, context)
							: payload;
						return this.#options.transformRequestPayload
							? this.#options.transformRequestPayload(manager.getSessionId(), cwd, mapped, model, signal, context)
							: mapped;
					},
				}),
			);
			this.#assertOpen();
			const configuration: ZCodeSessionConfiguration = {
				version: 1,
				mcp: await persistZCodeMcpConfiguration(authStorage, manager.getSessionId(), cwd, mcpServers),
				toolAllowlist,
				toolDenylist,
				memory,
			};
			manager.appendCustomEntry("zcode_session_configuration", configuration);
			await manager.flush();
			const record: ZCodeSessionRecord = {
				id: manager.getSessionId(),
				cwd,
				settings,
				registry,
				session: result.session,
				creationResult: result,
				run,
				toolRestrictions,
				configuration,
				resolveRequestAuth,
				memory,
			};
			const unsubscribe = record.run(() =>
				record.session.subscribe(event => {
					if (event.type !== "message_end") return;
					const message = event.message as AgentMessage & {
						inputId?: string;
						sourceCommand?: PromptOptions["sourceCommand"];
					};
					if (!message.inputId) return;
					const entry = manager
						.getEntries()
						.findLast(
							item =>
								item.type === "message" &&
								(item.message as AgentMessage & { inputId?: string }).inputId === message.inputId,
						);
					void this.#recordInputState(record, message.inputId, "promoted", message.sourceCommand, entry?.id).catch(
						error => process.stderr.write(`Input promotion receipt failed: ${String(error)}\n`),
					);
				}),
			);
			this.#modelIo.set(record.id, { cwd, capture: captureForSession, unsubscribe });
			this.#resources.set(record.id, { authStorage: ownedAuthStorage, mcpManager: ownedMcpManager });
			if (ownedAuthStorage) createAuthStorageSettingsSync(record.session, ownedAuthStorage);
			this.#records.set(record.id, record);
			return record;
		} catch (error) {
			if (result) await result.session.dispose();
			else await manager.close();
			await capture?.close();
			settings?.cancelPendingSaves();
			await ownedMcpManager?.disconnectAll();
			ownedAuthStorage?.close();
			throw error;
		} finally {
			this.#starting.delete(controller);
		}
	}

	async list(): Promise<SessionInfo[]> {
		const local = await SessionManager.list(this.#options.cwd, this.#sessionDir, this.#storage);
		if (path.resolve(this.#agentDir) !== path.resolve(getAgentDir())) return local;
		const all = await SessionManager.listAll(this.#storage);
		const merged = new Map(all.map(info => [info.id, info]));
		for (const info of local) merged.set(info.id, info);
		return [...merged.values()];
	}

	/** Resolve native ID/path linkage and the inherited boundary without IO in the projection. */
	async forkProjection(id: string): Promise<{ parentSessionId?: string; inheritedMessageCount?: number }> {
		const live = this.#records.get(id);
		const info = live ? undefined : await this.#find(id);
		const loaded = live ? undefined : await loadEntriesFromFile(info!.path, this.#storage, { throwIfMissing: true });
		const header = live?.session.sessionManager.getHeader() ?? loaded?.find(entry => entry.type === "session");
		const linkage = header?.parentSession;
		if (!linkage) return {};
		const journal = live
			? live.session.sessionManager.getBranch()
			: loaded!.filter((entry): entry is SessionEntry => entry.type !== "session");
		const byId = new Map(journal.map(entry => [entry.id, entry]));
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		let leaf = journal.at(-1);
		while (leaf) {
			if (visited.has(leaf.id)) throw new Error("Cycle in session history");
			visited.add(leaf.id);
			branch.push(leaf);
			leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId);
		}
		branch.reverse();
		let inheritedEntryId: string | undefined;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== "zcode_fork_boundary") continue;
			const data = entry.data;
			if (
				data &&
				typeof data === "object" &&
				"sessionId" in data &&
				data.sessionId === id &&
				"entryId" in data &&
				typeof data.entryId === "string"
			) {
				inheritedEntryId = data.entryId;
				break;
			}
		}
		const pathLinkage = path.isAbsolute(linkage) || path.win32.isAbsolute(linkage) || /[\\/]/.test(linkage);
		let parentSessionId = pathLinkage ? undefined : linkage;
		if (pathLinkage || !inheritedEntryId) {
			const parentPath = pathLinkage ? linkage : (await this.#find(linkage)).path;
			const parent = await loadEntriesFromFile(parentPath, this.#storage, { throwIfMissing: true });
			parentSessionId = parent.find(entry => entry.type === "session")?.id;
			if (!inheritedEntryId) {
				const parentIds = new Set(parent.map(entry => entry.id));
				inheritedEntryId = branch.findLast(entry => parentIds.has(entry.id))?.id;
			}
		}
		const boundaryIndex = branch.findIndex(entry => entry.id === inheritedEntryId);
		const resetIndex = branch.findLastIndex(entry => entry.type === "reset_boundary");
		const inheritedMessageCount =
			boundaryIndex > resetIndex
				? branch
						.slice(resetIndex + 1, boundaryIndex + 1)
						.filter(entry => entry.type === "message" || (entry.type === "custom_message" && entry.display))
						.length
				: 0;
		return { parentSessionId, inheritedMessageCount };
	}

	/** Existing-only journal facts; never constructs a session manager or takes its writer lease. */
	async readEntries(id: string): Promise<readonly SessionEntry[]> {
		const info = await this.#find(id);
		const entries = await loadEntriesFromFile(info.path, this.#storage, { throwIfMissing: true });
		return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	}

	/**
	 * Ledger scans may outlive their list snapshot. Pin each journal read against local deletion;
	 * a completed deletion is absence, not unreadable history. Real read/delete failures still reject.
	 */
	async readCommandEntries(id: string): Promise<readonly SessionEntry[] | undefined> {
		const deletion = this.#deletions.get(id);
		if (deletion) {
			await deletion;
			return undefined;
		}
		const read = this.readEntries(id);
		let readers = this.#commandJournalReads.get(id);
		if (!readers) {
			readers = new Set();
			this.#commandJournalReads.set(id, readers);
		}
		readers.add(read);
		try {
			return await read;
		} finally {
			readers.delete(read);
			if (readers.size === 0) this.#commandJournalReads.delete(id);
		}
	}

	applyModelIoPreferences(cwd: string, enabled: boolean): number {
		const key = path.resolve(cwd);
		this.#modelIoPreferences.set(key, enabled);
		let changed = 0;
		for (const value of this.#modelIo.values()) {
			if (path.resolve(value.cwd) !== key) continue;
			value.capture.setEnabled(enabled);
			changed++;
		}
		return changed;
	}

	async recordInputAdmission(
		id: string,
		inputId: string,
		sourceCommand?: PromptOptions["sourceCommand"],
		highspeedMeta?: HighspeedMessageMeta,
	): Promise<void> {
		const record = this.#require(id);
		await this.#recordInputState(record, inputId, "admitted", sourceCommand, undefined, highspeedMeta);
	}

	async #recordInputState(
		record: ZCodeSessionRecord,
		inputId: string,
		state: "admitted" | "promoted" | "cancelled" | "failed",
		sourceCommand?: PromptOptions["sourceCommand"],
		entryId?: string,
		highspeedMeta?: HighspeedMessageMeta,
	): Promise<void> {
		await record.run(async () => {
			const queued = record.session
				.getQueuedInputMessages()
				.some(message => (message as AgentMessage & { inputId?: string }).inputId === inputId);
			const guided = record.session.agent
				.peekSteeringQueue()
				.some(message => (message as AgentMessage & { inputId?: string }).inputId === inputId);
			const delivery = state === "admitted" ? (queued ? (guided ? "guide" : "queue") : "startNow") : undefined;
			record.session.sessionManager.appendCustomEntry("session_input", {
				inputId,
				state,
				sourceCommand,
				entryId,
				delivery,
				// 卡属于已接受的 inputId，不属于当前模型；拒绝的输入绝不能制造卡事实。
				...(highspeedMeta ? { highspeed: highspeedMessageMetaSchema.parse(highspeedMeta) } : {}),
			});
			await record.session.sessionManager.flush();
		});
	}

	async #find(id: string): Promise<SessionInfo> {
		const info = (await this.list()).find(item => item.id === id);
		if (info) return info;
		const child = await this.nativeChild(id);
		await child?.session?.sessionManager.flush();
		const persisted = child ? await readSessionInfo(child.file) : undefined;
		if (!persisted || persisted.id !== id) throw new Error(`Session not found: ${id}`);
		return persisted;
	}

	async read(id: string): Promise<{
		id: string;
		cwd: string;
		title?: string;
		messages: AgentMessage[];
		entries: SessionEntry[];
		info: SessionInfo;
	}> {
		const info = await this.#find(id);
		// No writable manager, lease, Goal restore, or registry registration on a history read.
		const entries = await loadEntriesFromFile(info.path, this.#storage, { throwIfMissing: true });
		await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
		const journal = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const byId = new Map(journal.map(entry => [entry.id, entry]));
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		let entry: SessionEntry | undefined = journal[journal.length - 1];
		while (entry) {
			if (visited.has(entry.id)) throw new Error("Cycle in session history");
			visited.add(entry.id);
			branch.push(entry);
			entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
		}
		const messages: AgentMessage[] = [];
		for (const item of branch.reverse()) {
			if (item.type === "reset_boundary") messages.length = 0;
			if (item.type === "message") messages.push(item.message);
			else if (item.type === "custom_message" && item.display)
				messages.push({
					role: "custom",
					customType: item.customType,
					content: item.content,
					display: true,
					details: item.details,
					timestamp: new Date(item.timestamp).getTime(),
				});
		}
		const boundary = branch.findLastIndex(item => item.type === "reset_boundary");
		return {
			id,
			cwd: info.cwd,
			title: info.title,
			messages,
			entries: boundary < 0 ? branch : branch.slice(boundary + 1),
			info,
		};
	}

	submit(id: string, text: string, options: ZCodeInputOptions): ZCodeInputSubmission {
		this.#executions.get(id)?.policy.userTakeover();
		const record = this.#require(id);
		return this.#beginSubmission(id, options, admitted =>
			record.session.prompt(text, { ...options, throwOnDrop: true, onPromptAdmitted: admitted }),
		);
	}

	submitCustom(
		id: string,
		message: ZCodeCustomPrompt,
		options: ZCodeInputOptions & { queueChipText?: string },
		execution?: ZCodeExecutionSubmission,
	): ZCodeInputSubmission {
		const start = (scoped: ZCodeInputOptions) =>
			this.#beginSubmission(id, scoped, admitted =>
				this.#require(id).session.promptCustomMessage(message, {
					...scoped,
					queueChipText: options.queueChipText,
					onPromptAdmitted: admitted,
				}),
			);
		if (execution) return this.#execute(id, options, execution, start);
		this.#executions.get(id)?.policy.userTakeover();
		return start(options);
	}

	submitExecution(
		id: string,
		text: string,
		options: ZCodeInputOptions,
		execution: ZCodeExecutionSubmission,
	): ZCodeInputSubmission {
		return this.#execute(id, options, execution, scoped =>
			this.#beginSubmission(id, scoped, admitted =>
				this.#require(id).session.prompt(text, { ...scoped, throwOnDrop: true, onPromptAdmitted: admitted }),
			),
		);
	}

	offPeakControl(params: OffPeakControlParams): OffPeakControlResult {
		return this.#executions.get(params.sessionId)?.policy.offPeakControl(params) ?? { accepted: false };
	}

	#beginSubmission(
		id: string,
		options: ZCodeInputOptions,
		start: (admitted: () => void) => Promise<boolean>,
	): ZCodeInputSubmission {
		this.#assertOpen();
		const record = this.#require(id);
		let accepted = false;
		const { promise: admitted, resolve, reject } = Promise.withResolvers<void>();
		const completion = record.run(() =>
			start(() => {
				// held CAS 必须先成功；先记 admitted 会把回调异常误报为 accepted，
				// Host 清空输入框后却没有 user row，且无法按失败 ACK 恢复输入。
				options.onPromptAdmitted?.();
				accepted = true;
				void this.recordInputAdmission(id, options.inputId, options.sourceCommand, options.highspeedMeta).then(
					resolve,
					reject,
				);
			}),
		);
		void completion.then(
			() => {
				if (!accepted) reject(new Error("Input completed without runtime admission"));
			},
			error => {
				if (!accepted) reject(error);
				else if (this.get(id) === record) {
					void this.#recordInputState(record, options.inputId, "failed", options.sourceCommand).catch(
						receiptError => process.stderr.write(`Input failure receipt failed: ${String(receiptError)}\n`),
					);
				}
			},
		);
		// Callers may only observe completion (or disconnect before admission).
		void admitted.catch(() => {});
		return { inputId: options.inputId, admitted, completion };
	}

	#execute(
		id: string,
		options: ZCodeInputOptions,
		execution: ZCodeExecutionSubmission,
		start: (scoped: ZCodeInputOptions) => ZCodeInputSubmission | Promise<ZCodeInputSubmission>,
	): ZCodeInputSubmission {
		this.#assertOpen();
		const record = this.#require(id);
		if (record.session.isBusyForSnapshot || record.session.hasPendingAsyncWork() || this.#executions.has(id)) {
			throw new Error("Execution materials require an idle session");
		}
		if (execution.offPeak && !this.#options.onOffPeakEvent)
			throw new Error("Off-peak lifecycle transport is unavailable");
		const controller = new AbortController();
		let activeSelection = execution.selection;
		const resident = record.session.model;
		const capturedSelection: ModelSelection | undefined = resident && {
			providerId: resident.provider,
			modelId: resident.id,
			...(record.session.thinkingLevel
				? { options: { reasoningLevel: toZCodeReasoningLevel(record.session.thinkingLevel) } }
				: {}),
		};
		const policy = createExecutionPolicies({
			sessionId: id,
			execution,
			capturedSelection,
			offPeakTaskId: execution.offPeakTaskId,
			signal: controller.signal,
			onOffPeakEvent: notification => this.#options.onOffPeakEvent?.(notification),
			onCancel: () => {
				controller.abort(new Error("Execution cancelled"));
				void record.session.abort();
			},
			onSelectionFallback: fallback => {
				record.session.sessionManager.appendCustomEntry("input_model_selection_fallback", {
					inputId: options.inputId,
					sourceCommand: options.sourceCommand,
					...fallback,
				});
				this.#options.onSelectionFallback?.(id, options.inputId, fallback);
			},
		});
		const resolveAuth: NonNullable<CreateAgentSessionOptions["resolveRequestAuth"]> = async (model, signal) => {
			controller.signal.throwIfAborted();
			const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			requestSignal.throwIfAborted();
			const material = policy.requestAuth;
			if (material && model.provider === activeSelection.providerId && model.id === activeSelection.modelId) {
				return { apiKey: material.apiKey, headers: material.headers };
			}
			const supplied = await record.resolveRequestAuth(model, requestSignal);
			if (supplied) return supplied;
			const apiKey = await record.session.modelRegistry.getApiKey(model, id, { signal: requestSignal });
			return apiKey ? { apiKey } : undefined;
		};
		const { promise: admitted, resolve, reject } = Promise.withResolvers<void>();
		const completion = record
			.run(async () => {
				let model = record.session.modelRegistry.find(activeSelection.providerId, activeSelection.modelId);
				if (!model) {
					const fallback = policy.recoverSelectionUnavailable(activeSelection.providerId);
					if (fallback) activeSelection = fallback.target;
					model = record.session.modelRegistry.find(activeSelection.providerId, activeSelection.modelId);
				}
				if (!model) throw new Error("Execution model selection is unavailable");
				const thinking = activeSelection.options?.reasoningLevel;
				const thinkingLevel = thinking === undefined ? undefined : parseZCodeThinkingLevel(thinking);
				if (thinking !== undefined && thinkingLevel === undefined)
					throw new Error("Execution reasoning level is unavailable");
				return record.session.withExecutionModel(
					{
						model,
						thinkingLevel,
						signal: controller.signal,
						resolveRequestAuth: resolveAuth,
						policies: { memoryExtraction: execution.memoryExtraction, subagents: execution.subagents },
						recoverModelRequest: async ({ model: failedModel, error, signal }) => {
							const failure =
								error && typeof error === "object"
									? (error as {
											providerErrorCode?: unknown;
											code?: unknown;
											stopReason?: string;
											stopDetails?: { providerErrorCode?: unknown; code?: unknown };
											role?: string;
										})
									: undefined;
							const code =
								failure?.providerErrorCode ??
								failure?.stopDetails?.providerErrorCode ??
								failure?.code ??
								failure?.stopDetails?.code;
							const recovery = await policy.recover({
								providerId: activeSelection.providerId,
								providerErrorCode: typeof code === "string" ? code : undefined,
								cancelled: signal?.aborted || controller.signal.aborted || failure?.stopReason === "aborted",
								contextOverflow:
									failure?.role === "assistant" &&
									AIError.isContextOverflow(error as AssistantMessage, failedModel.contextWindow ?? undefined),
							});
							if (!recovery) return undefined;
							if (recovery.kind === "fallback") activeSelection = recovery.target;
							const replacement = record.session.modelRegistry.find(
								activeSelection.providerId,
								activeSelection.modelId,
							);
							if (!replacement) throw new Error("Recovery model selection is unavailable");
							const level = activeSelection.options?.reasoningLevel;
							return {
								model: replacement,
								thinkingLevel: level === undefined ? undefined : parseZCodeThinkingLevel(level),
								resolveRequestAuth: resolveAuth,
							};
						},
					},
					async () => {
						const submission = await start({
							...options,
							onPromptAdmitted: () => {
								policy.start();
								options.onPromptAdmitted?.();
							},
						});
						void submission.admitted.then(resolve, reject);
						const result = await submission.completion;
						while (record.session.hasPendingAsyncWork() && !controller.signal.aborted) {
							policy.setBackgroundWaiting(true);
							const interrupted = Promise.withResolvers<never>();
							const abortWait = () => interrupted.reject(controller.signal.reason);
							controller.signal.addEventListener("abort", abortWait, { once: true });
							try {
								controller.signal.throwIfAborted();
								await Promise.race([record.session.settleAsyncWork(), interrupted.promise]);
							} finally {
								controller.signal.removeEventListener("abort", abortWait);
							}
						}
						policy.setBackgroundWaiting(false);
						return result;
					},
				);
			})
			.then(
				result => {
					const last = record.session.getLastAssistantMessage();
					policy.complete(
						controller.signal.aborted || last?.stopReason === "aborted"
							? "stopped"
							: last?.stopReason === "error"
								? "failed"
								: "succeeded",
					);
					return result;
				},
				error => {
					reject(error);
					policy.complete(controller.signal.aborted ? "stopped" : "failed");
					throw error;
				},
			)
			.finally(() => {
				if (this.#executions.get(id)?.controller === controller) this.#executions.delete(id);
			});
		this.#executions.set(id, { controller, policy, completion });
		void admitted.catch(() => {});
		void completion.catch(() => {});
		return { inputId: options.inputId, admitted, completion };
	}

	async rename(id: string, title: string): Promise<void> {
		this.#assertOpen();
		const live = this.get(id);
		if (live) {
			await live.session.sessionManager.setSessionName(title, "user");
			return;
		}
		const info = await this.#find(id);
		const manager = await SessionManager.open(info.path, this.#sessionDir, this.#storage, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
			runtimeOwnership: true,
		});
		try {
			manager.acquireRuntimeOwnership();
			await manager.setSessionName(title, "user");
			await manager.flush();
		} finally {
			await manager.close();
		}
	}

	delete(id: string): Promise<void> {
		const existing = this.#deletions.get(id);
		if (existing) return existing;
		const deletion = this.#delete(id).catch(error => {
			this.#deletions.delete(id);
			throw error;
		});
		this.#deletions.set(id, deletion);
		return deletion;
	}

	async #delete(id: string): Promise<void> {
		this.#assertOpen();
		// Only openings admitted before this deletion belong to the generation being removed.
		const opening = this.#opening.get(id);
		// Readers admitted before deletion own their snapshot until the file read completes.
		await Promise.allSettled(this.#commandJournalReads.get(id) ?? []);
		if (opening) await opening;
		await this.close(id);
		const info = await this.#find(id);
		const manager = await SessionManager.open(info.path, this.#sessionDir, this.#storage, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
			runtimeOwnership: true,
		});
		try {
			manager.acquireRuntimeOwnership();
			await this.#storage.deleteSessionWithArtifacts(info.path);
			const stored = manager
				.getEntries()
				.findLast(entry => entry.type === "custom" && entry.customType === "zcode_session_configuration");
			const configuration = stored?.type === "custom" ? (stored.data as ZCodeSessionConfiguration) : undefined;
			if (configuration?.mcp.credentialProvider) {
				const supplied = this.#options.sessionOptions;
				const settings = await Settings.loadIsolated({ cwd: info.cwd, agentDir: this.#agentDir });
				const provided = supplied?.authStorage ?? supplied?.modelRegistry?.authStorage;
				const authStorage = provided ?? (await discoverAuthStorage(this.#agentDir, { settings, cwd: info.cwd }));
				try {
					await forgetZCodeMcpConfiguration(authStorage, configuration.mcp);
				} finally {
					if (!provided) authStorage.close();
					settings.cancelPendingSaves();
				}
			}
		} finally {
			manager.seal();
			await manager.close();
		}
	}

	async stop(id: string): Promise<void> {
		const record = this.#require(id);
		this.#executions.get(id)?.controller.abort(new Error("Session stopped"));
		const queued = record.session
			.getQueuedInputMessages()
			.map(
				message => message as AgentMessage & { inputId?: string; sourceCommand?: PromptOptions["sourceCommand"] },
			);
		await record.run(() => record.session.abort({ preserveQueuedInputs: true }));
		const remaining = new Set(
			record.session
				.getQueuedInputMessages()
				.map(message => (message as AgentMessage & { inputId?: string }).inputId),
		);
		const promoted = new Set(
			record.session.sessionManager
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" ? [(entry.message as AgentMessage & { inputId?: string }).inputId] : [],
				),
		);
		for (const input of queued) {
			if (input.inputId && !remaining.has(input.inputId) && !promoted.has(input.inputId)) {
				await this.#recordInputState(record, input.inputId, "cancelled", input.sourceCommand);
			}
		}
	}

	/** Protocol mutations resolve their row target to an OMP journal entry before calling this owner. */
	async mutate(
		id: string,
		type: string,
		payload: {
			entryId?: string;
			queueItemId?: string;
			newText?: string;
			beforeQueueItemId?: string | null;
			autoDrain?: boolean;
			mode?: string;
			inputId?: string;
			images?: PromptOptions["images"];
			attachments?: PromptOptions["attachments"];
			sourceCommand?: PromptOptions["sourceCommand"];
			execution?: ZCodeExecutionSubmission;
			highspeedMeta?: HighspeedMessageMeta;
			highspeedMetrics?: Pick<
				HighspeedMessageMeta,
				| "regularTps"
				| "outputTokens"
				| "durationMs"
				| "highspeedTps"
				| "savedDurationMs"
				| "modelDurationMs"
				| "toolDurationMs"
				| "otherDurationMs"
			>;
			toolDenylist?: readonly string[];
		},
		promoteQueuedCommand?: (inputId: string) => Promise<void>,
	): Promise<unknown> {
		const record = this.#require(id);
		return record.run(async () => {
			if (payload.execution && (record.session.isBusyForSnapshot || record.session.hasPendingAsyncWork())) {
				throw new Error("Execution materials require an idle session");
			}
			if (type === "sendQueuedNow" && record.session.isStreaming && promoteQueuedCommand) {
				if (!payload.queueItemId) throw new Error("Queue input identity is required");
				if (
					!record.session
						.getQueuedInputMessages()
						.some(message => (message as AgentMessage & { inputId?: string }).inputId === payload.queueItemId)
				)
					throw new Error("Queue item was already delivered or removed");
				await promoteQueuedCommand(payload.queueItemId);
				// A native control-only command may consume its queued input without a model prompt.
				if (
					!record.session
						.getQueuedInputMessages()
						.some(message => (message as AgentMessage & { inputId?: string }).inputId === payload.queueItemId)
				)
					return { queueItemId: payload.queueItemId };
			}
			if (
				type === "sendQueuedNow" &&
				(payload.execution || (!record.session.isBusyForSnapshot && !record.session.hasPendingAsyncWork()))
			) {
				if (!payload.queueItemId) throw new Error("Queue input identity is required");
				const queued = record.session
					.getQueuedInputMessages()
					.find(message => (message as AgentMessage & { inputId?: string }).inputId === payload.queueItemId);
				if (!queued) throw new Error("Queue item was already delivered or removed");
				const source = queued as AgentMessage & {
					sourceCommand?: PromptOptions["sourceCommand"];
					toolDenylist?: readonly string[];
				};
				const inputOptions: ZCodeInputOptions = {
					inputId: payload.queueItemId,
					sourceCommand: source.sourceCommand ?? payload.sourceCommand,
					toolDenylist: source.toolDenylist,
					highspeedMeta:
						payload.highspeedMeta ??
						readHighspeedInputFacts(record.session.sessionManager.getBranch()).get(payload.queueItemId),
				};
				// Stop 的 held 会阻止 steering 自动投递；显式提升只借出所选输入，不释放其余队列。
				const start = (scoped: ZCodeInputOptions) => {
					const taken = record.session.takeQueuedInput(payload.queueItemId!);
					if (!taken) throw new Error("Queue item was already delivered or removed");
					const accepted = this.#beginSubmission(id, scoped, admitted =>
						taken.prompt({ ...scoped, throwOnDrop: true, onPromptAdmitted: admitted }),
					);
					void accepted.admitted.catch(() => taken.restore());
					return accepted;
				};
				const submission = payload.execution
					? this.#execute(id, inputOptions, payload.execution, start)
					: start(inputOptions);
				void submission.completion.catch(() => {});
				await submission.admitted;
				return { queueItemId: payload.queueItemId };
			}
			if (type === "setAutoDrain") {
				if (typeof payload.autoDrain !== "boolean") throw new Error("autoDrain must be a boolean");
				record.session.setQueueAutoDrain(payload.autoDrain);
				return { autoDrain: payload.autoDrain };
			}
			if (type === "setFollowupMode") {
				if (payload.mode !== "queue" && payload.mode !== "guide") throw new Error("Invalid follow-up mode");
				record.session.setSteeringMode(payload.mode === "guide" ? "one-at-a-time" : "all", false);
				record.session.setFollowUpMode("one-at-a-time", false);
				return { mode: payload.mode };
			}
			const operations = {
				editQueueItem: "edit",
				reorderQueueItem: "reorder",
				deleteQueueItem: "delete",
				sendQueuedNow: "sendNow",
			} as const;
			if (type in operations) {
				if (!payload.queueItemId) throw new Error("Queue input identity is required");
				const queued = record.session
					.getQueuedInputMessages()
					.find(message => (message as AgentMessage & { inputId?: string }).inputId === payload.queueItemId);
				const changed = record.session.mutateQueuedInput(
					payload.queueItemId,
					operations[type as keyof typeof operations],
					{
						text: payload.newText,
						beforeInputId: payload.beforeQueueItemId,
					},
				);
				if (!changed) throw new Error("Queue item was already delivered or removed");
				if (type === "deleteQueueItem" && queued) {
					await this.#recordInputState(
						record,
						payload.queueItemId,
						"cancelled",
						(queued as AgentMessage & { sourceCommand?: PromptOptions["sourceCommand"] }).sourceCommand,
					);
				}
				return { queueItemId: payload.queueItemId };
			}
			if (!payload.entryId) throw new Error("Resolved journal entry is required");
			const entry = record.session.sessionManager.getEntry(payload.entryId);
			if (!entry || entry.type !== "message") throw new Error("Conversation target is no longer available");
			if (type === "setHighspeedMetrics") {
				const inputId = (entry.message as AgentMessage & { inputId?: string }).inputId;
				const card = inputId && readHighspeedInputFacts(record.session.sessionManager.getBranch()).get(inputId);
				if (entry.message.role !== "user" || !card || !payload.highspeedMetrics)
					throw new Error("Highspeed metrics require an accepted card input");
				const highspeed = highspeedMessageMetaSchema.parse({ ...card, ...payload.highspeedMetrics });
				record.session.sessionManager.appendCustomEntry("input_highspeed_metrics", { inputId, highspeed });
				await record.session.sessionManager.flush();
				return { inputId };
			}
			if (type === "forkAssistant") {
				if (entry.message.role !== "assistant") throw new Error("Fork requires an assistant target");
				await record.session.sessionManager.flush();
				const source = record.session.sessionManager.getSessionFile();
				if (!source) throw new Error("Fork source has no durable journal");
				const manager = await SessionManager.forkFrom(source, record.cwd, this.#sessionDir, this.#storage, {
					entryId: entry.id,
					suppressBreadcrumb: true,
				});
				manager.appendCustomEntry("zcode_fork_boundary", { sessionId: manager.getSessionId(), entryId: entry.id });
				await manager.flush();
				const child = await this.#host(
					manager,
					{ additionalDirectories: record.session.sessionManager.getHeader()?.additionalDirectories },
					record.settings,
				);
				return { sessionId: child.id };
			}
			if (type !== "editUserQuery" && type !== "retryTurn") throw new Error(`Unknown session mutation: ${type}`);
			if (record.session.isStreaming) throw new Error("Conversation is running");
			const branch = record.session.sessionManager.getBranch(entry.id);
			const user =
				type === "editUserQuery"
					? entry
					: branch.findLast(item => item.type === "message" && item.message.role === "user");
			if (!user || user.type !== "message" || user.message.role !== "user")
				throw new Error("Target has no user input");
			const text =
				type === "editUserQuery"
					? payload.newText
					: typeof user.message.content === "string"
						? user.message.content
						: user.message.content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join("\n");
			if (text === undefined || !payload.inputId)
				throw new Error("Replacement text and stable input identity are required");
			const submit = async (scoped: ZCodeInputOptions): Promise<ZCodeInputSubmission> =>
				this.#beginSubmission(id, scoped, admitted =>
					record.session.promptEditedUserQuery(user.id, text, { ...scoped, onPromptAdmitted: admitted }),
				);
			const inputOptions = {
				inputId: payload.inputId,
				images: payload.images,
				attachments: payload.attachments,
				sourceCommand: payload.sourceCommand,
				toolDenylist: payload.toolDenylist,
				highspeedMeta: payload.highspeedMeta,
			};
			const submission = payload.execution
				? this.#execute(id, inputOptions, payload.execution, submit)
				: await submit(inputOptions);
			void submission.completion.catch(() => {});
			await submission.admitted;
			return type === "editUserQuery" ? { disposition: "rewind", sessionId: id } : { sessionId: id };
		});
	}

	async close(id: string): Promise<void> {
		const previous = this.#closing.get(id);
		if (previous) return previous;
		// attach 失败会从 opening 内回调 close；已创建资源必须先清理，不能等待自身。
		if (!this.#records.has(id)) {
			const pending = this.#opening.get(id);
			if (pending) await pending;
			const closing = this.#closing.get(id);
			if (closing) return closing;
		}
		const record = this.#records.get(id);
		if (!record) return;
		this.#records.delete(id);
		const closing = record.run(async () => {
			const modelIo = this.#modelIo.get(id);
			this.#modelIo.delete(id);
			try {
				const execution = this.#executions.get(id);
				execution?.controller.abort(new Error("Session closed"));
				await record.session.abort();
				if (execution) await execution.completion.catch(() => {});
				for (const message of record.session.getQueuedInputMessages()) {
					const input = message as AgentMessage & {
						inputId?: string;
						sourceCommand?: PromptOptions["sourceCommand"];
					};
					if (input.inputId) await this.#recordInputState(record, input.inputId, "cancelled", input.sourceCommand);
				}
				modelIo?.unsubscribe();
				await modelIo?.capture.close();
			} finally {
				try {
					await record.session.dispose();
				} finally {
					const resources = this.#resources.get(id);
					this.#resources.delete(id);
					await resources?.mcpManager?.disconnectAll();
					resources?.authStorage?.close();
					record.settings.cancelPendingSaves();
					this.#options.onSessionClosed?.(id);
				}
			}
		});
		this.#closing.set(id, closing);
		try {
			await closing;
		} finally {
			this.#closing.delete(id);
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		for (const controller of this.#starting) controller.abort(new Error("Session owner closed"));
		await Promise.allSettled(this.#opening.values());
		const results = await Promise.allSettled([...this.#records.keys()].map(id => this.close(id)));
		await Promise.allSettled(this.#closing.values());
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}

	#require(id: string): ZCodeSessionRecord {
		const record = this.get(id);
		if (!record) throw new Error(`Session is not active: ${id}`);
		return record;
	}
	#assertOpen(): void {
		if (this.#disposed) throw new Error("Session manager is closed");
	}
	async #assertDirectory(cwd: string): Promise<void> {
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`Not a working directory: ${cwd}`);
	}
}
