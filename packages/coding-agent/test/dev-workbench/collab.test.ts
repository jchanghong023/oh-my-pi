import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { GuestFrame, HostFrame } from "@oh-my-pi/pi-wire";
import { SessionReplica, type GuestSnapshot } from "../../../collab-web/src/lib/client";
import { CollabHost, type CollabHostPort, subscribeCollabEntries } from "../../src/collab/host";
import { intranetUsername } from "../../src/collab/intranet";
import * as collabRegistry from "../../src/collab/registry";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabFrame } from "../../src/collab/protocol";
import { startIntranetRelay } from "../../src/collab/relay-server";
import { CollabSocket } from "../../src/collab/relay-client";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { DevCollabBridge, createDevLocalSessionBridge } from "../../src/dev-workbench/collab";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const publishCollabHost = collabRegistry.publishCollabHost;

class Frames {
	readonly values: HostFrame[] = [];
	readonly #listeners = new Set<() => void>();
	push(frame: HostFrame): void {
		this.values.push(frame);
		for (const listener of this.#listeners) listener();
	}
	take(predicate: (frame: HostFrame) => boolean): Promise<HostFrame> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.#listeners.delete(receive);
			};
			const receive = () => {
				const index = this.values.findIndex(predicate);
				if (index < 0) return;
				const frame = this.values.splice(index, 1)[0]!;
				cleanup();
				resolve(frame);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Native collaboration frame not received"));
			}, 5_000);
			this.#listeners.add(receive);
			receive();
		});
	}
}

let previousOffline: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	previousOffline = process.env.OMP_OFFLINE;
	process.env.OMP_OFFLINE = "1";
});
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
		if (previousOffline === undefined) delete process.env.OMP_OFFLINE;
		else process.env.OMP_OFFLINE = previousOffline;
	}
});

async function fixture(options: { ready?: boolean; remote?: boolean; delayMs?: number } = {}) {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-collab-"));
	vi.spyOn(collabRegistry, "publishCollabHost").mockImplementation((source, publishOptions) =>
		publishCollabHost(source, { ...publishOptions, dir: path.join(temporary, "registry") }),
	);
	const remoteAddress = Object.values(os.networkInterfaces())
		.flat()
		.find(entry => entry?.family === "IPv4" && !entry.internal)?.address;
	if (options.remote && !remoteAddress) throw new Error("Remote HTTP/WS fixture requires a non-loopback IPv4 address");
	const relay = startIntranetRelay({ hostname: options.remote ? "0.0.0.0" : "127.0.0.1", port: 0 });
	const relayUrl = options.remote ? relay.url.replace(new URL(relay.url).hostname, remoteAddress!) : relay.url;
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("openai", "isolated-test-key");
	const mock = createMockModel({
		provider: "openai",
		id: "gpt-test",
		handler: { content: ["native response"], delayMs: options.delayMs },
	});
	const settings = Settings.isolated({
		"collab.relayUrl": relayUrl,
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	const manager = SessionManager.inMemory(temporary);
	manager.appendMessage({ role: "user", content: "shared history", timestamp: 1 });
	const agent = new Agent({
		getApiKey: () => "isolated-test-key",
		convertToLlm,
		streamFn: mock.stream,
		initialState: {
			model: mock.model,
			systemPrompt: ["Deterministic collaboration fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
	});
	const models = new ModelRegistry(auth);
	const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: models });
	const notices: string[] = [];
	const port: CollabHostPort = {
		session,
		sessionManager: manager,
		settings,
		subscribeEntries: listener => subscribeCollabEntries(manager, listener),
		getContextUsage: () => ({
			tokens: session.getContextUsage()?.tokens ?? 0,
			contextWindow: session.model?.contextWindow ?? 0,
		}),
		showStatus: message => {
			notices.push(message);
		},
	};
	const host = new CollabHost({ nativePort: port }, { guestActionsReady: () => options.ready !== false });
	cleanups.push(async () => {
		await host.stop("fixture cleanup");
		await session.dispose();
		auth.close();
		relay.stop();
		await fs.rm(temporary, { recursive: true, force: true });
	});
	await host.start(relayUrl);
	const frames = new Map<string, Frames>();
	const deliveries = new Map<string, (frame: HostFrame) => void>();
	const bridge = new DevCollabBridge({
		settings,
		onFrame: (browserId, frame) => {
			frames.get(browserId)?.push(frame);
			deliveries.get(browserId)?.(frame);
		},
	});
	cleanups.push(() => bridge.close());
	const join = async (browserId: string, link = host.link) => {
		const inbox = new Frames();
		frames.set(browserId, inbox);
		const identity = await bridge.joinDevCollab(
			{ browserId, name: browserId, usernameOrLink: link },
			AbortSignal.timeout(5_000),
		);
		return { inbox, identity };
	};
	return { host, bridge, session, manager, settings, port, models, mock, frames, deliveries, join, relay, notices };
}

describe("workbench native collaboration transport", () => {
	it("counts the owner once for local mirrors and retains a distinct same-name remote participant", async () => {
		const f = await fixture();
		const counts: number[] = [];
		f.port.onCollabStatus = status => {
			if (status) counts.push(status.participantCount);
		};
		const owner = f.host.participants[0]!;
		const inbox = new Frames();
		const local = f.host.connectLocal(frame => inbox.push(frame));
		const secondLocal = f.host.connectLocal(() => {});
		cleanups.push(async () => {
			secondLocal.close();
			local.close();
		});
		const welcome = await inbox.take(frame => frame.t === "welcome");
		if (welcome.t !== "welcome") throw new Error("Missing local welcome");
		expect(welcome.state.participants).toEqual([owner]);
		expect(f.host.participants).toEqual([owner]);
		expect(counts.at(-1)).toBe(1);

		const remote = await f.join(owner.name);
		const joined = await inbox.take(frame => frame.t === "state" && frame.state.participants.length === 2);
		if (joined.t !== "state") throw new Error("Missing joined state");
		expect(joined.state.participants).toEqual([owner, { name: owner.name, role: "guest" }]);
		expect(counts.at(-1)).toBe(2);
		expect(remote.identity.canWrite).toBe(true);

		await f.bridge.leaveDevCollab(owner.name);
		const left = await inbox.take(frame => frame.t === "state" && frame.state.participants.length === 1);
		if (left.t !== "state") throw new Error("Missing departed state");
		expect(left.state.participants).toEqual([owner]);
		expect(counts.at(-1)).toBe(1);
	});

	it("delivers native frames through plain HTTP/WS to two production browser reducers without browser cryptography", async () => {
		const f = await fixture();
		const server = Bun.serve<{ id: string }>({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, server) {
				const url = new URL(request.url);
				const id = url.searchParams.get("browser") ?? "";
				if (url.pathname === "/events") {
					if (server.upgrade(request, { data: { id } })) return;
					return new Response("Upgrade required", { status: 426 });
				}
				if (url.pathname === "/join") {
					const identity = await f.bridge.joinDevCollab(
						{
							browserId: id,
							name: id,
							usernameOrLink: intranetUsername(),
						},
						AbortSignal.timeout(5_000),
					);
					return Response.json(identity);
				}
				if (url.pathname === "/leave") {
					await f.bridge.leaveDevCollab(id);
					return Response.json({ left: true });
				}
				return new Response("Not found", { status: 404 });
			},
			websocket: {
				open(socket) {
					f.deliveries.set(socket.data.id, frame => {
						socket.send(JSON.stringify(frame));
					});
				},
				message(socket, message) {
					const frame = JSON.parse(String(message)) as GuestFrame;
					void f.bridge.sendFrame(socket.data.id, frame);
				},
				close(socket) {
					f.deliveries.delete(socket.data.id);
					void f.bridge.leaveDevCollab(socket.data.id);
				},
			},
		});
		cleanups.push(async () => {
			server.stop(true);
		});
		const origin = `http://127.0.0.1:${server.port}`;
		const waitSnapshot = (replica: SessionReplica, predicate: (snapshot: GuestSnapshot) => boolean) =>
			new Promise<void>((resolve, reject) => {
				const check = () => {
					if (!predicate(replica.getSnapshot())) return;
					clearTimeout(timer);
					unsubscribe();
					resolve();
				};
				const unsubscribe = replica.subscribe(check);
				const timer = setTimeout(() => {
					unsubscribe();
					reject(new Error("Browser reducer did not settle"));
				}, 5_000);
				check();
			});
		const browser = async (id: string) => {
			const opened = Promise.withResolvers<void>();
			let socket: WebSocket | undefined;
			const replica = new SessionReplica(
				{
					connect() {
						socket = new WebSocket(`${origin.replace(/^http/, "ws")}/events?browser=${id}`);
						socket.onopen = () => opened.resolve();
						socket.onerror = () => opened.reject(new Error("Browser WS failed"));
						socket.onmessage = event => replica.receiveFrame(JSON.parse(String(event.data)) as HostFrame);
					},
					send(frame) {
						if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Browser disconnected");
						socket.send(JSON.stringify(frame));
					},
					close() {
						socket?.close();
					},
				},
				id,
			);
			cleanups.push(async () => {
				replica.close();
				await f.bridge.leaveDevCollab(id);
			});
			replica.connect();
			await opened.promise;
			const response = await fetch(`${origin}/join?browser=${id}`, { method: "POST" });
			expect(response.ok).toBe(true);
			await waitSnapshot(replica, snapshot => snapshot.phase === "live");
			return replica;
		};
		const alice = await browser("http-alice");
		const bob = await browser("http-bob");
		expect(JSON.stringify(alice.getSnapshot().entries)).toContain("shared history");
		expect(alice.getSnapshot().entries).toEqual(bob.getSnapshot().entries);
		alice.sendPrompt("plain browser question");
		await Promise.all(
			[alice, bob].map(replica =>
				waitSnapshot(replica, snapshot => JSON.stringify(snapshot.entries).includes("native response")),
			),
		);
		const answer = f.host.requestGuestUi({ kind: "editor", title: "Native editor", prefill: "  original  " });
		await Promise.all([alice, bob].map(replica => waitSnapshot(replica, snapshot => snapshot.uiRequest !== null)));
		const request = bob.getSnapshot().uiRequest;
		if (!request) throw new Error("Native UI not delivered");
		bob.sendUiResponse(request.reqId, "  unchanged raw reply  ");
		expect(await answer).toEqual({ kind: "answered", value: "  unchanged raw reply  " });
		await Promise.all([alice, bob].map(replica => waitSnapshot(replica, snapshot => snapshot.uiRequest === null)));
		await fetch(`${origin}/leave?browser=http-alice`, { method: "POST" });
		expect(f.host.ending).toBe(false);
		expect(f.mock.calls).toHaveLength(1);
	}, 15_000);

	it("does not report joined until every native snapshot chunk has reached the consumer", async () => {
		const f = await fixture();
		for (let index = 0; index < 24; index++)
			f.manager.appendMessage({ role: "user", content: `${index}:${"x".repeat(48_000)}`, timestamp: index + 10 });
		const observed: Array<{ final: boolean; joined: boolean }> = [];
		f.deliveries.set("chunked", frame => {
			if (frame.t === "snapshot-chunk")
				observed.push({ final: frame.final, joined: f.bridge.getParticipant("chunked") !== null });
		});
		const peer = await f.join("chunked");
		expect(peer.identity.canWrite).toBe(true);
		expect(observed.length).toBeGreaterThan(1);
		expect(observed.at(-1)?.final).toBe(true);
		expect(observed.every(chunk => !chunk.joined)).toBe(true);
		expect(f.bridge.getParticipant("chunked")?.sessionId).toBe(f.manager.getSessionId());
	});

	it("joins two independent browser peers over intranet HTTP lookup/plain WS and mirrors one real native execution", async () => {
		const f = await fixture({ remote: true });
		const alice = await f.join("alice", intranetUsername());
		const bob = await f.join("bob", intranetUsername());
		expect(alice.identity.peerId).not.toBe(bob.identity.peerId);
		expect(alice.identity.roomId).toBe(bob.identity.roomId);
		for (const peer of [alice, bob]) {
			const welcome = await peer.inbox.take(frame => frame.t === "welcome");
			expect(welcome.t === "welcome" && welcome.entryCount).toBeGreaterThan(0);
			const snapshot = await peer.inbox.take(frame => frame.t === "snapshot-chunk" && frame.final);
			expect(snapshot.t === "snapshot-chunk" && JSON.stringify(snapshot.entries)).toContain("shared history");
		}
		expect((await f.bridge.sendFrame("alice", { t: "prompt", text: "shared question" })).kind).toBe("unknown");
		for (const peer of [alice, bob]) {
			await peer.inbox.take(frame => frame.t === "event" && frame.event.type === "message_update");
			await peer.inbox.take(frame => frame.t === "event" && frame.event.type === "agent_end");
		}
		expect(f.mock.calls).toHaveLength(1);
		expect(JSON.stringify(f.session.messages)).toContain("shared question");
		expect(JSON.stringify(f.session.messages)).toContain("native response");
		expect(f.port.collabGuest).toBeUndefined();
	}, 15_000);

	it("first guest UI answer settles once, reaches all consumers, and stale reqIds cannot be answered", async () => {
		const f = await fixture();
		const alice = await f.join("alice");
		const bob = await f.join("bob");
		const answer = f.host.requestGuestUi({ kind: "editor", title: "Keep raw approval?" });
		const request = await alice.inbox.take(frame => frame.t === "ui-request");
		if (request.t !== "ui-request") throw new Error("Missing UI request");
		await bob.inbox.take(frame => frame.t === "ui-request");
		expect(
			(await f.bridge.sendFrame("alice", { t: "ui-response", reqId: request.request.reqId, value: "  Approved\n" }))
				.kind,
		).toBe("unknown");
		expect(await answer).toEqual({ kind: "answered", value: "  Approved\n" });
		await alice.inbox.take(frame => frame.t === "ui-request-end");
		await bob.inbox.take(frame => frame.t === "ui-request-end");
		expect(
			(await f.bridge.sendFrame("bob", { t: "ui-response", reqId: request.request.reqId, value: "reject" })).kind,
		).toBe("rejected");
	});
	it("retains view-only and original native startup denial without promoting write access", async () => {
		const f = await fixture({ ready: false });
		const viewer = await f.join("viewer", f.host.viewLink);
		expect(viewer.identity.canWrite).toBe(false);
		expect((await f.bridge.sendFrame("viewer", { t: "abort" })).kind).toBe("rejected");
		expect((await f.bridge.sendFrame("viewer", { t: "prompt", text: "not admitted" })).kind).toBe("rejected");
		const writer = await f.join("writer");
		await f.bridge.sendFrame("writer", { t: "prompt", text: "still denied by native owner" });
		const error = await writer.inbox.take(frame => frame.t === "error");
		expect(error.t === "error" && error.message).toContain("unavailable");
		expect(f.mock.calls).toHaveLength(0);
	});

	it("leaves only its guest while host execution and other browser continue", async () => {
		const f = await fixture({ delayMs: 40 });
		const alice = await f.join("alice");
		const bob = await f.join("bob");
		await f.bridge.sendFrame("alice", { t: "prompt", text: "continue after tab closes" });
		await alice.inbox.take(frame => frame.t === "event" && frame.event.type === "agent_start");
		await f.bridge.leaveDevCollab("alice");
		expect(f.bridge.getParticipant("alice")).toBeNull();
		await bob.inbox.take(frame => frame.t === "event" && frame.event.type === "agent_end");
		expect(f.host.ending).toBe(false);
		expect(f.session.isDisposed).toBe(false);
		expect(f.mock.calls).toHaveLength(1);
	});

	it("does not follow usernames into a replacement room or replay disconnected mutations", async () => {
		const f = await fixture();
		const alice = await f.join("alice");
		await f.host.stop("stage changed");
		await alice.inbox.take(frame => frame.t === "bye");
		const replacement = new CollabHost({ nativePort: f.port });
		// A local successor is sufficient to ensure room retirement does not admit further input.
		const local = replacement.connectLocal(() => {});
		cleanups.push(async () => {
			local.close();
			await replacement.stop("cleanup");
		});
		expect((await f.bridge.sendFrame("alice", { t: "prompt", text: "must not migrate" })).kind).toBe("rejected");
		expect(f.bridge.getParticipant("alice")).toBeNull();
		expect(f.mock.calls).toHaveLength(0);
	});

	it("rejects online relaxation, an unshared username, and an alien relay origin", async () => {
		const f = await fixture();
		await expect(f.join("missing", "nobody_sharing_here")).rejects.toThrow("not sharing");
		const other = startIntranetRelay({ hostname: "127.0.0.1", port: 0 });
		try {
			const alienLink = f.host.link.replace(new URL(f.relay.url).host, new URL(other.url).host);
			await expect(f.join("alien", alienLink)).rejects.toThrow("different relay");
		} finally {
			other.stop();
		}
		delete process.env.OMP_OFFLINE;
		await expect(f.join("online")).rejects.toThrow("OMP_OFFLINE");
	});

	for (const outcome of ["cancelled", "failed"] as const) {
		it(`keeps replacement join B when an old username lookup is ${outcome}`, async () => {
			const f = await fixture();
			let finishLookup!: (response: Response) => void;
			const lookup = new Promise<Response>(resolve => {
				finishLookup = resolve;
			});
			vi.spyOn(globalThis, "fetch").mockImplementationOnce(
				Object.assign(() => lookup, { preconnect: fetch.preconnect }),
			);
			const oldSignal = new AbortController();
			const oldJoin = f.bridge
				.joinDevCollab(
					{
						browserId: "same-browser",
						name: "old",
						usernameOrLink: intranetUsername(),
					},
					oldSignal.signal,
				)
				.then(
					() => "joined",
					error => String(error),
				);
			await f.bridge.leaveDevCollab("same-browser");
			await f.join("same-browser");
			const replacement = f.bridge.getParticipant("same-browser");
			if (outcome === "cancelled") oldSignal.abort();
			finishLookup(
				outcome === "cancelled"
					? Response.json({ link: f.host.link })
					: new Response("lookup failed", { status: 503 }),
			);
			expect(await oldJoin).not.toBe("joined");
			expect(f.bridge.getParticipant("same-browser")).toEqual(replacement);
			expect(
				(
					await f.bridge.sendFrame("same-browser", {
						t: "fetch-transcript",
						reqId: 1,
						agentId: "absent",
						fromByte: 0,
					})
				).kind,
			).toBe("unknown");
		});
	}

	it("ignores closed-connection snapshots, rejoins on a live snapshot, and retains late UI ends and goodbye", async () => {
		const f = await fixture();
		const sockets: CollabSocket[] = [];
		const snapshots: CollabFrame[] = [];
		const connect = CollabSocket.prototype.connect;
		vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			sockets.push(this);
			const onFrame = this.onFrame;
			this.onFrame = (frame, fromPeer, connectionActive) => {
				if (frame.t === "welcome" || frame.t === "snapshot-chunk") snapshots.push(frame);
				onFrame?.(frame, fromPeer, connectionActive);
			};
			connect.call(this);
		});
		const { inbox } = await f.join("reconnecting");
		const socket = sockets[0]!;
		const welcome = snapshots.find(frame => frame.t === "welcome");
		const chunk = snapshots.find(frame => frame.t === "snapshot-chunk" && frame.final);
		if (!welcome || welcome.t !== "welcome" || !chunk || chunk.t !== "snapshot-chunk")
			throw new Error("Native snapshot frames were not received");
		const joined = f.bridge.getParticipant("reconnecting");
		socket.onClose?.("transient disconnect", true);
		// Both a late final chunk and an entire queued old snapshot must be harmless.
		socket.onFrame?.(chunk, 0, false);
		socket.onFrame?.(welcome, 0, false);
		socket.onFrame?.(chunk, 0, false);
		expect(f.bridge.getParticipant("reconnecting")).toBeNull();
		expect((await f.bridge.sendFrame("reconnecting", { t: "abort" })).kind).toBe("rejected");
		socket.onFrame?.({ t: "ui-request-end", reqId: 91 }, 0, false);
		expect(await inbox.take(frame => frame.t === "ui-request-end" && frame.reqId === 91)).toEqual({
			t: "ui-request-end",
			reqId: 91,
		});
		// The fresh native socket callback is the only path back to admission.
		socket.onOpen?.();
		// Existing direct callback consumers omit metadata and retain active semantics.
		socket.onFrame?.(welcome, 0);
		socket.onFrame?.(chunk, 0);
		expect(f.bridge.getParticipant("reconnecting")?.peerId).toBe(joined?.peerId);
		expect(f.bridge.getParticipant("reconnecting")!.generation).toBeGreaterThan(joined!.generation);
		socket.onClose?.("room teardown", true);
		socket.onFrame?.({ t: "bye", reason: "native room ended" }, 0, false);
		expect(await inbox.take(frame => frame.t === "bye")).toEqual({ t: "bye", reason: "native room ended" });
		socket.onOpen?.();
		socket.onFrame?.(welcome, 0, true);
		socket.onFrame?.(chunk, 0, true);
		expect(f.bridge.getParticipant("reconnecting")).toBeNull();
	});

	it("shares the entry callback and removes only the subscriber that leaves", async () => {
		const f = await fixture();
		let original = 0;
		let first = 0;
		let second = 0;
		// Use an independent real manager so the live host callback is not replaced.
		const manager = SessionManager.inMemory();
		manager.onEntryAppended = () => {
			original++;
		};
		const stopFirst = subscribeCollabEntries(manager, () => {
			first++;
		});
		const stopSecond = subscribeCollabEntries(manager, () => {
			second++;
		});
		manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		stopFirst();
		manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
		stopSecond();
		manager.appendMessage({ role: "user", content: "three", timestamp: 3 });
		expect([original, first, second]).toEqual([3, 1, 2]);
		expect(f.host.ending).toBe(false);
	});

	it("projects model metadata for local and relay frames without exposing native state or credentials", async () => {
		const f = await fixture();
		const nativeModel = Object.assign(f.mock, {
			nativeSession: f.session,
			headers: { Authorization: "private-native-model-token" },
		});
		const { inbox: remoteInbox } = await f.join("model-projection");
		const localInbox = new Frames();
		const local = createDevLocalSessionBridge(f.port, frame => localInbox.push(frame));
		cleanups.push(() => local.close());
		const assertModel = (frame: HostFrame) => {
			if (frame.t !== "welcome" && frame.t !== "state") throw new Error("Missing model state");
			expect(frame.state.model).toMatchObject({
				id: nativeModel.id,
				name: nativeModel.name,
				provider: nativeModel.provider,
				contextWindow: nativeModel.contextWindow,
				maxTokens: nativeModel.maxTokens,
				reasoning: nativeModel.reasoning,
				input: nativeModel.input,
				cost: nativeModel.cost,
				identity: nativeModel.identity,
			});
			for (const property of ["nativeSession", "headers", "calls", "fallback", "stream"])
				expect(frame.state.model).not.toHaveProperty(property);
			expect(JSON.stringify(frame)).not.toContain("private-native-model-token");
		};
		for (const inbox of [localInbox, remoteInbox]) {
			assertModel(await inbox.take(frame => frame.t === "welcome"));
		}
		expect((await local.sendFrame({ t: "prompt", text: "exercise cyclic native call context" })).kind).toBe(
			"accepted",
		);
		expect(f.mock.calls).toHaveLength(1);
		await f.session.setSessionName("Projected after native input", "user");
		for (const inbox of [localInbox, remoteInbox]) {
			assertModel(
				await inbox.take(
					frame => frame.t === "state" && frame.state.sessionName === "Projected after native input",
				),
			);
		}
		expect(f.session.model).toBe(nativeModel);
		expect(nativeModel.nativeSession).toBe(f.session);
		expect(nativeModel.headers.Authorization).toBe("private-native-model-token");
		await local.close();
		const localFramesAfterClose = localInbox.values.length;
		await f.session.setSessionName("Owner remains shared after detach", "user");
		assertModel(
			await remoteInbox.take(
				frame => frame.t === "state" && frame.state.sessionName === "Owner remains shared after detach",
			),
		);
		expect(localInbox.values).toHaveLength(localFramesAfterClose);
		expect(f.session.isDisposed).toBe(false);
		expect(f.host.ending).toBe(false);
	});

	it("local projection admits real input, scopes agent control, and closing detaches without aborting the owner", async () => {
		const f = await fixture();
		const registry = AgentRegistry.global();
		const suffix = randomBytes(8).toString("hex");
		const unrelated = registry.register({
			id: `unrelated-${suffix}`,
			displayName: "Unrelated",
			kind: "main",
			session: null,
		});
		const root = registry.register({ id: `root-${suffix}`, displayName: "Owner", kind: "main", session: f.session });
		const child = registry.register({
			id: `child-${suffix}`,
			displayName: "Child",
			kind: "sub",
			parentId: root.id,
			session: null,
		});
		cleanups.push(async () => {
			registry.unregister(unrelated.id, unrelated);
			registry.unregister(child.id, child);
			registry.unregister(root.id, root);
		});
		const inbox = new Frames();
		const local = createDevLocalSessionBridge(f.port, frame => inbox.push(frame));
		cleanups.push(() => local.close());
		const welcome = await inbox.take(frame => frame.t === "welcome");
		if (welcome.t !== "welcome") throw new Error("Missing welcome");
		expect(welcome.agents.map(agent => agent.id)).toEqual(expect.arrayContaining([root.id, child.id]));
		expect(welcome.agents.some(agent => agent.id === unrelated.id)).toBe(false);
		expect((await local.sendFrame({ t: "agent-cmd", cmd: "kill", agentId: unrelated.id })).kind).toBe("rejected");
		expect(registry.get(unrelated.id)).toBe(unrelated);
		expect((await local.sendFrame({ t: "prompt", text: "local native input" })).kind).toBe("accepted");
		expect(f.mock.calls).toHaveLength(1);
		const denied = vi.fn<AgentSession["promptCustomMessage"]>(async () => {
			throw new Error("Dev control operation has not settled");
		});
		f.port.promptCustomMessage = denied;
		expect((await local.sendFrame({ t: "prompt", text: "must not cross Dev control" })).kind).toBe("rejected");
		expect(denied).toHaveBeenCalledTimes(1);
		expect(f.mock.calls).toHaveLength(1);
		expect(JSON.stringify(f.session.messages)).not.toContain("must not cross Dev control");
		const submit = vi.fn<AgentSession["promptCustomMessage"]>((message, options) =>
			f.session.promptCustomMessage(message, options),
		);
		f.port.promptCustomMessage = submit;
		expect((await local.sendFrame({ t: "prompt", text: "preserve native custom input" })).kind).toBe("accepted");
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content: "preserve native custom input",
				display: true,
				details: { from: expect.any(String) },
				attribution: "user",
			}),
			{ streamingBehavior: "steer", queueChipText: "preserve native custom input" },
		);
		expect(f.mock.calls).toHaveLength(2);
		const abort = vi.spyOn(f.session, "abort");
		const dispose = vi.spyOn(f.session, "dispose");
		expect(f.session.isDisposed).toBe(false);
		await local.close();
		expect(f.session.isDisposed).toBe(false);
		expect(abort).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(f.host.ending).toBe(false);
		expect((await local.sendFrame({ t: "abort" })).kind).toBe("rejected");
	});

	it("rejects a live agent command when native prompt preflight refuses admission", async () => {
		const f = await fixture();
		const registry = AgentRegistry.global();
		const owner = registry.register({
			id: `preflight-${randomBytes(8).toString("hex")}`,
			displayName: "Owner",
			kind: "main",
			session: f.session,
		});
		cleanups.push(async () => {
			registry.unregister(owner.id, owner);
		});
		const local = createDevLocalSessionBridge(f.port, () => {});
		cleanups.push(() => local.close());
		vi.spyOn(f.models, "getApiKey").mockRejectedValueOnce(new Error("native authentication refused"));
		expect(
			(
				await local.sendFrame({
					t: "agent-cmd",
					cmd: "chat",
					agentId: owner.id,
					text: "keep this unadmitted input",
				})
			).kind,
		).toBe("rejected");
		expect(f.mock.calls).toHaveLength(0);
		expect(JSON.stringify(f.session.messages)).not.toContain("keep this unadmitted input");
	});

	it("rejects failed parked-child revival and accepts successful revival only at native input admission", async () => {
		const f = await fixture();
		const childFixture = await fixture();
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const suffix = randomBytes(8).toString("hex");
		const root = registry.register({ id: `owner-${suffix}`, displayName: "Owner", kind: "main", session: f.session });
		const child = registry.register({
			id: `parked-${suffix}`,
			displayName: "Parked",
			kind: "sub",
			parentId: root.id,
			session: null,
			status: "parked",
		});
		cleanups.push(async () => {
			registry.unregister(child.id, child);
			registry.unregister(root.id, root);
		});
		const inbox = new Frames();
		const local = createDevLocalSessionBridge(f.port, frame => inbox.push(frame));
		cleanups.push(() => local.close());
		lifecycle.adopt(
			child.id,
			{
				idleTtlMs: 0,
				revive: async () => {
					throw new Error("workspace no longer exists");
				},
			},
			child,
		);
		let draft = "retain this child input";
		const send = async () => {
			const result = await local.sendFrame({ t: "agent-cmd", cmd: "chat", agentId: child.id, text: draft });
			if (result.kind === "accepted") draft = "";
			return result;
		};
		expect((await send()).kind).toBe("rejected");
		expect(draft).toBe("retain this child input");
		expect(childFixture.mock.calls).toHaveLength(0);
		expect(
			await inbox.take(frame => frame.t === "error" && frame.message.includes("workspace no longer exists")),
		).toMatchObject({ t: "error" });
		let finishRevival!: () => void;
		const revival = new Promise<void>(resolve => {
			finishRevival = resolve;
		});
		lifecycle.adopt(
			child.id,
			{
				idleTtlMs: 0,
				revive: async () => {
					await revival;
					return childFixture.session;
				},
			},
			child,
		);
		let finishModel!: () => void;
		const model = new Promise<void>(resolve => {
			finishModel = resolve;
		});
		let finishPreflight!: () => void;
		const preflight = new Promise<void>(resolve => {
			finishPreflight = resolve;
		});
		let enterPreflight!: () => void;
		const preflightEntered = new Promise<void>(resolve => {
			enterPreflight = resolve;
		});
		const getApiKey = childFixture.models.getApiKey;
		vi.spyOn(childFixture.models, "getApiKey").mockImplementationOnce(async (...args) => {
			enterPreflight();
			await preflight;
			return getApiKey.apply(childFixture.models, args);
		});
		childFixture.mock.push(async () => {
			await model;
			return { throw: "provider failed after admission" };
		});
		const ended = new Promise<void>(resolve => {
			const unsubscribe = childFixture.session.subscribe(event => {
				if (event.type === "agent_end") {
					unsubscribe();
					resolve();
				}
			});
		});
		let settled = false;
		const submission = send().then(result => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(draft).toBe("retain this child input");
		expect(childFixture.mock.calls).toHaveLength(0);
		finishRevival();
		await preflightEntered;
		expect(settled).toBe(false);
		expect(draft).toBe("retain this child input");
		expect(childFixture.mock.calls).toHaveLength(0);
		finishPreflight();
		expect((await submission).kind).toBe("accepted");
		expect(draft).toBe("");
		expect(childFixture.session.isStreaming).toBe(true);
		finishModel();
		await ended;
		expect((await submission).kind).toBe("accepted");
		expect(JSON.stringify(childFixture.session.messages)).toContain("retain this child input");
	});
});
