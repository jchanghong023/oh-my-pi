import { randomBytes } from "node:crypto";
import type { GuestFrame, HostFrame } from "@oh-my-pi/pi-wire";
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
import type { DevSubmitResult } from "../spec-driven/types";

export interface DevCollabParticipant {
	peerId: string;
	roomId: string;
	generation: number;
	sessionId: string;
	name: string;
	canWrite: boolean;
}

export interface DevCollabBridgeOptions {
	settings: Settings;
	onFrame(browserId: string, frame: HostFrame): void;
	onDisconnected?(browserId: string, reason: string): void;
	onJoined?(browserId: string, participant: DevCollabParticipant): void;
}

interface BrowserPeer {
	identity: DevCollabParticipant;
	socket: CollabSocket | null;
	joined: boolean;
	ended: boolean;
	roomEnded: boolean;
	welcomed: boolean;
	expectedEntries: number;
	receivedEntries: number;
	pendingUi: Set<number>;
	timer: Timer | undefined;
	cancel(): void;
}

/** Native-only guest transport. It never adopts a replica session or owns the host runtime. */
export class DevCollabBridge {
	readonly #options: DevCollabBridgeOptions;
	readonly #peers = new Map<string, BrowserPeer>();
	#generation = 0;
	#closed = false;

	constructor(options: DevCollabBridgeOptions) {
		this.#options = options;
	}

	getParticipant(browserId: string): DevCollabParticipant | null {
		const peer = this.#peers.get(browserId);
		return peer?.joined && !peer.ended ? { ...peer.identity } : null;
	}

	async joinDevCollab(
		input: { browserId: string; usernameOrLink: string; name: string },
		signal: AbortSignal,
	): Promise<{ peerId: string; roomId: string; canWrite: boolean }> {
		if (this.#closed) throw new Error("Collaboration bridge closed");
		if (!intranetCollabEnabled()) throw new Error("Browser intranet collaboration requires OMP_OFFLINE");
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
			timer: undefined,
			cancel: () => rejectSnapshot(new Error("Collaboration join cancelled")),
		};
		this.#peers.set(input.browserId, peer);
		// Attach a rejection observer during async lookup; the awaited promise below still rejects normally.
		void firstSnapshot.catch(() => {});
		const current = () => !peer.ended && this.#peers.get(input.browserId) === peer;
		const fail = (reason: string) => {
			if (!current()) return;
			peer.joined = false;
			peer.ended = true;
			peer.pendingUi.clear();
			clearTimeout(peer.timer);
			peer.socket?.discardPendingSends();
			peer.socket?.close();
			rejectSnapshot(new Error(reason));
			this.#options.onDisconnected?.(input.browserId, reason);
		};
		const armTimeout = () => {
			clearTimeout(peer.timer);
			peer.timer = setTimeout(() => fail("Timed out receiving the complete collaboration snapshot"), 30_000);
		};
		const onAbort = () => {
			if (this.#peers.get(input.browserId) === peer) void this.leaveDevCollab(input.browserId);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const relay = intranetRelayUrl(cfgCollabRelayUrl.get(this.#options.settings));
			const requested = input.usernameOrLink.trim();
			const link = isIntranetUsername(requested) ? await resolveIntranetUsername(relay, requested) : requested;
			if (!current() || signal.aborted) throw new Error("Collaboration join cancelled");
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			if (new URL(parsed.wsUrl).origin !== relay) throw new Error("Collaboration link belongs to a different relay");
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
				peer.receivedEntries = 0;
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
				// A transient close retains queued decryptions for final goodbye/UI ends.
				// Only the socket that is still live may establish a snapshot or admission.
				if ((!connectionActive || peer.roomEnded) && frame.t !== "bye" && frame.t !== "ui-request-end") return;
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
					this.#options.onFrame(input.browserId, frame);
					fail(frame.message);
					return;
				} else if (frame.t !== "bye" && frame.t !== "ui-request-end" && !peer.joined && !peer.roomEnded) return;
				if (frame.t === "ui-request") peer.pendingUi.add(frame.request.reqId);
				if (frame.t === "ui-request-end") peer.pendingUi.delete(frame.reqId);
				// The existing browser client consumes this exact HostFrame grammar, including chunk/UI ends.
				this.#options.onFrame(input.browserId, frame as HostFrame);
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
				socket.discardPendingSends();
				this.#options.onDisconnected?.(input.browserId, "Collaboration room ended");
				armTimeout();
			};
			socket.onClose = (reason, willReconnect) => {
				if (!current()) return;
				if (peer.roomEnded) return;
				peer.joined = false;
				peer.welcomed = false;
				peer.pendingUi.clear();
				socket.discardPendingSends();
				clearTimeout(peer.timer);
				this.#options.onDisconnected?.(input.browserId, reason);
				if (!willReconnect) fail(reason);
				else armTimeout();
			};
			armTimeout();
			socket.connect();
			await firstSnapshot;
			if (!current() || signal.aborted) throw new Error("Collaboration join cancelled");
			return { peerId: peer.identity.peerId, roomId: peer.identity.roomId, canWrite: peer.identity.canWrite };
		} catch (error) {
			if (this.#peers.get(input.browserId) === peer) await this.leaveDevCollab(input.browserId);
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async sendFrame(browserId: string, frame: GuestFrame): Promise<DevSubmitResult> {
		const peer = this.#peers.get(browserId);
		if (!peer?.joined || peer.ended || !peer.socket)
			return { kind: "rejected", message: "Collaboration is not joined" };
		if (frame.t === "hello") return { kind: "rejected", message: "Already joined" };
		if (frame.t !== "fetch-transcript" && (!intranetCollabEnabled() || !peer.identity.canWrite))
			return {
				kind: "rejected",
				message: "This collaboration link is read-only or offline collaboration is disabled",
			};
		if (frame.t === "ui-response" && !peer.pendingUi.has(frame.reqId))
			return { kind: "rejected", message: "UI request ended or belongs to an earlier connection" };
		peer.socket.send(frame);
		// Native wire has no admission ACK: even a completed socket flush cannot prove Host acceptance.
		return {
			kind: "unknown",
			message: "Sent to collaboration transport; host admission is not acknowledged. Do not automatically resend.",
		};
	}

	async leaveDevCollab(browserId: string): Promise<void> {
		const peer = this.#peers.get(browserId);
		if (!peer) return;
		this.#peers.delete(browserId);
		peer.ended = true;
		peer.joined = false;
		peer.pendingUi.clear();
		clearTimeout(peer.timer);
		peer.socket?.discardPendingSends();
		peer.socket?.close();
		peer.cancel();
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const browserId of this.#peers.keys()) await this.leaveDevCollab(browserId);
	}
}

/** Dev owns its native port; no fabricated InteractiveModeContext reaches ordinary Collab. */
export function createDevCollabController(port: CollabHostPort): CollabController {
	return new CollabController({ nativePort: port });
}

export function createDevLocalSessionBridge(
	port: CollabHostPort,
	onFrame: (frame: HostFrame) => void,
): {
	sendFrame(frame: GuestFrame): Promise<DevSubmitResult>;
	close(): Promise<void>;
} {
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
		async close() {
			connection.close();
			await projection.stop("Workbench subscription closed");
		},
	};
}
