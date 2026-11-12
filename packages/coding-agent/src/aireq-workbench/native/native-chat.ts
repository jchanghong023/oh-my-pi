import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import { Emitter } from "../../../../../packages/aireq-frontend/packages/rpc/src/foundation";
import type {
	ZCodeMessageWithParts,
	ZCodeSessionInfo,
} from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-legacy-types";
import type {
	ZCodeSessionStateSnapshot,
	ZCodeSessionSubagentsResult,
} from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol";
import {
	attachmentRefSchema,
	type AttachmentRef,
} from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/attachment-ref";
import type { ConversationRow } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/rows";
import {
	conversationSnapshotSchema,
	type ConversationSnapshot,
	type ActiveWorkSummary,
	type ApiRetryState,
} from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import type { SessionSummary } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/sessions-index";
import type { CommandAck } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/command";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { isAgentViewSession } from "../../session/agent-session-handle";
import type { PromptOptions } from "../../session/agent-session-types";
import {
	isCustomMessageContent,
	isUserInvokedSkillPrompt,
	SKILL_PROMPT_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "../../session/messages";
import { resolveModelCompactionSettings } from "../../session/model-compaction-threshold";
import { loadSessionMessagesReadOnly, normalizeAssistantUsage } from "../../session/session-loader";
import { sessionDisplayName, type SessionInfo } from "../../session/session-listing";
import { NativeChildDirectory, type OwnedNativeChild } from "./native-subagents";
import { listBrowserProjects, readBrowserProject } from "./project-registry";
import { resolveNativeAttachments, resolveNativeFileContexts } from "./native-attachments";
import { buildNativeWebGuiSkillPrompt } from "./native-commands";
import { nativeWebGuiQuestions, withNativeWebGuiInteractionScope } from "./native-interactions";
import {
	assertAIReqNativeContext,
	isWebGuiNativeSessionUnavailable,
	listWebGuiNativeSessions,
	resolveWebGuiSession,
	resumeWebGuiNativeSession,
	runWebGuiSession,
	runAIReqNativeInput,
	resolveWebGuiInputSession,
	stopAIReqNativeInput,
	webGuiNativePorts,
} from "./native-session-host";
import { WebGuiNotImplementedError, type WebGuiServiceContext } from "./rpc-contract";

export function assertNativeChat(context: WebGuiServiceContext): AgentSession {
	context.signal.throwIfAborted();
	assertAIReqNativeContext(context, context.nativeSession?.sessionId);
	const session = context.nativeSession;
	const project = context.projectId ? readBrowserProject(context.projectId) : undefined;
	if (
		!session ||
		session.isDisposed ||
		isWebGuiNativeSessionUnavailable(session) ||
		!project ||
		(project.nativeSession !== session && !project.nativeSessions?.has(session)) ||
		project.mode !== "aireq" ||
		project.phase !== "active"
	) {
		throw new WebGuiNotImplementedError("native chat: no active native owner is bound");
	}
	return session;
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap(part =>
			part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("\n");
}

function isNativeUserInput(message: AgentMessage | undefined): message is
	| Extract<AgentMessage, { role: "user" }>
	| (Extract<AgentMessage, { role: "custom" }> & {
			customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
			attribution: "user";
	  }) {
	return message?.role === "user" || (message?.role === "custom" && isUserInvokedSkillPrompt(message));
}

function nativeInputText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	if (message.role === "custom" && isUserInvokedSkillPrompt(message)) {
		const details = message.details;
		return details && typeof details === "object" && "prompt" in details && typeof details.prompt === "string"
			? details.prompt
			: "";
	}
	return text(message.content);
}

function projectNativeAttachments(attachments: PromptOptions["attachments"]): AttachmentRef[] | undefined {
	return attachments?.map(attachment => {
		const { sourceKind, ...reference } = attachment;
		const source = attachmentRefSchema.shape.sourceKind.safeParse(sourceKind);
		// Older native history may contain other provenance labels. Keep the owned file
		// reference without inventing a supported V4 source for that display metadata.
		return attachmentRefSchema.parse({
			...reference,
			...(source.success && source.data !== undefined ? { sourceKind: source.data } : {}),
		});
	});
}

function liveSessionInfo(session: AgentSession): SessionInfo {
	const manager = session.sessionManager;
	const messages = session.messages;
	const created = new Date(manager.getHeader()?.timestamp ?? messages[0]?.timestamp ?? Date.now());
	return {
		id: session.sessionId,
		path: manager.getSessionFile() ?? "",
		cwd: manager.getCwd(),
		title: manager.getSessionName(),
		created,
		modified: new Date(messages.at(-1)?.timestamp ?? created.getTime()),
		messageCount: messages.length,
		size: 0,
		firstMessage: nativeInputText(messages.find(isNativeUserInput)),
		allMessagesText: "",
	};
}

export async function listNativeHistory(context: WebGuiServiceContext): Promise<SessionInfo[]> {
	context.signal.throwIfAborted();
	assertAIReqNativeContext(context);
	const sessions: SessionInfo[] = [];
	if (context.nativeSession && !context.nativeSession.isDisposed) {
		const session = context.nativeSession;
		if (!session.sessionFile) throw new Error("Exact native history is unavailable");
		await fs.access(session.sessionFile);
		sessions.push(liveSessionInfo(session));
	}
	nativeChatRuntime(context).recordHistory(sessions);
	return sessions;
}

interface NativeConversation {
	readonly epoch: string;
	seq: number;
	readonly rowIds: Map<string, number>;
	readonly revisions: Map<number, number>;
	nextRowId: number;
	error?: { message: string; at: number };
	snapshot?: ConversationSnapshot;
}

/** A projection of one existing runtime, shared by its browser connections; never another Agent. */
export class NativeChatRuntime {
	readonly changes = new Emitter<string>();
	readonly #session?: AgentSession;
	get hasSession(): boolean {
		return !!this.#session && !this.#session.isDisposed;
	}
	get session(): AgentSession {
		if (!this.hasSession) throw new Error("Create or explicitly continue a native session first.");
		return this.#session!;
	}
	readonly conversations = new Map<string, NativeConversation>();
	readonly commands = new Map<string, CommandAck>();
	readonly commandAdmissions = new Map<string, Promise<CommandAck>>();
	get boundSession(): AgentSession | undefined {
		return this.#session;
	}
	get isBusy(): boolean {
		return (
			this.hasSession &&
			(this.session.isStreaming ||
				this.session.isSessionTransitioning ||
				this.session.isRetrying ||
				this.session.isCompacting ||
				this.#submitting > 0 ||
				this.#stopping ||
				this.#reservations.size > 0 ||
				nativeWebGuiQuestions(this.session).pendingInteractions.length > 0)
		);
	}

	browserActions(context: WebGuiServiceContext, clientId?: string) {
		return this.#session
			? nativeWebGuiQuestions(this.#session)
					.pendingInteractionsFor({ connectionId: context.connectionId, clientId })
					.filter(
						interaction =>
							interaction.payload.kind === "userInput" && interaction.payload.toolName === "webgui-command",
					)
			: [];
	}
	#references = 0;
	#unsubscribe?: () => void;
	#unsubscribeRunState?: () => void;
	#streamMessage?: AgentMessage;
	#lastSessionId: string;
	#submitting = 0;
	#reservations = new Map<string, AgentMessage>();
	#stopping = false;
	#inputEpoch = 0;
	#stopGeneration = 0;
	#editing = false;
	#followupMode: "queue" | "guide" = "queue";
	#unsubscribeQuestions?: () => void;
	#executionId?: string;
	#executionStartedAt = 0;
	#maintenanceStartedAt?: number;
	indexVersion = 0;
	#history = new Map<string, SessionInfo>();
	#children?: NativeChildDirectory;
	#unsubscribeChildren?: () => void;
	#taskRunAdapters = 0;
	#retryState: ApiRetryState | null = null;
	#notices = new Map<
		string,
		Array<{
			id: string;
			text: string;
			level: "info" | "warning" | "error";
			source?: string;
			at: number;
		}>
	>();

	get childDirectory(): NativeChildDirectory | undefined {
		if (!this.hasSession || !this.#references || !this.session.agentRegistry) return undefined;
		if (!this.#children) {
			this.#children = new NativeChildDirectory(this.session);
			this.#unsubscribeChildren = this.#children.subscribe(change => {
				for (const id of change.sessionIds) {
					this.state(id).seq++;
					this.changes.fire(id);
					nativeChatChanges.fire(id);
				}
			});
		}
		return this.#children;
	}

	get taskRunsAvailable(): boolean {
		return this.#taskRunAdapters > 0;
	}

	registerTaskRuns(): () => void {
		this.#taskRunAdapters++;
		return () => {
			this.#taskRunAdapters--;
		};
	}

	async #withChildren<T>(read: (directory: NativeChildDirectory | undefined) => Promise<T>): Promise<T> {
		const owned = this.childDirectory;
		if (owned || !this.hasSession || !this.session.agentRegistry) return read(owned);
		const temporary = new NativeChildDirectory(this.session);
		try {
			return await read(temporary);
		} finally {
			temporary.dispose();
		}
	}

	async child(context: WebGuiServiceContext, id: string): Promise<OwnedNativeChild | undefined> {
		context.signal.throwIfAborted();
		const owner = await resolveNativeChatRuntime(context, id);
		if (owner !== this) return owner.findChild(context, id);
		return this.findChild(context, id);
	}

	async findChild(context: WebGuiServiceContext, id: string): Promise<OwnedNativeChild | undefined> {
		if (!this.hasSession || id === this.session.sessionId) return undefined;
		context = this.context(context);
		return this.#withChildren(async directory => {
			if (!directory) return undefined;
			try {
				return await directory.resolve(context, id);
			} catch (error) {
				if (error instanceof Error && error.message === `Native child conversation not found: ${id}`)
					return undefined;
				throw error;
			}
		});
	}

	async listSubagents(
		context: WebGuiServiceContext,
		id: string,
		cursor?: string,
		limit?: number,
	): Promise<ZCodeSessionSubagentsResult> {
		const owner = await resolveNativeChatRuntime(context, id);
		if (owner !== this) return owner.listSubagents(context, id, cursor, limit);
		context = this.context(context);
		return this.#withChildren(async directory => {
			if (!directory) throw new WebGuiNotImplementedError("native child registry is unavailable");
			return directory.list(context, id, cursor, limit);
		});
	}

	recordHistory(infos: SessionInfo[]): void {
		this.#history = new Map(infos.map(info => [info.id, info]));
	}

	constructor(session?: AgentSession) {
		this.#session = session;
		this.#lastSessionId = session?.sessionId ?? "";
	}

	context(context: WebGuiServiceContext): WebGuiServiceContext {
		return this.hasSession ? { ...context, nativeSession: this.session } : context;
	}

	retain(): () => void {
		if (this.#references++ === 0 && this.hasSession) {
			this.#executionId = undefined;
			this.#executionStartedAt = 0;
			this.#maintenanceStartedAt = undefined;
			this.#unsubscribe = this.session.subscribe(event => this.#onEvent(event));
			this.#unsubscribeRunState = this.session.subscribeRunState(() => this.notify());
			this.#unsubscribeQuestions = nativeWebGuiQuestions(this.session).subscribe(() => this.notify());
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.#references !== 0) return;
			this.#unsubscribe?.();
			this.#unsubscribeRunState?.();
			this.#unsubscribeQuestions?.();
			this.#unsubscribeQuestions = undefined;
			this.#unsubscribe = undefined;
			this.#unsubscribeRunState = undefined;
			this.#streamMessage = undefined;
			this.#unsubscribeChildren?.();
			this.#children?.dispose();
			this.#unsubscribeChildren = undefined;
			this.#children = undefined;
			for (const state of this.conversations.values()) state.snapshot = undefined;
		};
	}

	state(sessionId: string): NativeConversation {
		let state = this.conversations.get(sessionId);
		if (!state) {
			state = { epoch: crypto.randomUUID(), seq: 0, rowIds: new Map(), revisions: new Map(), nextRowId: 1 };
			this.conversations.set(sessionId, state);
		}
		return state;
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "session_abort") this.#inputEpoch++;
		if (event.type === "auto_retry_start")
			this.#retryState = {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				nextRetryAt: Date.now() + event.delayMs,
				reasonCode: "native.apiRetry",
			};
		if (event.type === "auto_retry_end") this.#retryState = null;
		if (event.type === "manual_compaction_start" || event.type === "auto_compaction_start")
			this.#maintenanceStartedAt = Date.now();
		if (event.type === "manual_compaction_end" || event.type === "auto_compaction_end")
			this.#maintenanceStartedAt = undefined;
		if (event.type === "agent_start") {
			this.#executionId = crypto.randomUUID();
			this.#executionStartedAt = Date.now();
			this.state(this.session.sessionId).error = undefined;
		}
		if (event.type === "message_start" || event.type === "message_update") this.#streamMessage = event.message;
		if (event.type === "message_end" || event.type === "agent_end") this.#streamMessage = undefined;
		if (event.type === "notice") {
			const id = this.session.sessionId;
			const notices = this.#notices.get(id) ?? [];
			notices.push({
				id: crypto.randomUUID(),
				text: event.message,
				level: event.level,
				source: event.source,
				at: Date.now(),
			});
			this.#notices.set(id, notices);
		}
		if (event.type === "notice" && event.level === "error")
			this.state(this.session.sessionId).error = { message: event.message, at: Date.now() };
		if (event.type !== "message_update" && event.type !== "tool_execution_update") this.indexVersion++;
		this.notify();
	}

	acceptEvent(event: AgentSessionEvent): void {
		this.#onEvent(event);
	}

	notify(): void {
		const id = this.#session?.sessionId ?? this.#lastSessionId;
		if (id !== this.#lastSessionId) {
			const previous = this.#lastSessionId;
			this.indexVersion++;
			this.#lastSessionId = id;
			this.#streamMessage = undefined;
			this.state(previous).seq++;
			this.changes.fire(previous);
		}
		this.state(id).seq++;
		this.notifyHistoricalViews();
		this.changes.fire(id);
		nativeChatChanges.fire(id);
	}

	notifyHistoricalViews(): void {
		for (const [id, state] of this.conversations) {
			if (id === this.#session?.sessionId) continue;
			state.seq++;
			this.changes.fire(id);
		}
	}

	async info(context: WebGuiServiceContext, id: string): Promise<SessionInfo> {
		context.signal.throwIfAborted();
		const owner = await resolveNativeChatRuntime(context, id);
		if (owner !== this) return owner.info(context, id);
		const child = await this.child(context, id);
		if (child) return child.info;
		if (this.hasSession && this.session.sessionId === id && !this.#history.has(id))
			this.#history.set(id, liveSessionInfo(this.session));
		const info = this.#history.get(id) ?? (await listNativeHistory(context)).find(candidate => candidate.id === id);
		if (!info) throw new Error(`Native session not found: ${id}`);
		if (!this.hasSession || id !== this.session.sessionId) return info;
		const messages = this.session.messages;
		return {
			...info,
			title: this.session.sessionManager.getSessionName() ?? info.title,
			firstMessage: info.firstMessage || nativeInputText(messages.find(isNativeUserInput)),
			messageCount: messages.length,
			modified: new Date(messages.at(-1)?.timestamp ?? info.modified.getTime()),
		};
	}

	async messages(context: WebGuiServiceContext, id: string): Promise<AgentMessage[]> {
		context.signal.throwIfAborted();
		const owner = await resolveNativeChatRuntime(context, id);
		if (owner !== this) return owner.messages(context, id);
		context = this.context(context);
		if (this.hasSession && id === this.session.sessionId) {
			const messages = this.session.messages;
			const stream = this.#streamMessage ?? this.session.agent.state.streamMessage;
			return stream && !messages.includes(stream) ? [...messages, stream] : messages;
		}
		const child = await this.child(context, id);
		if (child) return this.#withChildren(async directory => directory!.messages(context, id));
		const resident = listBrowserProjects()
			.flatMap(project => [...(project.nativeSessions ?? [])])
			.find(session => !session.isDisposed && session.sessionId === id);
		if (resident) {
			const messages = resident.messages;
			const stream = resident.agent.state.streamMessage;
			return stream && !messages.includes(stream) ? [...messages, stream] : messages;
		}
		const info = await this.info(context, id);
		await fs.stat(info.path);
		const messages = await loadSessionMessagesReadOnly(info.path);
		for (const message of messages) if (message.role === "assistant") normalizeAssistantUsage(message);
		return messages;
	}

	async resume(context: WebGuiServiceContext, id: string): Promise<AgentSession> {
		if (await this.child(context, id)) throw new Error("Native child conversations are read-only.");
		const session = await resumeWebGuiNativeSession(context, id);
		nativeChatRuntimeForSession(session).notify();
		return session;
	}

	async submit(
		context: WebGuiServiceContext,
		id: string,
		content: string,
		inputId: string,
		clientId?: string,
		commandId?: string,
		options: {
			requestedDelivery?: "startNow" | "queue" | "guide";
			attachments?: PromptOptions["attachments"];
			heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
			expectedHeldQueueItemIds?: string[];
			prepared?: { text: string; images: ImageContent[] };
		} = {},
	): Promise<"startNow" | "queue" | "guide"> {
		if (await this.child(context, id)) throw new Error("Native child conversations are read-only.");
		const session = await resolveWebGuiInputSession(context, id);
		const owner = nativeChatRuntimeForSession(session);
		if (owner !== this) return owner.submit(context, id, content, inputId, clientId, commandId, options);
		if (!content.trim() && !options.attachments?.length) throw new TypeError("A message or attachment is required.");
		if (session.isSessionTransitioning || this.#stopping || (this.#editing && !options.prepared))
			throw new Error("The native session is transitioning.");
		if (!session.isStreaming && nativeWebGuiQuestions(session).pendingInteractions.length)
			throw new Error("Resolve the pending native interaction before submitting another input.");
		const inputEpoch = this.#inputEpoch;
		const stopGeneration = this.#stopGeneration;
		const busy = this.isBusy;
		let delivery = options.requestedDelivery ?? (busy ? this.#followupMode : "startNow");
		if (delivery === "guide" && !busy) throw new Error("Guide requires a running native session.");
		context = this.context(context);
		const attachments = options.prepared ?? (await resolveNativeAttachments(context, options.attachments ?? [], id));
		const references = options.prepared
			? { text: "", images: [] }
			: await resolveNativeFileContexts(context, content, id);
		const images = [...attachments.images, ...references.images];
		if (images.length && !session.model?.input.includes("image"))
			throw new Error("The selected native model does not accept image inputs.");
		assertNativeChat(context);
		let goalAutoOrchestrateInitialId: string | undefined;
		const origin = {
			connectionId: context.connectionId,
			clientId,
			sessionId: id,
			input: { images },
			onPromptMetadata: (metadata: { goalAutoOrchestrateInitialId?: string }) => {
				goalAutoOrchestrateInitialId = metadata.goalAutoOrchestrateInitialId;
			},
		};
		const command = await runWebGuiSession(session, () =>
			webGuiNativePorts().executeCommand(session, content, origin),
		);
		if (command === true) {
			this.notify();
			return "startNow";
		}
		if (session.sessionId !== id) {
			if (typeof command !== "string") throw new Error("The native session changed before input admission.");
			id = session.sessionId;
		}
		if (goalAutoOrchestrateInitialId) delivery = busy ? "guide" : "startNow";
		const prompt = [typeof command === "string" ? command : content, attachments.text, references.text]
			.filter(Boolean)
			.join("\n\n");
		const skillPrompt = await runWebGuiSession(session, () =>
			buildNativeWebGuiSkillPrompt(
				session,
				prompt,
				delivery === "guide" || goalAutoOrchestrateInitialId ? "steer" : "followUp",
				images,
			),
		);
		if (skillPrompt) skillPrompt.message.details.prompt = content;
		assertNativeChat(context);
		if (inputEpoch !== this.#inputEpoch || this.#stopping)
			throw new Error("The input was cancelled before native admission.");
		const sourceCommand = commandId
			? {
					sessionId: id,
					commandId,
					fingerprint: JSON.stringify({ content, inputId }),
				}
			: undefined;
		if (delivery === "guide" && !goalAutoOrchestrateInitialId) {
			const unregisterOrigin = webGuiNativePorts().registerInputOrigin(session, inputId, origin);
			let accepted: boolean;
			try {
				accepted = await withNativeWebGuiInteractionScope(origin, () =>
					runWebGuiSession(session, () =>
						runAIReqNativeInput(
							session,
							() =>
								session.joinActiveTurn(prompt, images, {
									inputId,
									inputClientId: clientId,
									attachments: options.attachments ?? [],
									sourceCommand,
									allowAutonomous: session.agent.state.isStreaming,
									...(skillPrompt ? { customMessage: skillPrompt.message } : {}),
								}),
							content,
						),
					),
				);
				if (!accepted) throw new Error("The native run ended before the guide could be admitted.");
			} catch (error) {
				unregisterOrigin();
				throw error;
			}
			this.notify();
			return "guide";
		}
		if (delivery === "startNow" && busy) {
			nativeWebGuiQuestions(session).cancelPendingInteractions("Interrupted by immediate input.");
			await runWebGuiSession(session, () =>
				session.abort({ reason: USER_INTERRUPT_LABEL, preserveQueuedInputs: true }),
			);
		}
		assertNativeChat(context);
		if (stopGeneration !== this.#stopGeneration) throw new Error("The input was cancelled before native admission.");
		if (options.heldQueueDisposition) {
			session.disposeHeldQueue(options.expectedHeldQueueItemIds ?? [], options.heldQueueDisposition);
			if (options.heldQueueDisposition === "clearQueueAndSend")
				for (const queuedId of options.expectedHeldQueueItemIds ?? [])
					webGuiNativePorts().forgetInputOrigin(session, queuedId);
		}
		this.state(id).error = undefined;
		if (!session.isStreaming) this.#executionId = undefined;
		this.#submitting++;
		this.indexVersion++;
		this.notify();
		let actualDelivery = delivery;
		const admission = Promise.withResolvers<void>();
		let admitted = false;
		const unregisterOrigin = webGuiNativePorts().registerInputOrigin(session, inputId, origin);
		const promptOptions: PromptOptions = {
			inputId,
			inputClientId: clientId,
			attachments: options.attachments ?? [],
			images,
			throwOnDrop: true,
			...(goalAutoOrchestrateInitialId
				? { goalAutoOrchestrateInitialId, streamingBehavior: "steer" as const }
				: delivery === "queue"
					? { streamingBehavior: "followUp" as const, queueOnly: busy }
					: {}),
			sourceCommand,
			onPromptQueued: () => {
				actualDelivery = goalAutoOrchestrateInitialId ? "guide" : "queue";
			},
			onPromptAdmitted: () => {
				admitted = true;
				admission.resolve();
			},
		};
		const operation = withNativeWebGuiInteractionScope(origin, () =>
			runWebGuiSession(session, () =>
				skillPrompt
					? runAIReqNativeInput(
							session,
							() =>
								session.promptCustomMessage(skillPrompt.message, {
									...skillPrompt.options,
									...promptOptions,
									queueChipText: content,
								}),
							content,
						)
					: runAIReqNativeInput(session, () => session.prompt(prompt, promptOptions), content),
			),
		);
		void operation
			.then(
				() => {
					if (!admitted) {
						unregisterOrigin();
						admission.reject(new Error("The native prompt completed without admitting this input."));
					}
				},
				error => {
					if (!admitted) unregisterOrigin();
					this.state(id).error = {
						message: error instanceof Error ? error.message : String(error),
						at: Date.now(),
					};
					admission.reject(error);
				},
			)
			.finally(() => {
				if (actualDelivery === "startNow") unregisterOrigin();
				this.#submitting--;
				this.indexVersion++;
				this.notify();
			});
		await admission.promise;
		return actualDelivery;
	}

	async stop(context: WebGuiServiceContext, expectedExecutionId?: string): Promise<void> {
		const session = await resolveWebGuiSession(context, this.session.sessionId);
		assertNativeChat(this.context(context));
		if (expectedExecutionId && (!this.isBusy || expectedExecutionId !== this.#executionId))
			throw new Error("The requested foreground execution is no longer active.");
		if (this.#stopping) throw new Error("The native session is already stopping.");
		this.#inputEpoch++;
		this.#stopGeneration++;
		this.#stopping = true;
		this.notify();
		try {
			nativeWebGuiQuestions(session).cancelPendingInteractions("Native session stopped.");
			await stopAIReqNativeInput(session);
		} catch (error) {
			this.state(session.sessionId).error = {
				message: error instanceof Error ? error.message : String(error),
				at: Date.now(),
			};
			throw error;
		} finally {
			this.#stopping = false;
			this.notify();
		}
	}

	setFollowupMode(mode: "queue" | "guide"): void {
		this.#followupMode = mode;
		this.notify();
	}

	async editQueued(context: WebGuiServiceContext, inputId: string, newText: string): Promise<void> {
		const session = await resolveWebGuiSession(context, this.session.sessionId);
		const input = session
			.getQueuedInputMessages()
			.find(message => (message as AgentMessage & { inputId?: string }).inputId === inputId);
		if (!input) throw new Error("The queued input is no longer editable.");
		const attachments = (input as AgentMessage & { attachments?: PromptOptions["attachments"] }).attachments;
		const resolved = await resolveNativeAttachments(this.context(context), attachments ?? [], session.sessionId);
		const references = await resolveNativeFileContexts(this.context(context), newText, session.sessionId);
		assertNativeChat(this.context(context));
		const content = [newText, resolved.text, references.text].filter(Boolean).join("\n\n");
		const images = [
			...(attachments !== undefined
				? resolved.images
				: "content" in input && isCustomMessageContent(input.content) && Array.isArray(input.content)
					? input.content.filter((part): part is ImageContent => part.type === "image")
					: []),
			...references.images,
		];
		const skillPrompt = await runWebGuiSession(session, () =>
			buildNativeWebGuiSkillPrompt(
				session,
				content,
				session.agent.peekSteeringQueue().includes(input) ? "steer" : "followUp",
				images,
			),
		);
		if (skillPrompt) skillPrompt.message.details.prompt = newText;
		assertNativeChat(this.context(context));
		if (
			!session.mutateQueuedInput(inputId, "edit", {
				text: skillPrompt ? newText : content,
				images,
				...(skillPrompt ? { customMessage: skillPrompt.message } : {}),
			})
		)
			throw new Error("The queued input was consumed before the edit.");
		this.notify();
	}

	async sendQueuedNow(context: WebGuiServiceContext, inputId: string, clientId?: string): Promise<void> {
		const session = await resolveWebGuiSession(context, this.session.sessionId);
		assertNativeChat(this.context(context));
		if (this.#stopping || this.#editing || session.isSessionTransitioning)
			throw new Error("The native session is transitioning.");
		const reservation = session.takeQueuedInput(inputId);
		if (!reservation) throw new Error("The queued input is no longer available.");
		const stopGeneration = this.#stopGeneration;
		this.#reservations.set(inputId, reservation.message);
		this.notify();
		try {
			if (session.isStreaming || this.#submitting) {
				nativeWebGuiQuestions(session).cancelPendingInteractions("Interrupted by queued immediate input.");
				await runWebGuiSession(session, () =>
					session.abort({ reason: USER_INTERRUPT_LABEL, preserveQueuedInputs: true }),
				);
			}
			assertNativeChat(this.context(context));
			if (this.#stopping || stopGeneration !== this.#stopGeneration)
				throw new Error("The queued input was cancelled before native admission.");
			this.#executionId = undefined;
			const admission = Promise.withResolvers<void>();
			let admitted = false;
			const origin = { connectionId: context.connectionId, clientId, sessionId: session.sessionId };
			const unregisterOrigin = webGuiNativePorts().registerInputOrigin(session, inputId, origin);
			const operation = withNativeWebGuiInteractionScope(origin, () =>
				runWebGuiSession(session, () =>
					runAIReqNativeInput(
						session,
						() =>
							reservation.prompt({
								throwOnDrop: true,
								onPromptAdmitted: () => {
									admitted = true;
									this.#reservations.delete(inputId);
									this.notify();
									admission.resolve();
								},
							}),
						nativeInputText(reservation.message),
					),
				),
			);
			void operation
				.then(
					() => {
						if (!admitted) {
							unregisterOrigin();
							reservation.restore();
							admission.reject(new Error("The queued input was cancelled before native admission."));
						} else admission.resolve();
					},
					error => {
						this.state(session.sessionId).error = {
							message: error instanceof Error ? error.message : String(error),
							at: Date.now(),
						};
						unregisterOrigin();
						reservation.restore();
						admission.reject(error);
					},
				)
				.finally(() => {
					if (admitted) unregisterOrigin();
					this.notify();
				});
			await admission.promise;
		} catch (error) {
			reservation.restore();
			throw error;
		} finally {
			this.#reservations.delete(inputId);
			this.notify();
		}
	}

	async targetMessage(context: WebGuiServiceContext, target: { rowId: number; entityId: string }) {
		const snapshot = await this.snapshot(context, this.session.sessionId);
		const row = snapshot.rows.window.find(candidate => candidate.rowId === target.rowId);
		if (!row || row.entityId !== target.entityId)
			throw new Error("The native conversation row is stale or does not belong to this session.");
		const key = [...this.state(this.session.sessionId).rowIds].find(([, id]) => id === row.rowId)?.[0];
		const index = Number(key?.split(":")[0]);
		const message = this.session.messages[index];
		if (!message) throw new Error("The native message is no longer available.");
		return { row, message, index };
	}

	async edit(
		context: WebGuiServiceContext,
		target: { rowId: number; entityId: string },
		newText: string,
		inputId: string,
		clientId: string,
		attachments?: PromptOptions["attachments"],
	): Promise<string> {
		if (
			this.session.isStreaming ||
			this.session.isSessionTransitioning ||
			this.#submitting ||
			this.#stopping ||
			this.#editing
		)
			throw new Error("Wait for the native session to become idle before branching.");
		const inputEpoch = this.#inputEpoch;
		const stopGeneration = this.#stopGeneration;
		const { row, message } = await this.targetMessage(context, target);
		if (row.kind !== "userInput" || !isNativeUserInput(message) || !row.actions?.canEdit)
			throw new Error("This native user message is not currently editable.");
		if (this.#editing || this.isBusy) throw new Error("The native session became busy before branching.");
		this.#editing = true;
		this.notify();
		try {
			const entry = this.session.sessionManager
				.getBranch()
				.find(
					candidate =>
						(candidate.type === "message" &&
							candidate.message.role === "user" &&
							candidate.message.timestamp === message.timestamp &&
							text(candidate.message.content) === text(message.content)) ||
						(candidate.type === "custom_message" &&
							candidate.customType === SKILL_PROMPT_MESSAGE_TYPE &&
							candidate.attribution === "user" &&
							new Date(candidate.timestamp).getTime() === message.timestamp &&
							text(candidate.content) === text(message.content)),
				);
			if (!entry) throw new Error("The native branch entry is no longer available.");
			const retained =
				attachments ?? (message as AgentMessage & { attachments?: PromptOptions["attachments"] }).attachments;
			const resolved = await resolveNativeAttachments(this.context(context), retained ?? [], this.session.sessionId);
			const references = await resolveNativeFileContexts(this.context(context), newText, this.session.sessionId);
			if (inputEpoch !== this.#inputEpoch || this.#stopping)
				throw new Error("The native branch request was cancelled.");
			assertNativeChat(this.context(context));
			const branch = await runWebGuiSession(this.session, () => this.session.branch(entry.id));
			if (branch.cancelled) throw new Error("Native branching was cancelled.");
			if (stopGeneration !== this.#stopGeneration)
				throw new Error("The native branch input was cancelled before admission.");
			this.notify();
			await this.submit(context, this.session.sessionId, newText, inputId, clientId, inputId, {
				attachments: retained,
				prepared: {
					text: [resolved.text, references.text].filter(Boolean).join("\n\n"),
					images: [...(retained?.length ? resolved.images : branch.selectedImages), ...references.images],
				},
			});
			return this.session.sessionId;
		} finally {
			this.#editing = false;
			this.notify();
		}
	}

	async retry(
		context: WebGuiServiceContext,
		target: { rowId: number; entityId: string },
		clientId?: string,
	): Promise<void> {
		if (this.session.isStreaming || this.session.isSessionTransitioning || this.#submitting)
			throw new Error("Wait for the native session to become idle before retrying.");
		const { row, message, index } = await this.targetMessage(context, target);
		const last = this.session.messages.findLast(candidate => candidate.role === "assistant");
		if (
			!row.actions?.canRetry ||
			message !== last ||
			message.role !== "assistant" ||
			(message.stopReason !== "error" && message.stopReason !== "aborted")
		)
			throw new Error("Only the latest failed native response can be retried.");
		assertNativeChat(this.context(context));
		if (this.#editing || this.isBusy) throw new Error("The native session became busy before retrying.");
		const admission = Promise.withResolvers<void>();
		let started = false;
		const unsubscribe = this.session.subscribe(event => {
			if (event.type !== "agent_start") return;
			if (!started) {
				started = true;
				const state = this.state(this.session.sessionId);
				state.revisions.set(index, (state.revisions.get(index) ?? 0) + 1);
				this.notify();
			}
			admission.resolve();
		});
		const operation = withNativeWebGuiInteractionScope(
			{ connectionId: context.connectionId, clientId, sessionId: this.session.sessionId },
			() => runWebGuiSession(this.session, () => runAIReqNativeInput(this.session, () => this.session.retry())),
		);
		void operation
			.then(
				result => {
					if (result) admission.resolve();
					else admission.reject(new Error("The native response is not retryable."));
				},
				error => admission.reject(error),
			)
			.finally(() => {
				unsubscribe();
				this.notify();
			});
		await admission.promise;
	}

	async snapshot(context: WebGuiServiceContext, id: string, clientId?: string): Promise<ConversationSnapshot> {
		context.signal.throwIfAborted();
		const retained = this.conversations.get(id)?.snapshot;
		const browserActions = this.browserActions(context, clientId);
		const project = context.projectId ? readBrowserProject(context.projectId) : undefined;
		let draining = false;
		try {
			assertAIReqNativeContext(context);
		} catch {
			draining = true;
		}
		if (
			retained &&
			browserActions.length &&
			(!this.hasSession ||
				this.session.sessionId !== id ||
				draining ||
				project?.mode !== "aireq" ||
				project.phase !== "active")
		) {
			const latest = this.#session?.messages.findLast(message => message.role === "assistant");
			const executing =
				this.hasSession &&
				this.session.sessionId === id &&
				(this.session.isStreaming || this.session.isRetrying || this.session.isCompacting);
			return {
				...retained,
				seq: this.state(id).seq,
				revision: this.state(id).seq,
				control: {
					...retained.control,
					phase: executing
						? "running"
						: latest?.role === "assistant" && latest.stopReason === "error"
							? "error"
							: latest?.role === "assistant" && latest.stopReason === "aborted"
								? "completedInterrupted"
								: retained.control.phase,
					canStop: false,
					stopState: "idle",
					sessionEnded: !executing && retained.control.sessionEnded,
					activeWorks: [],
				},
				pendingInteractions: browserActions,
			};
		}
		const owner = await resolveNativeChatRuntime(context, id);
		if (owner !== this) return owner.snapshot(context, id, clientId);
		context = this.context(context);
		const state = this.state(id);
		const seq = state.seq;
		const child = await this.child(context, id);
		const active = this.hasSession && id === this.session.sessionId;
		if (active && state.snapshot?.seq === state.seq)
			return {
				...state.snapshot,
				pendingInteractions: nativeWebGuiQuestions(this.session).pendingInteractionsFor({
					connectionId: context.connectionId,
					clientId,
				}),
			};
		const info = await this.info(context, id);
		const messages = await this.messages(context, id);
		const lastAssistant = messages.findLast(message => message.role === "assistant");
		const busy = child
			? child.status === "running" || child.status === "waiting" || child.status === "blocked"
			: active && this.isBusy;
		const rows: ConversationRow[] = [];
		let turnId = `${id}:history`;
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--)
			if (isNativeUserInput(messages[index])) {
				lastUserIndex = index;
				break;
			}
		const rowBase = (key: string, timestamp: number) => {
			key = `${key}:${timestamp}:${state.revisions.get(Number(key.split(":")[0])) ?? 0}`;
			let rowId = state.rowIds.get(key);
			if (rowId === undefined) {
				rowId = state.nextRowId++;
				state.rowIds.set(key, rowId);
			}
			return { rowId, turnId, entityId: `${id}:${key}`, createdAt: timestamp, createdAtSeq: 0 };
		};
		let lastAssistantError: { message: string; at: number } | undefined;
		const toolResults = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
		for (const message of messages) if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
		const turnResults = new Map<number, "completedSuccess" | "completedInterrupted" | "failed">();
		let userIndex = -1;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (isNativeUserInput(message)) userIndex = index;
			if (message.role === "assistant" && userIndex >= 0)
				turnResults.set(
					userIndex,
					message.stopReason === "error"
						? "failed"
						: message.stopReason === "aborted"
							? "completedInterrupted"
							: "completedSuccess",
				);
		}
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			const at = typeof message.timestamp === "number" ? message.timestamp : info.created.getTime();
			if (isNativeUserInput(message)) {
				turnId = `${id}:turn:${index}`;
				const attribution = message as AgentMessage & {
					inputId?: string;
					sourceCommand?: { commandId: string };
					inputClientId?: string;
					attachments?: PromptOptions["attachments"];
				};
				rows.push({
					...rowBase(`${index}:turn`, at),
					kind: "turnHeader",
					origin: "userInput",
					state:
						busy && index === lastUserIndex
							? "running"
							: (turnResults.get(index) ??
								(state.error && index === lastUserIndex ? "failed" : "completedInterrupted")),
					startedAt: at,
				});
				rows.push({
					...rowBase(`${index}:user`, at),
					kind: "userInput",
					text: nativeInputText(message),
					origin: "realUser",
					...(active && !busy && !this.#editing
						? { actions: { canEdit: true as const, editDisposition: "fork" as const } }
						: {}),
					...(attribution.attachments ? { attachments: projectNativeAttachments(attribution.attachments) } : {}),
					...(message.role === "user" && message.steering ? { guided: true as const } : {}),
					...(attribution.sourceCommand ? { sourceCommandId: attribution.sourceCommand.commandId } : {}),
					...(attribution.inputClientId ? { clientId: attribution.inputClientId } : {}),
				});
			} else if (message.role === "assistant") {
				const streaming =
					busy &&
					(child
						? message === child.session?.agent.state.streamMessage
						: active && (message === this.#streamMessage || message === this.session.agent.state.streamMessage));
				if (message.stopReason === "error")
					lastAssistantError = { message: message.errorMessage || "Native model request failed.", at };
				if (
					!message.content.some(part => part.type === "text") &&
					(message.stopReason === "error" || message.stopReason === "aborted")
				) {
					rows.push({
						...rowBase(`${index}:error`, at),
						kind: "assistantText",
						text:
							message.errorMessage ||
							(message.stopReason === "error" ? "Native model request failed." : "Native response interrupted."),
						state: message.stopReason === "error" ? "failed" : "interrupted",
						model: message.model,
						...(active && !busy && !this.#editing && message === lastAssistant
							? { actions: { canRetry: true as const } }
							: {}),
					});
				}
				for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
					const part = message.content[partIndex]!;
					const base = rowBase(`${index}:${partIndex}`, at);
					if (part.type === "text")
						rows.push({
							...base,
							kind: "assistantText",
							text: part.text,
							state: streaming
								? "streaming"
								: message.stopReason === "error"
									? "failed"
									: message.stopReason === "aborted"
										? "interrupted"
										: "complete",
							model: message.model,
							...(active &&
							!busy &&
							!this.#editing &&
							message === lastAssistant &&
							(message.stopReason === "error" || message.stopReason === "aborted")
								? { actions: { canRetry: true as const } }
								: {}),
						});
					if (part.type === "thinking")
						rows.push({
							...base,
							kind: "reasoning",
							text: part.thinking,
							state: streaming ? "streaming" : message.stopReason === "aborted" ? "interrupted" : "complete",
						});
					if (part.type === "toolCall") {
						const result = toolResults.get(part.id);
						rows.push({
							...base,
							kind: "toolCall",
							toolCallId: part.id,
							toolName: part.name,
							inputText: JSON.stringify(part.arguments),
							status: result ? (result.isError ? "error" : "success") : busy ? "running" : "cancelled",
							...(result?.isError
								? {
										error: {
											code: "native.toolError",
											message: text(result.content) || "Native tool failed.",
										},
									}
								: {}),
						});
						const childIds = await this.#withChildren(async directory =>
							directory && (active || child) ? directory.childSessionIdsForToolCall(context, id, part.id) : [],
						);
						for (const childId of childIds) {
							const actor = await this.child(context, childId);
							if (!actor) continue;
							rows.push({
								...rowBase(`${index}:${partIndex}:child:${childId}`, actor.startedAt),
								kind: "subagent",
								parentToolCallId: part.id,
								childSessionId: childId,
								subagentType: actor.subagentType,
								status:
									actor.status === "waiting" || actor.status === "blocked"
										? "running"
										: actor.status === "lost"
											? "failed"
											: actor.status,
								summaryText: actor.summary || actor.info.title || actor.nativeAgentId,
								startedAt: actor.startedAt,
								endedAt: actor.endedAt,
							});
						}
					}
				}
			} else if (message.role === "custom" && message.display) {
				rows.push({
					...rowBase(`${index}:custom`, at),
					kind: "timelineMarker",
					marker: { type: "nativeNotice", text: text(message.content), level: "info", source: message.customType },
				});
			}
		}
		for (const notice of this.#notices.get(id) ?? [])
			rows.push({
				...rowBase(`notice:${notice.id}`, notice.at),
				kind: "timelineMarker",
				marker: { type: "nativeNotice", text: notice.text, level: notice.level, source: notice.source },
			});
		rows.sort((left, right) => left.rowId - right.rowId);
		const error =
			state.error ??
			(lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error" ? lastAssistantError : undefined);
		const denied = { allowed: false as const, reasonCode: "guard.nativeChatOnly" };
		const model = active
			? this.session.model
			: (child?.session?.model ??
				(lastAssistant?.role === "assistant"
					? { provider: lastAssistant.provider, id: lastAssistant.model }
					: undefined));
		const canContinue = !child && active && context.inputAllowed !== false;
		const pendingInteractions = active
			? nativeWebGuiQuestions(this.session).pendingInteractionsFor({ connectionId: context.connectionId, clientId })
			: [];
		const queuedInputs = active ? [...this.#reservations.values(), ...this.session.getQueuedInputMessages()] : [];
		const queueAutoDrain = active && this.session.getQueueAutoDrain();
		const queuePauseReason =
			active && !queueAutoDrain ? (this.session.agent.queuedMessagesHeld ? "stopped" : "manual") : undefined;
		const queue = queuedInputs.flatMap((message, index) => {
			const input = message as AgentMessage & {
				inputId?: string;
				inputClientId?: string;
				inputAdmissionSeq?: number;
				sourceCommand?: { commandId: string };
				attachments?: PromptOptions["attachments"];
			};
			if (!input.inputId) return [];
			const guided =
				(message.role === "user" && message.steering) ||
				(active && this.session.agent.peekSteeringQueue().includes(message));
			return [
				{
					sourceCommandId: input.sourceCommand?.commandId ?? input.inputId,
					queueItemId: input.inputId,
					clientId: input.inputClientId ?? "native",
					kind: "sendText",
					text: nativeInputText(message),
					attachments: input.attachments ?? [],
					delivery: { requested: guided ? "guide" : "queue", admitted: guided ? "guide" : "queue" },
					order: { admissionSeq: input.inputAdmissionSeq ?? index, queuePosition: index },
					steer: { state: guided ? "steering" : "notRequested" },
					dispatch: { state: this.#reservations.has(input.inputId) ? "reserved" : "queued" },
					admittedAt: message.timestamp,
				},
			];
		});
		const subagents = await this.#withChildren(async directory =>
			directory && (active || child) ? directory.projection(context, id) : undefined,
		);
		const activeWorks: ActiveWorkSummary[] = [];
		if (active && this.session.isCompacting && this.#maintenanceStartedAt !== undefined)
			activeWorks.push({ kind: "compact", startedAt: this.#maintenanceStartedAt });
		else if (active && this.session.agent.state.isStreaming && this.#executionStartedAt > 0)
			activeWorks.push({
				kind: "primaryTurn",
				foregroundExecutionId: this.#executionId,
				startedAt: this.#executionStartedAt,
			});
		// Use only the selected actual native session's context estimate.
		const contextSession = active
			? this.session
			: child?.session && isAgentViewSession(child.session)
				? child.session
				: undefined;
		const contextUsage = contextSession?.getContextUsage();
		const compactionSettings = contextSession
			? resolveModelCompactionSettings(contextSession.settings, contextSession.model)
			: undefined;
		const contextWindow =
			contextUsage && contextUsage.contextWindow > 0
				? {
						usedTokens: contextUsage.tokens,
						maxTokens: contextUsage.contextWindow,
						autoCompactThresholdTokens: compactionSettings?.enabled
							? resolveThresholdTokens(contextUsage.contextWindow, compactionSettings)
							: null,
					}
				: null;
		const snapshot = conversationSnapshotSchema.parse({
			protocolVersion: 1,
			sessionId: id,
			logEpoch: state.epoch,
			seq,
			revision: seq,
			control: {
				phase: busy
					? "running"
					: error || child?.status === "failed" || child?.status === "lost"
						? "error"
						: child?.status === "cancelled" ||
							  info.status === "aborted" ||
							  info.status === "interrupted" ||
							  (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted")
							? "completedInterrupted"
							: messages.length
								? "completedSuccess"
								: "draft",
				sessionEnded: !busy && !error && messages.length > 0,
				canStop: active && busy && !this.#stopping,
				stopState: this.#stopping ? "stopping" : active && busy ? "stoppable" : "idle",
				stopTargetKind:
					active && this.session.isCompacting
						? "compact"
						: activeWorks.some(work => work.kind === "primaryTurn")
							? "assistant"
							: "unknown",
				activeWorks,
				lastError: error
					? {
							code: "native.promptError",
							message: error.message,
							recoverable: true,
							at: error.at,
							source: "runtime",
						}
					: null,
				apiRetry: active ? this.#retryState : null,
			},
			availability: {
				fork: denied,
				compact: denied,
				switchModelConfig: active ? { allowed: true } : denied,
				setFollowupMode: active ? { allowed: true } : denied,
				queueEdit: active ? { allowed: true } : denied,
				sendQueuedNow: active ? { allowed: true } : denied,
				pauseGoal: denied,
				resumeGoal: denied,
			},
			inputRouting: child
				? { mode: "reject", reasonCode: "guard.nativeChildReadOnly" }
				: !canContinue
					? { mode: "reject", reasonCode: "guard.nativeHistoryRequiresResume" }
					: this.#stopping ||
						  this.#editing ||
						  this.session.isSessionTransitioning ||
						  (!this.session.isStreaming && pendingInteractions.length > 0)
						? { mode: "reject", reasonCode: "guard.nativeSessionTransition" }
						: busy
							? { mode: this.#followupMode === "guide" ? "guide" : "enqueue" }
							: queue.length && !queueAutoDrain
								? { mode: "choice" }
								: { mode: "startNow" },
			meta: { title: sessionDisplayName(info), titleSource: "default" },
			config: {
				provider: model?.provider ?? "",
				model: model?.id ?? "",
				thought: active ? (this.session.thinkingLevel ?? "off") : (child?.session?.thinkingLevel ?? "off"),
				followupMode: this.#followupMode,
				mode: active && this.session.getPlanModeState()?.enabled ? "plan" : "build",
				...(model ? { modelSelection: { providerId: model.provider, modelId: model.id } } : {}),
			},
			usage: {
				contextWindow,
				cumulative: messages.reduce(
					(sum, message) => {
						if (message.role === "assistant") {
							sum.inputTokens += message.usage.input;
							sum.outputTokens += message.usage.output;
							sum.cacheReadTokens += message.usage.cacheRead;
							sum.cacheWriteTokens += message.usage.cacheWrite;
						}
						return sum;
					},
					{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				),
			},
			queue: {
				items: queue,
				autoDrain: queueAutoDrain,
				...(queuePauseReason ? { pauseReason: queuePauseReason } : {}),
			},
			pendingInteractions,
			pendingCommands: [],
			backgroundWorks: [],
			...(subagents ? { subagents } : {}),
			goal: null,
			plan: null,
			rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
		});
		if (active) state.snapshot = snapshot;
		return snapshot;
	}

	summary(info: SessionInfo, workspaceId: string): SessionSummary {
		const active = this.hasSession && info.id === this.session.sessionId;
		const busy = active && this.isBusy;
		const last = active ? this.session.messages.findLast(message => message.role === "assistant") : undefined;
		return {
			sessionId: info.id,
			workspaceId,
			title: sessionDisplayName(info),
			phase: busy
				? "running"
				: info.status === "error" || (last?.role === "assistant" && last.stopReason === "error")
					? "error"
					: info.status === "aborted" ||
						  info.status === "interrupted" ||
						  (last?.role === "assistant" && last.stopReason === "aborted")
						? "completedInterrupted"
						: "completedSuccess",
			sessionEnded: !busy,
			hasBackgroundWork: false,
			lastActivityAt: info.modified.getTime(),
			createdAt: info.created.getTime(),
		};
	}
}

const runtimes = new WeakMap<AgentSession, NativeChatRuntime>();
const historyRuntimes = new Map<string, { ownerId: string; runtime: NativeChatRuntime }>();
let unboundHistoryRuntime: NativeChatRuntime | undefined;
export const nativeChatChanges = new Emitter<string>();

export function nativeChatRuntimeForSession(session: AgentSession): NativeChatRuntime {
	let runtime = runtimes.get(session);
	if (!runtime) {
		runtime = new NativeChatRuntime(session);
		runtimes.set(session, runtime);
	}
	return runtime;
}

export function emitNativeWebGuiSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
	nativeChatRuntimeForSession(session).acceptEvent(event);
}

export function refreshNativeWebGuiSession(session: AgentSession): void {
	nativeChatRuntimeForSession(session).notify();
}

/** Receipts survive reconnect and default-session changes, but never cross a project-owner epoch. */
export function nativeChatProjectRuntime(context: WebGuiServiceContext): NativeChatRuntime {
	context.signal.throwIfAborted();
	for (const id of historyRuntimes.keys()) if (!readBrowserProject(id)) historyRuntimes.delete(id);
	const project = context.projectId ? readBrowserProject(context.projectId) : undefined;
	if (!project) return (unboundHistoryRuntime ??= new NativeChatRuntime());
	const previous = historyRuntimes.get(project.projectId);
	if (previous?.ownerId === project.ownerId) return previous.runtime;
	const runtime = new NativeChatRuntime();
	historyRuntimes.set(project.projectId, { ownerId: project.ownerId, runtime });
	return runtime;
}

export function nativeChatRuntime(context: WebGuiServiceContext): NativeChatRuntime {
	context.signal.throwIfAborted();
	if (context.nativeSession && !context.nativeSession.isDisposed)
		return nativeChatRuntimeForSession(assertNativeChat(context));
	return nativeChatProjectRuntime(context);
}

export async function resolveNativeChatRuntime(context: WebGuiServiceContext, id?: string): Promise<NativeChatRuntime> {
	const residents = context.projectId ? await listWebGuiNativeSessions(context) : [];
	const session = id ? residents.find(candidate => candidate.sessionId === id) : residents[0];
	if (session) return nativeChatRuntimeForSession(session);
	if (id) {
		for (const candidate of residents) {
			const runtime = nativeChatRuntimeForSession(candidate);
			const child = await runtime.findChild(context, id);
			if (child) return runtime;
		}
		throw new Error("Native history does not belong to this exact AIReq object/session");
	}
	return nativeChatRuntime(context);
}

export function legacySessionInfo(context: WebGuiServiceContext, info: SessionInfo): ZCodeSessionInfo {
	const current = context.nativeSession?.sessionId === info.id ? context.nativeSession : undefined;
	return {
		sessionId: info.id,
		workspace: { workspacePath: context.workspacePath!, workspaceKey: context.workspacePath! },
		sessionKind: "interactive",
		title: sessionDisplayName(info),
		mode: "build",
		status: current?.isStreaming ? "running" : info.status === "error" ? "error" : "idle",
		createdAt: info.created.getTime(),
		updatedAt: info.modified.getTime(),
		...(current?.model ? { model: { providerId: current.model.provider, modelId: current.model.id } } : {}),
	};
}

export async function legacyMessages(context: WebGuiServiceContext, id: string): Promise<ZCodeMessageWithParts[]> {
	const runtime = await resolveNativeChatRuntime(context, id);
	const messages = await runtime.messages(context, id);
	const info = await runtime.info(context, id);
	const cwd = info.cwd || context.workspacePath!;
	let parentMessageId = `${id}:root`;
	return messages.flatMap((message, index): ZCodeMessageWithParts[] => {
		if (!isNativeUserInput(message) && message.role !== "assistant") return [];
		const messageId = `${id}:${index}`;
		const base = { sessionId: id, messageId };
		const parts: ZCodeMessageWithParts["parts"] = isNativeUserInput(message)
			? [{ ...base, partId: `${messageId}:text`, type: "text", text: nativeInputText(message) }]
			: typeof message.content === "string"
				? [{ ...base, partId: `${messageId}:text`, type: "text", text: message.content }]
				: message.content.flatMap((part, partIndex): ZCodeMessageWithParts["parts"] => {
						if (part.type === "text")
							return [{ ...base, partId: `${messageId}:${partIndex}`, type: "text", text: part.text }];
						if (part.type === "thinking")
							return [{ ...base, partId: `${messageId}:${partIndex}`, type: "reasoning", text: part.thinking }];
						return [];
					});
		if (isNativeUserInput(message)) {
			parentMessageId = messageId;
			return [{ info: { ...base, role: "user", time: { created: message.timestamp }, agent: "omp" }, parts }];
		}
		return [
			{
				info: {
					...base,
					role: "assistant",
					time: { created: message.timestamp },
					parentMessageId,
					agent: "omp",
					path: { cwd, root: cwd },
					model: { providerId: message.provider, modelId: message.model },
					cost: message.usage.cost.total,
					tokens: {
						input: message.usage.input,
						output: message.usage.output,
						reasoning: 0,
						cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
					},
					finish: message.stopReason,
				},
				parts,
			},
		];
	});
}

export async function legacySnapshot(context: WebGuiServiceContext, id: string): Promise<ZCodeSessionStateSnapshot> {
	const runtime = await resolveNativeChatRuntime(context, id);
	const info = legacySessionInfo(runtime.context(context), await runtime.info(context, id));
	const projection = await runtime.snapshot(context, id);
	return {
		protocol: { name: "ZCode Protocol", version: 1 },
		session: info,
		settings: {
			model: { available: [], ...(info.model ? { current: info.model } : {}) },
			thoughtLevel: { enabled: false, available: [] },
			mode: { current: "build" },
		},
		projection: {
			sessionId: id,
			status: info.status,
			mode: "build",
			turnCount: projection.rows.window.filter(row => row.kind === "userInput").length,
			totalTokenCount: projection.usage.cumulative.inputTokens + projection.usage.cumulative.outputTokens,
			contextUsed: 0,
			contextWindow: runtime.hasSession ? (runtime.session.model?.contextWindow ?? 0) : 0,
			pendingPermissions: [],
			activeToolCalls: [],
			backgroundJobs: [],
		},
		runtime: {
			eventSeq: projection.seq,
			stateRevision: projection.revision,
			deliveryKind: "desktop-continuous",
			pendingRequestIds: [],
		},
		messages: await legacyMessages(context, id),
		slashCommands: runtime.hasSession ? await webGuiNativePorts().listCommands(runtime.session) : [],
	};
}
