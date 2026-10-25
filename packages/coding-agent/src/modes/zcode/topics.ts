import { randomUUID } from "node:crypto";
import {
	encodeTopicWireFrames,
	measureTopicNotificationEnvelopeBytes,
	routedTopicFrameSchema,
	routedTopicWireFrameSchema,
	type ConversationDelta,
	type ConversationSnapshot,
	type ConversationRow,
	type SessionsIndexDelta,
	type SessionsIndexSnapshot,
	type WorkspaceConfigDelta,
	type WorkspaceConfigSnapshot,
	type RoutedTopicFrame,
	type RoutedTopicWireFrame,
	type SubscribeAck,
	DELIVERY_PROFILES,
	conversationTopicFrameSchema,
	filterConversationDeltasForProfile,
	filterConversationRowsForProfile,
	PROTOCOL_V4_LIMITS,
	utf8JsonByteLength,
} from "./schema";
import { conversationTopicFrameSchema as baselineConversationTopicFrameSchema } from "./schema/vendor/zcode-protocol-v4/index";

export type TopicDelta = ConversationDelta | SessionsIndexDelta | WorkspaceConfigDelta;
export type TopicSnapshot = ConversationSnapshot | SessionsIndexSnapshot | WorkspaceConfigSnapshot;
export interface ZCodeTopicSource<D extends TopicDelta = TopicDelta> {
	snapshot(): TopicSnapshot;
	logEpoch?(): string;
	subscribe?(listener: (deltas: D[]) => void): () => void;
}
interface TopicState {
	source: Pick<ZCodeTopicSource, "snapshot" | "logEpoch">;
	epoch: string;
	seq: number;
	history: { from: number; to: number; deltas: TopicDelta[] }[];
	dispose?: () => void;
	released?: true;
	specRunIds: Set<string>;
}
interface Subscription {
	id: string;
	topic: string;
	connectionId: string;
	profile: "continuous" | "replayable";
	includeSpecDriven: boolean;
	emit: (frame: RoutedTopicWireFrame) => void;
	ordinal: number;
	paused: boolean;
	pending: { frame: RoutedTopicFrame; kind: "initial" | "online" | "recovery" }[];
	recoveryKind: "initial" | "recovery";
	saturated: boolean;
	pendingBytes: number;
	needsSnapshot: boolean;
}

/** Adapter-owned topic sequence space, never an OMP journal cursor. */
export class ZCodeTopics {
	readonly #topics = new Map<string, TopicState>();
	readonly #subscriptions = new Map<string, Subscription>();
	readonly #replayLimit: number;
	constructor(options: { replayLimit?: number } = {}) {
		this.#replayLimit = options.replayLimit ?? 512;
	}

	register<D extends TopicDelta>(topic: string, source: ZCodeTopicSource<D>): void {
		this.#topics.get(topic)?.dispose?.();
		const snapshot = source.snapshot();
		const state: TopicState = {
			source,
			epoch: snapshot.logEpoch,
			seq: "seq" in snapshot ? snapshot.seq : 0,
			history: [],
			specRunIds: new Set(
				"workflowRuns" in snapshot ? snapshot.workflowRuns?.runs.filter(run => run.spec).map(run => run.runId) : [],
			),
		};
		this.#topics.set(topic, state);
		state.dispose = source.subscribe?.(deltas => this.publish(topic, deltas));
		for (const sub of this.#subscriptions.values())
			if (sub.topic === topic) {
				sub.pending = [];
				sub.pendingBytes = 0;
				sub.needsSnapshot = false;
				sub.recoveryKind = "recovery";
				this.#snapshot(sub, state);
			}
	}

	publish(topic: string, deltas: TopicDelta[]): void {
		const state = this.#requireTopic(topic);
		if (!deltas.length) return;
		const epoch = state.source.logEpoch?.() ?? state.source.snapshot().logEpoch;
		if (epoch !== state.epoch) {
			const snapshot = state.source.snapshot();
			state.epoch = snapshot.logEpoch;
			state.seq = "seq" in snapshot ? snapshot.seq : 0;
			state.history = [];
			state.specRunIds = new Set(
				"workflowRuns" in snapshot ? snapshot.workflowRuns?.runs.filter(run => run.spec).map(run => run.runId) : [],
			);
			for (const sub of this.#subscriptions.values())
				if (sub.topic === topic) {
					sub.pending = [];
					sub.pendingBytes = 0;
					sub.needsSnapshot = false;
					if (sub.ordinal > 0) sub.recoveryKind = "recovery";
					this.#snapshot(sub, state);
				}
			return;
		}
		for (const delta of deltas) {
			if (delta.op === "workflowRun.updated" && delta.run?.spec) state.specRunIds.add(delta.runId);
			if (delta.op === "state.updated")
				for (const run of delta.patch.workflowRuns?.runs ?? []) if (run.spec) state.specRunIds.add(run.runId);
		}
		const from = state.seq;
		state.seq += 1;
		const entry = { from, to: state.seq, deltas: structuredClone(deltas) };
		state.history.push(entry);
		if (state.history.length > this.#replayLimit) state.history.shift();
		for (const sub of this.#subscriptions.values())
			if (sub.topic === topic)
				this.#deliver(sub, {
					topic,
					subscriptionId: sub.id,
					fromSeq: from,
					toSeq: state.seq,
					sentAt: Date.now(),
					payload: { kind: "deltas", deltas: entry.deltas },
				});
	}

	subscribe(
		params: {
			topic: string;
			connectionId: string;
			clientMode: "desktop-continuous" | "web-remote-replayable";
			base?: { logEpoch: string; seq: number };
			includeSpecDriven?: true;
		},
		emit: (frame: RoutedTopicWireFrame) => void,
	): { ack: SubscribeAck; flush: () => void } {
		const state = this.#requireTopic(params.topic);
		// Replacement is scoped to the trusted attachment and topic, not the process.
		for (const sub of this.#subscriptions.values())
			if (sub.connectionId === params.connectionId && sub.topic === params.topic) this.cancel(sub.id);
		const sub: Subscription = {
			id: randomUUID(),
			topic: params.topic,
			connectionId: params.connectionId,
			profile: params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
			includeSpecDriven: params.includeSpecDriven === true,
			emit,
			ordinal: 0,
			paused: true,
			pending: [],
			recoveryKind: "initial",
			saturated: false,
			pendingBytes: 0,
			needsSnapshot: false,
		};
		this.#subscriptions.set(sub.id, sub);
		return this.#recover(sub, state, params.base);
	}

	recover(params: {
		subscriptionId: string;
		base?: { logEpoch: string; seq: number } | null;
		forceSnapshot?: boolean;
	}): { ack: SubscribeAck; flush: () => void } {
		const sub = this.#subscriptions.get(params.subscriptionId);
		if (!sub) throw new Error("Unknown subscription");
		sub.paused = true;
		sub.pending = [];
		sub.pendingBytes = 0;
		sub.needsSnapshot = false;
		sub.recoveryKind = "recovery";
		return this.#recover(
			sub,
			this.#requireTopic(sub.topic),
			params.forceSnapshot ? undefined : (params.base ?? undefined),
		);
	}

	setConnectionFlow(connectionId: string, state: "saturated" | "drained"): void {
		for (const sub of this.#subscriptions.values())
			if (sub.connectionId === connectionId) {
				sub.saturated = state === "saturated";
				if (sub.saturated && sub.ordinal > 0) sub.recoveryKind = "recovery";
				if (!sub.saturated && !sub.paused) this.#flushPending(sub);
			}
	}

	hasSubscribers(topic: string): boolean {
		return Array.from(this.#subscriptions.values()).some(sub => sub.topic === topic);
	}
	/** Drop owner references while preserving recovery for viewers of a closed owner. */
	releaseSource(topic: string): void {
		const state = this.#topics.get(topic);
		if (!state) return;
		state.dispose?.();
		state.dispose = undefined;
		if (!this.hasSubscribers(topic)) {
			this.#topics.delete(topic);
			return;
		}
		const snapshot = state.source.snapshot();
		state.source = { snapshot: () => structuredClone(snapshot), logEpoch: () => snapshot.logEpoch };
		state.released = true;
	}
	cancel(subscriptionId: string): void {
		const sub = this.#subscriptions.get(subscriptionId);
		this.#subscriptions.delete(subscriptionId);
		if (sub && this.#topics.get(sub.topic)?.released && !this.hasSubscribers(sub.topic))
			this.#topics.delete(sub.topic);
	}
	closeConnection(connectionId: string): void {
		for (const sub of this.#subscriptions.values()) if (sub.connectionId === connectionId) this.cancel(sub.id);
	}
	dispose(): void {
		this.#subscriptions.clear();
		for (const state of this.#topics.values()) state.dispose?.();
		this.#topics.clear();
	}

	#requireTopic(topic: string): TopicState {
		const state = this.#topics.get(topic);
		if (!state) throw new Error(`Unknown existing topic: ${topic}`);
		return state;
	}
	#recover(
		sub: Subscription,
		state: TopicState,
		base?: { logEpoch: string; seq: number },
	): { ack: SubscribeAck; flush: () => void } {
		const resume =
			base !== undefined &&
			base.logEpoch === state.epoch &&
			Number.isInteger(base.seq) &&
			base.seq >= 0 &&
			base.seq <= state.seq &&
			(base.seq === state.seq || base.seq >= (state.history[0]?.from ?? state.seq));
		if (resume) {
			for (const entry of state.history)
				if (entry.to > base.seq)
					this.#deliver(
						sub,
						{
							topic: sub.topic,
							subscriptionId: sub.id,
							fromSeq: entry.from,
							toSeq: entry.to,
							sentAt: Date.now(),
							payload: { kind: "deltas", deltas: entry.deltas },
						},
						sub.recoveryKind,
					);
		} else this.#snapshot(sub, state);
		return {
			ack: { subscriptionId: sub.id, mode: resume ? "resume" : "snapshot", logEpoch: state.epoch },
			flush: () => {
				if (this.#subscriptions.get(sub.id) !== sub) return;
				sub.paused = false;
				if (!sub.saturated) this.#flushPending(sub);
			},
		};
	}
	#flushPending(sub: Subscription): void {
		sub.pendingBytes = 0;
		if (sub.needsSnapshot) {
			sub.needsSnapshot = false;
			sub.pending = [];
			this.#snapshot(sub, this.#requireTopic(sub.topic));
			return;
		}
		for (const pending of sub.pending.splice(0)) this.#deliver(sub, pending.frame, pending.kind);
	}
	#snapshot(sub: Subscription, state: TopicState): void {
		const snapshot = state.source.snapshot();
		if ("seq" in snapshot) snapshot.seq = state.seq;
		this.#deliver(
			sub,
			{
				topic: sub.topic,
				subscriptionId: sub.id,
				fromSeq: 0,
				toSeq: state.seq,
				sentAt: Date.now(),
				payload: { kind: "snapshot", snapshot },
			},
			sub.recoveryKind,
		);
	}
	#deliver(sub: Subscription, candidate: unknown, kind: "initial" | "online" | "recovery" = "online"): void {
		let frame = routedTopicFrameSchema.parse(candidate);
		if (sub.topic.startsWith("conversation/") && !sub.includeSpecDriven) {
			const conversation = conversationTopicFrameSchema.parse(frame);
			const nativeIds = this.#requireTopic(sub.topic).specRunIds;
			if (conversation.payload.kind === "snapshot") {
				delete conversation.payload.snapshot.dev;
				const runs = conversation.payload.snapshot.workflowRuns;
				if (runs) runs.runs = runs.runs.filter(run => !run.spec);
			} else {
				conversation.payload.deltas = conversation.payload.deltas.filter(delta => {
					if (delta.op === "state.updated") {
						delete delta.patch.dev;
						const runs = delta.patch.workflowRuns;
						if (runs) runs.runs = runs.runs.filter(run => !run.spec);
					}
					if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed")
						return !nativeIds.has(delta.runId);
					return true;
				});
			}
			// Strip every local namespace before the pinned client's validation/encoding.
			frame = baselineConversationTopicFrameSchema.parse(conversation);
		}
		if (sub.paused || sub.saturated) {
			if (sub.needsSnapshot) return;
			const bytes = utf8JsonByteLength(frame);
			if (
				sub.pending.length >= PROTOCOL_V4_LIMITS.subscriberBufferMaxOps ||
				sub.pendingBytes + bytes > PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes
			) {
				sub.pending = [];
				sub.pendingBytes = 0;
				sub.needsSnapshot = true;
			} else {
				sub.pending.push({ frame, kind });
				sub.pendingBytes += bytes;
			}
			return;
		}
		if (!this.#subscriptions.has(sub.id)) return;
		if (sub.topic.startsWith("conversation/")) {
			const conversation = conversationTopicFrameSchema.parse(frame);
			if (conversation.payload.kind === "deltas") {
				conversation.payload.deltas = filterConversationDeltasForProfile(
					conversation.payload.deltas,
					DELIVERY_PROFILES[sub.profile],
				);
				for (const delta of conversation.payload.deltas)
					if (delta.op === "row.appended" || delta.op === "row.upserted") this.#profileRow(delta.row, sub.profile);
			} else {
				conversation.payload.snapshot.rows.window = filterConversationRowsForProfile(
					conversation.payload.snapshot.rows.window,
					DELIVERY_PROFILES[sub.profile],
				);
				for (const row of conversation.payload.snapshot.rows.window) this.#profileRow(row, sub.profile);
			}
			Object.assign(frame, conversation);
		}
		const wires = encodeTopicWireFrames(frame, {
			deliveryKind: kind,
			topic: sub.topic,
			subscriptionId: sub.id,
			logicalFrameId: randomUUID(),
			logicalFrameOrdinal: ++sub.ordinal,
			measurePhysicalFrameBytes: wire => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
		});
		for (const wire of wires) sub.emit(routedTopicWireFrameSchema.parse(wire));
	}
	#profileRow(row: ConversationRow, profile: "continuous" | "replayable"): void {
		if (row.kind !== "toolCall" || !["running", "inputStreaming", "pendingApproval"].includes(row.status)) return;
		if (profile === "replayable") {
			delete row.output;
			delete row.outputPreview;
		} else if (row.output) {
			const bytes = Buffer.from(row.output.text, "utf8");
			if (bytes.byteLength > DELIVERY_PROFILES.continuous.streamOutputCapBytes) {
				row.output.text = bytes.subarray(-DELIVERY_PROFILES.continuous.streamOutputCapBytes).toString("utf8");
			}
		}
	}
}
