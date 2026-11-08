import { Emitter, type Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import type { ZCodeAgentStorageStartupSnapshot } from "../../../../vendor/zcode-frontend/packages/services/src/zcode-agent/zcodeAgent";
import type { ZCodeAgentWorkspaceTarget } from "../../../../vendor/zcode-frontend/packages/services/src/zcode-agent/zcodeAgentPluginParams";
import { V4_WIRE_PROTOCOL_VERSION } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/core";
import { sessionsIndexTopic } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/sessions-index";
import {
	clientHelloSchema,
	conversationResyncParamsSchema,
	type ClientHello,
	type HelloMessage,
	type SessionsIndexTopicWireFrame,
	type V4ConversationResyncResult,
	type V4SessionsIndexSubscribeResult,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/transport";
import {
	WebGuiNotImplementedError,
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

/** Only sessions attached to this browser protocol connection; never a native history listing. */
class BrowserAgentAttachment {
	#context: WebGuiServiceContext;
	#clientHello: ClientHello | undefined;
	#indexes = new Map<string, AttachmentIndex>();
	#subscriptions = new Map<string, IndexSubscription>();
	#timers = new Set<NodeJS.Timeout>();
	#storage: ZCodeAgentStorageStartupSnapshot = { generation: 0, state: null };
	#storageEvents = new Emitter<ZCodeAgentStorageStartupSnapshot>();
	#disposed = false;
	#onAbort = () => this.dispose();

	constructor(context: WebGuiServiceContext) {
		this.#context = context;
		context.signal.addEventListener("abort", this.#onAbort, { once: true });
		if (context.signal.aborted) this.dispose();
	}

	#assertOpen(): void {
		if (this.#disposed || this.#context.signal.aborted) throw new Error("ConnectionClosed");
	}

	storageState(value: unknown): ZCodeAgentStorageStartupSnapshot {
		this.#assertOpen();
		workspaceTarget(value);
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
		if (this.#clientHello && JSON.stringify(this.#clientHello) !== JSON.stringify(hello)) {
			throw new Error("fault.connection.alreadyInitialized");
		}
		this.#clientHello = hello;
	}

	#assertInitialized(): void {
		this.#assertOpen();
		if (!this.#clientHello) throw new Error("fault.connection.handshakeRequired");
	}

	#target(value: unknown): ZCodeAgentWorkspaceTarget {
		this.#assertOpen();
		const target = workspaceTarget(value);
		if (!this.#context.workspacePath || target.workspacePath !== this.#context.workspacePath) {
			throw new WebGuiNotImplementedError(
				"zcode-agent.workspace: workspace is not bound to this browser connection",
			);
		}
		return target;
	}

	#index(value: unknown): AttachmentIndex {
		const target = this.#target(value);
		const key = workspaceKey(target);
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

	#base(value: unknown): { logEpoch: string; seq: number } | undefined {
		if (value === undefined) return undefined;
		return conversationResyncParamsSchema.parse({ subscriptionId: "base", base: value }).base ?? undefined;
	}

	#mode(index: AttachmentIndex, base: { logEpoch: string; seq: number } | null | undefined): "snapshot" | "resume" {
		if (base?.logEpoch !== index.epoch) return "snapshot";
		// This connection has not attached any conversations, so its authoritative sequence is zero.
		if (base.seq !== 0) throw new Error("fault.subscription.invalidWatermark");
		return "resume";
	}

	#publish(subscription: IndexSubscription, mode: "snapshot" | "resume", deliveryKind: "initial" | "recovery"): void {
		// The RPC response is sent in the current microtask chain; notifications follow in the next task.
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
			const topic = sessionsIndexTopic(subscription.index.workspaceId);
			const frame: SessionsIndexTopicWireFrame = {
				wireVersion: V4_WIRE_PROTOCOL_VERSION,
				kind: "complete",
				deliveryKind,
				logicalFrameId: crypto.randomUUID(),
				logicalFrameOrdinal: ++subscription.ordinal,
				topic,
				subscriptionId: subscription.id,
				frame: {
					topic,
					subscriptionId: subscription.id,
					fromSeq: 0,
					toSeq: 0,
					sentAt: Date.now(),
					payload:
						mode === "resume"
							? { kind: "deltas", deltas: [] }
							: {
									kind: "snapshot",
									snapshot: {
										protocolVersion: 1,
										workspaceId: subscription.index.workspaceId,
										logEpoch: subscription.index.epoch,
										sessions: [],
									},
								},
				},
			};
			subscription.index.frames.fire(frame);
		}, 0);
		this.#timers.add(timer);
	}

	subscribe(value: unknown): V4SessionsIndexSubscribeResult {
		this.#assertInitialized();
		const params = record(value);
		const index = this.#index(value);
		const base = this.#base(params.base);
		const policy = runtimePolicy(params.runtimePolicy);
		if (params.visibility !== undefined && params.visibility !== "foreground" && params.visibility !== "background") {
			throw new TypeError("Invalid visibility");
		}
		const scope = params.subscriberScope === undefined ? "" : nonempty(params.subscriberScope, "subscriberScope");
		const mode = this.#mode(index, base);
		for (const subscription of this.#subscriptions.values()) {
			if (subscription.index === index && subscription.scope === scope) this.#subscriptions.delete(subscription.id);
		}
		const subscription: IndexSubscription = {
			index,
			id: crypto.randomUUID(),
			scope,
			runtimePolicy: policy,
			ordinal: 0,
		};
		this.#subscriptions.set(subscription.id, subscription);
		this.#publish(subscription, mode, "initial");
		return { ack: { subscriptionId: subscription.id, logEpoch: index.epoch, mode } };
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
		) {
			throw new Error("fault.subscription.notOwned");
		}
		return subscription;
	}

	resync(value: unknown): V4ConversationResyncResult {
		const subscription = this.#owned(value);
		const input = record(value);
		const params = conversationResyncParamsSchema.parse({
			subscriptionId: input.subscriptionId,
			base: input.base,
			...(input.forceSnapshot === undefined ? {} : { forceSnapshot: input.forceSnapshot }),
		});
		const baseMode = this.#mode(subscription.index, params.base);
		const mode = params.forceSnapshot ? "snapshot" : baseMode;
		this.#publish(subscription, mode, "recovery");
		return { ack: { subscriptionId: subscription.id, logEpoch: subscription.index.epoch, mode } };
	}

	unsubscribe(value: unknown): void {
		const subscription = this.#owned(value);
		this.#subscriptions.delete(subscription.id);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#context.signal.removeEventListener("abort", this.#onAbort);
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#subscriptions.clear();
		for (const index of this.#indexes.values()) index.frames.dispose();
		this.#indexes.clear();
		this.#storageEvents.dispose();
		this.#clientHello = undefined;
	}
}

export function createAgentServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	const attachment = new BrowserAgentAttachment(context);
	return [
		createWebGuiService(
			"zcode-agent",
			{
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
					// No storage preparation has occurred; null is the declared unattempted startup state, not a database result.
					onDynamicStorageStartupState: value => attachment.storageEvents(value),
				},
				dispose: () => attachment.dispose(),
			},
		),
	];
}
