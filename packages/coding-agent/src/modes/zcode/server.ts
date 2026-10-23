import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { SessionInfo } from "../../session/session-listing";
import type { AgentSession } from "../../session/agent-session";
import type { PromptOptions } from "../../session/agent-session-types";
import { Settings } from "../../config/settings";
import { ModelRegistry } from "../../config/model-registry";
import { discoverAuthStorage, loadCliExtensionProviders } from "../../sdk";
import { TeamConfigError, TeamConfigService } from "../../team/config";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { ZCodeCommandHost, workspaceCatalog } from "./commands";
import { ZCodeCatalogs, zcodeSkillsManageParamsSchema, type ZCodeCatalogOptions } from "./catalogs";
import { ZCodeQueries } from "./queries";
import { ZCodeAttachmentResources } from "./attachments";
import { parseZCodeThinkingLevel, toZCodeReasoningLevel, ZCodeProviderConfiguration } from "./provider-config";
import { ZCodeCommandLedger } from "./command-ledger";
import { ZCodeProjection } from "./projection";
import { ZCodeRuntimeControls, workspaceMode } from "./controls";
import { LegacySessionBridge } from "./legacy-session";
import * as P from "./schema";
import { LegacyProtocol as L } from "./schema";
import {
	ZCodeSessionManager,
	type ZCodeSessionRecord,
	type ZCodeExecutionSubmission,
	type ZCodeNativeChild,
} from "./sessions";
import { ZCodeStorageStartup } from "./storage";
import { ZCodeTopics } from "./topics";
import type { ModelSelection } from "./schema/vendor/model-selection";
import type { HighspeedMessageMeta } from "./schema/vendor/highspeed";
import { cfgTaskAgentModelOverrides } from "../../task/settings";
import { startOfflineShmBackup } from "../../offline/backup-lifecycle";
import { offPeakControlParamsSchema } from "./schema/vendor/off-peak-execution";
import { ZCodeWorkflowService } from "./workflows/service";
import { ZCodeConversationTelemetry } from "./memory-telemetry";
import { createZCodeAutomationTools } from "./automation";
import { createZCodeWorkflowTools } from "./workflows/tools";
import type { AgentDefinition } from "../../task/types";
import { OmpIndexesBridge } from "./indexes";
import { OmpTeamBridge } from "./team";
import { OmpProfilesBridge, type OmpProfileBlocker } from "./profiles";
import { OmpTanBridge, ompTanListParamsSchema, ompTanStartParamsSchema, ompTanStopParamsSchema } from "./tan";
import { generateWorkspaceText } from "./workspace-text";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { resolveRoleAssignments } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { createModelBrowserSource } from "../model-browser-source";
import { createAuthStorageSettingsSync } from "../../session/auth-broker-config";
import type { ZCodeConfigurationRecord } from "./provider-config";
import type { AuthStorage } from "../../session/auth-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { offlineFromEnv } from "../../cli/args";

export interface ZCodeServerOptions {
	cwd?: string;
	surface?: "desktop" | "default";
	input?: Readable;
	output?: Writable;
}
/** I20:ZCode ModelSelection → OMP 模型选择器 pattern(provider/modelId[:level])。 */
function subagentModelPattern(selection: ModelSelection): string {
	const level = selection.options?.reasoningLevel
		? parseZCodeThinkingLevel(selection.options.reasoningLevel)
		: undefined;
	return `${selection.providerId}/${selection.modelId}${level ? `:${level}` : ""}`;
}
export class ZCodeProtocolError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

/** Bounded output queue; writes serialize only transport, never business dispatch. */
export class ZCodeFrameWriter {
	#pending = 0;
	#tail = Promise.resolve();
	constructor(readonly output: Writable) {}
	write(frame: unknown): Promise<void> {
		const line = `${JSON.stringify(frame)}\n`;
		const bytes = Buffer.byteLength(line);
		// Legacy RPC results (including the complete model catalog) are logical
		// NDJSON messages. The 1 MiB physical limit belongs to the V4 topic codec,
		// before its envelopes reach this shared transport queue.
		if (this.#pending + bytes > 16 * 1024 * 1024)
			return Promise.reject(new ZCodeProtocolError(-32000, "Protocol output capacity exceeded"));
		this.#pending += bytes;
		const write = this.#tail
			.then(() => {
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				this.output.write(line, error => (error ? reject(error) : resolve()));
				return promise;
			})
			.finally(() => {
				this.#pending -= bytes;
			});
		this.#tail = write.catch(() => {});
		return write;
	}
	flush(): Promise<void> {
		return this.#tail;
	}
}

interface HostedSession {
	record: ZCodeSessionRecord;
	projection: ZCodeProjection;
	commands: ZCodeCommandHost;
	controls: ZCodeRuntimeControls;
	unsubscribe: () => void;
	telemetry: ZCodeConversationTelemetry;
	unsubscribeTelemetry: () => void;
}

export class ZCodeServer {
	readonly manager: ZCodeSessionManager;
	readonly queries: ZCodeQueries;
	readonly attachments: ZCodeAttachmentResources;
	readonly configuration: ZCodeProviderConfiguration;
	readonly ledger: ZCodeCommandLedger;
	readonly legacy: LegacySessionBridge;
	readonly topics = new ZCodeTopics();
	readonly catalogs = new ZCodeCatalogs();
	readonly writer: ZCodeFrameWriter;
	readonly startup: ZCodeStorageStartup;
	readonly workflows: ZCodeWorkflowService;
	readonly indexes: OmpIndexesBridge;
	readonly team: OmpTeamBridge;
	readonly profiles: OmpProfilesBridge;
	readonly tan: OmpTanBridge;
	#businessDispatches = 0;
	#hosted = new Map<string, HostedSession>();
	#attaching = new Map<string, Promise<HostedSession>>();
	#inputAdmissionObservers = new Map<string, () => void>();
	#casDecisions = new Map<string, Promise<P.CommandAck>>();
	#cold = new Map<string, { projection: ZCodeProjection; version: number }>();
	readonly #nativeProjections = new Map<
		string,
		{
			projection?: ZCodeProjection;
			child: ZCodeNativeChild;
			generation: number;
			unsubscribe?: () => void;
			pending?: Promise<ZCodeProjection>;
			/** Session targeted by the in-flight open; null = persisted-only rebuild. */
			pendingSession?: AgentSession | null;
		}
	>();
	readonly #agentDefinitions = new Map<string, readonly AgentDefinition[]>();
	#reverse = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	#closed = false;
	#ready = false;
	readonly #lifetime = new AbortController();
	#ownerSignal?: AbortSignal;
	#initialization?: Promise<void>;
	#stopBackup = () => {};
	#workspaceEpoch = randomUUID();
	#workspaceIds = new Map<string, string>();
	// workspaceId(key/identity/路径)→ 该工作区 cwd 的显式登记。#workspaceIds 是
	// 路径↔key 双向表,单看查到的值无法区分是路径还是 key;sessions-index 过滤与
	// createSession 归属裁决需要无歧义的 cwd(findings P2/J)。
	#workspaceCwds = new Map<string, string>();
	#connections = new Map<string, string>();
	#closedConnections = new Set<string>();
	#subscriptions = new Map<string, { connectionId: string; topic: string }>();
	// 视图退订不释放审批所有权；仅真正断连或会话关闭才清理 root 归属。
	#permissionOwners = new Map<string, Set<string>>();
	#indexInfos = new Map<string, SessionInfo[]>();
	#registeredTopics = new Set<string>();
	#workspaceConfigs = new Map<string, P.WorkspaceConfigState>();
	readonly #catalogs = new Map<string, Promise<ZCodeConfigurationRecord>>();
	readonly #catalogDisposers = new Set<() => void>();
	#catalogTimer?: NodeJS.Timeout;
	#catalogRefresh?: Promise<void>;
	readonly #workspaceText = new Map<string, AbortController>();
	constructor(readonly options: ZCodeServerOptions = {}) {
		this.configuration = new ZCodeProviderConfiguration({
			records: () => this.#configurationRecords(),
			applyInteractionPreferences: (cwd, enabled) =>
				Array.from(this.#hosted.values())
					.filter(hosted => hosted.record.cwd === cwd)
					.reduce((count, hosted) => count + hosted.commands.interactions.setAutoResolutionEnabled(enabled), 0),
			applyModelIoPreferences: (cwd, enabled) => this.manager.applyModelIoPreferences(cwd, enabled),
			requestRuntimeHeaders: (params, signal) =>
				this.requestHost(L.zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders, params, signal),
			applyRegistryUpdate: async current => {
				const hosted = Array.from(this.#hosted.values()).find(
					item => item.record.session.modelRegistry === current.modelRegistry,
				);
				if (!hosted) return;
				// 目录刷新只重绑同一模型元数据，不把原生 max 当公开选择重交，也不改稀疏选择意图。
				await hosted.record.run(() => hosted.record.session.refreshCurrentModelMetadata());
			},
		});
		this.manager = new ZCodeSessionManager({
			cwd: path.resolve(options.cwd ?? process.cwd()),
			modelIoRetention: cwd => this.configuration.getWorkspacePreferences(cwd).fullRetentionEnabled,
			getAgentDefinitions: id => this.#agentDefinitions.get(id) ?? [],
			onWorkflowActor: async record => {
				await this.#attach(record);
			},
			onSessionClosed: id => {
				this.team.detach(id);
				for (const [connectionId, roots] of this.#permissionOwners) {
					roots.delete(id);
					if (roots.size === 0) this.#permissionOwners.delete(connectionId);
				}
				const hosted = this.#hosted.get(id);
				hosted?.unsubscribeTelemetry();
				hosted?.telemetry.close();
				hosted?.commands.dispose();
				hosted?.unsubscribe();
				hosted?.projection.dispose();
				this.#hosted.delete(id);
				this.#agentDefinitions.delete(id);
				this.legacy.disposeSession(id);
				this.attachments.disposeSession(id);
				for (const [childId, entry] of this.#nativeProjections) {
					if (entry.child.root?.id !== id) continue;
					entry.generation++;
					entry.unsubscribe?.();
					entry.unsubscribe = undefined;
					entry.projection?.dispose();
					entry.projection = undefined;
					entry.pending = undefined;
					entry.pendingSession = undefined;
					void this.manager
						.nativeChild(childId)
						.then(child => {
							if (child && !this.#closed) return this.#nativeProjection(childId, child);
						})
						.catch(error => process.stderr.write(`${String(error)}\n`));
				}
			},
			workflowInteractionUI: parentId => this.#hosted.get(parentId)?.commands.interactions.createSubagentUI,
			runtimeTools: sessionId => [
				...createZCodeAutomationTools({
					request: (method, params, signal) => this.requestHost(method, params, signal),
					execution: () => {
						const record = this.manager.get(sessionId);
						if (!record) throw new Error("Automation tool session is not active");
						const input = record.session.state.messages.findLast(message => message.role === "user") as
							| { sourceCommand?: { automationId?: string } }
							| undefined;
						const model = record.session.model;
						return {
							sessionId,
							automationTurn: Boolean(input?.sourceCommand?.automationId),
							modelSelection: model ? { providerId: model.provider, modelId: model.id } : undefined,
							mode: workspaceMode(record.settings),
						};
					},
				}),
				...createZCodeWorkflowTools({
					service: this.workflows,
					record: () => {
						const record = this.manager.get(sessionId);
						if (!record) throw new Error("Workflow tool session is not active");
						return record;
					},
				}),
			],
			memoryPreference: async sessionId => {
				const response = await this.requestHost(L.zcodeProtocolMethods.sessionRequestRuntimePreferences, {
					sessionId,
					scope: "runtime-materialization",
				});
				return L.zcodeSessionRuntimePreferencesResultSchema.parse(response).memoryEnabled;
			},
			onModelIoError: (error, id) =>
				process.stderr.write(
					`Model IO capture failed for ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
				),
			onOffPeakEvent: params => {
				void this.writer.write({ method: P.V4_NOTIFICATIONS.offPeakLifecycle, params });
			},
			resolveRequestAuth: (sessionId, cwd, model, signal, context) => {
				const thought = context?.thinkingLevel ?? this.manager.get(sessionId)?.session.configuredThinkingLevel();
				return this.configuration.resolveRequestAuth(
					{
						sessionId,
						workspace: { workspacePath: cwd, workspaceKey: this.#workspaceIds.get(cwd) ?? cwd },
						modelSelection: {
							providerId: model.provider,
							modelId: model.id,
							options: thought ? { reasoningLevel: toZCodeReasoningLevel(thought) } : undefined,
						},
					},
					model,
					signal,
				);
			},
			transformRequestPayload: (sessionId, _cwd, payload, model, _signal, context) => {
				if (!model) return payload;
				// hook 可由 child 继承，但思考配置必须取当前请求 owner，不能捕获父模型的 off。
				const thought = context?.thinkingLevel ?? this.manager.get(sessionId)?.session.configuredThinkingLevel();
				return this.configuration.transformRequestPayload(payload, model, {
					providerId: model.provider,
					modelId: model.id,
					options: thought ? { reasoningLevel: thought } : undefined,
				});
			},
			sessionOptions: {
				prepareConfiguration: (cwd, settings, registry) => this.#prepareConfiguration(cwd, settings, registry),
			},
		});
		this.tan = new OmpTanBridge(this.manager);
		this.ledger = new ZCodeCommandLedger(this.manager);
		this.writer = new ZCodeFrameWriter(options.output ?? process.stdout);
		this.indexes = new OmpIndexesBridge({
			notify: (method, params) => {
				void this.writer.write({ method, params }).catch(error => {
					process.stderr.write(`${String(error)}\n`);
				});
			},
		});
		this.team = new OmpTeamBridge({ sessions: this.manager });
		this.profiles = new OmpProfilesBridge({
			cwd: path.resolve(options.cwd ?? process.cwd()),
			blockers: () => {
				const blockers: OmpProfileBlocker[] = this.manager.profileSwitchBlockers();
				if (this.#businessDispatches)
					blockers.push({ code: "inflightDispatch", message: "Business requests are still in flight" });
				if (this.#reverse.size)
					blockers.push({ code: "hostInteraction", message: "Native runtime is awaiting Host responses" });
				if (this.#attaching.size || this.#casDecisions.size)
					blockers.push({
						code: "bridgeTransition",
						message: "Session attachment or command admission is in flight",
					});
				for (const hosted of this.#hosted.values()) {
					if (hosted.commands.interactions.pending.length)
						blockers.push({
							code: "pendingInteraction",
							sessionId: hosted.record.id,
							message: "Native session is awaiting an interaction answer",
						});
				}
				// journal 保留真实 pending/running 状态；不能把没有可证明终态的工作流当 idle。
				for (const run of this.workflows.journal.listRuns({
					statuses: ["pending", "running"],
					limit: Number.MAX_SAFE_INTEGER,
				}))
					blockers.push({
						code: "workflowRunning",
						sessionId: run.parentSessionId,
						message: "Native workflow has not reached a terminal state",
					});
				return blockers;
			},
		});
		this.startup = new ZCodeStorageStartup(frame => this.writer.write(frame));
		this.queries = new ZCodeQueries({
			manager: this.manager,
			getProjection: id =>
				this.#hosted.get(id)?.projection ??
				this.#nativeProjections.get(id)?.projection ??
				this.#cold.get(id)?.projection,
			reasoning: (provider, model, level) => this.configuration.readReasoningConfig(provider, model, level),
		});
		this.attachments = new ZCodeAttachmentResources({
			getSession: async id => (await this.#active(id)).record,
			getRows: async id => (await this.#projection(id)).rows(),
		});
		this.workflows = new ZCodeWorkflowService({
			agentDir: getAgentDir(),
			manager: this.manager,
			catalog: cwd => this.configuration.catalog(cwd),
			onChange: async sessionId => {
				const projection = this.#hosted.get(sessionId)?.projection;
				if (projection) projection.setWorkflowState(await this.workflows.projection(sessionId));
			},
		});
		this.legacy = new LegacySessionBridge({
			manager: this.manager,
			getRecord: id => this.manager.get(id),
			getProjection: id => this.#projection(id),
			snapshot: id => this.#snapshot(id),
			notify: (method, params) => this.writer.write({ method, params }),
		});
	}
	initialize(signal?: AbortSignal): Promise<void> {
		this.#ownerSignal ??= signal;
		return (this.#initialization ??= this.startup.open(signal).then(() => {
			this.#ready = true;
			this.#stopBackup = startOfflineShmBackup(message => process.stderr.write(`${message}\n`));
		}));
	}
	async requestHost(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.#closed) throw new ZCodeProtocolError(-32000, "Owner disconnected");
		signal?.throwIfAborted();
		if (this.#reverse.size >= 256) throw new ZCodeProtocolError(-32000, "Host request capacity exceeded");
		const id = `omp:${randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#reverse.delete(id);
			reject(new ZCodeProtocolError(-32000, "Host request timed out"));
		}, 30_000);
		void promise.catch(() => {});
		const abort = () => {
			reject(new ZCodeProtocolError(-32800, "Host request cancelled"));
			if (method === L.zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders) {
				const request = L.zcodeProviderRuntimeHeadersRequestParamsSchema.parse(params);
				void this.writer
					.write({
						method: "interaction/providerRuntimeHeadersCancelled",
						params: { requestId: request.requestId, sessionId: request.sessionId, workspace: request.workspace },
					})
					.catch(() => {});
			}
		};
		this.#reverse.set(id, { resolve, reject, timer });
		signal?.addEventListener("abort", abort, { once: true });
		try {
			signal?.throwIfAborted();
			await this.writer.write({ id, method, params });
			return await promise;
		} finally {
			clearTimeout(timer);
			this.#reverse.delete(id);
			signal?.removeEventListener("abort", abort);
		}
	}
	async receive(value: unknown): Promise<void> {
		const parsed = L.zcodeProtocolMessageSchema.safeParse(value);
		if (!parsed.success) throw new ZCodeProtocolError(-32600, "Invalid ZCode protocol envelope");
		const frame = parsed.data;
		if (!("method" in frame)) {
			const pending = this.#reverse.get(String(frame.id));
			if (!pending) return;
			if ("error" in frame)
				pending.reject(new ZCodeProtocolError(frame.error.code, frame.error.message, frame.error.data));
			else pending.resolve(frame.result);
			return;
		}
		let afterResponse: (() => void) | undefined;
		let responded = false;
		try {
			const result = await this.dispatch(frame.method, frame.params, callback => {
				afterResponse = callback;
			});
			if (this.#closed) return;
			if ("id" in frame) {
				await this.writer.write({ id: frame.id, result });
				responded = true;
			}
			afterResponse?.();
		} catch (error) {
			if (responded) throw error;
			if (this.#closed) return;
			if (!("id" in frame)) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				return;
			}
			const fault = error as { code?: unknown; message?: string; data?: unknown };
			// 字符串业务错误码不能被参数错误覆盖；保留回执字段并用数字外层满足 wire schema。
			const data =
				typeof fault.code === "string"
					? {
							...(fault.data !== null && typeof fault.data === "object" && !Array.isArray(fault.data)
								? fault.data
								: fault.data === undefined
									? {}
									: { data: fault.data }),
							code: fault.code,
						}
					: fault.data;
			await this.writer.write({
				id: frame.id,
				error: {
					code: typeof fault.code === "number" ? fault.code : typeof fault.code === "string" ? -32000 : -32602,
					message: fault.message || "Request failed",
					...(data === undefined ? {} : { data }),
				},
			});
		}
	}
	#attach(record: ZCodeSessionRecord): Promise<HostedSession> {
		this.team.observeSession(record);
		const pending = this.#attaching.get(record.id);
		if (pending) return pending;
		const existing = this.#hosted.get(record.id);
		if (existing) return Promise.resolve(existing);
		const opening = this.#bind(record)
			.catch(async error => {
				const hosted = this.#hosted.get(record.id);
				hosted?.unsubscribeTelemetry();
				hosted?.telemetry.close();
				hosted?.commands.dispose();
				hosted?.unsubscribe();
				hosted?.projection.dispose();
				this.#hosted.delete(record.id);
				await this.manager.close(record.id);
				throw error;
			})
			.finally(() => this.#attaching.delete(record.id));
		this.#attaching.set(record.id, opening);
		return opening;
	}
	async #bind(record: ZCodeSessionRecord): Promise<HostedSession> {
		const existing = this.#hosted.get(record.id);
		if (existing) return existing;
		await record.run(() =>
			this.catalogs.captureSession(record.cwd, {
				session: record.session,
				settings: record.settings,
				sessionId: record.id,
			}),
		);
		// Host 只提供已解析定义；实际派生、模型与工具限制仍交给当前原生 session。
		await this.#applySubagentRuntimeConfig(record);
		this.#cold.get(record.id)?.projection.dispose();
		this.#cold.delete(record.id);
		const projection = new ZCodeProjection({
			sessionId: record.id,
			cwd: record.cwd,
			session: record.session,
			registry: record.registry,
			agentId: record.registry.list().find(ref => ref.session === record.session)?.id,
			childSessions: await this.manager.childIdentities(record.id),
			...(await this.manager.forkProjection(record.id)),
			reasoning: session => {
				const model = session.model;
				const declared = model ? this.configuration.getReasoningLevels(model.provider, model.id) : undefined;
				const nativeThought = toZCodeReasoningLevel(session.thinkingLevel ?? "off");
				return {
					thought: declared?.includes("enabled") && nativeThought !== "disabled" ? "enabled" : nativeThought,
					thoughtLevels: declared
						? declared.map(toZCodeReasoningLevel)
						: session.getAvailableThinkingLevels().map(toZCodeReasoningLevel),
				};
			},
		});
		const commands = new ZCodeCommandHost(
			record.session,
			record.cwd,
			pendingInteractions => projection.setState({ pendingInteractions }),
			{
				run: record.run,
				mcpManager: record.creationResult.mcpManager,
				startTan: work => this.tan.start(record, work, () => projection.refresh()),
				resourcesReloaded: async () => {
					this.catalogs.invalidateSession(record.session);
					await this.catalogs.captureSession(record.cwd, {
						session: record.session,
						settings: record.settings,
						sessionId: record.id,
					});
				},
				setToolUIContext: record.creationResult.setToolUIContext,
				uiContext: record.creationResult.interactionUI,
				recordInputAdmission: async (inputId, sourceCommand) => {
					await this.manager.recordInputAdmission(record.id, inputId, sourceCommand);
					this.#inputAdmissionObservers.get(JSON.stringify([record.id, inputId]))?.();
				},
				settingsChanged: () => {
					void this.#refreshWorkspaceConfigs(record.cwd).catch(error =>
						process.stderr.write(`${String(error)}\n`),
					);
				},
				submit: async (text, options = {}) => {
					const { execution, ...promptOptions } = options;
					const input = { ...promptOptions, inputId: options.inputId ?? randomUUID() };
					const admission = execution
						? this.manager.submitExecution(record.id, text, input, execution)
						: this.manager.submit(record.id, text, input);
					await admission.admitted;
					this.#inputAdmissionObservers.get(JSON.stringify([record.id, input.inputId]))?.();
					void admission.completion.catch(error => process.stderr.write(`${String(error)}\n`));
					return admission;
				},
				submitCustom: async (message, options) => {
					const { execution, ...promptOptions } = options;
					const input = { ...promptOptions, inputId: options.inputId ?? randomUUID() };
					const admission = this.manager.submitCustom(record.id, message, input, execution);
					await admission.admitted;
					this.#inputAdmissionObservers.get(JSON.stringify([record.id, input.inputId]))?.();
					void admission.completion.catch(error => process.stderr.write(`${String(error)}\n`));
					return admission;
				},
				output: text =>
					record.run(async () => {
						const session = record.session;
						const manager = session.sessionManager;
						const generation = session.sessionGeneration;
						const transcript = manager.getSessionId();
						const message = {
							role: "custom" as const,
							customType: "zcode-command-output",
							content: text,
							display: true,
							attribution: "agent" as const,
							timestamp: Date.now(),
						};
						// 命令结果不是新输入；sendCustomMessage 在 streaming 时会 steer，
						// 导致 /goal pause 的输出等模型结束才出现，甚至误触发后续 turn。
						// 保留原生 custom-message 的 journal/context 所有者，不进入输入队列。
						manager.appendCustomMessageEntry(
							message.customType,
							message.content,
							message.display,
							undefined,
							message.attribution,
							message.timestamp,
						);
						session.agent.appendMessage(message);
						await manager.ensureOnDisk();
						await manager.flush();
						if (
							session.isDisposed ||
							generation !== session.sessionGeneration ||
							transcript !== manager.getSessionId()
						)
							return;
						projection.applyEvent({ type: "message_end", message });
					}),
			},
		);
		const controls = new ZCodeRuntimeControls(record.session, {
			setPlanEnabled: (enabled, atInputBoundary, signal) =>
				commands.setPlanEnabled(enabled, atInputBoundary, signal),
		});
		record.session.setInputDeliveryHandler(async (source, signal) => {
			const configuration = source?.configuration;
			if (!configuration) return;
			signal?.throwIfAborted();
			const mode =
				configuration.mode === undefined
					? undefined
					: P.commandPayloadSchemas.switchCollaborationMode.parse({ mode: configuration.mode }).mode;
			const control = await record.run(() =>
				controls.applyInputConfiguration({ mode, planEnabled: configuration.planEnabled }, signal),
			);
			projection.setState({ config: { ...projection.snapshot().config, mode: control.mode } });
		});
		projection.setState({ config: { ...projection.snapshot().config, mode: controls.snapshot().mode } });
		const telemetry = new ZCodeConversationTelemetry({
			sessionId: record.id,
			memoryEnabled: record.memory.memoryEnabled,
			identity: () => projection.telemetryIdentity(),
			emit: fact => {
				void this.writer.write({ method: P.V4_NOTIFICATIONS.conversationTelemetryFact, params: fact });
			},
		});
		const hosted: HostedSession = {
			record,
			projection,
			commands,
			controls,
			telemetry,
			unsubscribe: () => {},
			unsubscribeTelemetry: record.session.subscribe(event => telemetry.consume(event)),
		};
		this.#hosted.set(record.id, hosted);
		this.legacy.attach(record, projection);
		this.topics.register(`conversation/${record.id}`, {
			snapshot: () => projection.snapshot(),
			subscribe: listener => projection.subscribe(listener),
		});
		const unsubscribeProjection = projection.subscribe(() => {
			// 只向归属该会话 cwd 的 workspace index 投递增量,避免跨工作区污染(findings P2)。
			for (const workspaceId of this.#indexInfos.keys()) {
				if (!this.#ownsWorkspaceSession(workspaceId, record)) continue;
				this.topics.publish(`sessions-index/${workspaceId}`, [
					{ op: "session.upserted", session: projection.summary(workspaceId) },
				]);
			}
		});
		const unsubscribeRegistry = record.registry.onChange(event => {
			// 先订阅冷 child、后恢复父树时，只绑定该树原生复活出来的同一身份。
			for (const [id, entry] of this.#nativeProjections) {
				if (entry.child.root || event.ref.kind !== "sub") continue;
				if (
					event.ref.session?.sessionManager.getSessionId() !== id &&
					(!event.ref.sessionFile || path.resolve(event.ref.sessionFile) !== path.resolve(entry.child.file))
				)
					continue;
				void this.manager
					.nativeChild(id)
					.then(child => {
						if (child) return this.#nativeProjection(id, child);
					})
					.catch(error => process.stderr.write(`${String(error)}\n`));
			}
		});
		hosted.unsubscribe = () => {
			unsubscribeProjection();
			unsubscribeRegistry();
		};
		await commands.initialize();
		await this.workflows.reconcileParentOwnership(record.id);
		projection.setWorkflowState(await this.workflows.projection(record.id));
		if (this.#closed) throw new ZCodeProtocolError(-32000, "Owner disconnected");
		commands.interactions.setAutoResolutionEnabled(
			this.configuration.getWorkspacePreferences(record.cwd).askUserQuestionAutoResolutionEnabled,
		);
		return hosted;
	}
	#readSubagentRuntimeConfig(sessionId: string): Promise<L.SubagentRuntimeConfig | undefined> {
		// Host 自有解析缓存已保证低成本；不能把首个主会话的配置缓存到其他 root。
		return this.requestHost(
			L.zcodeProtocolMethods.subagentsReadRuntimeConfig,
			L.zcodeSubagentsReadRuntimeConfigParamsSchema.parse({ sessionId }),
		)
			.then(response => L.subagentRuntimeConfigSchema.parse(response))
			.catch(error => {
				// -32601 = Host 未实现该方法(合同允许,静默跳过);其余失败也不让会话建立出错。
				if (!(error instanceof ZCodeProtocolError && error.code === -32601))
					process.stderr.write(`Subagent runtime config unavailable: ${String(error)}\n`);
				return undefined;
			});
	}
	async #applySubagentRuntimeConfig(record: ZCodeSessionRecord): Promise<void> {
		const config = await this.#readSubagentRuntimeConfig(record.id);
		if (!config || config.kind !== "ready") {
			this.#agentDefinitions.delete(record.id);
			cfgTaskAgentModelOverrides.clearOverride(record.settings);
			return;
		}
		const toolNames = record.session.getAllToolNames();
		const nativeTool = (name: string): string => {
			const resolved = toolNames.find(tool => tool === name || tool.toLowerCase() === name.toLowerCase());
			if (!resolved) throw new Error(`Subagent configuration references unavailable native tool: ${name}`);
			return resolved;
		};
		// Host Markdown 不在 .omp discovery 路径内；只转换其已解析 snapshot，既不复制文件也不另建 registry。
		const definitions: AgentDefinition[] = config.profiles.map(profile => {
			const denied = new Set((profile.disallowedTools ?? []).map(nativeTool));
			const tools = profile.tools?.map(nativeTool);
			return {
				name: profile.name,
				description: profile.description,
				systemPrompt: profile.systemPrompt,
				source: profile.source === "built-in" ? "bundled" : profile.source,
				filePath: profile.path,
				model: profile.modelSelection ? [subagentModelPattern(profile.modelSelection)] : undefined,
				thinkingLevel: profile.modelSelection?.options?.reasoningLevel
					? parseZCodeThinkingLevel(profile.modelSelection.options.reasoningLevel)
					: undefined,
				restrictToolNames: profile.tools !== undefined || profile.disallowedTools !== undefined,
				tools:
					tools !== undefined
						? tools.filter(tool => !denied.has(tool))
						: denied.size
							? toolNames.filter(tool => !denied.has(tool))
							: undefined,
				autoloadSkills: profile.skills ? [...profile.skills] : undefined,
			};
		});
		const mapped = await this.catalogs.mapSubagentModelSelectionOverrides(
			record.cwd,
			{ session: record.session, settings: record.settings, sessionId: record.id },
			config,
		);
		this.#agentDefinitions.set(record.id, definitions);
		// 此层只承载本次 Host 覆盖；移除覆盖后回落原生配置，不能保留上个父 turn 的值。
		cfgTaskAgentModelOverrides.clearOverride(record.settings);
		if (Object.keys(mapped).length)
			cfgTaskAgentModelOverrides.override(record.settings, {
				...cfgTaskAgentModelOverrides.get(record.settings),
				...Object.fromEntries(
					Object.entries(mapped).map(([name, selection]) => [name, subagentModelPattern(selection)]),
				),
			});
	}
	/** 登记工作区身份(key/identity/路径均指向同一 cwd),维持 #workspaceIds 双向表。 */
	#registerWorkspace(workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string }): void {
		this.#workspaceIds.set(workspace.workspacePath, workspace.workspaceKey);
		this.#workspaceIds.set(workspace.workspaceKey, workspace.workspacePath);
		for (const id of new Set(
			[workspace.workspaceKey, workspace.workspacePath, workspace.workspaceIdentity].filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			),
		))
			this.#workspaceCwds.set(id, workspace.workspacePath);
	}
	#registerIndexWorkspace(raw: unknown): void {
		const workspace = L.zcodeWorkflowsListParamsSchema.shape.workspace.parse(
			raw && typeof raw === "object" && "workspace" in raw ? raw.workspace : undefined,
		);
		// 原始身份必须仍路由到已登记的执行目录，不能用索引请求重绑另一工作区。
		for (const id of [workspace.workspaceKey, workspace.workspaceIdentity, workspace.workspacePath]) {
			if (!id) continue;
			const registered = this.#workspaceCwds.get(id);
			if (registered !== undefined && path.resolve(registered) !== path.resolve(workspace.workspacePath))
				throw new ZCodeProtocolError(-32602, "Index workspace does not match registered route");
		}
		this.#registerWorkspace(workspace);
	}
	/** workspaceId 归属的 cwd;未登记时退回进程默认工作区(app-server 按主工作区拉起)。 */
	#workspaceCwd(workspaceId: string): string {
		return path.resolve(this.#workspaceCwds.get(workspaceId) ?? this.options.cwd ?? process.cwd());
	}
	#isRootSession(id: string): boolean {
		// actor 不是独立主任务：实时采用原生 scoped UI，冷态只查同一工作流 journal。
		return !this.manager.isNestedSession(id) && !this.workflows.isActorSession(id);
	}
	/** 会话 info 是否归属该 workspaceId 的 cwd(路径归一化后比较)。 */
	#ownsWorkspaceSession(workspaceId: string, info: { id: string; cwd: string }): boolean {
		return this.#isRootSession(info.id) && path.resolve(info.cwd) === this.#workspaceCwd(workspaceId);
	}
	async #refreshIndexes(): Promise<void> {
		if (!this.#indexInfos.size) return;
		const infos = await this.manager.list();
		for (const [workspaceId, previous] of this.#indexInfos) {
			// manager.list() 的 listAll 合并了所有项目的会话;sessions-index 只发布
			// 归属该工作区 cwd 的会话,否则其他工作区的会话会泄漏进本工作区侧栏(findings P2)。
			const owned = infos.filter(info => this.#ownsWorkspaceSession(workspaceId, info));
			this.#indexInfos.set(workspaceId, owned);
			const deltas: P.SessionsIndexDelta[] = owned.map(info => ({
				op: "session.upserted",
				session: this.#summary(info, workspaceId),
			}));
			for (const info of previous)
				if (!owned.some(current => current.id === info.id))
					deltas.push({ op: "session.removed", sessionId: info.id });
			this.topics.publish(`sessions-index/${workspaceId}`, deltas);
		}
	}
	#summary(info: SessionInfo, workspaceId: string): P.SessionSummary {
		return (
			this.#hosted.get(info.id)?.projection.summary(workspaceId) ?? {
				sessionId: info.id,
				workspaceId,
				title: info.title ?? info.firstMessage,
				phase: info.status === "error" ? "error" : "completedSuccess",
				sessionEnded: true,
				hasBackgroundWork: false,
				workflowActivity: P.deriveSessionWorkflowActivity(this.workflows.projection(info.id)),
				lastActivityAt: info.modified.getTime(),
				createdAt: info.created.getTime(),
			}
		);
	}
	async #active(id: string): Promise<HostedSession> {
		return this.#attach(this.manager.get(id) ?? (await this.manager.resume(id)));
	}
	#sessionInfo(info: SessionInfo) {
		const record = this.manager.get(info.id);
		const model = record?.session.model;
		return {
			sessionId: info.id,
			workspace: { workspacePath: info.cwd, workspaceKey: this.#workspaceIds.get(info.cwd) ?? info.cwd },
			sessionKind: "interactive" as const,
			title: info.title ?? info.firstMessage ?? "New session",
			mode: "build" as const,
			status: record?.session.isStreaming
				? ("running" as const)
				: info.status === "error"
					? ("error" as const)
					: ("idle" as const),
			...(model ? { model: { providerId: model.provider, modelId: model.id } } : {}),
			createdAt: info.created.getTime(),
			updatedAt: info.modified.getTime(),
		};
	}
	async #snapshot(id: string, options: Pick<L.ZCodeSessionReadParams, "messageLimit" | "contentProfile"> = {}) {
		const read = await this.manager.read(id);
		const hosted = this.#hosted.get(id);
		const model = hosted?.record.session.model;
		const state = (await this.#projection(id)).snapshot();
		const available = (hosted?.record.session.modelRegistry.getAvailable() ?? []).map(candidate => ({
			ref: { providerId: candidate.provider, modelId: candidate.id },
			label: candidate.name,
			providerLabel: candidate.provider,
			contextWindow: candidate.contextWindow,
			maxOutputTokens: candidate.maxTokens,
			properties: {
				inputFormat: {
					supportsText: candidate.input.includes("text"),
					supportsImage: candidate.input.includes("image"),
					supportsVideo: false,
					supportsAudio: false,
					supportsPdf: false,
				},
				outputFormat: { supportsText: true },
			},
		}));
		const configuredThoughtLevels = model
			? this.configuration.getReasoningLevels(model.provider, model.id)
			: undefined;
		const thoughtLevels = (
			configuredThoughtLevels ??
			hosted?.record.session.getAvailableEffortSelectors().map(value => toZCodeReasoningLevel(value)) ??
			state.config.thoughtLevels
		).map(value => ({ value: toZCodeReasoningLevel(value), label: toZCodeReasoningLevel(value) }));
		const nativeThought = toZCodeReasoningLevel(
			hosted?.record.session.configuredThinkingLevel() ?? state.config.thought,
		);
		const currentThought =
			configuredThoughtLevels?.includes("enabled") && nativeThought !== "disabled" ? "enabled" : nativeThought;
		const messages = await this.legacy.messages(id);
		const selectedMessages = (options.messageLimit ? messages.slice(-options.messageLimit) : messages).map(message =>
			options.contentProfile === "index"
				? {
						...message,
						parts: message.parts.filter(
							part => part.type === "text" || (part.type === "file" && !part.url.startsWith("data:")),
						),
					}
				: message,
		);
		const totalTokenCount = read.messages.reduce(
			(total, message) =>
				message.role === "assistant"
					? total + message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
					: total,
			0,
		);
		return L.zcodeSessionStateSnapshotSchema.parse({
			protocol: { name: "ZCode Protocol", version: 1 },
			session: this.#sessionInfo(read.info),
			settings: {
				model: {
					...(state.config.provider && state.config.model
						? { current: { providerId: state.config.provider, modelId: state.config.model } }
						: {}),
					available,
				},
				thoughtLevel: {
					enabled: thoughtLevels.length > 0,
					current: currentThought || undefined,
					available: thoughtLevels,
				},
				mode: { current: state.config.mode },
			},
			projection: {
				sessionId: id,
				status: state.pendingInteractions.length
					? "waiting"
					: hosted?.record.session.isStreaming
						? "running"
						: "idle",
				mode: state.config.mode,
				turnCount: read.messages.filter(m => m.role === "assistant").length,
				totalTokenCount,
				contextUsed: state.usage.contextWindow?.usedTokens ?? 0,
				contextWindow: state.usage.contextWindow?.maxTokens ?? model?.contextWindow ?? 0,
				pendingPermissions: state.pendingInteractions.flatMap(interaction =>
					interaction.payload.kind === "permission"
						? [
								{
									requestId: interaction.interactionId,
									toolCallId: interaction.payload.toolCallId,
									toolName: interaction.payload.toolName,
									reason: interaction.payload.summary,
									riskLevel: "medium",
									input: interaction.payload.detail,
									origin: interaction.payload.origin,
									options: interaction.payload.options.map(option => ({
										optionId: option.optionId,
										kind: option.kind,
										name: option.label,
										response: option.response ?? { decision: option.kind === "deny" ? "deny" : "allow" },
									})),
									requestedAt: interaction.createdAt,
								},
							]
						: [],
				),
				activeToolCalls: state.rows.window.flatMap(row =>
					row.kind === "toolCall" && ["inputStreaming", "pendingApproval", "running"].includes(row.status)
						? [
								{
									toolCallId: row.toolCallId,
									toolName: row.toolName,
									status: row.status === "running" ? "running" : "pending",
									startedAt: row.startedAt,
								},
							]
						: [],
				),
				backgroundJobs: state.backgroundWorks,
			},
			runtime: {
				eventSeq: this.legacy.eventSeq(id),
				stateRevision: state.revision,
				pendingRequestIds: state.pendingInteractions.map(item => item.interactionId),
			},
			messages: selectedMessages,
		});
	}
	async #prepareConfiguration(cwd: string, settings: Settings, registry: ModelRegistry): Promise<void> {
		await this.configuration.prepare(cwd, settings, registry);
		// resident 会话会接管 workspace 目录；仅 SDK 凭据域水合会重新暴露构造器的过期元数据。
		// 两条初始化路径均完整解析本地缓存，在线时保留原生自动 provider discovery 权限。
		if (offlineFromEnv()) await registry.refresh("offline");
		else await registry.reapplyModelPolicies();
	}
	#configurationRecords(): ZCodeConfigurationRecord[] {
		return [
			...Array.from(this.#hosted.values(), hosted => ({
				cwd: hosted.record.cwd,
				settings: hosted.record.settings,
				modelRegistry: hosted.record.session.modelRegistry,
			})),
			...this.#catalogRecords.values(),
		];
	}
	readonly #catalogRecords = new Map<string, ZCodeConfigurationRecord>();
	async #catalog(cwd: string): Promise<ZCodeConfigurationRecord> {
		const live = this.#configurationRecords().find(record => path.resolve(record.cwd) === cwd);
		if (live) return live;
		let pending = this.#catalogs.get(cwd);
		if (!pending) {
			pending = (async () => {
				// 目录属于 workspace，不创建 AgentSession；与 SDK 共享原生设置、认证及离线缓存。
				const settings = await Settings.loadIsolated({ cwd });
				let auth: AuthStorage | undefined;
				try {
					auth = await discoverAuthStorage(undefined, { cwd, settings });
					const modelRegistry = new ModelRegistry(auth, undefined, { settings });
					await loadCliExtensionProviders(modelRegistry, settings, cwd, { discoverModels: false });
					await this.#prepareConfiguration(cwd, settings, modelRegistry);
					if (!offlineFromEnv()) modelRegistry.refreshInBackground();
					const sync = createAuthStorageSettingsSync(settings, auth);
					const record = { cwd, settings, modelRegistry };
					this.#catalogDisposers.add(() => {
						sync.stop();
						auth!.close();
						settings.cancelPendingSaves();
					});
					this.#catalogRecords.set(cwd, record);
					return record;
				} catch (error) {
					auth?.close();
					settings.cancelPendingSaves();
					throw error;
				}
			})();
			this.#catalogs.set(cwd, pending);
			void pending.catch(() => this.#catalogs.delete(cwd));
		}
		return pending;
	}
	#watchCatalogs(): void {
		if (this.#catalogTimer || this.#closed) return;
		// SQLite 外部写使用原生 generation/poll；models.yml 使用 registry 的 stale 检测。
		// 单航班也覆盖后台 discovery 已在两轮之间完成的情况，不另建模型或认证状态。
		this.#catalogTimer = setInterval(() => {
			if (this.#closed || this.#catalogRefresh) return;
			const directories = new Set(
				Array.from(this.#subscriptions.values())
					.filter(owner => owner.topic.startsWith("workspace-config/"))
					.map(owner =>
						path.resolve(this.#workspaceIds.get(owner.topic.slice(17)) ?? this.options.cwd ?? process.cwd()),
					),
			);
			if (directories.size === 0) {
				clearInterval(this.#catalogTimer);
				this.#catalogTimer = undefined;
				return;
			}
			this.#catalogRefresh = (async () => {
				for (const record of this.#configurationRecords()) {
					if (!directories.has(path.resolve(record.cwd))) continue;
					const { settings, modelRegistry } = record;
					await settings.reloadFromDisk();
					const authChanged = await modelRegistry.authStorage.credentials.poll();
					if (authChanged) await modelRegistry.hydrateCredentialScopedModelCaches();
					await modelRegistry.refreshIfStale();
				}
				if (!this.#closed) await this.#refreshAllWorkspaceConfigs(false);
			})()
				.catch(error => {
					logger.warn("ZCode workspace catalog refresh failed; retaining the last projection", {
						error: String(error),
					});
				})
				.finally(() => {
					this.#catalogRefresh = undefined;
				});
		}, 1000);
		this.#catalogTimer.unref();
	}
	async #refreshAllWorkspaceConfigs(force = true): Promise<void> {
		const directories = new Set(
			Array.from(
				Array.from(this.#workspaceConfigs.keys()).filter(
					id =>
						force ||
						Array.from(this.#subscriptions.values()).some(owner => owner.topic === `workspace-config/${id}`),
				),
				id => this.#workspaceIds.get(id) ?? this.options.cwd ?? process.cwd(),
			),
		);
		await Promise.all(Array.from(directories, cwd => this.#refreshWorkspaceConfigs(cwd, force)));
	}
	async #refreshWorkspaceConfigs(cwd: string, force = true): Promise<void> {
		const previous = !force
			? Array.from(this.#workspaceConfigs.entries()).find(
					([id]) => (this.#workspaceIds.get(id) ?? this.options.cwd ?? process.cwd()) === cwd,
				)?.[1]
			: undefined;
		const config = await this.#workspaceConfig(cwd, previous?.slashCommands);
		for (const workspaceId of this.#workspaceConfigs.keys()) {
			if ((this.#workspaceIds.get(workspaceId) ?? this.options.cwd ?? process.cwd()) !== cwd) continue;
			if (!force && JSON.stringify(this.#workspaceConfigs.get(workspaceId)) === JSON.stringify(config)) continue;
			this.#workspaceConfigs.set(workspaceId, config);
			this.topics.publish(`workspace-config/${workspaceId}`, [{ op: "config.updated", config }]);
		}
	}
	async #workspaceConfig(
		cwd: string,
		retainedSlashCommands?: P.WorkspaceConfigState["slashCommands"],
	): Promise<P.WorkspaceConfigState> {
		// Git 等调用方可返回 Windows 正斜杠路径；与 manager 同样规范化，避免漏选真实 resident 扩展目录。
		const resolvedCwd = path.resolve(cwd);
		const hosted = Array.from(this.#hosted.values()).find(item => path.resolve(item.record.cwd) === resolvedCwd);
		const catalog = await this.#catalog(resolvedCwd);
		const settings = catalog.settings;
		const commands = retainedSlashCommands
			? []
			: hosted
				? await hosted.commands.catalog()
				: await workspaceCatalog(resolvedCwd, settings);
		// 既有 wire schema 没有 aliases；将实际注册别名投影成同行，不能丢掉原生补全入口。
		const slashCommands =
			retainedSlashCommands ??
			commands.flatMap(command =>
				[command.name, ...(command.aliases ?? [])].map(name => ({
					name,
					description: command.description ?? "",
					...(command.inputHint ? { inputHint: command.inputHint } : {}),
					source: command.source === "builtin" ? ("builtin" as const) : ("custom" as const),
				})),
			);
		const models = catalog.modelRegistry.getAvailable();
		const source = createModelBrowserSource(settings);
		const selected = resolveRoleAssignments(source, models, models).default;
		return {
			slashCommands,
			configOptions: [
				{
					id: "model",
					name: "Model",
					type: "select",
					currentValue: selected ? `${selected.model.provider}/${selected.model.id}` : "",
					options: models.map(model => ({
						value: `${model.provider}/${model.id}`,
						name: model.name,
						modelProviderId: model.provider,
						modelProviderName: model.provider,
						modelDefaultThoughtLevel: toZCodeReasoningLevel(
							!model.reasoning
								? "off"
								: selected?.model.provider === model.provider && selected.model.id === model.id
									? selected.thinkingLevel
									: source.defaultThinkingLevel,
						),
						origin: "native",
						modelThoughtLevels: (
							this.configuration.getReasoningLevels(model.provider, model.id) ?? [
								"off",
								...(model.reasoning && !model.thinking?.unverified ? ["auto"] : []),
								...getSupportedEfforts(model),
							]
						).map(toZCodeReasoningLevel),
					})),
				},
				{
					id: "mode",
					name: "Mode",
					type: "select",
					currentValue: workspaceMode(settings),
					options: P.commandPayloadSchemas.switchCollaborationMode.shape.mode.options.map(value => ({
						value,
						name: value,
					})),
				},
			],
		};
	}
	async #model(
		hosted: HostedSession,
		selection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } },
	): Promise<void> {
		const model = hosted.record.session.modelRegistry.find(selection.providerId, selection.modelId);
		if (!model) throw new ZCodeProtocolError(-32602, "Model not found");
		const thought = selection.options?.reasoningLevel
			? this.configuration.resolveThinkingLevel(
					selection.providerId,
					selection.modelId,
					selection.options.reasoningLevel,
				)
			: undefined;
		if (selection.options?.reasoningLevel && thought === undefined)
			throw new ZCodeProtocolError(-32602, "Invalid reasoning level");
		await hosted.record.run(async () => {
			await hosted.record.session.setModelTemporary(model, thought);
			// 缺陷1:合同(session-config.ts)规定 sessionConfig.modelSelection 是已接受的稀疏
			// 选择意图。这里把接受结果作为会话事实持久化(custom entry,与 workspace-file-rewind
			// 同机制),渲染器刷新与冷恢复都从 journal 还原;不写全局配置,也不用 effective 字段伪造。
			hosted.record.session.sessionManager.appendCustomEntry("zcode_model_selection", selection);
			await hosted.record.session.sessionManager.flush();
		});
		hosted.projection.acceptModelSelection(selection);
		hosted.projection.refresh();
	}
	async #input(
		hosted: HostedSession,
		text: string,
		inputId: string,
		delivery?: string,
		attachments?: unknown[],
		sourceCommand?: PromptOptions["sourceCommand"],
		options: PromptOptions & { highspeedMeta?: HighspeedMessageMeta } = {},
		execution?: ZCodeExecutionSubmission,
	): Promise<P.CommandResult | undefined> {
		await this.#applySubagentRuntimeConfig(hosted.record);
		// 原生 parser 同时支持 /tan work 与 /tan:work；必须早于父会话 stop/admission。
		if (parseSlashCommand(text)?.name === "tan") {
			if (attachments?.length || execution)
				throw new ZCodeProtocolError(-32602, "Tan accepts work text without parent execution material");
			const receipt = await hosted.commands.dispatch(text, { ...options, inputId, sourceCommand });
			await receipt.completion;
			return { type: "inputAccepted", inputId, delivery: "startNow" };
		}
		const references = await hosted.record.run(() =>
			this.catalogs.prepareReferences(hosted.record.cwd, text, {
				session: hosted.record.session,
				settings: hosted.record.settings,
				sessionId: hosted.record.id,
			}),
		);
		text = references.text;
		const wasBusy = hosted.record.session.isStreaming || hosted.record.session.isCompacting;
		if (execution && wasBusy) throw new ZCodeProtocolError(-32602, "Execution material requires an idle session");
		delivery ??= hosted.projection.snapshot().config.followupMode;
		if (wasBusy && delivery === "startNow") await this.manager.stop(hosted.record.id);
		const materials = attachments?.length
			? await this.attachments.resolveInputAttachments(hosted.record.id, attachments)
			: undefined;
		const reminder = references.reminder;
		if (reminder)
			await hosted.record.run(() =>
				hosted.record.session.sendCustomMessage(
					{ customType: "plugin_reference", content: reminder, display: false },
					{ deliverAs: "nextTurn" },
				),
			);
		const content = materials?.text ? `${text}\n${materials.text}` : text;
		if (text.startsWith("/")) {
			let inputAdmitted = false;
			const key = JSON.stringify([hosted.record.id, inputId]);
			this.#inputAdmissionObservers.set(key, () => {
				inputAdmitted = true;
			});
			try {
				const accepted = await hosted.commands.dispatch(content, {
					...options,
					inputId,
					sourceCommand,
					execution,
					images: materials?.images,
					attachments: materials?.attachments,
					streamingBehavior: delivery === "guide" ? "steer" : "followUp",
				});
				void accepted.completion.catch(error => process.stderr.write(`${String(error)}\n`));
			} finally {
				this.#inputAdmissionObservers.delete(key);
			}
			if (!inputAdmitted) return undefined;
		} else {
			const promptOptions = {
				...options,
				inputId,
				sourceCommand,
				images: materials?.images,
				attachments: materials?.attachments,
				streamingBehavior: delivery === "guide" ? ("steer" as const) : ("followUp" as const),
			};
			const admitted = execution
				? this.manager.submitExecution(hosted.record.id, content, promptOptions, execution)
				: this.manager.submit(hosted.record.id, content, promptOptions);
			await admitted.admitted;
			void admitted.completion.catch(error => process.stderr.write(`${String(error)}\n`));
		}
		// admission 日志已落盘后再刷新，避免 message_start 先到时卡快照尚不可见。
		hosted.projection.refresh();
		return {
			type: "inputAccepted",
			inputId,
			delivery: wasBusy && delivery !== "startNow" ? (delivery === "guide" ? "guide" : "queue") : "startNow",
		};
	}
	async #command(raw: unknown): Promise<P.CommandAck> {
		const parsed = P.parseCommandEnvelope(raw);
		if (!parsed.ok) throw new ZCodeProtocolError(-32602, parsed.error.message);
		const envelope = parsed.envelope;
		return this.ledger.execute(envelope, () => {
			if (!envelope.sessionId || !P.COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type))
				return this.#decide(envelope);
			const sessionId = envelope.sessionId;
			const previous = this.#casDecisions.get(sessionId);
			const decision = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
				this.#decide(envelope),
			);
			const gate = decision.finally(() => {
				if (this.#casDecisions.get(sessionId) === gate) this.#casDecisions.delete(sessionId);
			});
			this.#casDecisions.set(sessionId, gate);
			return gate;
		});
	}
	async #decide(envelope: P.CommandEnvelope): Promise<P.CommandAck> {
		let revision = 0;
		try {
			const payload = envelope.payload as Record<string, unknown>;
			let hosted: HostedSession | undefined;
			let workflowPreparation: Awaited<ReturnType<ZCodeWorkflowService["prepareSaved"]>> | undefined;
			if (envelope.type === "startSavedWorkflow") {
				if (!envelope.sessionId) throw new ZCodeProtocolError(-32602, "Workflow command requires sessionId");
				const params = P.commandPayloadSchemas.startSavedWorkflow.parse(payload);
				const cwd = this.manager.get(envelope.sessionId)?.cwd ?? (await this.manager.read(envelope.sessionId)).cwd;
				workflowPreparation = await this.workflows.prepareSaved({ cwd, ...params });
				if (!workflowPreparation.ok)
					return {
						commandId: envelope.commandId,
						status: "rejected",
						reasonCode: `fault.command.savedWorkflowStartRejected.${workflowPreparation.reason}`,
						message: workflowPreparation.message,
						revisionAtDecision: revision,
					};
			}
			if (envelope.type === "stop" && envelope.sessionId && !this.manager.get(envelope.sessionId))
				return {
					commandId: envelope.commandId,
					status: "stale",
					reasonCode: "proto.sessionResumed",
					revisionAtDecision: 0,
				};
			if (envelope.sessionId) {
				hosted =
					envelope.type === "stop" ? this.#hosted.get(envelope.sessionId) : await this.#active(envelope.sessionId);
				revision = hosted?.projection.snapshot().revision ?? 0;
			}
			if (envelope.baseRevision !== undefined && envelope.baseRevision !== revision)
				return {
					commandId: envelope.commandId,
					status: "stale",
					reasonCode: "guard.revision",
					revisionAtDecision: revision,
				};
			if (envelope.baseLogEpoch && envelope.baseLogEpoch !== hosted?.projection.snapshot().logEpoch)
				return {
					commandId: envelope.commandId,
					status: "stale",
					reasonCode: "guard.logEpoch",
					revisionAtDecision: revision,
				};
			let result: P.CommandResult | undefined;
			if (envelope.type === "createSession") {
				const create = P.commandPayloadSchemas.createSession.parse(payload);
				// 未知 workspaceId 显式失败:此前静默落 process.cwd 会把派生会话挂错工作区
				// (findings J)。允许两类:#workspaceCwds 已登记的工作区;或 workspaceId 本身
				// 就是进程默认工作区路径(桌面单工作区直发路径的场景,见 zcode-process 测试)。
				const defaultCwd = path.resolve(this.options.cwd ?? process.cwd());
				const registered = this.#workspaceCwds.get(create.workspaceId);
				const cwd =
					registered !== undefined
						? registered
						: path.resolve(create.workspaceId) === defaultCwd
							? defaultCwd
							: undefined;
				if (cwd === undefined) throw new ZCodeProtocolError(-32602, `Unknown workspaceId: ${create.workspaceId}`);
				hosted = await this.#attach(
					await this.manager.create({
						cwd,
						sessionId: create.sessionId,
						additionalDirectories: create.additionalDirectories,
						mcpServers: create.mcpServers,
						autoTitle: true,
					}),
				);
				result = { type: "createSession", sessionId: hosted.record.id };
				await this.ledger.recordProduced(envelope, hosted.record.id, result, hosted.projection.snapshot().revision);
				const selected =
					create.firstInput?.modelSelection ??
					create.config?.modelSelection ??
					(create.config?.provider && create.config.model
						? {
								providerId: create.config.provider,
								modelId: create.config.model,
								options: create.config.thought ? { reasoningLevel: create.config.thought } : undefined,
							}
						: undefined) ??
					this.configuration.getDefaultModelSelection();
				if (selected) await this.#model(hosted, selected);
				if (create.config?.followupMode) {
					await this.manager.mutate(hosted.record.id, "setFollowupMode", { mode: create.config.followupMode });
					hosted.projection.setState({
						config: { ...hosted.projection.snapshot().config, followupMode: create.config.followupMode },
					});
				}
				if (create.config?.mode) {
					const mode = P.commandPayloadSchemas.switchCollaborationMode.parse({ mode: create.config.mode }).mode;
					const target = hosted;
					await target.record.run(() => target.controls.switchMode(mode));
				}
				if (create.config?.planEnabled || create.firstInput?.planEnabled)
					await hosted.commands.setPlanEnabled(true);
				if (create.firstInput) {
					if (create.firstInput.modelSelection) await this.#model(hosted, create.firstInput.modelSelection);
					const input = await this.#input(
						hosted,
						create.firstInput.text,
						envelope.commandId,
						undefined,
						create.firstInput.attachments,
						{ ...this.ledger.identity(envelope), type: envelope.type },
					);
					if (input?.type === "inputAccepted") result.input = { inputId: input.inputId, delivery: input.delivery };
				}
			} else if (envelope.type === "createSelectionSideSession") {
				if (!envelope.sessionId)
					throw new ZCodeProtocolError(-32602, "Selection side session requires parent sessionId");
				const params = P.commandPayloadSchemas.createSelectionSideSession.parse(payload);
				hosted = await this.#attach(await this.manager.createSelectionSideSession(envelope.sessionId));
				result = { type: "createSelectionSideSession", sessionId: hosted.record.id };
				await this.ledger.recordProduced(envelope, hosted.record.id, result, hosted.projection.snapshot().revision);
				if (params.firstInput) {
					if (params.firstInput.modelSelection) await this.#model(hosted, params.firstInput.modelSelection);
					const input = await this.#input(
						hosted,
						params.firstInput.text,
						envelope.commandId,
						undefined,
						undefined,
						{ ...this.ledger.identity(envelope), type: envelope.type },
						{ inputClientId: envelope.clientId },
					);
					if (input?.type === "inputAccepted") result.input = { inputId: input.inputId, delivery: input.delivery };
				}
			} else {
				if (!hosted) throw new ZCodeProtocolError(-32602, "Command requires sessionId");
				switch (envelope.type) {
					case "sendText":
					case "sendGoalCommand": {
						const input = P.commandPayloadSchemas.sendText.parse(payload);
						const tanControl = envelope.type === "sendText" && parseSlashCommand(input.text)?.name === "tan";
						if (!tanControl && input.modelSelection && !input.modelExecution)
							await this.#model(hosted, input.modelSelection);
						const target = hosted;
						const held = !tanControl && hosted.projection.snapshot().inputRouting.mode === "choice";
						// held 会话仍必带 disposition;但 keepQueueAndSend 语义是「保留队列并直接
						// 发送」,无 CAS 需要——Host(zcodeTaskServiceAdapter)固定只发 keepQueueAndSend
						// 且不带 expectedHeldQueueItemIds,此前的双全硬校验会把 choice 会话的派发
						// 全部拒成 -32602(findings J)。clear 仍要求完整 CAS 集合。
						if (held && !input.heldQueueDisposition)
							throw new ZCodeProtocolError(-32602, "Held queue disposition is required");
						if (held && input.heldQueueDisposition === "clearQueueAndSend" && !input.expectedHeldQueueItemIds)
							throw new ZCodeProtocolError(
								-32602,
								"Held queue disposition and expected identities are required",
							);
						const onPromptAdmitted =
							held && input.expectedHeldQueueItemIds
								? () =>
										this.manager.disposeHeldQueue(
											target.record.id,
											input.expectedHeldQueueItemIds!,
											input.heldQueueDisposition!,
										)
								: undefined;
						const execution =
							input.modelExecution && input.modelSelection
								? {
										...input.modelExecution,
										selection: input.modelSelection,
										offPeakTaskId: input.offPeakTaskId,
									}
								: undefined;
						const sourceCommand = {
							...this.ledger.identity(envelope),
							type: envelope.type,
							automationId: input.automationId,
							configuration:
								input.mode === undefined && input.planEnabled === undefined
									? undefined
									: { mode: input.mode, planEnabled: input.planEnabled },
						};
						result = await this.#input(
							hosted,
							// The public Goal command carries its objective without the composer slash.
							// Re-enter the shared controller; ordinary prompt admission cannot create a goal.
							envelope.type === "sendGoalCommand" ? `/goal set ${input.text}` : input.text,
							envelope.commandId,
							// automation/cron 派生执行路径(Host 带 automationId 派发)缺省 delivery 显式
							// startNow:缺省会落 followupMode(默认 queue),忙时派发被排队而非立即执行
							// (findings J「立即运行未直接派发」)。仅限调度派发输入;普通用户输入语义不变。
							held ? "startNow" : (input.requestedDelivery ?? (input.automationId ? "startNow" : undefined)),
							input.attachments,
							sourceCommand,
							{
								inputClientId: envelope.clientId,
								onPromptAdmitted,
								highspeedMeta: input.highspeedMeta,
								toolDenylist: input.automationId
									? [...new Set([...(input.toolDisallowlist ?? []), "CronCreate", "CronUpdate", "CronDelete"])]
									: input.toolDisallowlist,
							},
							execution,
						);
						break;
					}
					case "stop": {
						const stop = P.commandPayloadSchemas.stop.parse(payload);
						if (
							stop.expectedForegroundExecutionId &&
							!hosted.projection
								.snapshot()
								.control.activeWorks.some(
									work => work.foregroundExecutionId === stop.expectedForegroundExecutionId,
								)
						)
							throw new ZCodeProtocolError(-32000, "Foreground execution changed");
						hosted.projection.setState({
							control: { ...hosted.projection.snapshot().control, stopState: "stopping" },
						});
						hosted.commands.cancel();
						await this.manager.stop(hosted.record.id);
						break;
					}
					case "compact":
						result = await this.#input(hosted, "/compact", envelope.commandId, undefined, undefined, {
							...this.ledger.identity(envelope),
							type: envelope.type,
						});
						break;
					case "editQueueItem":
					case "reorderQueueItem":
					case "deleteQueueItem":
					case "sendQueuedNow":
					case "setAutoDrain":
					case "setFollowupMode": {
						const promotion =
							envelope.type === "sendQueuedNow"
								? P.commandPayloadSchemas.sendQueuedNow.parse(payload)
								: undefined;
						const execution =
							promotion?.modelExecution && promotion.modelSelection
								? { ...promotion.modelExecution, selection: promotion.modelSelection }
								: undefined;
						if (promotion?.modelSelection && !execution) await this.#model(hosted, promotion.modelSelection);
						const commandHost = hosted.commands;
						await this.manager.mutate(
							hosted.record.id,
							envelope.type,
							{
								...payload,
								execution,
								highspeedMeta: promotion?.highspeedMeta,
								inputId: envelope.commandId,
								sourceCommand: { ...this.ledger.identity(envelope), type: envelope.type },
							},
							inputId => commandHost.promoteQueuedGoal(inputId),
						);
						if (envelope.type === "setFollowupMode")
							hosted.projection.setState({
								config: {
									...hosted.projection.snapshot().config,
									followupMode: P.commandPayloadSchemas.setFollowupMode.parse(payload).mode,
								},
							});
						hosted.projection.refresh();
						break;
					}
					case "forkAssistant":
					case "editUserQuery":
					case "retryTurn": {
						const target = hosted.projection.resolveTarget(P.conversationRowTargetSchema.parse(payload.target));
						if (!target) throw new ZCodeProtocolError(-32602, "Conversation target no longer exists");
						const edit =
							envelope.type === "editUserQuery"
								? P.commandPayloadSchemas.editUserQuery.parse(payload)
								: undefined;
						const execution =
							edit?.modelExecution && edit.modelSelection
								? { ...edit.modelExecution, selection: edit.modelSelection }
								: undefined;
						if (execution && hosted.record.session.isStreaming)
							throw new ZCodeProtocolError(-32602, "Execution material requires an idle session");
						const materials = edit?.attachments?.length
							? await this.attachments.resolveInputAttachments(hosted.record.id, edit.attachments)
							: undefined;
						if (edit?.modelSelection && !execution) await this.#model(hosted, edit.modelSelection);
						if (envelope.type === "editUserQuery" && payload.workspaceMode === "rewind") {
							const header = hosted.projection
								.rows()
								.find(row => row.kind === "turnHeader" && row.turnId === target.row.turnId);
							if (!header?.entityId)
								throw new ZCodeProtocolError(-32602, "Turn checkpoint target is unavailable");
							const restored = await this.queries.applyFileRewind({
								sessionId: hosted.record.id,
								target: { rowId: header.rowId, entityId: header.entityId },
								baseRevision: envelope.baseRevision,
								baseLogEpoch: envelope.baseLogEpoch,
							});
							if (!restored.applied)
								throw new ZCodeProtocolError(
									-32000,
									"Workspace files cannot be safely restored",
									restored.response,
								);
						}
						const changed = await this.manager.mutate(hosted.record.id, envelope.type, {
							...payload,
							entryId: target.entryId,
							inputId: envelope.commandId,
							sourceCommand: { ...this.ledger.identity(envelope), type: envelope.type },
							execution,
							highspeedMeta: edit?.highspeedMeta,
							images: materials?.images,
							attachments: materials?.attachments,
							newText: edit
								? materials?.text
									? `${edit.newText}\n${materials.text}`
									: edit.newText
								: undefined,
						});
						if (envelope.type === "forkAssistant") {
							const child = changed as { sessionId: string };
							await this.#active(child.sessionId);
							result = { type: "forkAssistant", sessionId: child.sessionId };
							await this.ledger.recordProduced(
								envelope,
								child.sessionId,
								result,
								hosted.projection.snapshot().revision,
							);
						} else if (envelope.type === "editUserQuery")
							result = { type: "editUserQuery", disposition: "rewind", sessionId: hosted.record.id };
						if (envelope.type === "editUserQuery" || envelope.type === "retryTurn")
							hosted.projection.resetEpoch();
						else hosted.projection.refresh();
						break;
					}
					case "applyFileRewind": {
						const applied = await this.queries.applyFileRewind({
							sessionId: hosted.record.id,
							target: payload.target,
							baseRevision: envelope.baseRevision,
							baseLogEpoch: envelope.baseLogEpoch,
						});
						result = {
							type: "applyFileRewind",
							applied: applied.applied,
							preview: applied.preview,
							response: JSON.stringify(applied.response),
						};
						break;
					}
					case "resolveInteraction": {
						const interaction = P.commandPayloadSchemas.resolveInteraction.parse(payload);
						if (!hosted.commands.resolveInteraction(interaction.interactionId, interaction.answer)) {
							// 先到者生效,晚到/重复应答幂等收口为 noop+proto.alreadyResolved
							// (forkZcode docs/v4-refactor/03-commands.md:80-81;vendor schema
							// command.ts resolveInteraction 注释)。此前抛 -32602 会把命令记成
							// failed 并毒化同 commandId 重试(findings I)。
							return {
								commandId: envelope.commandId,
								status: "noop",
								reasonCode: "proto.alreadyResolved",
								revisionAtDecision: revision,
							};
						}
						result = { type: "resolveInteraction", resolvedBy: { clientId: envelope.clientId } };
						break;
					}
					case "setHighspeedMetrics": {
						const { target: rowTarget, ...metrics } = P.commandPayloadSchemas.setHighspeedMetrics.parse(payload);
						const target = hosted.projection.resolveTarget(rowTarget);
						if (!target) throw new ZCodeProtocolError(-32602, "Conversation target no longer exists");
						await this.manager.mutate(hosted.record.id, envelope.type, {
							entryId: target.entryId,
							highspeedMetrics: metrics,
						});
						hosted.projection.refresh();
						break;
					}
					case "setAssistantFeedback":
					case "respondWorkspaceHookReview":
					case "toggleWorkspaceHookReviewItem":
					case "revokeWorkspaceHookTrust":
					case "requestWorkspaceHookReview":
					case "discardSharedContext": {
						// 上述合同命令(vendor schema command.ts:189-292)在本 fork 无实现场景:
						// 行内反馈与 workspaceHook 审核流、共享上下文丢弃均无本地
						// 存储面。信封校验通过后按幂等 noop 收口(status=noop, reasonCode=proto.noop),
						// 与 snoozeInteractionAutoResolution 的幂等 noop 同风格;此前落入 default →
						// -32601 会把命令记成 failed 并毒化同 commandId 重试(findings I)。
						P.commandPayloadSchemas[envelope.type].parse(payload);
						return {
							commandId: envelope.commandId,
							status: "noop",
							reasonCode: "proto.noop",
							revisionAtDecision: revision,
						};
					}
					case "snoozeInteractionAutoResolution": {
						// AskUserQuestion 首次有效操作永久暂停本次自动结束;重复/迟到调用为幂等 noop
						// (vendor schema command.ts:250 注释)。此前落入 default → -32601 会把命令
						// 记成 failed 并毒化同 commandId 重试(findings B/S2-1),noop ack 与
						// resolveInteraction 的 alreadyResolved 风格一致。
						const interaction = P.commandPayloadSchemas.snoozeInteractionAutoResolution.parse(payload);
						if (hosted.commands.interactions.snoozeAutoResolution(interaction.interactionId) === "noop")
							return {
								commandId: envelope.commandId,
								status: "noop",
								reasonCode: "proto.alreadyResolved",
								revisionAtDecision: revision,
							};
						break;
					}
					case "renameSession":
						await this.manager.rename(hosted.record.id, String(payload.title));
						break;
					case "deleteSession":
						await this.#close(hosted.record.id);
						await this.manager.delete(hosted.record.id);
						break;
					case "switchModelConfig": {
						const selection = P.commandPayloadSchemas.switchModelConfig.parse(payload);
						await this.#model(hosted, {
							providerId: selection.provider,
							modelId: selection.model,
							options: { reasoningLevel: selection.thought },
						});
						break;
					}
					case "switchCollaborationMode": {
						const mode = P.commandPayloadSchemas.switchCollaborationMode.parse(payload).mode;
						const target = hosted;
						const control = await target.record.run(() => target.controls.switchMode(mode));
						target.projection.setState({
							config: { ...target.projection.snapshot().config, mode: control.mode },
						});
						break;
					}
					case "cancelBackgroundWork": {
						const workId = P.commandPayloadSchemas.cancelBackgroundWork.parse(payload).workId;
						const target = hosted;
						if (await this.workflows.cancel(target.record.id, workId)) break;
						await target.record.run(() =>
							target.controls.cancelBackgroundWork(
								P.commandPayloadSchemas.cancelBackgroundWork.parse(payload).workId,
							),
						);
						target.projection.refresh();
						break;
					}
					case "pauseGoal": {
						const receipt = await hosted.commands.dispatch("/goal pause", {
							inputId: envelope.commandId,
							sourceCommand: { ...this.ledger.identity(envelope), type: envelope.type },
						});
						await receipt.completion;
						break;
					}
					case "resumeGoal": {
						const receipt = await hosted.commands.dispatch("/goal resume", {
							inputId: envelope.commandId,
							sourceCommand: { ...this.ledger.identity(envelope), type: envelope.type },
						});
						await receipt.completion;
						break;
					}
					case "startSavedWorkflow": {
						const params = P.commandPayloadSchemas.startSavedWorkflow.parse(payload);
						const target = hosted;
						if (!workflowPreparation?.ok) throw new Error("Workflow preflight was not completed");
						const started = await this.workflows.start(
							target.record,
							workflowPreparation.prepared,
							envelope.commandId,
						);
						if (!target.record.session.sessionName) {
							await target.record.run(() =>
								target.record.session.sessionManager.setSessionName(params.name, "auto", "saved-workflow"),
							);
						}
						await target.record.run(() =>
							target.record.session.appendCustomMessage({
								customType: "zcode-workflow-launch",
								content: `Started workflow ${params.name}.`,
								display: true,
								details: { launch: started.launch, inputId: envelope.commandId },
							}),
						);
						target.projection.refresh();
						target.projection.setWorkflowState(await this.workflows.projection(target.record.id));
						result = { type: "startSavedWorkflow", runId: started.runId, toolCallId: started.toolCallId };
						break;
					}
					case "resumeWorkflowRun": {
						const params = P.commandPayloadSchemas.resumeWorkflowRun.parse(payload);
						await this.workflows.resume(hosted.record, params.workId);
						break;
					}
					case "amendWorkflowRunSettings": {
						const params = P.commandPayloadSchemas.amendWorkflowRunSettings.parse(payload);
						const target = hosted;
						try {
							const amended = await this.workflows.amend(target.record, params, envelope.commandId);
							await target.record.run(() =>
								target.record.session.appendCustomMessage({
									customType: "zcode-workflow-launch",
									content: "Updated workflow run settings.",
									display: true,
									details: { launch: amended.launch, inputId: envelope.commandId },
								}),
							);
							target.projection.setWorkflowState(this.workflows.projection(target.record.id));
							result = {
								type: "amendWorkflowRunSettings",
								runId: amended.runId,
								toolCallId: amended.toolCallId,
								...("supersededRunId" in amended && amended.supersededRunId
									? { supersededRunId: amended.supersededRunId }
									: {}),
							};
						} catch (error) {
							const reason = P.workflowRunSettingsRejectionReasonSchema.safeParse(
								error && typeof error === "object" && "reason" in error ? error.reason : undefined,
							);
							return {
								commandId: envelope.commandId,
								status: "rejected",
								revisionAtDecision: revision,
								reasonCode: `fault.command.workflowRunSettingsRejected.${reason.success ? reason.data : "start_failed"}`,
								message: error instanceof Error ? error.message : String(error),
							};
						}
						break;
					}
					default:
						throw new ZCodeProtocolError(-32601, `Unknown command: ${envelope.type}`);
				}
			}
			await this.#refreshIndexes();
			return P.commandAckSchema.parse({
				commandId: envelope.commandId,
				memoryEnabled: hosted?.record.memory.memoryEnabled,
				status: "accepted",
				revisionAtDecision: hosted?.projection.snapshot().revision ?? revision,
				...(result ? { result } : {}),
			});
		} catch (error) {
			return {
				commandId: envelope.commandId,
				status: "failed",
				reasonCode: "fault.command.execution",
				message: error instanceof Error ? error.message : String(error),
				revisionAtDecision: revision,
			};
		}
	}
	#readCatalog<T>(
		cwd: string,
		sessionId: string | undefined,
		read: (options: ZCodeCatalogOptions) => Promise<T>,
	): Promise<T> {
		if (!sessionId) return read({});
		const record = this.manager.get(sessionId);
		if (!record) throw new ZCodeProtocolError(-32004, "Catalog session is not active", { sessionId });
		if (path.resolve(record.cwd) !== path.resolve(cwd))
			throw new ZCodeProtocolError(-32602, "Catalog workspace does not match session");
		return record.run(() => read({ sessionId, session: record.session, settings: record.settings }));
	}
	async #close(id: string): Promise<void> {
		await this.workflows.cancelSession(id);
		const hosted = this.#hosted.get(id);
		this.legacy.disposeSession(id);
		hosted?.unsubscribeTelemetry();
		hosted?.telemetry.close();
		hosted?.commands.dispose();
		hosted?.unsubscribe();
		hosted?.projection.dispose();
		this.attachments.disposeSession(id);
		this.#hosted.delete(id);
		await this.manager.close(id);
		await this.#refreshIndexes();
	}
	async dispatch(
		method: string,
		raw: unknown,
		afterResponse: (callback: () => void) => void = () => {},
	): Promise<unknown> {
		if (!this.#ready && this.#initialization) await this.#initialization;
		if (!this.#ready || this.#closed) throw new ZCodeProtocolError(-32000, "Storage is not ready");
		switch (method) {
			case "omp/profiles/list":
				return this.profiles.list(raw);
			case "omp/profiles/prepareSwitch":
				return this.profiles.prepare(raw);
			case "omp/profiles/cancelSwitch":
				return this.profiles.cancel(raw);
		}
		if (method === "runtime/capabilities") return this.#dispatchAdmitted(method, raw, afterResponse);
		if (this.profiles.blocked)
			throw new ZCodeProtocolError(-32000, "Profile switch admission barrier is active", {
				kind: "omp.profileSwitchPrepared",
			});
		this.#businessDispatches++;
		try {
			return await this.#dispatchAdmitted(method, raw, afterResponse);
		} finally {
			this.#businessDispatches--;
		}
	}
	async #dispatchAdmitted(
		method: string,
		raw: unknown,
		afterResponse: (callback: () => void) => void,
	): Promise<unknown> {
		switch (method) {
			case "runtime/capabilities":
				return {
					historyFirst: true,
					independentPlanState: true,
					ompConfiguration: true,
					ompSkillManagement: true,
					ompIndexes: true,
					ompTeam: true,
					ompProfiles: true,
					ompTan: true,
				};
			case "workspace/generateText": {
				const params = L.zcodeWorkspaceGenerateTextParamsSchema.parse(raw);
				this.#registerIndexWorkspace(params);
				const operationId = params.operationId?.trim();
				if (operationId && this.#workspaceText.has(operationId))
					throw new ZCodeProtocolError(-32600, `Workspace generate operation is already active: ${operationId}`);
				const controller = new AbortController();
				if (operationId) this.#workspaceText.set(operationId, controller);
				try {
					return await generateWorkspaceText(
						this.configuration,
						params,
						AbortSignal.any([this.#lifetime.signal, controller.signal]),
					);
				} finally {
					if (operationId && this.#workspaceText.get(operationId) === controller)
						this.#workspaceText.delete(operationId);
				}
			}
			case "workspace/cancelGenerateText": {
				const { operationId } = L.zcodeWorkspaceCancelGenerateTextParamsSchema.parse(raw);
				const controller = this.#workspaceText.get(operationId);
				if (!controller) return { operationId, cancelled: false };
				controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
				this.#workspaceText.delete(operationId);
				return { operationId, cancelled: true };
			}
			case "omp/tan/start":
			case "omp/tan/list":
			case "omp/tan/stop": {
				const params =
					method === "omp/tan/start"
						? ompTanStartParamsSchema.parse(raw)
						: method === "omp/tan/stop"
							? ompTanStopParamsSchema.parse(raw)
							: ompTanListParamsSchema.parse(raw);
				this.#registerIndexWorkspace(params);
				const info = await this.manager.read(params.sessionId);
				if (!this.#ownsWorkspaceSession(params.workspace.workspaceKey, info))
					throw new ZCodeProtocolError(-32602, "Tan session does not belong to this workspace");
				if (method === "omp/tan/list") return { jobs: await this.tan.list(params.sessionId) };
				const hosted = await this.#active(params.sessionId);
				if (method === "omp/tan/start" && "work" in params && typeof params.work === "string") {
					await this.#applySubagentRuntimeConfig(hosted.record);
					return { job: await this.tan.start(hosted.record, params.work, () => hosted.projection.refresh()) };
				}
				if ("jobId" in params && typeof params.jobId === "string")
					return this.tan.stop(hosted.record, params.jobId);
				throw new ZCodeProtocolError(-32602, "Invalid Tan method parameters");
			}
			case "omp/wiki/list":
			case "omp/wiki/init":
			case "omp/wiki/remove":
			case "omp/wiki/search":
			case "omp/wiki/grep":
			case "omp/wiki/cancel":
				this.#registerIndexWorkspace(raw);
				return this.indexes.handleWiki(method.slice("omp/wiki/".length), raw, this.#lifetime.signal);
			case "omp/repo/status":
			case "omp/repo/init":
			case "omp/repo/update":
			case "omp/repo/rebuild":
			case "omp/repo/remove":
			case "omp/repo/text":
			case "omp/repo/symbol":
			case "omp/repo/cancel":
				this.#registerIndexWorkspace(raw);
				return this.indexes.handleRepo(method.slice("omp/repo/".length), raw, this.#lifetime.signal);
			case "omp/team/configure": {
				const { workspace, request } = P.ompTeamConfigureParamsSchema.parse(raw);
				const cwd = path.resolve(this.options.cwd ?? process.cwd());
				// workspace 只负责可信进程路由；不能借全局配置接口访问任意目录或创建隐藏会话。
				if (
					!path.isAbsolute(workspace.workspacePath) ||
					(await realpath(workspace.workspacePath)) !== (await realpath(cwd))
				)
					throw new ZCodeProtocolError(-32602, "Team configuration workspace does not match execution directory");
				const settings =
					request.operation === "set_team_config"
						? await Settings.loadIsolated({ cwd })
						: await Settings.loadReadOnly({ cwd });
				const auth = await discoverAuthStorage(undefined, { cwd, settings });
				try {
					const registry = new ModelRegistry(auth, undefined, { settings });
					await this.configuration.prepare(cwd, settings, registry);
					// 构造器不恢复账号隔离缓存；与 SDK 一致仅离线补齐，不能靠隐藏会话或联网刷新模型目录。
					await registry.hydrateCredentialScopedModelCaches();
					let committed = false;
					const service = new TeamConfigService({
						getSettings: () => settings,
						getModelRegistry: () => registry,
						getSessionModel: () => undefined,
						emit: () => {
							committed = true;
						},
					});
					let data;
					switch (request.operation) {
						case "get_team_config":
							data = await service.getConfig(request.preview);
							break;
						case "get_team_models":
							data = service.getModels(request.query);
							break;
						case "set_team_config": {
							let failure: unknown;
							try {
								data = await service.setConfig({
									scope: request.scope,
									expectedRevision: request.expectedRevision,
									members: request.members,
								});
							} catch (error) {
								failure = error;
								if (error instanceof TeamConfigError && error.data?.writes.active.status === "unknown")
									committed = true;
								throw error;
							} finally {
								// 旧会话持有独立 settings 快照；保存后重读同一全局事实，后续 /team 不再沿用旧成员。
								if (committed) {
									try {
										await Promise.all(
											Array.from(this.#hosted.values(), hosted => hosted.record.settings.reloadFromDisk()),
										);
									} catch (error) {
										if (failure) throw failure;
										throw new TeamConfigError("execution_failed", String(error), data);
									}
								}
							}
							break;
						}
					}
					return P.zcodeSessionConfigureResultSchema.parse({ operation: request.operation, data });
				} finally {
					auth.close();
					settings.cancelPendingSaves();
				}
			}
			case "omp/team":
				return this.team.handle(raw);
			case "workflows/list":
				return L.zcodeWorkflowsListResultSchema.parse(
					await this.workflows.list(L.zcodeWorkflowsListParamsSchema.parse(raw)),
				);
			case "workflows/get":
				return L.zcodeWorkflowsGetResultSchema.parse(
					await this.workflows.get(L.zcodeWorkflowsGetParamsSchema.parse(raw)),
				);
			case "workflows/updateMeta":
				return L.zcodeWorkflowsUpdateMetaResultSchema.parse(
					await this.workflows.updateMeta(L.zcodeWorkflowsUpdateMetaParamsSchema.parse(raw)),
				);
			case "workflows/delete":
				return L.zcodeWorkflowsDeleteResultSchema.parse(
					await this.workflows.delete(L.zcodeWorkflowsDeleteParamsSchema.parse(raw)),
				);
			case "workflows/move":
				return L.zcodeWorkflowsMoveResultSchema.parse(
					await this.workflows.move(L.zcodeWorkflowsMoveParamsSchema.parse(raw)),
				);
			case "workflows/runs":
				return L.zcodeWorkflowsRunsResultSchema.parse(
					await this.workflows.runs(L.zcodeWorkflowsRunsParamsSchema.parse(raw)),
				);
			case "workflows/save":
				return L.zcodeWorkflowsSaveResultSchema.parse(
					await this.workflows.save(L.zcodeWorkflowsSaveParamsSchema.parse(raw)),
				);
			case "workflows/forRun":
				return L.zcodeWorkflowsForRunResultSchema.parse(
					await this.workflows.forRun(L.zcodeWorkflowsForRunParamsSchema.parse(raw)),
				);
			case "v4/conversation/workflowRuns": {
				const params = P.v4ConversationWorkflowRunsParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunsResultSchema.parse(
					await this.workflows.listRuns(params.sessionId, params),
				);
			}
			case "v4/conversation/workflowRunEvents": {
				const params = P.v4ConversationWorkflowRunEventsParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunEventsResultSchema.parse(
					await this.workflows.getRunEvents(params.sessionId, params.runId, params),
				);
			}
			case "v4/conversation/workflowRunArtifacts": {
				const params = P.v4ConversationWorkflowRunArtifactsParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunArtifactsResultSchema.parse(
					await this.workflows.getRunArtifacts(params.sessionId, params.runId),
				);
			}
			case "v4/conversation/workflowRunArtifactRead": {
				const params = P.v4ConversationWorkflowRunArtifactReadParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunArtifactReadResultSchema.parse(await this.workflows.artifactRead(params));
			}
			case "v4/conversation/workflowRunArtifactData": {
				const params = P.v4ConversationWorkflowRunArtifactDataParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunArtifactDataResultSchema.parse(await this.workflows.artifactData(params));
			}
			case "v4/conversation/workflowRunWorkspace": {
				const params = P.v4ConversationWorkflowRunWorkspaceParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunWorkspaceResultSchema.parse(await this.workflows.workspace(params));
			}
			case "v4/conversation/workflowRunNodeResult": {
				const params = P.v4ConversationWorkflowRunNodeResultParamsSchema.parse(raw);
				return P.v4ConversationWorkflowRunNodeResultResultSchema.parse(await this.workflows.nodeResult(params));
			}
			case "plugins/list": {
				const params = L.zcodePluginsListParamsSchema.parse(raw);
				return this.catalogs.plugins(params.workspace.workspacePath, { configScope: params.configScope });
			}
			case "plugins/overview": {
				const params = L.zcodePluginsOverviewParamsSchema.parse(raw);
				return this.catalogs.overview(params.workspace.workspacePath, { configScope: params.configScope });
			}
			case "plugins/referenceCatalog": {
				const params = L.zcodePluginsReferenceCatalogParamsSchema.parse(raw);
				return this.#readCatalog(params.workspace.workspacePath, params.sessionId, options =>
					this.catalogs.pluginReferences(params.workspace.workspacePath, options),
				);
			}
			case "skills/referenceCatalog": {
				const params = L.zcodeSkillsReferenceCatalogParamsSchema.parse(raw);
				return this.#readCatalog(params.workspace.workspacePath, params.sessionId, options =>
					this.catalogs.skillReferences(params.workspace.workspacePath, options),
				);
			}
			case "skills/manage": {
				const params = zcodeSkillsManageParamsSchema.parse(raw);
				return this.catalogs.manageSkills(params.workspacePath, params, {
					onChanged: async () => {
						// 原生 profile 是唯一启停事实；驻留会话重读同一持久层，不维护第二份开关。
						for (const hosted of this.#hosted.values()) {
							await hosted.record.run(async () => {
								await hosted.record.settings.reloadFromDisk();
								await hosted.record.session.refreshSkillsAndCommands();
								this.catalogs.invalidateSession(hosted.record.session);
							});
						}
					},
				});
			}
			case "provider/testModelConnectivity":
				return this.configuration.testModelConnectivity(
					raw,
					this.#ownerSignal ? AbortSignal.any([this.#lifetime.signal, this.#ownerSignal]) : this.#lifetime.signal,
				);
			case "provider/updateAccountConfig": {
				const result = await this.configuration.updateAccountConfig(raw);
				await this.#refreshAllWorkspaceConfigs();
				return result;
			}
			case "provider/refreshRegistry": {
				const result = await this.configuration.refreshRegistry(raw);
				await this.#refreshAllWorkspaceConfigs();
				return result;
			}
			case "workspace/hooks/trustGrant": {
				L.zcodeWorkspaceHookTrustGrantParamsSchema.parse(raw);
				// Native hooks have no Host-managed trust store; never pretend to persist a grant.
				return L.zcodeWorkspaceHookTrustGrantResultSchema.parse({
					accepted: false,
					reasonCode: "workspace_hooks_policy_requires_pretrust",
				});
			}
			case "workspace/updateInteractionPreferences":
				return this.configuration.updateInteractionPreferences(raw);
			case "workspace/updateModelIoPreferences":
				return this.configuration.updateModelIoPreferences(raw);
			case "session/create": {
				const params = L.zcodeSessionCreateParamsSchema.parse(raw);
				this.#registerWorkspace(params.workspace);
				const hosted = await this.#attach(
					await this.manager.create({
						cwd: params.workspace.workspacePath,
						sessionId: params.sessionId,
						additionalDirectories: params.additionalDirectories,
						mcpServers: params.mcpServers,
						toolAllowlist: params.toolAllowlist,
						toolDenylist: params.toolDenylist,
						autoTitle: params.titleGenerationEnabled ?? true,
					}),
				);
				const selected = params.model ?? this.configuration.getDefaultModelSelection();
				if (selected) await this.#model(hosted, selected);
				const mode = params.mode;
				if (mode && mode !== "auto") await hosted.record.run(() => hosted.controls.switchMode(mode));
				if (params.thoughtLevel) {
					const model = hosted.record.session.model;
					const thought = model
						? this.configuration.resolveThinkingLevel(model.provider, model.id, params.thoughtLevel)
						: parseZCodeThinkingLevel(params.thoughtLevel);
					if (thought === undefined) throw new ZCodeProtocolError(-32602, "Invalid reasoning level");
					hosted.record.run(() => hosted.record.session.setThinkingLevel(thought, false));
				}
				hosted.projection.refresh();
				await this.#refreshIndexes();
				return this.#snapshot(hosted.record.id);
			}
			case "session/resume": {
				const params = L.zcodeSessionResumeParamsSchema.parse(raw);
				await this.#attach(
					await this.manager.resume(params.sessionId, {
						additionalDirectories: params.additionalDirectories,
						mcpServers: params.mcpServers,
						toolAllowlist: params.toolAllowlist,
						toolDenylist: params.toolDenylist,
					}),
				);
				return this.#snapshot(params.sessionId);
			}
			case "session/read": {
				const params = L.zcodeSessionReadParamsSchema.parse(raw);
				return this.#snapshot(params.sessionId, params);
			}
			case "session/list": {
				const params = L.zcodeSessionListParamsSchema.parse(raw ?? {});
				const sessions = await this.manager.list();
				return L.zcodeSessionListResultSchema.parse({
					sessions: sessions
						.filter(
							info =>
								this.#isRootSession(info.id) &&
								(!params.sessionIds || params.sessionIds.includes(info.id)) &&
								// 路径归一化比较(与 #readCatalog 一致):裸字符串相等会漏掉
								// 分隔符/大小写写法不同的同一工作区。
								(!params.workspace || path.resolve(info.cwd) === path.resolve(params.workspace.workspacePath)),
						)
						.slice(0, params.limit ?? 10000)
						.map(info => this.#sessionInfo(info)),
				});
			}
			case "session/messages": {
				const params = L.zcodeSessionMessagesParamsSchema.parse(raw);
				let messages = await this.legacy.messages(params.sessionId);
				if (params.afterMessageId) {
					const index = messages.findIndex(message => message.info.messageId === params.afterMessageId);
					if (index < 0) throw new ZCodeProtocolError(-32602, "History message cursor no longer exists");
					messages = messages.slice(index + 1);
				}
				return L.zcodeSessionMessagesResultSchema.parse({
					messages: params.limit ? messages.slice(-params.limit) : messages,
				});
			}
			case "session/send": {
				const params = L.zcodeSessionSendParamsSchema.parse(raw);
				const hosted = await this.#active(params.sessionId);
				if (params.modelSelection && !params.modelExecution) await this.#model(hosted, params.modelSelection);
				const execution =
					params.modelSelection && params.modelExecution
						? { ...params.modelExecution, selection: params.modelSelection, offPeakTaskId: params.offPeakTaskId }
						: undefined;
				const inputId = params.inputId ?? randomUUID();
				const sourceCommand = params.automationId
					? {
							sessionId: params.sessionId,
							commandId: inputId,
							type: "sendText",
							automationId: params.automationId,
							fingerprint: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
						}
					: undefined;
				await this.#input(
					hosted,
					params.content,
					inputId,
					// automation 派发(legacy send 路径同带 automationId)缺省 startNow,与 v4 sendText
					// 的派发语义对齐(findings J);普通输入仍走 followupMode 缺省。
					params.automationId ? "startNow" : undefined,
					params.attachments,
					sourceCommand,
					{
						toolDenylist: params.automationId
							? [...new Set([...(params.toolDenylist ?? []), "CronCreate", "CronUpdate", "CronDelete"])]
							: params.toolDenylist,
					},
					execution,
				);
				return {
					sessionId: params.sessionId,
					accepted: true,
					stateRevision: hosted.projection.snapshot().revision,
				};
			}
			case "session/close": {
				const params = L.zcodeSessionCloseParamsSchema.parse(raw);
				await this.#close(params.sessionId);
				return { closed: true };
			}
			case "session/setModel": {
				const params = L.zcodeSessionSetModelParamsSchema.parse(raw);
				await this.#model(await this.#active(params.sessionId), params.model);
				return this.#snapshot(params.sessionId);
			}
			case "session/setThoughtLevel": {
				const params = L.zcodeSessionSetThoughtLevelParamsSchema.parse(raw);
				const hosted = await this.#active(params.sessionId);
				const model = hosted.record.session.model;
				const thought =
					params.thoughtLevel === undefined
						? undefined
						: model
							? this.configuration.resolveThinkingLevel(model.provider, model.id, params.thoughtLevel)
							: parseZCodeThinkingLevel(params.thoughtLevel);
				if (params.thoughtLevel !== undefined && thought === undefined)
					throw new ZCodeProtocolError(-32602, "Invalid reasoning level");
				hosted.record.run(() => hosted.record.session.setThinkingLevel(thought, false));
				hosted.projection.refresh();
				return this.#snapshot(params.sessionId);
			}
			case "session/compact": {
				const params = L.zcodeSessionCompactParamsSchema.parse(raw);
				const hosted = await this.#active(params.sessionId);
				const inputId = params.inputId ?? randomUUID();
				await this.#input(hosted, `/compact${params.instructions ? ` ${params.instructions}` : ""}`, inputId);
				return {
					response: "Compaction admitted.",
					snapshot: await this.#snapshot(params.sessionId),
					compact: { state: "accepted", inputId },
				};
			}
			case "session/goal": {
				const params = L.zcodeSessionGoalParamsSchema.parse(raw);
				const hosted = await this.#active(params.sessionId);
				// 裸目标会被解析成控制子命令，且不能替换活动目标；显式 set 保留完整目标文本。
				const text =
					params.action === "show"
						? "/goal"
						: params.action === "set" || params.action === "replace"
							? `/goal set ${params.objective ?? ""}`
							: `/goal ${params.action}`;
				const receipt = await hosted.commands.dispatch(text, { inputId: params.inputId });
				await receipt.completion;
				return { response: "", snapshot: await this.#snapshot(params.sessionId) };
			}
			case "session/stop": {
				const params = L.zcodeSessionStopParamsSchema.parse(raw);
				const hosted = this.#hosted.get(params.sessionId);
				if (!hosted) throw new ZCodeProtocolError(-32004, "Session is not active");
				hosted.projection.setState({ control: { ...hosted.projection.snapshot().control, stopState: "stopping" } });
				hosted.commands.cancel();
				await this.manager.stop(params.sessionId);
				return {};
			}
			case "session/setMode": {
				const params = L.zcodeSessionSetModeParamsSchema.parse(raw);
				const hosted = await this.#active(params.sessionId);
				const requestedMode = params.mode;
				if (requestedMode === "auto")
					throw new ZCodeProtocolError(-32602, "Auto mode is reserved but not implemented yet", {
						reasonCode: "mode.auto.unimplemented",
					});
				const mode = await hosted.record.run(() => hosted.controls.switchMode(requestedMode));
				hosted.projection.setState({ config: { ...hosted.projection.snapshot().config, mode: mode.mode } });
				return this.#snapshot(params.sessionId);
			}
			case "session/subscribe":
				return this.legacy.subscribe(raw);
			case "session/events":
				return this.legacy.events(raw);
			case "session/debug":
				return this.legacy.debug(raw);
			case "session/subagents":
				return this.legacy.subagents(raw);
			case "workspace/readPresentation": {
				const params = L.zcodeWorkspaceReadPresentationParamsSchema.parse(raw);
				const config = await this.#workspaceConfig(params.workspace.workspacePath);
				return L.zcodeWorkspacePresentationSchema.parse({
					workspace: params.workspace,
					mode: config.configOptions.find(option => option.id === "mode")?.currentValue,
					slashCommands: config.slashCommands,
				});
			}
			case "session/configure": {
				const params = P.zcodeSessionConfigureParamsSchema.parse(raw);
				const hosted = await this.#active(params.sessionId);
				return P.zcodeSessionConfigureResultSchema.parse({
					operation: params.operation,
					data: await hosted.commands.configure(params.operation, params),
				});
			}
			case "v4/command":
				return this.#command(raw);
			case "v4/commands/query": {
				const params = P.commandsQueryParamsSchema.parse(raw);
				return this.ledger.query(params.commands);
			}
			case "v4/conversation/subscribe": {
				const params = P.v4ConversationSubscribeParamsSchema.parse(raw);
				if (params.workspace) this.#registerWorkspace(params.workspace);
				if (this.#closedConnections.has(params.connectionId))
					throw new ZCodeProtocolError(-32602, "Connection is closed");
				if (!this.#connections.has(params.connectionId) && this.#connections.size >= 256)
					throw new ZCodeProtocolError(-32000, "Connection capacity exceeded");
				const knownMode = this.#connections.get(params.connectionId);
				if (knownMode && knownMode !== params.clientMode)
					throw new ZCodeProtocolError(-32602, "Connection delivery profile changed");
				this.#connections.set(params.connectionId, params.clientMode);
				let permissionRoot: string | undefined;
				if (params.topic.startsWith("conversation/")) {
					const id = params.topic.slice(13);
					const child = await this.manager.nativeChild(id);
					permissionRoot = child?.root?.id ?? id;
					if (child) await this.#nativeProjection(id, child);
					else
						await this.#attach(
							this.manager.get(id) ??
								(await this.manager.resume(id, { additionalDirectories: params.additionalDirectories })),
						);
					// actor 是独立 runtime record，但审批仍由 SDK 分配的父级 scoped UI 持有。
					// 原生 child 可能属于 actor；沿同一运行时父链归一，不能另建 actor owner 表。
					let permissionOwner = child?.root ?? this.manager.get(id);
					while (permissionOwner?.interactionParentSessionId) {
						permissionRoot = permissionOwner.interactionParentSessionId;
						const parentChild = await this.manager.nativeChild(permissionRoot);
						permissionOwner = parentChild?.root ?? this.manager.get(permissionRoot);
						permissionRoot = permissionOwner?.id ?? permissionRoot;
					}
					// 复用已挂载 projection 时也要先观察 SDK 晚绑定的真实 child 身份，再交付恢复快照。
					(await this.#projection(id)).refresh();
				} else if (params.topic.startsWith("sessions-index/")) {
					const workspaceId = params.topic.slice(15);
					// 初始快照按该工作区 cwd 过滤:manager.list() 的 listAll 合并了所有项目
					// 的会话,不过滤会把其他工作区的会话发进本工作区侧栏(findings P2)。
					this.#indexInfos.set(
						workspaceId,
						(await this.manager.list()).filter(info => this.#ownsWorkspaceSession(workspaceId, info)),
					);
					if (!this.#registeredTopics.has(params.topic)) {
						this.topics.register(params.topic, {
							snapshot: () => ({
								protocolVersion: 1,
								workspaceId,
								logEpoch: this.#workspaceEpoch,
								sessions: (this.#indexInfos.get(workspaceId) ?? []).map(info =>
									this.#summary(info, workspaceId),
								),
							}),
						});
						this.#registeredTopics.add(params.topic);
					}
				} else if (params.topic.startsWith("workspace-config/")) {
					const workspaceId = params.topic.slice(17);
					const cwd =
						params.workspace?.workspacePath ??
						this.#workspaceIds.get(workspaceId) ??
						this.options.cwd ??
						process.cwd();
					const config = await this.#workspaceConfig(cwd);
					this.#workspaceConfigs.set(workspaceId, config);
					if (this.#registeredTopics.has(params.topic))
						this.topics.publish(params.topic, [{ op: "config.updated", config }]);
					else {
						this.topics.register(params.topic, {
							snapshot: () => ({
								protocolVersion: 1,
								workspaceId,
								logEpoch: this.#workspaceEpoch,
								config: this.#workspaceConfigs.get(workspaceId)!,
							}),
						});
						this.#registeredTopics.add(params.topic);
					}
				}
				// 打开 projection 期间可能已收到 closed，不能重新登记失效连接的审批 owner。
				if (this.#closedConnections.has(params.connectionId))
					throw new ZCodeProtocolError(-32602, "Connection is closed");
				const subscription = this.topics.subscribe(params, wire => {
					void this.writer.write({ method: "v4/conversation/frame", params: wire });
				});
				for (const [id, owner] of this.#subscriptions)
					if (owner.connectionId === params.connectionId && owner.topic === params.topic)
						this.#subscriptions.delete(id);
				this.#subscriptions.set(subscription.ack.subscriptionId, {
					connectionId: params.connectionId,
					topic: params.topic,
				});
				if (params.topic.startsWith("workspace-config/")) this.#watchCatalogs();
				if (permissionRoot) {
					const owners = this.#permissionOwners.get(params.connectionId) ?? new Set<string>();
					owners.add(permissionRoot);
					this.#permissionOwners.set(params.connectionId, owners);
				}
				afterResponse(subscription.flush);
				return { ack: subscription.ack };
			}
			case "v4/conversation/resync": {
				const params = P.v4ConversationResyncParamsSchema.parse(raw);
				const owner = this.#subscriptions.get(params.subscriptionId);
				if (!owner || owner.connectionId !== params.connectionId || owner.topic !== params.topic)
					throw new ZCodeProtocolError(-32602, "Subscription ownership mismatch");
				if (params.topic.startsWith("conversation/")) (await this.#projection(params.topic.slice(13))).refresh();
				const subscription = this.topics.recover(params);
				afterResponse(subscription.flush);
				return { ack: subscription.ack };
			}
			case "v4/conversation/unsubscribe": {
				const params = P.v4ConversationUnsubscribeParamsSchema.parse(raw);
				const owner = this.#subscriptions.get(params.subscriptionId);
				if (owner && (owner.connectionId !== params.connectionId || owner.topic !== params.topic))
					throw new ZCodeProtocolError(-32602, "Subscription ownership mismatch");
				this.topics.cancel(params.subscriptionId);
				this.#subscriptions.delete(params.subscriptionId);
				return {};
			}
			case "v4/conversation/usage":
				return this.queries.conversationUsage(raw);
			case "v4/usage/stats":
				return this.queries.usageStats(raw);
			case "v4/conversation/plans": {
				const params = P.v4ConversationPlansParamsSchema.parse(raw);
				await this.#projection(params.sessionId);
				return this.queries.plans(params);
			}
			case "v4/conversation/fileChanges": {
				const params = P.v4ConversationFileChangesParamsSchema.parse(raw);
				await this.#projection(params.sessionId);
				return this.queries.fileChanges(params);
			}
			case "v4/conversation/fileRewindPreview": {
				const params = P.v4ConversationFileRewindPreviewParamsSchema.parse(raw);
				await this.#projection(params.sessionId);
				return this.queries.fileRewindPreview(params);
			}
			case "v4/conversation/backgroundBashOutput":
				return this.queries.backgroundBashOutput(raw);
			case "v4/conversation/offPeakControl":
				return this.manager.offPeakControl(offPeakControlParamsSchema.parse(raw));
			case "v4/attachment/begin": {
				const params = P.v4AttachmentBeginParamsSchema.parse(raw);
				if (this.#closedConnections.has(params.connectionId))
					throw new ZCodeProtocolError(-32602, "Attachment connection is closed");
				return this.attachments.attachmentBegin(params);
			}
			case "v4/attachment/chunk":
				return this.attachments.attachmentChunk(raw);
			case "v4/attachment/commit":
				return this.attachments.attachmentCommit(raw);
			case "v4/attachment/abort":
				return this.attachments.attachmentAbort(raw);
			case "v4/attachment/read":
				return this.attachments.attachmentRead(raw);
			case "v4/attachment/previewSource":
				return this.attachments.attachmentPreviewSource(raw);
			case "v4/conversation/attachmentRead":
				return this.attachments.conversationAttachmentRead(raw);
			case "v4/conversation/attachmentStat":
				return this.attachments.conversationAttachmentStat(raw);
			case "v4/connection/flow": {
				const params = P.v4ConnectionFlowParamsSchema.parse(raw);
				if (params.state === "closed") {
					this.#closedConnections.add(params.connectionId);
					this.topics.closeConnection(params.connectionId);
					this.attachments.closeConnection(params.connectionId);
					this.#connections.delete(params.connectionId);
					// 退订 A 后切到 B 仍拥有 A 的审批；真正断连才撤销失去最后活连接 owner 的审批。
					const abandonedRoots = this.#permissionOwners.get(params.connectionId) ?? new Set<string>();
					this.#permissionOwners.delete(params.connectionId);
					for (const [id, owner] of this.#subscriptions)
						if (owner.connectionId === params.connectionId) this.#subscriptions.delete(id);
					for (const sessionId of abandonedRoots) {
						const hasOwner = Array.from(this.#permissionOwners.values()).some(roots => roots.has(sessionId));
						if (!hasOwner) this.#hosted.get(sessionId)?.commands.interactions.cancelPermissions();
					}
				} else this.topics.setConnectionFlow(params.connectionId, params.state);
				return {};
			}
			case "v4/conversation/rowsRange": {
				const params = P.v4ConversationRowsRangeParamsSchema.parse(raw);
				const projection = await this.#projection(params.sessionId);
				const snapshot = projection.snapshot();
				const rows = projection
					.rows()
					.filter(row => params.beforeRowId === undefined || row.rowId < params.beforeRowId);
				return {
					rows: rows.slice(-params.limit),
					atSeq: snapshot.seq,
					atRevision: snapshot.revision,
					atLogEpoch: snapshot.logEpoch,
					hasMore: rows.length > params.limit,
				};
			}
			case "v4/sessionsIndex/reconcile": {
				const params = P.sessionsIndexReconcileParamsSchema.parse(raw);
				const infos = (await this.manager.list()).filter(info => this.#isRootSession(info.id));
				return {
					sessions: params.sessionIds.map(sessionId => {
						const info = infos.find(row => row.id === sessionId);
						return info
							? {
									sessionId,
									exists: true,
									deleted: false,
									title: info.title ?? info.firstMessage,
									titleSource: "default",
									createdAt: info.created.getTime(),
									updatedAt: info.modified.getTime(),
								}
							: { sessionId, exists: false, deleted: false };
					}),
				};
			}
			default:
				throw new ZCodeProtocolError(-32601, `Unknown method: ${method}`);
		}
	}
	async #nativeProjection(id: string, child: ZCodeNativeChild): Promise<ZCodeProjection> {
		let entry = this.#nativeProjections.get(id);
		if (!entry) {
			entry = { child, generation: 0 };
			this.#nativeProjections.set(id, entry);
		}
		if (child.session && entry.child.session === child.session && entry.projection) return entry.projection;
		const target = child.session ?? null;
		if (entry.pending && entry.pendingSession === target) return entry.pending;
		if (entry.pending) {
			// 冷态重建期间 child 被原生复活时，必须由 live 重绑取代旧 flight；
			// 否则 registered 通知会被在途冷读吞掉，详情长期停在旧投影。
			entry.generation++;
			entry.pending = undefined;
			entry.pendingSession = undefined;
		}
		const current = entry;
		const generation = ++current.generation;
		current.pendingSession = target;
		current.pending = (async () => {
			if (child.session) {
				this.#cold.get(id)?.projection.dispose();
				this.#cold.delete(id);
			}
			const projection = child.session
				? new ZCodeProjection({
						sessionId: id,
						cwd: child.session.sessionManager.getCwd(),
						session: child.session,
						registry: child.root?.registry,
						agentId: child.agentId,
						childSessions: await this.manager.childIdentities(id),
					})
				: await this.#coldProjection(id);
			// registry 的 release/revive 可跨 await 换代；旧详情不能重新接管已释放的 child。
			if (this.#closed || this.#nativeProjections.get(id) !== current || current.generation !== generation) {
				projection.dispose();
				throw new Error("Native child projection owner changed");
			}
			if (child.session && child.root?.registry.get(child.agentId)?.session !== child.session) {
				projection.dispose();
				current.pending = undefined;
				current.pendingSession = undefined;
				const next = await this.manager.nativeChild(id);
				if (!next) throw new Error("Native child owner disappeared");
				return this.#nativeProjection(id, next);
			}
			if (current.projection === projection) return projection;
			current.unsubscribe?.();
			if (current.projection !== projection) current.projection?.dispose();
			current.child = child;
			current.projection = projection;
			current.unsubscribe = child.root?.registry.onChange(event => {
				if (event.ref.id !== child.agentId) return;
				if (event.ref.session === current.child.session && event.type !== "removed") return;
				// 只观察原生 owner 的换代；不调用 ensureLive、不获得 writer 或 dispose child。
				current.generation++;
				current.pending = undefined;
				void this.manager
					.nativeChild(id)
					.then(next => {
						if (next) return this.#nativeProjection(id, next);
					})
					.catch(error => process.stderr.write(`${String(error)}\n`));
			});
			this.topics.register(`conversation/${id}`, {
				snapshot: () => projection.snapshot(),
				subscribe: listener => projection.subscribe(listener),
			});
			return projection;
		})().finally(() => {
			if (current.generation === generation) {
				current.pending = undefined;
				current.pendingSession = undefined;
			}
		});
		return current.pending;
	}
	async #projection(id: string): Promise<ZCodeProjection> {
		const hosted = this.#hosted.get(id);
		if (hosted) return hosted.projection;
		const child = await this.manager.nativeChild(id);
		if (child) return this.#nativeProjection(id, child);
		return this.#coldProjection(id);
	}
	async #coldProjection(id: string): Promise<ZCodeProjection> {
		const read = await this.manager.read(id);
		const version = read.info.modified.getTime();
		const cached = this.#cold.get(id);
		if (cached?.version === version) return cached.projection;
		cached?.projection.dispose();
		const [state, goalState, revertedTargets] = await Promise.all([
			this.queries.projectionState(id),
			this.queries.goalState(id),
			this.queries.revertedTargets(id),
		]);
		const projection = new ZCodeProjection({
			sessionId: id,
			cwd: read.cwd,
			messages: read.messages,
			entries: read.entries,
			state,
			goalState,
			revertedTargets,
			childSessions: await this.manager.childIdentities(id),
			...(await this.manager.forkProjection(id)),
		});
		projection.setWorkflowState(await this.workflows.projection(id));
		this.#cold.set(id, { projection, version });
		return projection;
	}
	async dispose(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#lifetime.abort(new Error("Owner disconnected"));
		this.#workspaceText.clear();
		for (const pending of this.#reverse.values()) {
			clearTimeout(pending.timer);
			pending.reject(new ZCodeProtocolError(-32000, "Owner disconnected"));
		}
		this.#reverse.clear();
		this.#permissionOwners.clear();
		this.#subscriptions.clear();
		this.#connections.clear();
		this.#closedConnections.clear();
		clearInterval(this.#catalogTimer);
		await this.#catalogRefresh;
		await Promise.allSettled(this.#catalogs.values());
		await Promise.allSettled(
			Array.from(this.#catalogRecords.values(), record => record.modelRegistry.awaitBackgroundRefresh()),
		);
		for (const dispose of this.#catalogDisposers) dispose();
		this.#catalogDisposers.clear();
		this.#catalogRecords.clear();
		this.#catalogs.clear();
		this.#stopBackup();
		// 取消审批会同步发布投影，订阅者仍需查询 workflow journal；
		// 必须先取消自有交互并卸载订阅，再关闭这些订阅依赖的资源。
		for (const hosted of this.#hosted.values()) {
			hosted.commands.dispose();
			hosted.unsubscribeTelemetry();
			hosted.telemetry.close();
			hosted.unsubscribe();
			hosted.projection.dispose();
		}
		this.#hosted.clear();
		for (const entry of this.#nativeProjections.values()) {
			entry.generation++;
			entry.unsubscribe?.();
			entry.projection?.dispose();
		}
		this.#nativeProjections.clear();
		for (const cold of this.#cold.values()) cold.projection.dispose();
		this.#cold.clear();
		this.team.dispose();
		await this.indexes.dispose();
		this.topics.dispose();
		this.attachments.dispose();
		this.legacy.dispose();
		await this.workflows.dispose();
		try {
			await this.manager.dispose();
		} finally {
			this.startup.close();
			await this.writer.flush();
		}
	}
}

export async function runZCodeAppServer(options: ZCodeServerOptions = {}): Promise<void> {
	const server = new ZCodeServer(options);
	const input = options.input ?? process.stdin;
	let pending = Buffer.alloc(0);
	let inFlight = 0;
	const work = new Set<Promise<void>>();
	const { promise: ended, resolve, reject } = Promise.withResolvers<void>();
	void ended.catch(() => {});
	const owner = new AbortController();
	const fail = (error: unknown) => {
		owner.abort(error);
		reject(error);
		input.pause();
	};
	const onData = (chunk: Buffer) => {
		if (chunk.length > 1024 * 1024) {
			fail(new Error("Protocol input chunk exceeds capacity"));
			return;
		}
		pending = Buffer.concat([pending, Buffer.from(chunk)]);
		while (true) {
			const lf = pending.indexOf(10);
			if (lf < 0) {
				if (pending.length > 1024 * 1024) fail(new Error("NDJSON frame exceeds limit"));
				return;
			}
			if (lf + 1 > 1024 * 1024 || inFlight >= 256) {
				fail(new Error("Protocol input capacity exceeded"));
				return;
			}
			const line = pending.subarray(0, lf);
			pending = pending.subarray(lf + 1);
			try {
				const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
				inFlight++;
				const task = server
					.receive(value)
					.catch(fail)
					.finally(() => {
						inFlight--;
						work.delete(task);
					});
				work.add(task);
			} catch (error) {
				fail(error);
				return;
			}
		}
	};
	const onEnd = () => {
		if (pending.length) fail(new Error("Incomplete NDJSON frame at EOF"));
		else {
			owner.abort(Object.assign(new Error("Owner disconnected"), { kind: "transport_closed" }));
			resolve();
		}
	};
	const onSignal = () => {
		owner.abort(Object.assign(new Error("Owner cancelled"), { kind: "transport_closed" }));
		resolve();
	};
	input.on("data", onData);
	input.once("end", onEnd);
	input.once("error", fail);
	const output = options.output ?? process.stdout;
	output.once("error", fail);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		await server.initialize(owner.signal);
		await ended;
	} finally {
		input.off("data", onData);
		input.off("end", onEnd);
		input.off("error", fail);
		output.off("error", fail);
		input.pause();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await server.dispose();
		await Promise.allSettled(work);
	}
}
