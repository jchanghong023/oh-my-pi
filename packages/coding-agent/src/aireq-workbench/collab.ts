import { randomBytes } from "node:crypto";
import type { GuestFrame, HostFrame, SubmitResult } from "@oh-my-pi/pi-wire";
import type { Settings } from "../config/settings";
import { CollabController } from "../collab/controller";
import { importRoomKey } from "../collab/crypto";
import { CollabHost, type CollabHostPort } from "../collab/host";
import {
	intranetCollabEnabled,
	intranetRelayUrl,
	isIntranetUsername,
	resolveIntranetUsername,
} from "../collab/intranet";
import { COLLAB_PROTO, parseCollabLink } from "../collab/protocol";
import { CollabSocket } from "../collab/relay-client";
import { cfgCollabRelayUrl } from "../collab/settings";

export interface AIReqCollabParticipant {
	peerId: string;
	roomId: string;
	generation: number;
	sessionId: string;
	name: string;
	canWrite: boolean;
}

export type AIReqCollabTarget = Pick<AIReqCollabParticipant, "peerId" | "roomId" | "sessionId" | "generation">;
export type AIReqCollabSubmitResult = Exclude<SubmitResult, { kind: "sent" }>;

export function sameAIReqCollabTarget(left: AIReqCollabTarget, right: AIReqCollabTarget): boolean {
	return (
		left.peerId === right.peerId &&
		left.roomId === right.roomId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation
	);
}

export interface AIReqCollabBridgeOptions {
	settings: Settings;
	onFrame(browserId: string, frame: HostFrame, participant: AIReqCollabParticipant): void;
	onDisconnected?(browserId: string, reason: string, participant: AIReqCollabParticipant): void;
	onJoined?(browserId: string, participant: AIReqCollabParticipant): void;
	onConnecting?(browserId: string, participant: AIReqCollabParticipant): void;
}

interface BrowserPeer {
	identity: AIReqCollabParticipant;
	socket: CollabSocket | null;
	joined: boolean;
	ended: boolean;
	roomEnded: boolean;
	welcomed: boolean;
	expectedEntries: number;
	receivedEntries: number;
	pendingUi: Set<number>;
	pendingTranscripts: Set<number>;
	timer: Timer | undefined;
	cancel(): void;
}

/** Native-only guest transport. It never adopts a replica session or owns the host runtime. */
export class AIReqCollabBridge {
	readonly #options: AIReqCollabBridgeOptions;
	readonly #peers = new Map<string, BrowserPeer>();
	#generation = 0;
	#closed = false;

	constructor(options: AIReqCollabBridgeOptions) {
		this.#options = options;
	}

	getParticipant(browserId: string): AIReqCollabParticipant | null {
		const peer = this.#peers.get(browserId);
		return peer?.joined && !peer.ended ? { ...peer.identity } : null;
	}

	async joinAIReqCollab(
		input: { browserId: string; usernameOrLink: string; name: string },
		signal: AbortSignal,
	): Promise<{ peerId: string; roomId: string; canWrite: boolean }> {
		if (this.#closed) throw new Error("Collaboration bridge closed");
		if (signal.aborted) throw new Error("Collaboration join cancelled");
		if (!input.browserId) throw new Error("Missing browser identity");
		if (this.#peers.has(input.browserId)) throw new Error("Leave the current collaboration before joining again");
		let resolveSnapshot!: () => void;
		let rejectSnapshot!: (error: Error) => void;
		const firstSnapshot = new Promise<void>((resolve, reject) => {
			resolveSnapshot = resolve;
			rejectSnapshot = reject;
		});
		// The peer is reserved before username lookup/crypto so leave cannot be overtaken by a late join.
		const peer: BrowserPeer = {
			identity: {
				peerId: randomBytes(16).toString("hex"),
				roomId: "",
				generation: ++this.#generation,
				name: input.name.trim().slice(0, 64) || "guest",
				sessionId: "",
				canWrite: false,
			},
			socket: null,
			joined: false,
			ended: false,
			roomEnded: false,
			welcomed: false,
			expectedEntries: 0,
			receivedEntries: 0,
			pendingUi: new Set(),
			pendingTranscripts: new Set(),
			timer: undefined,
			cancel: () => rejectSnapshot(new Error("Collaboration join cancelled")),
		};
		this.#peers.set(input.browserId, peer);
		this.#options.onConnecting?.(input.browserId, { ...peer.identity });
		// Attach a rejection observer during async lookup; the awaited promise below still rejects normally.
		void firstSnapshot.catch(() => {});
		const current = () => !peer.ended && this.#peers.get(input.browserId) === peer;
		const fail = (reason: string) => {
			if (!current()) return;
			peer.joined = false;
			peer.ended = true;
			peer.pendingUi.clear();
			peer.pendingTranscripts.clear();
			clearTimeout(peer.timer);
			peer.socket?.discardPendingSends();
			peer.socket?.close();
			rejectSnapshot(new Error(reason));
			this.#options.onDisconnected?.(input.browserId, reason, { ...peer.identity });
		};
		const armTimeout = () => {
			clearTimeout(peer.timer);
			peer.timer = setTimeout(() => fail("Timed out receiving the complete collaboration snapshot"), 30_000);
		};
		const onAbort = () => {
			if (this.#peers.get(input.browserId) === peer) void this.leaveAIReqCollab(input.browserId);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const offline = intranetCollabEnabled();
			const relay = offline ? intranetRelayUrl(cfgCollabRelayUrl.get(this.#options.settings)) : undefined;
			const requested = input.usernameOrLink.trim();
			const link =
				offline && isIntranetUsername(requested) ? await resolveIntranetUsername(relay!, requested) : requested;
			if (!current() || signal.aborted) throw new Error("Collaboration join cancelled");
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error.replaceAll(link, "[redacted]"));
			if (relay && new URL(parsed.wsUrl).origin !== relay)
				throw new Error("Collaboration link belongs to a different relay");
			peer.identity.roomId = parsed.roomId;
			const key = await importRoomKey(parsed.key);
			if (!current() || signal.aborted) throw new Error("Collaboration join cancelled");
			const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			peer.socket = socket;
			socket.onOpen = () => {
				if (!current() || peer.roomEnded) return;
				peer.identity.generation = ++this.#generation;
				socket.discardPendingSends();
				peer.joined = false;
				peer.welcomed = false;
				peer.pendingUi.clear();
				peer.pendingTranscripts.clear();
				peer.receivedEntries = 0;
				this.#options.onConnecting?.(input.browserId, { ...peer.identity });
				armTimeout();
				socket.send({
					t: "hello",
					proto: COLLAB_PROTO,
					name: peer.identity.name,
					writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
				});
			};
			socket.onFrame = (frame, _fromPeer, connectionActive = true) => {
				if (!current()) return;
				// Decryption from a retired connection never changes a new connection's projection.
				if (!connectionActive || peer.roomEnded) return;
				if (
					frame.t === "hello" ||
					frame.t === "prompt" ||
					frame.t === "abort" ||
					frame.t === "ui-response" ||
					frame.t === "agent-cmd" ||
					frame.t === "fetch-transcript"
				)
					return;
				if (frame.t === "welcome") {
					if (frame.proto !== COLLAB_PROTO || !Number.isSafeInteger(frame.entryCount) || frame.entryCount < 0) {
						fail("Invalid collaboration welcome");
						return;
					}
					if (peer.identity.sessionId && peer.identity.sessionId !== frame.header.id) {
						fail("Collaboration room changed native session");
						return;
					}
					peer.identity.sessionId = frame.header.id;
					peer.welcomed = true;
					peer.joined = false;
					peer.identity.canWrite = !!parsed.writeToken && frame.readOnly !== true;
					peer.expectedEntries = frame.entryCount;
					peer.receivedEntries = 0;
					peer.pendingUi.clear();
					armTimeout();
				} else if (frame.t === "snapshot-chunk") {
					if (!peer.welcomed || peer.joined) {
						fail("Unexpected collaboration snapshot");
						return;
					}
					peer.receivedEntries += frame.entries.length;
					if (
						peer.receivedEntries > peer.expectedEntries ||
						(frame.final && peer.receivedEntries !== peer.expectedEntries)
					) {
						fail("Incomplete collaboration snapshot");
						return;
					}
					armTimeout();
				} else if (frame.t === "error" && !peer.joined && !peer.roomEnded) {
					this.#options.onFrame(input.browserId, frame, { ...peer.identity });
					fail(frame.message);
					return;
				} else if (frame.t !== "bye" && frame.t !== "ui-request-end" && !peer.joined && !peer.roomEnded) return;
				if (frame.t === "ui-request") peer.pendingUi.add(frame.request.reqId);
				if (frame.t === "ui-request-end") peer.pendingUi.delete(frame.reqId);
				if (frame.t === "transcript" && !peer.pendingTranscripts.delete(frame.reqId)) return;
				this.#options.onFrame(input.browserId, frame as HostFrame, { ...peer.identity });
				if (frame.t === "snapshot-chunk" && frame.final && !peer.roomEnded) {
					clearTimeout(peer.timer);
					peer.joined = true;
					this.#options.onJoined?.(input.browserId, { ...peer.identity });
					resolveSnapshot();
				}
				if (frame.t === "bye") fail(frame.reason);
			};
			socket.onControl = message => {
				if (message.t !== "room-closed" || !current()) return;
				// Native decryption is asynchronous. Retire admission now, but let the queued
				// goodbye/UI-end frames arrive before terminal close invalidates that receive chain.
				peer.roomEnded = true;
				peer.joined = false;
				peer.pendingUi.clear();
				peer.pendingTranscripts.clear();
				socket.discardPendingSends();
				this.#options.onDisconnected?.(input.browserId, "Collaboration room ended", { ...peer.identity });
				armTimeout();
			};
			socket.onClose = (reason, willReconnect) => {
				if (!current()) return;
				if (peer.roomEnded) return;
				peer.joined = false;
				peer.welcomed = false;
				peer.pendingUi.clear();
				peer.pendingTranscripts.clear();
				socket.discardPendingSends();
				clearTimeout(peer.timer);
				this.#options.onDisconnected?.(input.browserId, reason, { ...peer.identity });
				if (!willReconnect) fail(reason);
				else armTimeout();
			};
			armTimeout();
			socket.connect();
			await firstSnapshot;
			if (!current() || signal.aborted) throw new Error("Collaboration join cancelled");
			return { peerId: peer.identity.peerId, roomId: peer.identity.roomId, canWrite: peer.identity.canWrite };
		} catch (error) {
			if (this.#peers.get(input.browserId) === peer) await this.leaveAIReqCollab(input.browserId);
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async sendFrame(browserId: string, frame: GuestFrame, target: AIReqCollabTarget): Promise<AIReqCollabSubmitResult> {
		const peer = this.#peers.get(browserId);
		if (!peer?.joined || peer.ended || !peer.socket)
			return { kind: "rejected", message: "Collaboration is not joined" };
		if (!sameAIReqCollabTarget(peer.identity, target))
			return { kind: "rejected", message: "Collaboration target belongs to an earlier peer, session or connection" };
		if (frame.t === "hello") return { kind: "rejected", message: "Already joined" };
		if (frame.t !== "fetch-transcript" && !peer.identity.canWrite)
			return { kind: "rejected", message: "This collaboration link is read-only" };
		if (frame.t === "ui-response" && !peer.pendingUi.has(frame.reqId))
			return { kind: "rejected", message: "UI request ended or belongs to an earlier connection" };
		if (frame.t === "ui-response") peer.pendingUi.delete(frame.reqId);
		if (frame.t === "fetch-transcript") {
			if (peer.pendingTranscripts.has(frame.reqId))
				return { kind: "rejected", message: "Transcript request is already pending" };
			peer.pendingTranscripts.add(frame.reqId);
		}
		peer.socket.send(frame);
		// Native wire has no admission ACK: even a completed socket flush cannot prove Host acceptance.
		return {
			kind: "unknown",
			message: "Sent to collaboration transport; host admission is not acknowledged. Do not automatically resend.",
		};
	}

	async leaveAIReqCollab(browserId: string): Promise<void> {
		const peer = this.#peers.get(browserId);
		if (!peer) return;
		this.#peers.delete(browserId);
		peer.ended = true;
		peer.joined = false;
		peer.pendingUi.clear();
		peer.pendingTranscripts.clear();
		clearTimeout(peer.timer);
		peer.socket?.discardPendingSends();
		peer.socket?.close();
		peer.cancel();
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const browserId of this.#peers.keys()) await this.leaveAIReqCollab(browserId);
	}
}

/** AIReq owns its native port; no fabricated InteractiveModeContext reaches ordinary Collab. */
export function createAIReqCollabController(port: CollabHostPort): CollabController {
	return new CollabController({ nativePort: port });
}

export interface AIReqLocalSessionBridge {
	sendFrame(frame: GuestFrame): Promise<AIReqCollabSubmitResult>;
	refreshParticipants(): void;
	close(): Promise<void>;
}

export function createAIReqLocalSessionBridge(
	port: CollabHostPort,
	onFrame: (frame: HostFrame) => void,
): AIReqLocalSessionBridge {
	const projection = new CollabHost({ nativePort: port });
	const connection = projection.connectLocal(onFrame);
	return {
		async sendFrame(frame) {
			try {
				const result = await connection.sendFrame(frame);
				return result.accepted
					? { kind: "accepted" }
					: { kind: "rejected", message: result.reason ?? "Native input rejected" };
			} catch (error) {
				return { kind: "rejected", message: error instanceof Error ? error.message : String(error) };
			}
		},
		refreshParticipants: () => projection.refreshParticipants(),
		async close() {
			connection.close();
			await projection.stop("Workbench subscription closed");
		},
	};
}
