import type {
	AgentSnapshot,
	CollabUiRequest,
	GuestFrame,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import {
	conversationSnapshotSchema,
	type ConversationSnapshot,
} from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import type { ConversationRow } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/rows";
import type { SessionSummary } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/sessions-index";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import {
	AIReqCollabBridge,
	sameAIReqCollabTarget,
	type AIReqCollabParticipant,
	type AIReqCollabSubmitResult,
	type AIReqCollabTarget,
} from "../collab";

export interface AIReqNativeCollabSnapshot {
	participant: AIReqCollabParticipant | null;
	status: "joining" | "loading" | "joined" | "disconnected";
	header: SessionHeader | null;
	state: SessionState | null;
	agents: AgentSnapshot[];
	entries: SessionEntry[];
	uiRequests: CollabUiRequest[];
	error?: string;
	revision: number;
}
export interface AIReqNativeCollabUpdate {
	type: "snapshot" | "frame" | "left";
	snapshot: AIReqNativeCollabSnapshot | null;
	target: AIReqCollabTarget | null;
	frame?: HostFrame;
}
export interface AIReqNativeCollabProjectionOptions {
	settings: Settings;
	resolveBrowserId(connectionId: string): string;
	onUpdate?(browserId: string, event: AIReqNativeCollabUpdate): void;
}

/** Remote native frames are presentation data, never input to the local actor or its journal. */
export class AIReqNativeCollabProjection {
	readonly #bridge: AIReqCollabBridge;
	readonly #options: AIReqNativeCollabProjectionOptions;
	readonly #views = new Map<string, AIReqNativeCollabSnapshot>();
	readonly #listeners = new Map<string, Set<(event: AIReqNativeCollabUpdate) => void>>();

	readonly #streams = new Map<string, WireMessage>();
	readonly #tools = new Map<string, Map<string, { result: unknown; done: boolean; isError?: boolean }>>();
	readonly #rowIds = new Map<string, { epoch: string; ids: Map<string, number> }>();
	readonly #conversations = new Map<
		string,
		{ target: AIReqCollabTarget; revision: number; snapshot: ConversationSnapshot }
	>();
	constructor(options: AIReqNativeCollabProjectionOptions) {
		this.#options = options;
		this.#bridge = new AIReqCollabBridge({
			settings: options.settings,
			onFrame: (browserId, frame, participant) => this.#frame(browserId, frame, participant),
			onConnecting: (browserId, participant) => {
				const view = this.#views.get(browserId);
				if (!view || (view.participant && view.participant.peerId !== participant.peerId)) return;
				view.participant = participant;
				view.status = "loading";
				view.uiRequests = [];
				this.#streams.delete(browserId);
				this.#tools.delete(browserId);
				this.#rowIds.delete(browserId);
				this.#publish(browserId, "snapshot");
			},
			onJoined: (browserId, participant) => {
				const view = this.#views.get(browserId);
				if (!view?.participant || !sameAIReqCollabTarget(view.participant, participant)) return;
				view.status = "joined";
				view.participant = participant;
				this.#publish(browserId, "snapshot");
			},
			onDisconnected: (browserId, reason, participant) => {
				const view = this.#views.get(browserId);
				if (!view || (view.participant && !sameAIReqCollabTarget(view.participant, participant))) return;
				view.status = "disconnected";
				view.uiRequests = [];
				view.error = reason;
				this.#publish(browserId, "snapshot");
			},
		});
	}

	browserId(connectionId: string): string {
		const browserId = this.#options.resolveBrowserId(connectionId);
		if (!browserId) throw new Error("Collaboration requires its originating browser page");
		return browserId;
	}

	read(browserId: string): AIReqNativeCollabSnapshot | null {
		const view = this.#views.get(browserId);
		return view
			? {
					...view,
					participant: view.participant ? { ...view.participant } : null,
					entries: [...view.entries],
					agents: [...view.agents],
					uiRequests: [...view.uiRequests],
				}
			: null;
	}

	subscribe(browserId: string, listener: (event: AIReqNativeCollabUpdate) => void): () => void {
		const listeners = this.#listeners.get(browserId) ?? new Set<(event: AIReqNativeCollabUpdate) => void>();
		this.#listeners.set(browserId, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (!listeners.size && this.#listeners.get(browserId) === listeners) this.#listeners.delete(browserId);
		};
	}

	async join(
		input: { browserId: string; usernameOrLink: string; name: string },
		signal: AbortSignal,
	): Promise<AIReqNativeCollabSnapshot> {
		if (this.#views.has(input.browserId)) throw new Error("Leave the current collaboration before joining again");
		const view: AIReqNativeCollabSnapshot = {
			participant: null,
			status: "joining",
			header: null,
			state: null,
			agents: [],
			entries: [],
			uiRequests: [],
			revision: 0,
		};
		this.#views.set(input.browserId, view);
		this.#publish(input.browserId, "snapshot");
		try {
			await this.#bridge.joinAIReqCollab(input, signal);
			if (this.#views.get(input.browserId) !== view || view.status !== "joined")
				throw new Error("Collaboration join ended before admission");
			return this.read(input.browserId)!;
		} catch (error) {
			if (this.#views.get(input.browserId) === view) {
				this.#views.delete(input.browserId);
				this.#streams.delete(input.browserId);
				this.#tools.delete(input.browserId);
				this.#rowIds.delete(input.browserId);
				this.#conversations.delete(input.browserId);
				await this.#bridge.leaveAIReqCollab(input.browserId);
				this.#publish(input.browserId, "left", undefined, view.participant);
			}
			throw error;
		}
	}

	async sendFrame(browserId: string, target: AIReqCollabTarget, frame: GuestFrame): Promise<AIReqCollabSubmitResult> {
		const view = this.#views.get(browserId);
		if (!view?.participant || view.status !== "joined" || !sameAIReqCollabTarget(view.participant, target))
			return { kind: "rejected", message: "Collaboration target is no longer joined" };
		return this.#bridge.sendFrame(browserId, frame, target);
	}

	async leave(browserId: string, target: AIReqCollabTarget): Promise<void> {
		const view = this.#views.get(browserId);
		if (!view?.participant || !sameAIReqCollabTarget(view.participant, target))
			throw new Error("Collaboration leave target is stale");
		this.#views.delete(browserId);
		this.#streams.delete(browserId);
		this.#tools.delete(browserId);
		this.#rowIds.delete(browserId);
		this.#conversations.delete(browserId);
		await this.#bridge.leaveAIReqCollab(browserId);
		this.#publish(browserId, "left", undefined, target);
	}

	async close(): Promise<void> {
		const views = [...this.#views];
		this.#views.clear();
		await this.#bridge.close();
		this.#streams.clear();
		this.#tools.clear();
		this.#rowIds.clear();
		this.#conversations.clear();
		for (const [browserId, view] of views) this.#publish(browserId, "left", undefined, view.participant);
		this.#listeners.clear();
	}

	conversation(browserId: string, target: AIReqCollabTarget): ConversationSnapshot {
		const view = this.#views.get(browserId);
		if (!view?.participant || !sameAIReqCollabTarget(view.participant, target) || !view.header || !view.state)
			throw new Error("Collaboration projection target is unavailable");
		const cached = this.#conversations.get(browserId);
		if (cached?.revision === view.revision && sameAIReqCollabTarget(cached.target, target)) return cached.snapshot;
		const id = target.sessionId;
		const epoch = `${target.peerId}:${target.roomId}:${target.generation}`;
		const busy = view.status === "joined" && view.state.isStreaming;
		const writable = view.status === "joined" && view.participant.canWrite;
		const rows: ConversationRow[] = [];
		const messages: Array<{ key: string; message: WireMessage; notice?: string }> = [];
		// Render the host's wire transcript directly. Its filtered parent links cannot
		// reconstruct a local actor context, and must never be replayed as one.
		for (const entry of view.entries) {
			if (entry.type === "message")
				messages.push({
					key: entry.message.role === "assistant" ? `assistant:${entry.message.timestamp}` : entry.id,
					message: entry.message,
				});
			else if (entry.type === "custom_message" && entry.display) {
				messages.push({
					key: entry.id,
					message: {
						role: entry.customType === "collab-prompt" ? "user" : "developer",
						content: entry.content,
						timestamp: Date.parse(entry.timestamp),
					},
					...(entry.customType === "collab-prompt" ? {} : { notice: entry.customType }),
				});
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				messages.push({
					key: entry.id,
					notice: entry.type,
					message: {
						role: "developer",
						content: entry.summary,
						timestamp: Date.parse(entry.timestamp),
					},
				});
			}
		}
		const stream = this.#streams.get(browserId);
		if (stream) messages.push({ key: `assistant:${stream.timestamp}`, message: stream });
		const results = new Map(
			messages.flatMap(({ message }) =>
				message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
			),
		);
		const contentText = (content: unknown): string => {
			if (typeof content === "string") return content;
			if (Array.isArray(content))
				return content
					.flatMap(part =>
						part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
							? [part.text]
							: [],
					)
					.join("\n");
			return "";
		};
		let rowIdentity = this.#rowIds.get(browserId);
		if (!rowIdentity || rowIdentity.epoch !== epoch) {
			rowIdentity = { epoch, ids: new Map() };
			this.#rowIds.set(browserId, rowIdentity);
		}
		const identities = rowIdentity.ids;
		const lastUserKey = messages.findLast(item => item.message.role === "user")?.key;
		const outcomes = new Map<string, "completedSuccess" | "completedInterrupted" | "failed">();
		let userKey: string | undefined;
		for (const { key, message } of messages) {
			if (message.role === "user") userKey = key;
			else if (message.role === "assistant" && userKey)
				outcomes.set(
					userKey,
					message.stopReason === "error"
						? "failed"
						: message.stopReason === "aborted"
							? "completedInterrupted"
							: "completedSuccess",
				);
		}
		const lastAssistant = messages.findLast(item => item.message.role === "assistant")?.message;
		const error =
			view.error ||
			(lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error"
				? lastAssistant.errorMessage || "Remote model request failed"
				: undefined);
		let turnId = `${epoch}:history`;
		for (const { key, message, notice } of messages) {
			const at = message.timestamp;
			const base = (suffix: string) => {
				const entityId = `${epoch}:${key}:${suffix}`;
				let rowId = identities.get(entityId);
				if (rowId === undefined) {
					rowId = identities.size + 1;
					identities.set(entityId, rowId);
				}
				return { rowId, turnId, entityId, createdAt: at, createdAtSeq: 0 };
			};
			if (notice) {
				rows.push({
					...base("notice"),
					kind: "timelineMarker",
					marker: { type: "nativeNotice", text: contentText(message.content), level: "info", source: notice },
				});
				continue;
			}
			if (message.role === "user") {
				turnId = `${epoch}:turn:${key}`;
				rows.push({
					...base("turn"),
					kind: "turnHeader",
					origin: "userInput",
					state: busy && key === lastUserKey ? "running" : (outcomes.get(key) ?? "completedInterrupted"),
					startedAt: at,
				});
				const attachments = Array.isArray(message.content)
					? message.content.flatMap((part, index) =>
							part.type === "image"
								? [
										{
											ref: `collab-image:${key}:${index}`,
											fileName: `image-${index + 1}`,
											mime: part.mimeType,
											bytes: Buffer.byteLength(part.data, "base64"),
											previewRef: `collab-image:${key}:${index}`,
										},
									]
								: [],
						)
					: [];
				rows.push({
					...base("user"),
					kind: "userInput",
					origin: message.synthetic ? "synthetic" : "realUser",
					text: contentText(message.content),
					...(attachments.length ? { attachments } : {}),
				});
			} else if (message.role === "assistant") {
				const streaming = message === stream && busy;
				const interrupted =
					message.stopReason === "aborted" || (message === stream && view.status === "disconnected");
				for (let index = 0; index < message.content.length; index++) {
					const part = message.content[index]!;
					if (part.type === "text")
						rows.push({
							...base(String(index)),
							kind: "assistantText",
							text: part.text,
							model: message.model,
							state: streaming
								? "streaming"
								: message.stopReason === "error"
									? "failed"
									: interrupted
										? "interrupted"
										: "complete",
						});
					else if (part.type === "thinking")
						rows.push({
							...base(String(index)),
							kind: "reasoning",
							text: part.thinking,
							state: streaming ? "streaming" : interrupted ? "interrupted" : "complete",
						});
					else if (part.type === "toolCall") {
						const result = results.get(part.id);
						const live = this.#tools.get(browserId)?.get(part.id);
						const isError = result?.isError ?? live?.isError;
						const output = result
							? contentText(result.content)
							: live
								? contentText(
										live.result && typeof live.result === "object" && "content" in live.result
											? live.result.content
											: live.result,
									)
								: undefined;
						rows.push({
							...base(String(index)),
							kind: "toolCall",
							toolCallId: part.id,
							toolName: part.name,
							inputText: JSON.stringify(part.arguments),
							input: part.arguments,
							status: result || live?.done ? (isError ? "error" : "success") : busy ? "running" : "cancelled",
							...(output !== undefined ? { output: { text: output } } : {}),
							...(isError
								? { error: { code: "native.collabToolError", message: output || "Remote native tool failed" } }
								: {}),
						});
					}
				}
				if (message.stopReason === "error" && !message.content.some(part => part.type === "text"))
					rows.push({
						...base("error"),
						kind: "assistantText",
						text: message.errorMessage || "Remote model request failed",
						state: "failed",
						model: message.model,
					});
			}
		}
		const denied = { allowed: false as const, reasonCode: "guard.remoteNativeOwner" };
		const model = view.state.model;
		const context = view.state.contextUsage;
		const pendingInteractions = writable
			? view.uiRequests.map(request => ({
					interactionId: `${epoch}:ui:${request.reqId}`,
					kind: "userInput" as const,
					anchorRowId: null,
					createdAt: Date.parse(view.header!.timestamp),
					payload: {
						kind: "userInput" as const,
						prompt:
							request.kind === "select" && request.helpText
								? `${request.title}\n\n${request.helpText}`
								: request.title,
						freeText: request.kind === "editor",
						toolName: "collab-native",
						...(request.kind === "editor"
							? { input: { multiline: true, prefill: request.prefill ?? "" } }
							: {
									input: {
										kind: "collab-native-selector",
										initialIndex: request.initialIndex,
										selectionMarker: request.selectionMarker,
										checkedIndices: request.checkedIndices,
										markableCount: request.markableCount,
										helpText: request.helpText,
									},
									options: request.options.map((option, index) => {
										const label = typeof option === "string" ? option : option.label;
										const markable =
											request.selectionMarker && index < (request.markableCount ?? request.options.length);
										const checked =
											request.selectionMarker === "checkbox"
												? request.checkedIndices?.includes(index)
												: index === (request.initialIndex ?? 0);
										const description = typeof option === "string" ? "" : option.description;
										return {
											optionId: String(index),
											label: `${markable ? (checked ? "[x] " : "[ ] ") : ""}${label}${description ? ` — ${description}` : ""}`,
										};
									}),
								}),
					},
				}))
			: [];
		const snapshot = conversationSnapshotSchema.parse({
			protocolVersion: 1,
			sessionId: id,
			logEpoch: epoch,
			seq: view.revision,
			revision: view.revision,
			control: {
				phase: busy
					? "running"
					: error
						? "error"
						: lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted"
							? "completedInterrupted"
							: rows.length
								? "completedSuccess"
								: "draft",
				sessionEnded: !busy && !error && rows.length > 0,
				canStop: writable && busy,
				stopState: writable && busy ? "stoppable" : "idle",
				stopTargetKind: "assistant",
				activeWorks: [],
				lastError: error
					? {
							code: "native.collab",
							message: error,
							recoverable: false,
							at: Date.parse(view.header.timestamp),
							source: "runtime",
						}
					: null,
				apiRetry: null,
			},
			availability: {
				fork: denied,
				compact: denied,
				switchModelConfig: denied,
				setFollowupMode: denied,
				queueEdit: denied,
				sendQueuedNow: denied,
				pauseGoal: denied,
				resumeGoal: denied,
			},
			inputRouting: !writable
				? { mode: "reject", reasonCode: "guard.remoteReadOnly" }
				: busy
					? { mode: "guide" }
					: { mode: "startNow" },
			meta: { title: view.state.sessionName || view.header.title || "Native collaboration", titleSource: "default" },
			config: {
				provider: model?.provider ?? "",
				model: model?.id ?? "",
				thought: view.state.thinkingLevel ?? "off",
				followupMode: "guide",
				mode: "build",
				...(model ? { modelSelection: { providerId: model.provider, modelId: model.id } } : {}),
			},
			usage: {
				contextWindow: context?.contextWindow
					? { usedTokens: context.tokens ?? 0, maxTokens: context.contextWindow, autoCompactThresholdTokens: null }
					: null,
				cumulative: messages.reduce(
					(sum, { message }) => {
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
			queue: { items: [], autoDrain: true },
			pendingInteractions,
			pendingCommands: [],
			backgroundWorks: [],
			goal: null,
			plan: null,
			rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
		});
		this.#conversations.set(browserId, { target: { ...target }, revision: view.revision, snapshot });
		return snapshot;
	}

	summary(browserId: string, target: AIReqCollabTarget): SessionSummary {
		const conversation = this.conversation(browserId, target);
		const view = this.#views.get(browserId)!;
		const last = conversation.rows.window.findLast(row => row.kind === "assistantText");
		return {
			sessionId: target.sessionId,
			workspaceId: `collab:${target.peerId}`,
			title: conversation.meta.title,
			phase: conversation.control.phase,
			sessionEnded: conversation.control.sessionEnded,
			hasBackgroundWork: false,
			createdAt: Date.parse(view.header!.timestamp),
			lastActivityAt: Date.parse(view.entries.at(-1)?.timestamp ?? view.header!.timestamp),
			...(last?.kind === "assistantText" ? { lastAssistantPreview: last.text.slice(0, 120) } : {}),
		};
	}
	#frame(browserId: string, frame: HostFrame, participant: AIReqCollabParticipant): void {
		const view = this.#views.get(browserId);
		if (!view) return;
		if (frame.t === "welcome") {
			if (
				view.participant &&
				(view.participant.peerId !== participant.peerId ||
					(view.participant.sessionId && view.participant.sessionId !== participant.sessionId) ||
					participant.generation < view.participant.generation)
			)
				return;
			view.participant = participant;
			view.status = "loading";
			view.header = frame.header;
			view.state = frame.state;
			view.agents = frame.agents;
			view.entries = [];
			view.uiRequests = [];
			this.#streams.delete(browserId);
			this.#tools.delete(browserId);
			delete view.error;
		} else {
			if (!view.participant || !sameAIReqCollabTarget(view.participant, participant)) return;
			switch (frame.t) {
				case "snapshot-chunk":
					view.entries.push(...frame.entries);
					break;
				case "entry": {
					const index = view.entries.findIndex(entry => entry.id === frame.entry.id);
					if (index === -1) view.entries.push(frame.entry);
					else view.entries[index] = frame.entry;
					if (
						frame.entry.type === "message" &&
						frame.entry.message.timestamp === this.#streams.get(browserId)?.timestamp
					)
						this.#streams.delete(browserId);
					break;
				}
				case "state":
					view.state = frame.state;
					break;
				case "agents":
					view.agents = frame.agents;
					break;
				case "ui-request":
					view.uiRequests.push(frame.request);
					break;
				case "ui-request-end":
					view.uiRequests = view.uiRequests.filter(request => request.reqId !== frame.reqId);
					break;
				case "bye":
					view.status = "disconnected";
					view.uiRequests = [];
					view.error = frame.reason;
					break;
				case "error":
					view.error = frame.message;
					break;
				case "event": {
					const event = frame.event;
					if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
						if (event.message.role === "assistant") {
							const persisted = view.entries.some(
								entry =>
									entry.type === "message" &&
									entry.message.role === "assistant" &&
									entry.message.timestamp === event.message.timestamp,
							);
							if (!persisted) this.#streams.set(browserId, event.message);
						}
					}
					if (event.type === "agent_start" && view.state) view.state = { ...view.state, isStreaming: true };
					if (event.type === "agent_end" && view.state) view.state = { ...view.state, isStreaming: false };
					if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
						let tools = this.#tools.get(browserId);
						if (!tools) this.#tools.set(browserId, (tools = new Map()));
						tools.set(event.toolCallId, {
							result: event.type === "tool_execution_end" ? event.result : event.partialResult,
							done: event.type === "tool_execution_end",
							...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
						});
					}
					break;
				}
			}
		}
		this.#publish(browserId, "frame", frame);
	}

	#publish(
		browserId: string,
		type: AIReqNativeCollabUpdate["type"],
		frame?: HostFrame,
		retired?: AIReqCollabTarget | null,
	): void {
		const view = this.#views.get(browserId);
		if (view) view.revision++;
		// Streaming frames carry their own payload; do not recopy the entire transcript per token.
		const snapshot = type === "frame" ? null : this.read(browserId);
		const event: AIReqNativeCollabUpdate = {
			type,
			snapshot,
			target: view?.participant ?? retired ?? null,
			...(frame ? { frame } : {}),
		};
		this.#options.onUpdate?.(browserId, event);
		for (const listener of this.#listeners.get(browserId) ?? []) listener(event);
	}
}

const bindings = new WeakMap<AgentSession, AIReqNativeCollabProjection>();
export function bindAIReqNativeCollabProjection(
	session: AgentSession,
	projection: AIReqNativeCollabProjection,
): () => void {
	bindings.set(session, projection);
	return () => {
		if (bindings.get(session) === projection) bindings.delete(session);
	};
}
export function aiReqNativeCollabProjection(session: AgentSession): AIReqNativeCollabProjection {
	const projection = bindings.get(session);
	if (!projection) throw new Error("Native collaboration projection is not bound");
	return projection;
}
