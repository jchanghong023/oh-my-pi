import { logger } from "@oh-my-pi/pi-utils";
import { Emitter, type Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import type {
	ZCodeAgentInitializeResult,
	ZCodeAgentStorageStartupSnapshot,
} from "../../../../vendor/zcode-frontend/packages/services/src/zcode-agent/zcodeAgent";
import type { ZCodeAgentWorkspaceTarget } from "../../../../vendor/zcode-frontend/packages/services/src/zcode-agent/zcodeAgentPluginParams";
import { V4_WIRE_PROTOCOL_VERSION } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/core";
import { sessionsIndexTopic } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/sessions-index";
import {
	clientHelloSchema,
	type ClientHello,
	type HelloMessage,
	type SessionsIndexTopicWireFrame,
	type V4ConversationResyncResult,
	type V4SessionsIndexSubscribeResult,
	type V4ConversationSubscribeResult,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/transport";
import type { ConversationSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import type { ConversationDelta } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/delta";
import type {
	ConversationTopicFrame,
	ConversationTopicWireFrame,
	SessionsIndexTopicFrame,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/transport";
import {
	encodeTopicWireFrames,
	measureTopicNotificationEnvelopeBytes,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/wire-codec";
import {
	commandEnvelopeSchema,
	commandPayloadSchemas,
	type CommandAck,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/command";
import {
	assertNativeChat,
	legacyMessages,
	legacySessionInfo,
	legacySnapshot,
	listNativeHistory,
	nativeChatRuntime,
	type NativeChatRuntime,
} from "./native-chat";
import { createNativeTaskRunAdapter } from "./native-task-runs";
import {
	WebGuiNotImplementedError,
	type WebGuiMethod,
	type WebGuiServiceContext,
	type WebGuiServiceDefinition,
} from "./rpc-contract";
import { createWebGuiService } from "./service-channel";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected RPC parameters");
	return value as Record<string, unknown>;
}

function nonempty(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
	return value;
}

function workspaceTarget(value: unknown): ZCodeAgentWorkspaceTarget {
	const params = record(value);
	const workspacePath = nonempty(params.workspacePath, "workspacePath");
	if (params.remoteSessionId !== undefined) {
		throw new WebGuiNotImplementedError("zcode-agent.remoteWorkspace: no remote Host is attached");
	}
	return {
		workspacePath,
		...(params.workspaceIdentity === undefined
			? {}
			: { workspaceIdentity: nonempty(params.workspaceIdentity, "workspaceIdentity") }),
	};
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
	return target.workspaceIdentity?.trim() || target.workspacePath;
}

function runtimePolicy(value: unknown): "start-if-needed" | "existing-only" | undefined {
	if (value !== undefined && value !== "start-if-needed" && value !== "existing-only") {
		throw new TypeError("Invalid runtimePolicy");
	}
	return value;
}

interface AttachmentIndex {
	readonly workspaceId: string;
	readonly epoch: string;
	readonly frames: Emitter<SessionsIndexTopicWireFrame>;
}

interface IndexSubscription {
	readonly index: AttachmentIndex;
	readonly id: string;
	readonly scope: string;
	readonly runtimePolicy: "start-if-needed" | "existing-only" | undefined;
	ordinal: number;
}

interface ConversationSubscription {
	readonly id: string;
	readonly sessionId: string;
	ordinal: number;
	snapshot: ConversationSnapshot;
}

/** Connection-owned subscriptions projecting the project's existing native runtime. */
class BrowserAgentAttachment {
	#context: WebGuiServiceContext;
	#clientHello: ClientHello | undefined;
	#indexes = new Map<string, AttachmentIndex>();
	#subscriptions = new Map<string, IndexSubscription>();
	#conversations = new Map<string, ConversationSubscription>();
	#conversationFrames = new Emitter<ConversationTopicWireFrame>();
	#timers = new Set<NodeJS.Timeout>();
	#storage: ZCodeAgentStorageStartupSnapshot = { generation: 0, state: null };
	#storageEvents = new Emitter<ZCodeAgentStorageStartupSnapshot>();
	#runtime?: NativeChatRuntime;
	#release?: () => void;
	#changes?: { dispose(): void };
	#refreshing = false;
	#refreshAgain = false;
	#flowState: "saturated" | "drained" | "closed" = "drained";
	#lastIndexVersion = -1;
	#disposed = false;
	#onAbort = () => this.dispose();

	constructor(context: WebGuiServiceContext) {
		this.#context = context;
		if (context.nativeSession) {
			this.#runtime = nativeChatRuntime(context);
			this.#release = this.#runtime.retain();
			this.#changes = this.#runtime.changes.event(() => this.#scheduleRefresh());
		}
		context.signal.addEventListener("abort", this.#onAbort, { once: true });
		if (context.signal.aborted) this.dispose();
	}

	#assertOpen(): void {
		if (this.#disposed || this.#context.signal.aborted) throw new Error("ConnectionClosed");
	}

	target(value: unknown): ZCodeAgentWorkspaceTarget {
		this.#assertOpen();
		const target = workspaceTarget(value);
		if (!this.#context.workspacePath || target.workspacePath !== this.#context.workspacePath)
			throw new WebGuiNotImplementedError(
				"zcode-agent.workspace: workspace is not bound to this browser connection",
			);
		return target;
	}

	runtime(value: unknown): NativeChatRuntime {
		this.target(value);
		assertNativeChat(this.#context);
		if (!this.#runtime) throw new WebGuiNotImplementedError("zcode-agent: native chat is unavailable");
		return this.#runtime;
	}
	setFlowState(value: unknown): void {
		this.target(value);
		const state = record(value).state;
		if (state !== "saturated" && state !== "drained" && state !== "closed")
			throw new TypeError("Invalid connection flow state");
		this.#flowState = state;
		if (state === "drained") this.#scheduleRefresh();
	}

	#notificationError(error: unknown): void {
		if (!this.#disposed && !this.#context.signal.aborted)
			logger.warn("Native browser subscription delivery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
	}

	storageState(value: unknown): ZCodeAgentStorageStartupSnapshot {
		this.target(value);
		return this.#storage;
	}

	storageEvents(value: unknown): Event<unknown> {
		const snapshot = this.storageState(value);
		return listener => {
			this.#assertOpen();
			const subscription = this.#storageEvents.event(listener);
			listener(snapshot);
			return subscription;
		};
	}

	hello(): HelloMessage {
		this.#assertOpen();
		return {
			kind: "hello",
			protocolVersion: V4_WIRE_PROTOCOL_VERSION,
			connectionId: this.#context.connectionId,
			clientMode: "desktop-continuous",
			deliveryProfile: "continuous",
			serverTime: Date.now(),
			capabilities: { nativeDialogs: false, binaryFrames: true, compression: "none" },
			auth: {},
		};
	}

	initialize(value: unknown): void {
		this.#assertOpen();
		const hello = clientHelloSchema.parse(value);
		nonempty(hello.clientId, "clientId");
		if (this.#clientHello && JSON.stringify(this.#clientHello) !== JSON.stringify(hello))
			throw new Error("fault.connection.alreadyInitialized");
		this.#clientHello = hello;
	}

	#assertInitialized(): void {
		this.#assertOpen();
		if (!this.#clientHello) throw new Error("fault.connection.handshakeRequired");
	}

	#index(value: unknown): AttachmentIndex {
		const key = workspaceKey(this.target(value));
		let index = this.#indexes.get(key);
		if (!index) {
			index = { workspaceId: key, epoch: crypto.randomUUID(), frames: new Emitter<SessionsIndexTopicWireFrame>() };
			this.#indexes.set(key, index);
		}
		return index;
	}

	frames(value: unknown): Event<unknown> {
		return this.#index(value).frames.event;
	}
	conversationFrames(value: unknown): Event<unknown> {
		this.target(value);
		return this.#conversationFrames.event;
	}

	#later(run: () => void): void {
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			if (!this.#disposed) run();
		}, 0);
		this.#timers.add(timer);
	}

	async #indexFrame(subscription: IndexSubscription, deliveryKind: "initial" | "online" | "recovery"): Promise<void> {
		const sessions = await listNativeHistory(this.#context);
		if (this.#disposed || !this.#subscriptions.has(subscription.id)) return;
		const topic = sessionsIndexTopic(subscription.index.workspaceId);
		const frame: SessionsIndexTopicFrame = {
			topic,
			subscriptionId: subscription.id,
			fromSeq: 0,
			toSeq: 0,
			sentAt: Date.now(),
			payload: {
				kind: "snapshot",
				snapshot: {
					protocolVersion: 1,
					workspaceId: subscription.index.workspaceId,
					logEpoch: subscription.index.epoch,
					sessions: this.#runtime
						? sessions.map(info => this.#runtime!.summary(info, subscription.index.workspaceId))
						: [],
				},
			},
		};
		for (const wire of encodeTopicWireFrames(frame, {
			deliveryKind,
			topic,
			subscriptionId: subscription.id,
			logicalFrameId: crypto.randomUUID(),
			logicalFrameOrdinal: ++subscription.ordinal,
			measurePhysicalFrameBytes: wire => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
		}))
			subscription.index.frames.fire(wire);
	}

	async subscribe(value: unknown): Promise<V4SessionsIndexSubscribeResult> {
		this.#assertInitialized();
		const params = record(value);
		const index = this.#index(value);
		const policy = runtimePolicy(params.runtimePolicy);
		const scope = params.subscriberScope === undefined ? "" : nonempty(params.subscriberScope, "subscriberScope");
		for (const subscription of this.#subscriptions.values())
			if (subscription.index === index && subscription.scope === scope) this.#subscriptions.delete(subscription.id);
		const subscription: IndexSubscription = {
			index,
			id: crypto.randomUUID(),
			scope,
			runtimePolicy: policy,
			ordinal: 0,
		};
		// Resolve the actual storage before acknowledging; asynchronous notification failures must not strand startup.
		await listNativeHistory(this.#context);
		this.#subscriptions.set(subscription.id, subscription);
		this.#later(() => {
			void this.#indexFrame(subscription, "initial").catch(error => this.#notificationError(error));
		});
		return { ack: { subscriptionId: subscription.id, logEpoch: index.epoch, mode: "snapshot" } };
	}

	#owned(value: unknown): IndexSubscription {
		this.#assertInitialized();
		const params = record(value);
		const index = this.#index(value);
		const subscription = this.#subscriptions.get(nonempty(params.subscriptionId, "subscriptionId"));
		if (
			!subscription ||
			subscription.index !== index ||
			runtimePolicy(params.runtimePolicy) !== subscription.runtimePolicy
		)
			throw new Error("fault.subscription.notOwned");
		return subscription;
	}

	resync(value: unknown): V4ConversationResyncResult {
		const subscription = this.#owned(value);
		this.#later(() => {
			void this.#indexFrame(subscription, "recovery").catch(error => this.#notificationError(error));
		});
		return { ack: { subscriptionId: subscription.id, logEpoch: subscription.index.epoch, mode: "snapshot" } };
	}

	unsubscribe(value: unknown): void {
		this.#subscriptions.delete(this.#owned(value).id);
	}

	#publishConversation(
		subscription: ConversationSubscription,
		snapshot: ConversationSnapshot,
		deliveryKind: "initial" | "online" | "recovery",
	): void {
		if (this.#disposed || !this.#conversations.has(subscription.id)) return;
		if (deliveryKind === "online" && this.#flowState !== "drained") return;
		const previous = subscription.snapshot;
		const topic = `conversation/${subscription.sessionId}`;
		let frame: ConversationTopicFrame;
		if (deliveryKind !== "online") {
			frame = {
				topic,
				subscriptionId: subscription.id,
				fromSeq: 0,
				toSeq: snapshot.seq,
				sentAt: Date.now(),
				payload: {
					kind: "snapshot",
					snapshot: { ...snapshot, rows: { ...snapshot.rows, window: snapshot.rows.window.slice(-200) } },
				},
			};
		} else {
			if (snapshot.seq <= previous.seq) return;
			const deltas: ConversationDelta[] = [];
			const oldRows = new Map(previous.rows.window.map(row => [row.rowId, row]));
			const newIds = new Set(snapshot.rows.window.map(row => row.rowId));
			const removed = previous.rows.window.find(row => !newIds.has(row.rowId));
			if (removed) deltas.push({ op: "row.removed", fromRowId: removed.rowId });
			for (const row of snapshot.rows.window) {
				const before = oldRows.get(row.rowId);
				if (!before || (removed && row.rowId >= removed.rowId)) deltas.push({ op: "row.appended", row });
				else if (
					(row.kind === "assistantText" || row.kind === "reasoning") &&
					(before.kind === "assistantText" || before.kind === "reasoning") &&
					before.kind === row.kind &&
					before.state === "streaming" &&
					row.state === "streaming" &&
					row.text.startsWith(before.text)
				) {
					const append = row.text.slice(before.text.length);
					if (append) deltas.push({ op: "row.delta", rowId: row.rowId, path: "text", append });
				} else if (JSON.stringify(before) !== JSON.stringify(row)) deltas.push({ op: "row.upserted", row });
			}
			const {
				rows: _rows,
				protocolVersion: _protocol,
				sessionId: _session,
				logEpoch: _epoch,
				seq: _seq,
				...patch
			} = snapshot;
			deltas.push({ op: "state.updated", patch });
			frame = {
				topic,
				subscriptionId: subscription.id,
				fromSeq: previous.seq,
				toSeq: snapshot.seq,
				sentAt: Date.now(),
				payload: { kind: "deltas", deltas },
			};
		}
		subscription.snapshot = snapshot;
		for (const wire of encodeTopicWireFrames(frame, {
			deliveryKind,
			topic,
			subscriptionId: subscription.id,
			logicalFrameId: crypto.randomUUID(),
			logicalFrameOrdinal: ++subscription.ordinal,
			measurePhysicalFrameBytes: wire => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
		}))
			this.#conversationFrames.fire(wire);
	}

	async subscribeConversation(value: unknown): Promise<V4ConversationSubscribeResult> {
		this.#assertInitialized();
		const params = record(value);
		const runtime = this.runtime(value);
		const sessionId = nonempty(params.sessionId, "sessionId");
		const snapshot = await runtime.snapshot(this.#context, sessionId);
		for (const existing of this.#conversations.values())
			if (existing.sessionId === sessionId) this.#conversations.delete(existing.id);
		const subscription: ConversationSubscription = { id: crypto.randomUUID(), sessionId, ordinal: 0, snapshot };
		this.#conversations.set(subscription.id, subscription);
		this.#later(() => {
			this.#publishConversation(subscription, snapshot, "initial");
			this.#scheduleRefresh();
		});
		return { ack: { subscriptionId: subscription.id, logEpoch: snapshot.logEpoch, mode: "snapshot" } };
	}

	#ownedConversation(value: unknown): ConversationSubscription {
		this.#assertInitialized();
		this.runtime(value);
		const subscription = this.#conversations.get(nonempty(record(value).subscriptionId, "subscriptionId"));
		if (!subscription) throw new Error("fault.subscription.notOwned");
		return subscription;
	}

	async resyncConversation(value: unknown): Promise<V4ConversationResyncResult> {
		const subscription = this.#ownedConversation(value);
		const snapshot = await this.#runtime!.snapshot(this.#context, subscription.sessionId);
		this.#later(() => {
			this.#publishConversation(subscription, snapshot, "recovery");
			this.#scheduleRefresh();
		});
		return { ack: { subscriptionId: subscription.id, logEpoch: snapshot.logEpoch, mode: "snapshot" } };
	}

	unsubscribeConversation(value: unknown): void {
		this.#conversations.delete(this.#ownedConversation(value).id);
	}

	#scheduleRefresh(): void {
		if (this.#disposed) return;
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return;
		}
		this.#refreshing = true;
		this.#later(() => {
			void this.#refresh()
				.catch(error => this.#notificationError(error))
				.finally(() => {
					this.#refreshing = false;
					if (this.#refreshAgain) {
						this.#refreshAgain = false;
						this.#scheduleRefresh();
					}
				});
		});
	}

	async #refresh(): Promise<void> {
		if (!this.#runtime || this.#disposed || this.#flowState !== "drained") return;
		for (const subscription of this.#conversations.values()) {
			if (this.#runtime.state(subscription.sessionId).seq <= subscription.snapshot.seq) continue;
			try {
				this.#publishConversation(
					subscription,
					await this.#runtime.snapshot(this.#context, subscription.sessionId),
					"online",
				);
			} catch (error) {
				if (this.#disposed || this.#context.signal.aborted) return;
				const state = this.#runtime.state(subscription.sessionId);
				const previous = subscription.snapshot;
				this.#publishConversation(
					subscription,
					{
						...previous,
						seq: Math.max(previous.seq + 1, state.seq),
						revision: Math.max(previous.revision + 1, state.seq),
						control: {
							...previous.control,
							phase: "error",
							sessionEnded: false,
							lastError: {
								code: "native.readError",
								message: error instanceof Error ? error.message : String(error),
								recoverable: true,
								source: "runtime",
								at: Date.now(),
							},
						},
					},
					"online",
				);
			}
		}
		if (this.#lastIndexVersion !== this.#runtime.indexVersion) {
			this.#lastIndexVersion = this.#runtime.indexVersion;
			for (const subscription of this.#subscriptions.values()) await this.#indexFrame(subscription, "online");
		}
	}

	async command(value: unknown): Promise<CommandAck> {
		const runtime = this.runtime(value);
		const envelope = commandEnvelopeSchema.parse(record(value).envelope);
		const sessionId = nonempty(envelope.sessionId, "sessionId");
		const key = JSON.stringify([sessionId, envelope.commandId]);
		const existing = runtime.commands.get(key);
		if (existing) return existing;
		let ack: CommandAck;
		try {
			if (envelope.type !== "sendText") throw new WebGuiNotImplementedError(`zcode-agent.command.${envelope.type}`);
			const input = record(envelope.payload);
			const payload = commandPayloadSchemas.sendText.parse(input);
			const { text, attachments, requestedDelivery, modelSelection, mode, planEnabled, ...extraInput } = payload;
			if (
				attachments?.length ||
				Object.values(extraInput).some(value => value !== undefined) ||
				Object.entries(input).some(([key, value]) => value !== undefined && !Object.hasOwn(payload, key)) ||
				(requestedDelivery !== undefined && requestedDelivery !== "startNow") ||
				(mode !== undefined && mode !== "build") ||
				planEnabled === true
			)
				throw new WebGuiNotImplementedError(
					"native chat: plain text only; contextual input and execution overrides are unavailable",
				);
			if (
				modelSelection &&
				(modelSelection.providerId !== runtime.session.model?.provider ||
					modelSelection.modelId !== runtime.session.model?.id ||
					(modelSelection.options?.reasoningLevel !== undefined &&
						modelSelection.options.reasoningLevel !== (runtime.session.thinkingLevel ?? "off")))
			)
				throw new WebGuiNotImplementedError("native chat: submission must use the current native model selection");
			await runtime.submit(
				this.#context,
				sessionId,
				text,
				envelope.commandId,
				envelope.clientId,
				envelope.commandId,
			);
			ack = {
				commandId: envelope.commandId,
				status: "accepted",
				revisionAtDecision: runtime.state(sessionId).seq,
				result: { type: "inputAccepted", delivery: "startNow", inputId: envelope.commandId },
			};
		} catch (error) {
			ack = {
				commandId: envelope.commandId,
				status: "rejected",
				reasonCode: "guard.nativeChatUnavailable",
				message: error instanceof Error ? error.message : String(error),
				revisionAtDecision: runtime.state(sessionId).seq,
			};
		}
		runtime.commands.set(key, ack);
		return ack;
	}

	queryCommands(value: unknown): unknown {
		const runtime = this.runtime(value);
		const commands = record(value).commands;
		if (!Array.isArray(commands)) throw new TypeError("Expected command keys");
		return {
			results: commands.map(value => {
				const key = record(value);
				return { key, result: runtime.commands.get(JSON.stringify([key.sessionId, key.commandId])) ?? "unknown" };
			}),
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#context.signal.removeEventListener("abort", this.#onAbort);
		this.#changes?.dispose();
		this.#release?.();
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#subscriptions.clear();
		this.#conversations.clear();
		for (const index of this.#indexes.values()) index.frames.dispose();
		this.#indexes.clear();
		this.#conversationFrames.dispose();
		this.#storageEvents.dispose();
		this.#clientHello = undefined;
	}
}

export function createAgentServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	const attachment = new BrowserAgentAttachment(context);
	const runtime = context.nativeSession ? nativeChatRuntime(context) : undefined;
	const directory = runtime?.childDirectory;
	const taskRuns = directory ? createNativeTaskRunAdapter(context, directory) : undefined;
	const releaseTaskRuns = taskRuns ? runtime!.registerTaskRuns() : undefined;
	let taskRunsDisposed = false;
	const disposeTaskRuns = () => {
		if (taskRunsDisposed) return;
		taskRunsDisposed = true;
		context.signal.removeEventListener("abort", disposeTaskRuns);
		taskRuns?.dispose();
		releaseTaskRuns?.();
	};
	context.signal.addEventListener("abort", disposeTaskRuns, { once: true });
	if (context.signal.aborted) disposeTaskRuns();
	const initialize = (value: unknown): ZCodeAgentInitializeResult => {
		const target = attachment.target(value);
		if (!context.nativeSession)
			return {
				available: false,
				workspaceKey: workspaceKey(target),
				reason: "No native OMP session is bound to this browser connection.",
			};
		attachment.runtime(value);
		return {
			available: true,
			workspaceKey: workspaceKey(target),
			protocolName: "OMP native chat",
			protocolVersion: V4_WIRE_PROTOCOL_VERSION,
			transportKind: "websocket",
		};
	};
	const sessionId = (value: unknown): string => nonempty(record(value).sessionId, "sessionId");
	const taskReads: Record<string, WebGuiMethod> = {};
	if (taskRuns)
		for (const [name, method] of Object.entries(taskRuns.methods)) {
			taskReads[name] = (value: unknown) => {
				attachment.runtime(value);
				return method(value);
			};
		}
	const reads: Record<string, WebGuiMethod> = {
		getWorkspaceRuntimeIdentity: value => {
			const runtime = attachment.runtime(value);
			return {
				generation: runtime.session.sessionGeneration,
				identity: `${process.pid}:${context.projectId}`,
				processId: process.pid,
				workspaceKey: workspaceKey(attachment.target(value)),
			};
		},
		readWorkspacePresentation: value => {
			attachment.runtime(value);
			const target = attachment.target(value);
			return { workspace: { ...target, workspaceKey: workspaceKey(target) }, mode: "build", slashCommands: [] };
		},
		listSessions: async value => {
			attachment.runtime(value);
			return (await listNativeHistory(context)).map(info => legacySessionInfo(context, info));
		},
		listSessionSubagents: value => {
			const runtime = attachment.runtime(value);
			const params = record(value);
			if (params.endedCursor !== undefined && typeof params.endedCursor !== "string")
				throw new TypeError("Invalid native child cursor");
			if (params.endedLimit !== undefined && typeof params.endedLimit !== "number")
				throw new TypeError("Invalid native child page size");
			return runtime.listSubagents(context, sessionId(value), params.endedCursor, params.endedLimit);
		},
		readSession: value => {
			attachment.runtime(value);
			return legacySnapshot(context, sessionId(value));
		},
		readSessionMessages: async value => {
			attachment.runtime(value);
			const params = record(value);
			let messages = await legacyMessages(context, sessionId(value));
			if (typeof params.afterMessageId === "string") {
				const index = messages.findIndex(message => message.info.messageId === params.afterMessageId);
				if (index >= 0) messages = messages.slice(index + 1);
			}
			if (typeof params.limit === "number") messages = messages.slice(-Math.max(0, Math.floor(params.limit)));
			return messages;
		},
		resumeSession: async value => {
			const runtime = attachment.runtime(value);
			const id = sessionId(value);
			await runtime.resume(context, id);
			return legacySnapshot(context, id);
		},
	};
	return [
		createWebGuiService(
			"zcode-agent",
			{
				...reads,
				...taskReads,
				prepareStorage: async value => {
					attachment.runtime(value);
					await listNativeHistory(context);
				},
				getSessionLifecycle: async value => {
					const runtime = attachment.runtime(value);
					const id = sessionId(value);
					await runtime.info(context, id);
					const child = await runtime.child(context, id);
					return {
						sessionId: id,
						state: runtime.session.sessionId === id || child?.session ? "ready" : "unloaded",
						generation: child?.generation ?? runtime.session.sessionGeneration,
						revision: runtime.state(id).seq,
						lastError: null,
					};
				},
				reconcileSessionsIndexV4: async value => {
					const runtime = attachment.runtime(value);
					const params = record(value);
					if (!Array.isArray(params.sessionIds)) throw new TypeError("Expected session IDs");
					const infos = new Map((await listNativeHistory(context)).map(info => [info.id, info]));
					for (const value of params.sessionIds) {
						const id = nonempty(value, "sessionId");
						if (!infos.has(id)) {
							const child = await runtime.child(context, id);
							if (child) infos.set(id, child.info);
						}
					}
					return {
						sessions: params.sessionIds.map(id => {
							const info = infos.get(String(id));
							return info
								? {
										sessionId: info.id,
										exists: true,
										deleted: false,
										title: info.title || info.firstMessage,
										titleSource: info.title ? "custom" : "default",
										createdAt: info.created.getTime(),
										updatedAt: info.modified.getTime(),
									}
								: { sessionId: String(id), exists: false, deleted: false };
						}),
					};
				},
				sendPrompt: async value => {
					const runtime = attachment.runtime(value);
					const params = record(value);
					if (Array.isArray(params.attachments) && params.attachments.length)
						throw new WebGuiNotImplementedError("native chat: plain text only");
					const id = sessionId(value);
					await runtime.submit(
						context,
						id,
						nonempty(params.content, "content"),
						typeof params.inputId === "string" ? params.inputId : crypto.randomUUID(),
					);
					return { sessionId: id, accepted: true, stateRevision: runtime.state(id).seq };
				},
				subscribeConversationV4: value => attachment.subscribeConversation(value),
				resyncConversationV4: value => attachment.resyncConversation(value),
				unsubscribeConversationV4: value => attachment.unsubscribeConversation(value),
				conversationRowsRangeV4: async value => {
					const runtime = attachment.runtime(value);
					const params = record(value);
					if (
						typeof params.limit !== "number" ||
						!Number.isInteger(params.limit) ||
						params.limit < 1 ||
						params.limit > 200
					)
						throw new TypeError("Row limit must be 1..200");
					if (
						params.residency === "resident-only" &&
						sessionId(value) !== runtime.session.sessionId &&
						!(await runtime.child(context, sessionId(value)))?.session
					)
						throw new Error("proto.sessionNotResident");
					const snapshot = await runtime.snapshot(context, sessionId(value));
					const candidates = snapshot.rows.window.filter(
						row => typeof params.beforeRowId !== "number" || row.rowId < params.beforeRowId,
					);
					return {
						rows: candidates.slice(-params.limit),
						atSeq: snapshot.seq,
						atRevision: snapshot.revision,
						atLogEpoch: snapshot.logEpoch,
						hasMore: candidates.length > params.limit,
					};
				},
				sendConversationCommandV4: value => attachment.command(value),
				queryConversationCommandsV4: value => attachment.queryCommands(value),
				setConnectionFlowStateV4: value => attachment.setFlowState(value),
				initialize,
				getStorageStartupState: value => attachment.storageState(value),
				helloConversationV4: () => attachment.hello(),
				initializeConversationV4: value => attachment.initialize(value),
				subscribeSessionsIndexV4: value => attachment.subscribe(value),
				resyncSessionsIndexV4: value => attachment.resync(value),
				unsubscribeSessionsIndexV4: value => attachment.unsubscribe(value),
			},
			{
				...(taskRuns ? { events: { onNativeTaskRunsChanged: taskRuns.onDidChange } } : {}),
				dynamicEvents: {
					onDynamicSessionsIndexFrame: value => attachment.frames(value),
					onDynamicConversationFrame: value => attachment.conversationFrames(value),
					// Native journal storage has no ZCode database migration attempt.
					onDynamicStorageStartupState: value => attachment.storageEvents(value),
				},
				dispose: () => {
					disposeTaskRuns();
					attachment.dispose();
				},
			},
		),
		createWebGuiService("zcode-session", {
			...reads,
			initializeWorkspace: initialize,
		}),
	];
}
