import { logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";
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
	nativeChatProjectRuntime,
	nativeChatChanges,
	nativeChatRuntimeForSession,
	resolveNativeChatRuntime,
	type NativeChatRuntime,
} from "./native-chat";
import { nativeWebGuiQuestions } from "./native-interactions";
import {
	assertWebGuiNativeAdmission,
	createWebGuiNativeSession,
	listWebGuiNativeSessions,
	resolveWebGuiSession,
	runWebGuiSession,
	subscribeWebGuiNativeSessions,
	webGuiSessionProject,
} from "./native-session-host";
import { listBrowserProjects, readBrowserProject } from "./project-registry";
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
	#receipts: NativeChatRuntime;
	#residents = new Map<NativeChatRuntime, () => void>();
	#changes?: { dispose(): void };
	#unsubscribeLifecycle?: () => void;
	#refreshing = false;
	#refreshAgain = false;
	#flowState: "saturated" | "drained" | "closed" = "drained";
	#indexDirty = true;
	#indexVersions = new Map<NativeChatRuntime, number>();
	#deliveredSeq = new Map<string, number>();
	#ownerId?: string;
	#disposed = false;
	#onAbort = () => this.dispose();

	constructor(context: WebGuiServiceContext) {
		this.#context = context;
		this.#ownerId = context.projectId ? readBrowserProject(context.projectId)?.ownerId : undefined;
		this.#runtime = nativeChatRuntime(context);
		this.#receipts = nativeChatProjectRuntime(context);
		this.#changes = nativeChatChanges.event(() => this.#scheduleRefresh());
		this.#unsubscribeLifecycle = subscribeWebGuiNativeSessions(() => {
			this.#indexDirty = true;
			this.#scheduleRefresh();
		});
		context.signal.addEventListener("abort", this.#onAbort, { once: true });
		if (context.signal.aborted) this.dispose();
	}

	#assertOpen(): void {
		if (this.#disposed || this.#context.signal.aborted) throw new Error("ConnectionClosed");
	}

	target(value: unknown): ZCodeAgentWorkspaceTarget {
		this.#assertOpen();
		const target = workspaceTarget(value);
		const expected = this.#context.workspacePath;
		const requestedId = record(value).sessionId;
		const project = this.#context.projectId ? readBrowserProject(this.#context.projectId) : undefined;
		const residents = [...(project?.nativeSessions ?? [])].filter(
			session => !session.isDisposed && (typeof requestedId !== "string" || session.sessionId === requestedId),
		);
		if (
			!expected ||
			(normalizePathForComparison(target.workspacePath) !== normalizePathForComparison(expected) &&
				!residents.some(
					session =>
						normalizePathForComparison(session.sessionManager.getCwd()) ===
						normalizePathForComparison(target.workspacePath),
				))
		)
			throw new WebGuiNotImplementedError(
				"zcode-agent.workspace: workspace is not bound to this browser connection",
			);
		return target;
	}

	get clientId(): string | undefined {
		return this.#clientHello?.clientId;
	}

	runtime(value: unknown): NativeChatRuntime {
		this.target(value);
		return this.#runtime!;
	}

	#receiptRuntime(value: unknown): NativeChatRuntime {
		this.target(value);
		return this.#receipts;
	}

	async sessionRuntime(value: unknown, id?: string): Promise<NativeChatRuntime> {
		this.target(value);
		await this.#observeResidents();
		return this.#runtimeForId(id ?? nonempty(record(value).sessionId, "sessionId"));
	}

	async #runtimeForId(id: string): Promise<NativeChatRuntime> {
		return resolveNativeChatRuntime(this.#context, id);
	}

	async #observeResidents(): Promise<void> {
		if (!this.#context.projectId || this.#context.nativeSession?.isDisposed) return;
		try {
			assertWebGuiNativeAdmission();
		} catch {
			return;
		}
		const project = readBrowserProject(this.#context.projectId);
		if (!project || project.mode !== "webgui" || project.phase !== "active" || project.ownerId !== this.#ownerId)
			return;
		for (const session of await listWebGuiNativeSessions(this.#context)) {
			const runtime = nativeChatRuntimeForSession(session);
			if (!this.#residents.has(runtime)) this.#residents.set(runtime, runtime.retain());
		}
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
		await this.#observeResidents();
		const residents = new Map(
			listBrowserProjects().flatMap(project =>
				[...(project.nativeSessions ?? [])]
					.filter(session => !session.isDisposed)
					.map(session => [session.sessionId, session] as const),
			),
		);
		const summaries = sessions.map(info =>
			(residents.has(info.id) ? nativeChatRuntimeForSession(residents.get(info.id)!) : this.#runtime!).summary(
				info,
				subscription.index.workspaceId,
			),
		);
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
					sessions: summaries,
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
		const owner = this.#context.projectId ? readBrowserProject(this.#context.projectId) : undefined;
		if (
			owner &&
			owner.ownerId === this.#ownerId &&
			owner.mode === "webgui" &&
			owner.phase === "active" &&
			(!this.#context.nativeSession || owner.nativeSessions?.has(this.#context.nativeSession))
		)
			this.#deliveredSeq.set(subscription.id, snapshot.seq);
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
		const sessionId = nonempty(params.sessionId, "sessionId");
		const runtime = await this.sessionRuntime(value, sessionId);
		const snapshot = await runtime.snapshot(this.#context, sessionId, this.#clientHello?.clientId);
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
		const runtime = await this.sessionRuntime(value, subscription.sessionId);
		const snapshot = await runtime.snapshot(this.#context, subscription.sessionId, this.#clientHello?.clientId);
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
		await this.#observeResidents();
		const project = this.#context.projectId ? readBrowserProject(this.#context.projectId) : undefined;
		let controlsOnly =
			!!this.#context.nativeSession?.isDisposed ||
			(!!this.#context.projectId &&
				(!project || project.ownerId !== this.#ownerId || project.mode !== "webgui" || project.phase !== "active"));
		try {
			assertWebGuiNativeAdmission();
		} catch {
			controlsOnly = true;
		}
		for (const subscription of this.#conversations.values()) {
			if (controlsOnly) continue;
			const runtime = await this.#runtimeForId(subscription.sessionId);
			if (runtime.state(subscription.sessionId).seq <= subscription.snapshot.seq) continue;
			try {
				this.#publishConversation(
					subscription,
					await runtime.snapshot(this.#context, subscription.sessionId, this.#clientHello?.clientId),
					"online",
				);
			} catch (error) {
				if (this.#disposed || this.#context.signal.aborted) return;
				const state = runtime.state(subscription.sessionId);
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
		if (controlsOnly) return;
		for (const runtime of this.#residents.keys()) {
			if (this.#indexVersions.get(runtime) === runtime.indexVersion) continue;
			this.#indexVersions.set(runtime, runtime.indexVersion);
			this.#indexDirty = true;
		}
		if (this.#indexDirty) {
			this.#indexDirty = false;
			for (const subscription of this.#subscriptions.values()) await this.#indexFrame(subscription, "online");
		}
	}

	command(value: unknown): Promise<CommandAck> {
		const envelope = commandEnvelopeSchema.parse(record(value).envelope);
		const runtime = this.#receiptRuntime(value);
		const key = JSON.stringify([envelope.sessionId, envelope.commandId]);
		const existing = runtime.commands.get(key);
		if (existing) return Promise.resolve(existing);
		const pending = runtime.commandAdmissions.get(key);
		if (pending) return pending;
		const operation = this.#executeCommand(value);
		runtime.commandAdmissions.set(key, operation);
		void operation.then(
			() => runtime.commandAdmissions.delete(key),
			() => runtime.commandAdmissions.delete(key),
		);
		return operation;
	}

	async #executeCommand(value: unknown): Promise<CommandAck> {
		const envelope = commandEnvelopeSchema.parse(record(value).envelope);
		const receiptRuntime = this.#receiptRuntime(value);
		const key = JSON.stringify([envelope.sessionId, envelope.commandId]);
		const existing = receiptRuntime.commands.get(key);
		if (existing) return existing;
		let runtime = receiptRuntime;
		let id = envelope.sessionId;
		let ack: CommandAck;
		try {
			if (this.#clientHello && envelope.clientId !== this.#clientHello.clientId)
				throw new Error("The command client identity does not match this browser connection.");
			let result: CommandAck["result"];
			if (envelope.type === "createSession") {
				if (id !== null) throw new Error("createSession requires a null envelope sessionId.");
				const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
				if (payload.sessionId || payload.additionalDirectories?.length || payload.mcpServers?.length)
					throw new Error("Native session identity and tool configuration are owned by the native project.");
				const session = await createWebGuiNativeSession(this.#context, this.target(value).workspacePath);
				id = session.sessionId;
				runtime = nativeChatRuntimeForSession(session);
				await this.#observeResidents();
				if (payload.config?.followupMode) runtime.setFollowupMode(payload.config.followupMode);
				const selection = payload.firstInput?.modelSelection ?? payload.config?.modelSelection;
				if (selection) {
					const model = session
						.getAvailableModels()
						.find(candidate => candidate.provider === selection.providerId && candidate.id === selection.modelId);
					if (!model) throw new Error("The requested native model is unavailable or unauthenticated.");
					assertNativeChat(runtime.context(this.#context));
					const project = this.#context.projectId ? readBrowserProject(this.#context.projectId) : undefined;
					const operation = runWebGuiSession(session, () => session.setModelTemporary(model));
					project?.pendingModelSelections?.add(operation);
					try {
						await operation;
					} finally {
						project?.pendingModelSelections?.delete(operation);
					}
				}
				if (payload.config)
					this.#assertSubmission(runtime, {
						mode: payload.config.mode,
						planEnabled: payload.config.planEnabled,
						modelSelection: payload.config.modelSelection,
					});
				if (payload.config?.thought !== undefined && payload.config.thought !== (session.thinkingLevel ?? "off"))
					throw new Error(
						"The requested thinking level differs from the native session; refresh the thinking selection.",
					);
				if (
					(payload.config?.provider !== undefined && payload.config.provider !== session.model?.provider) ||
					(payload.config?.model !== undefined && payload.config.model !== session.model?.id)
				)
					throw new Error("Use the native model selection identity for session creation.");
				runtime.notify();
				let input: { delivery: "startNow" | "queue" | "guide"; inputId: string } | undefined;
				if (payload.firstInput) {
					this.#assertSubmission(runtime, payload.firstInput);
					const delivery = await runtime.submit(
						this.#context,
						id,
						payload.firstInput.text,
						envelope.commandId,
						envelope.clientId,
						envelope.commandId,
					);
					input = { delivery, inputId: envelope.commandId };
				}
				result = { type: "createSession", sessionId: id, ...(input ? { input } : {}) };
			} else {
				id = nonempty(id, "sessionId");
				const session = await resolveWebGuiSession(this.#context, id);
				runtime = nativeChatRuntimeForSession(session);
				await this.#observeResidents();
				if (envelope.type !== "resolveInteraction") assertNativeChat(runtime.context(this.#context));
				switch (envelope.type) {
					case "sendText": {
						const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
						this.#assertSubmission(runtime, payload);
						const delivery = await runtime.submit(
							this.#context,
							id,
							payload.text,
							envelope.commandId,
							envelope.clientId,
							envelope.commandId,
							{
								requestedDelivery: payload.requestedDelivery,
								heldQueueDisposition: payload.heldQueueDisposition,
								expectedHeldQueueItemIds: payload.expectedHeldQueueItemIds,
							},
						);
						result = { type: "inputAccepted", delivery, inputId: envelope.commandId };
						break;
					}
					case "stop": {
						const payload = commandPayloadSchemas.stop.parse(envelope.payload);
						await runtime.stop(this.#context, payload.expectedForegroundExecutionId);
						break;
					}
					case "resolveInteraction": {
						const payload = commandPayloadSchemas.resolveInteraction.parse(envelope.payload);
						await runWebGuiSession(session, () =>
							nativeWebGuiQuestions(session).resolveInteraction(payload.interactionId, payload.answer, {
								connectionId: this.#context.connectionId,
								clientId: envelope.clientId,
							}),
						);
						result = {
							type: "resolveInteraction",
							resolvedBy: {
								clientId: envelope.clientId,
								optionId: payload.answer.optionId,
							},
						};
						break;
					}
					case "setFollowupMode":
						runtime.setFollowupMode(commandPayloadSchemas.setFollowupMode.parse(envelope.payload).mode);
						break;
					case "setAutoDrain": {
						const payload = commandPayloadSchemas.setAutoDrain.parse(envelope.payload);
						// Resuming an idle queue schedules native work; retain this root's registry.
						runWebGuiSession(session, () => session.setQueueAutoDrain(payload.autoDrain));
						break;
					}
					case "editQueueItem": {
						const payload = commandPayloadSchemas.editQueueItem.parse(envelope.payload);
						await runtime.editQueued(this.#context, payload.queueItemId, payload.newText);
						break;
					}
					case "deleteQueueItem": {
						const payload = commandPayloadSchemas.deleteQueueItem.parse(envelope.payload);
						if (!session.mutateQueuedInput(payload.queueItemId, "delete"))
							throw new Error("The queued input is no longer pending.");
						break;
					}
					case "reorderQueueItem": {
						const payload = commandPayloadSchemas.reorderQueueItem.parse(envelope.payload);
						if (
							!session.mutateQueuedInput(payload.queueItemId, "reorder", {
								beforeInputId: payload.beforeQueueItemId,
							})
						)
							throw new Error("The queued input is no longer pending.");
						break;
					}
					case "sendQueuedNow": {
						const payload = commandPayloadSchemas.sendQueuedNow.parse(envelope.payload);
						this.#assertSubmission(runtime, payload);
						await runtime.sendQueuedNow(this.#context, payload.queueItemId, envelope.clientId);
						break;
					}
					case "editUserQuery": {
						const payload = commandPayloadSchemas.editUserQuery.parse(envelope.payload);
						if (payload.workspaceMode === "rewind") throw new Error("Native editing preserves workspace files.");
						this.#assertSubmission(runtime, payload);
						const branchId = await runtime.edit(
							this.#context,
							payload.target,
							payload.newText,
							envelope.commandId,
							envelope.clientId,
						);
						result = { type: "editUserQuery", disposition: "fork", sessionId: branchId };
						break;
					}
					case "retryTurn":
						await runtime.retry(
							this.#context,
							commandPayloadSchemas.retryTurn.parse(envelope.payload).target,
							envelope.clientId,
						);
						break;
					default:
						throw new WebGuiNotImplementedError(`zcode-agent.command.${envelope.type}`);
				}
				runtime.notify();
			}
			ack = {
				commandId: envelope.commandId,
				status: "accepted",
				revisionAtDecision: runtime.state(id ?? "").seq,
				...(result ? { result } : {}),
			};
		} catch (error) {
			ack = {
				commandId: envelope.commandId,
				status: "rejected",
				reasonCode: "guard.nativeChatUnavailable",
				message: error instanceof Error ? error.message : String(error),
				revisionAtDecision: runtime.state(id ?? "").seq,
			};
		}
		receiptRuntime.commands.set(key, ack);
		this.#indexDirty = true;
		this.#scheduleRefresh();
		return ack;
	}

	#assertSubmission(
		runtime: NativeChatRuntime,
		payload: {
			modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
			mode?: string;
			planEnabled?: boolean;
			modelExecution?: unknown;
		},
	): void {
		const planning = runtime.session.getPlanModeState()?.enabled === true;
		if (
			(payload.mode !== undefined && payload.mode !== (planning ? "plan" : "build")) ||
			(payload.planEnabled !== undefined && payload.planEnabled !== planning) ||
			payload.modelExecution
		)
			throw new Error("The submitted execution mode differs from the native session.");
		const model = payload.modelSelection;
		if (
			model &&
			(model.providerId !== runtime.session.model?.provider ||
				model.modelId !== runtime.session.model?.id ||
				(model.options?.reasoningLevel !== undefined &&
					model.options.reasoningLevel !== (runtime.session.thinkingLevel ?? "off")))
		)
			throw new Error("The submitted model selection is stale; refresh the selected native session.");
	}

	queryCommands(value: unknown): unknown {
		this.target(value);
		const runtime = this.#receipts;
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
		this.#unsubscribeLifecycle?.();
		for (const [runtime, release] of this.#residents) {
			if (runtime.boundSession)
				nativeWebGuiQuestions(runtime.boundSession).cancelConnectionActions(this.#context.connectionId);
			release();
		}
		this.#residents.clear();
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
	const initialize = (value: unknown): ZCodeAgentInitializeResult => {
		const target = attachment.target(value);
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
	const reads: Record<string, WebGuiMethod> = {
		createSession: async value => {
			const target = attachment.target(value);
			const session = await createWebGuiNativeSession(context, target.workspacePath);
			const runtime = await attachment.sessionRuntime(value, session.sessionId);
			runtime.notify();
			return legacySnapshot(runtime.context(context), session.sessionId);
		},
		getWorkspaceRuntimeIdentity: value => {
			const runtime = attachment.runtime(value);
			return {
				generation: runtime.hasSession ? runtime.session.sessionGeneration : 0,
				identity: `${process.pid}:${context.projectId}`,
				processId: process.pid,
				workspaceKey: workspaceKey(attachment.target(value)),
			};
		},
		readWorkspacePresentation: async value => {
			attachment.runtime(value);
			const target = attachment.target(value);
			const id = record(value).sessionId;
			const sessions = await listWebGuiNativeSessions(context);
			const session = typeof id === "string" ? sessions.find(candidate => candidate.sessionId === id) : sessions[0];
			return {
				workspace: { ...target, workspaceKey: workspaceKey(target) },
				mode: session?.getPlanModeState()?.enabled ? "plan" : "build",
			};
		},
		listSessions: async value => {
			attachment.runtime(value);
			return Promise.all(
				(await listNativeHistory(context)).map(async info =>
					legacySessionInfo((await resolveNativeChatRuntime(context, info.id)).context(context), info),
				),
			);
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
			const session = await runtime.resume(context, id);
			const project = webGuiSessionProject(session);
			if (!project) throw new Error("The resumed native project is unavailable.");
			const rebound = {
				...context,
				projectId: project.projectId,
				workspacePath: project.root,
				nativeSession: session,
			};
			return {
				...(await legacySnapshot(rebound, id)),
				projectId: project.projectId,
				workspacePath: project.root,
				projectUrl: project.url,
			};
		},
	};
	const agentService = createWebGuiService(
		"zcode-agent",
		{
			...reads,
			prepareStorage: async value => {
				attachment.runtime(value);
				await listNativeHistory(context);
			},
			getSessionLifecycle: async value => {
				const id = sessionId(value);
				const runtime = await attachment.sessionRuntime(value, id);
				await runtime.info(context, id);
				const child = await runtime.child(context, id);
				return {
					sessionId: id,
					state: (runtime.hasSession && runtime.session.sessionId === id) || child?.session ? "ready" : "unloaded",
					generation: child?.generation ?? (runtime.hasSession ? runtime.session.sessionGeneration : 0),
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
				const runtime = await attachment.sessionRuntime(value);
				const params = record(value);
				const payload = commandPayloadSchemas.sendText.parse({ ...params, text: params.content });
				const id = sessionId(value);
				await runtime.submit(
					context,
					id,
					payload.text,
					typeof params.inputId === "string" ? params.inputId : crypto.randomUUID(),
					attachment.clientId,
					undefined,
					{
						requestedDelivery: payload.requestedDelivery,
						heldQueueDisposition: payload.heldQueueDisposition,
						expectedHeldQueueItemIds: payload.expectedHeldQueueItemIds,
					},
				);
				return { sessionId: id, accepted: true, stateRevision: runtime.state(id).seq };
			},
			subscribeConversationV4: value => attachment.subscribeConversation(value),
			resyncConversationV4: value => attachment.resyncConversation(value),
			unsubscribeConversationV4: value => attachment.unsubscribeConversation(value),
			conversationRowsRangeV4: async value => {
				const runtime = await attachment.sessionRuntime(value);
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
					(!runtime.hasSession || sessionId(value) !== runtime.session.sessionId) &&
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
			dynamicEvents: {
				onDynamicSessionsIndexFrame: value => attachment.frames(value),
				onDynamicConversationFrame: value => attachment.conversationFrames(value),
				// Native journal storage has no ZCode database migration attempt.
				onDynamicStorageStartupState: value => attachment.storageEvents(value),
			},
			dispose: () => {
				attachment.dispose();
			},
		},
	);
	return [
		agentService,
		createWebGuiService("zcode-session", {
			...reads,
			initializeWorkspace: initialize,
		}),
	];
}
