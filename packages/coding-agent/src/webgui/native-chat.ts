import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { Emitter } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import type {
	ZCodeMessageWithParts,
	ZCodeSessionInfo,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-legacy-types";
import type { ZCodeSessionStateSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol";
import type { ConversationRow } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/rows";
import {
	conversationSnapshotSchema,
	type ConversationSnapshot,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import type { SessionSummary } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/sessions-index";
import type { CommandAck } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/command";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { loadSessionMessagesReadOnly, normalizeAssistantUsage } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { sessionDisplayName, type SessionInfo } from "../session/session-listing";
import { nativeCwdHost } from "./native-cwd";
import { NativeChildDirectory, type OwnedNativeChild } from "./native-subagents";
import { readBrowserProject } from "./project-registry";
import { WebGuiNotImplementedError, type WebGuiServiceContext } from "./rpc-contract";

export function assertNativeChat(context: WebGuiServiceContext): AgentSession {
	context.signal.throwIfAborted();
	const session = context.nativeSession;
	const project = context.projectId ? readBrowserProject(context.projectId) : undefined;
	if (
		!session ||
		session.isDisposed ||
		!project ||
		project.nativeSession !== session ||
		project.mode !== "webgui" ||
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

export async function listNativeHistory(context: WebGuiServiceContext): Promise<SessionInfo[]> {
	if (!context.nativeSession) return [];
	const session = assertNativeChat(context);
	const sessions = await SessionManager.listAll();
	const manager = session.sessionManager;
	if (!sessions.some(info => info.id === manager.getSessionId())) {
		const header = manager.getHeader();
		const messages = session.messages;
		const created = new Date(header?.timestamp ?? messages[0]?.timestamp ?? Date.now());
		sessions.unshift({
			id: manager.getSessionId(),
			path: manager.getSessionFile() ?? "",
			cwd: manager.getCwd(),
			title: manager.getSessionName(),
			created,
			modified: new Date(messages.at(-1)?.timestamp ?? created.getTime()),
			messageCount: messages.length,
			size: 0,
			firstMessage: text(messages.find(message => message.role === "user")?.content),
			allMessagesText: "",
		});
	}
	nativeChatRuntime(context).recordHistory(sessions);
	return sessions;
}

interface NativeConversation {
	readonly epoch: string;
	seq: number;
	readonly rowIds: Map<string, number>;
	nextRowId: number;
	error?: { message: string; at: number };
	snapshot?: ConversationSnapshot;
}

/** A projection of one existing runtime, shared by its browser connections; never another Agent. */
export class NativeChatRuntime {
	readonly changes = new Emitter<string>();
	readonly session: AgentSession;
	readonly conversations = new Map<string, NativeConversation>();
	readonly commands = new Map<string, CommandAck>();
	#references = 0;
	#unsubscribe?: () => void;
	#unsubscribeRunState?: () => void;
	#streamMessage?: AgentMessage;
	#lastSessionId: string;
	#submitting = false;
	#resuming = false;
	indexVersion = 0;
	#history = new Map<string, SessionInfo>();
	#children?: NativeChildDirectory;
	#unsubscribeChildren?: () => void;
	#taskRunAdapters = 0;

	get childDirectory(): NativeChildDirectory | undefined {
		if (!this.#references || !this.session.agentRegistry) return undefined;
		if (!this.#children) {
			this.#children = new NativeChildDirectory(this.session);
			this.#unsubscribeChildren = this.#children.subscribe(change => {
				for (const id of change.sessionIds) {
					this.state(id).seq++;
					this.changes.fire(id);
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
		if (owned || !this.session.agentRegistry) return read(owned);
		const temporary = new NativeChildDirectory(this.session);
		try {
			return await read(temporary);
		} finally {
			temporary.dispose();
		}
	}

	async child(context: WebGuiServiceContext, id: string): Promise<OwnedNativeChild | undefined> {
		assertNativeChat(context);
		if (id === this.session.sessionId) return undefined;
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

	async listSubagents(context: WebGuiServiceContext, id: string, cursor?: string, limit?: number) {
		assertNativeChat(context);
		return this.#withChildren(async directory => {
			if (!directory) throw new WebGuiNotImplementedError("native child registry is unavailable");
			return directory.list(context, id, cursor, limit);
		});
	}

	recordHistory(infos: SessionInfo[]): void {
		this.#history = new Map(infos.map(info => [info.id, info]));
	}

	constructor(session: AgentSession) {
		this.session = session;
		this.#lastSessionId = session.sessionId;
	}

	retain(): () => void {
		if (this.#references++ === 0) {
			this.#unsubscribe = this.session.subscribe(event => this.#onEvent(event));
			this.#unsubscribeRunState = this.session.subscribeRunState(() => this.notify());
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.#references !== 0) return;
			this.#unsubscribe?.();
			this.#unsubscribeRunState?.();
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
			state = { epoch: crypto.randomUUID(), seq: 0, rowIds: new Map(), nextRowId: 1 };
			this.conversations.set(sessionId, state);
		}
		return state;
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start" || event.type === "message_update") this.#streamMessage = event.message;
		if (event.type === "message_end" || event.type === "agent_end") this.#streamMessage = undefined;
		if (event.type === "notice" && event.level === "error")
			this.state(this.session.sessionId).error = { message: event.message, at: Date.now() };
		if (event.type !== "message_update" && event.type !== "tool_execution_update") this.indexVersion++;
		this.notify();
	}

	notify(): void {
		const id = this.session.sessionId;
		if (id !== this.#lastSessionId) {
			const previous = this.#lastSessionId;
			this.indexVersion++;
			this.#lastSessionId = id;
			this.#streamMessage = undefined;
			this.state(previous).seq++;
			this.changes.fire(previous);
		}
		this.state(id).seq++;
		this.changes.fire(id);
	}

	async info(context: WebGuiServiceContext, id: string): Promise<SessionInfo> {
		assertNativeChat(context);
		const child = await this.child(context, id);
		if (child) return child.info;
		const info = this.#history.get(id) ?? (await listNativeHistory(context)).find(candidate => candidate.id === id);
		if (!info) throw new Error(`Native session not found: ${id}`);
		if (id !== this.session.sessionId) return info;
		const messages = this.session.messages;
		return {
			...info,
			title: this.session.sessionManager.getSessionName() ?? info.title,
			modified: new Date(messages.at(-1)?.timestamp ?? info.modified.getTime()),
		};
	}

	async messages(context: WebGuiServiceContext, id: string): Promise<AgentMessage[]> {
		assertNativeChat(context);
		if (id === this.session.sessionId) {
			const messages = this.session.messages;
			const stream = this.#streamMessage ?? this.session.agent.state.streamMessage;
			return stream && !messages.includes(stream) ? [...messages, stream] : messages;
		}
		const child = await this.child(context, id);
		if (child) return this.#withChildren(async directory => directory!.messages(context, id));
		const info = await this.info(context, id);
		await fs.stat(info.path);
		const messages = await loadSessionMessagesReadOnly(info.path);
		for (const message of messages) if (message.role === "assistant") normalizeAssistantUsage(message);
		return messages;
	}

	async resume(context: WebGuiServiceContext, id: string): Promise<void> {
		const session = assertNativeChat(context);
		if (await this.child(context, id)) throw new Error("Native child conversations are read-only.");
		if (this.#resuming || session.isStreaming || session.isSessionTransitioning || this.#submitting)
			throw new Error("The native session is busy; wait for it to finish before continuing another history.");
		if (session.sessionId === id) return;
		const previousId = session.sessionId;
		this.#resuming = true;
		try {
			const info =
				this.#history.get(id) ?? (await listNativeHistory(context)).find(candidate => candidate.id === id);
			if (!info) throw new Error(`Native session not found: ${id}`);
			assertNativeChat(context);
			if (
				session.sessionId !== previousId ||
				session.isStreaming ||
				session.isSessionTransitioning ||
				this.#submitting
			)
				throw new Error("The native session changed or became busy before recovery.");
			const host = nativeCwdHost(session);
			if (host) {
				await host.resume(info.path, info.cwd || session.sessionManager.getCwd(), id, context.signal, () => {
					assertNativeChat(context);
				});
			} else {
				if (
					info.cwd &&
					normalizePathForComparison(info.cwd) !== normalizePathForComparison(session.sessionManager.getCwd())
				)
					throw new Error("Continuing this history requires an active native workspace host.");
				if (!(await session.switchSession(info.path))) throw new Error("Native session recovery was cancelled.");
			}
			assertNativeChat(context);
			if (session.sessionId !== id) throw new Error("The requested native history was not restored.");
			this.notify();
		} finally {
			this.#resuming = false;
		}
	}

	async submit(
		context: WebGuiServiceContext,
		id: string,
		content: string,
		inputId: string,
		clientId?: string,
		commandId?: string,
	): Promise<void> {
		if (!content.trim()) throw new TypeError("A plain text message is required.");
		const session = assertNativeChat(context);
		await this.resume(context, id);
		assertNativeChat(context);
		if (session.isStreaming || session.isSessionTransitioning || this.#submitting)
			throw new Error("The native session is busy; wait for the current reply.");
		this.state(id).error = undefined;
		this.#submitting = true;
		this.indexVersion++;
		this.notify();
		const admission = Promise.withResolvers<void>();
		let admitted = false;
		const operation = session.prompt(content, {
			inputId,
			inputClientId: clientId,
			...(commandId
				? { sourceCommand: { sessionId: id, commandId, fingerprint: JSON.stringify({ content, inputId }) } }
				: {}),
			onPromptAdmitted: () => {
				admitted = true;
				admission.resolve();
			},
		});
		void operation
			.then(
				completed => {
					if (!admitted) {
						if (completed) admission.resolve();
						else admission.reject(new Error("The native prompt was cancelled before admission."));
					}
				},
				error => {
					this.state(id).error = {
						message: error instanceof Error ? error.message : String(error),
						at: Date.now(),
					};
					admission.reject(error);
				},
			)
			.finally(() => {
				this.#submitting = false;
				this.indexVersion++;
				this.notify();
			});
		await admission.promise;
	}

	async snapshot(context: WebGuiServiceContext, id: string): Promise<ConversationSnapshot> {
		assertNativeChat(context);
		const state = this.state(id);
		const seq = state.seq;
		const child = await this.child(context, id);
		const active = id === this.session.sessionId;
		if (active && state.snapshot?.seq === state.seq) return state.snapshot;
		const info = await this.info(context, id);
		const messages = await this.messages(context, id);
		const busy = child
			? child.status === "running" || child.status === "waiting" || child.status === "blocked"
			: active && (this.session.isStreaming || this.session.isSessionTransitioning || this.#submitting);
		const rows: ConversationRow[] = [];
		let turnId = `${id}:history`;
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--)
			if (messages[index]?.role === "user") {
				lastUserIndex = index;
				break;
			}
		const rowBase = (key: string, timestamp: number) => {
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
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			const at = typeof message.timestamp === "number" ? message.timestamp : info.created.getTime();
			if (message.role === "user") {
				turnId = `${id}:turn:${index}`;
				const attribution = message as AgentMessage & {
					inputId?: string;
					sourceCommand?: { commandId: string };
					inputClientId?: string;
				};
				rows.push({
					...rowBase(`${index}:turn`, at),
					kind: "turnHeader",
					origin: "userInput",
					state: busy && index === lastUserIndex ? "running" : "completedSuccess",
					startedAt: at,
				});
				rows.push({
					...rowBase(`${index}:user`, at),
					kind: "userInput",
					text: text(message.content),
					origin: "realUser",
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
			}
		}
		rows.sort((left, right) => left.rowId - right.rowId);
		const lastAssistant = messages.findLast(message => message.role === "assistant");
		const error =
			state.error ??
			(lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error" ? lastAssistantError : undefined);
		const denied = { allowed: false as const, reasonCode: "guard.nativeChatOnly" };
		const model = active ? this.session.model : child?.session?.model;
		const canContinue =
			!child &&
			(active ||
				Boolean(nativeCwdHost(this.session)) ||
				!info.cwd ||
				normalizePathForComparison(info.cwd) === normalizePathForComparison(this.session.sessionManager.getCwd()));
		const subagents = await this.#withChildren(async directory =>
			directory && (active || child) ? directory.projection(context, id) : undefined,
		);
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
						: child?.status === "cancelled" || info.status === "aborted" || info.status === "interrupted"
							? "completedInterrupted"
							: "completedSuccess",
				sessionEnded: !busy && !error,
				canStop: false,
				stopState: "idle",
				stopTargetKind: "unknown",
				activeWorks: [],
				lastError: error
					? {
							code: "native.promptError",
							message: error.message,
							recoverable: true,
							at: error.at,
							source: "runtime",
						}
					: null,
				apiRetry: null,
			},
			availability: {
				fork: denied,
				compact: denied,
				switchModelConfig: active ? { allowed: true } : denied,
				setFollowupMode: denied,
				queueEdit: denied,
				sendQueuedNow: denied,
				pauseGoal: denied,
				resumeGoal: denied,
			},
			inputRouting: child
				? { mode: "reject", reasonCode: "guard.nativeChildReadOnly" }
				: busy
					? { mode: "reject", reasonCode: "guard.nativeSessionBusy" }
					: !canContinue
						? { mode: "reject", reasonCode: "guard.nativeHistoryWorkingDirectory" }
						: { mode: "startNow" },
			meta: { title: sessionDisplayName(info), titleSource: "default" },
			config: {
				provider: model?.provider ?? "",
				model: model?.id ?? "",
				thought: active ? (this.session.thinkingLevel ?? "off") : (child?.session?.thinkingLevel ?? "off"),
				followupMode: "queue",
				mode: "build",
				...(model ? { modelSelection: { providerId: model.provider, modelId: model.id } } : {}),
			},
			usage: {
				contextWindow: null,
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
			queue: { items: [], autoDrain: false },
			pendingInteractions: [],
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
		const busy = info.id === this.session.sessionId && (this.session.isStreaming || this.#submitting);
		return {
			sessionId: info.id,
			workspaceId,
			title: sessionDisplayName(info),
			phase: busy
				? "running"
				: info.status === "error"
					? "error"
					: info.status === "aborted" || info.status === "interrupted"
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
export function nativeChatRuntime(context: WebGuiServiceContext): NativeChatRuntime {
	const session = assertNativeChat(context);
	let runtime = runtimes.get(session);
	if (!runtime) {
		runtime = new NativeChatRuntime(session);
		runtimes.set(session, runtime);
	}
	return runtime;
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
	const runtime = nativeChatRuntime(context);
	const messages = await runtime.messages(context, id);
	const info = await runtime.info(context, id);
	const cwd = info.cwd || context.workspacePath!;
	let parentMessageId = `${id}:root`;
	return messages.flatMap((message, index): ZCodeMessageWithParts[] => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		const messageId = `${id}:${index}`;
		const base = { sessionId: id, messageId };
		const parts: ZCodeMessageWithParts["parts"] =
			typeof message.content === "string"
				? [{ ...base, partId: `${messageId}:text`, type: "text", text: message.content }]
				: message.content.flatMap((part, partIndex): ZCodeMessageWithParts["parts"] => {
						if (part.type === "text")
							return [{ ...base, partId: `${messageId}:${partIndex}`, type: "text", text: part.text }];
						if (part.type === "thinking")
							return [{ ...base, partId: `${messageId}:${partIndex}`, type: "reasoning", text: part.thinking }];
						return [];
					});
		if (message.role === "user") {
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
	const runtime = nativeChatRuntime(context);
	const info = legacySessionInfo(context, await runtime.info(context, id));
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
			contextWindow: runtime.session.model?.contextWindow ?? 0,
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
		slashCommands: [],
	};
}
