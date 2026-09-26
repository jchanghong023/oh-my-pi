/**
 * Contract: the CollabHost wires its lifetime to the local host registry
 * (#6099). It publishes exactly once — and only after the relay connection
 * succeeds — serves metadata without links, hands out a link only for its
 * current generation and published access, withdraws on every teardown path
 * (explicit stop, terminal relay close), suspends without withdrawing while
 * another session is provisionally active, keeps hosting when publication
 * fails, and guests joining through the relay never add an entry.
 *
 * The in-memory relay harness (./helpers/in-memory-relay) replaces the real
 * WebSocket so a real CollabHost/CollabSocket run unchanged; a per-test spy on
 * the `publishCollabHost` export redirects discovery metadata into a temp dir,
 * so the registry's real Unix-socket IPC is exercised without touching ~/.omp.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const RELAY_URL = "ws://localhost:8788";
const WEB_URL = "https://collab.example";

/** Mutable, observable surface of a host context fixture. */
interface HostContextState {
	sessionId: string;
	/** Whether the mirrored session is mid-turn; drives the snapshot's `busy`. */
	isStreaming: boolean;
	transition?: Promise<void>;
	showStatus: string[];
	/** Guest prompts the host forwarded into the session. */
	prompts: string[];
	subscribed: ((event: { type: string; [k: string]: unknown }) => void) | null;
	/** Invoked on every `getSessionId()` read, i.e. each time the host checks the session it mirrors. */
	onSessionIdRead: (() => void) | undefined;
	/** Resolves when the host clears its status-line segment, i.e. tore down. */
	tornDown: PromiseWithResolvers<void>;
}

/**
 * Minimal InteractiveModeContext the host needs to `start()` and serve a
 * registry snapshot, plus the handles a test drives: the mutable session id,
 * captured `showStatus` messages, and the session-event subscriber callback.
 */
function makeHostContext(): { ctx: InteractiveModeContext; state: HostContextState } {
	const state: HostContextState = {
		sessionId: `sess-${crypto.randomUUID()}`,
		isStreaming: false,
		showStatus: [],
		prompts: [],
		subscribed: null,
		onSessionIdRead: undefined,
		tornDown: Promise.withResolvers<void>(),
	};
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => {
				state.onSessionIdRead?.();
				return state.sessionId;
			},
			getCwd: () => "/tmp/collab-registry-test",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: state.sessionId,
					timestamp: "2026-07-20T00:00:00Z",
					cwd: "/tmp/collab-registry-test",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			get isSessionTransitioning() {
				return state.transition !== undefined;
			},
			waitForSessionTransition: async () => {
				await state.transition;
			},
			get isStreaming() {
				return state.isStreaming;
			},
			queuedMessageCount: 0,
			sessionName: "registry-test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (cb: HostContextState["subscribed"]) => {
				state.subscribed = cb;
				return () => {};
			},
			emitNotice: () => {},
			promptCustomMessage: (message: { content: unknown }) => {
				state.prompts.push(String(message.content));
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: (status: unknown) => {
				if (status === null) state.tornDown.resolve();
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => {
			state.showStatus.push(message);
		},
		collabHost: undefined,
	};
	return { ctx: ctx as unknown as InteractiveModeContext, state };
}

let tmp: string;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let capturedSockets: FakeWebSocket[] = [];
let host: CollabHost | undefined;
const guestCleanups: (() => void)[] = [];

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hostreg-"));
	installInMemoryRelay();
	// Record every fake socket the host/guests construct so a test can drive a
	// terminal close on the host's transport directly.
	capturedSockets = [];
	const Capturing = class extends FakeWebSocket {
		constructor(url: string) {
			super(url);
			capturedSockets.push(this);
		}
	};
	globalThis.WebSocket = Capturing as unknown as typeof WebSocket;
	// Redirect publication into the temp dir. Captured before the spy so the
	// implementation calls the genuine registry (real Unix-socket IPC).
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		real(source, { ...options, dir: tmp }),
	);
	host = undefined;
});

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	if (host) await host.stop("test cleanup").catch(() => {});
	uninstallInMemoryRelay();
	publishSpy?.mockRestore();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("collab host registry lifecycle (#6099): teardown", () => {
	it("withdraws on a terminal (non-reconnecting) relay close", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);
		// The controller installs a live room here; `/collab` and `/join` read it.
		ctx.collabHost = host;
		expect(await registry.listCollabHosts({ dir: tmp })).toHaveLength(1);

		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		// Code 4001 ("room closed") is classified fatal/non-reconnecting by
		// relay-client, so the host tears down instead of retrying. The public
		// slot is left at once — before registry withdrawal is awaited — so a
		// concurrent `/collab` cannot re-print the dead room's link.
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		expect(ctx.collabHost).toBeUndefined();

		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("withdraws a publication that completes after a fatal relay close during startup", async () => {
		const { ctx } = makeHostContext();
		// Hold publication open so the relay can die while start() awaits it;
		// `publishing` resolves once the host actually entered that await.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const publishing = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		publishSpy.mockImplementation(async provider => {
			publishing.resolve();
			await gate.promise;
			return redirected(provider);
		});
		host = new CollabHost(ctx);
		const started = host.start(RELAY_URL, WEB_URL);
		await publishing.promise;

		const hostSocket = capturedSockets.find(s => s.role === "host");
		if (!hostSocket) throw new Error("host transport socket was never created");
		hostSocket.onclose?.({ code: 4001, reason: "room closed" });
		gate.resolve();

		// Startup fails instead of handing back a dead host, and the late
		// publication is withdrawn rather than left discoverable.
		await expect(started).rejects.toThrow(/closed during startup/);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("mirrors activity to a guest who joined while registry publication was still pending", async () => {
		const { ctx, state } = makeHostContext();
		// Hold publication open: the relay is up and the link is visible (an
		// auto-started room is installed before start() resolves), so a guest
		// can join now and must not miss what happens before publication lands.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const publishing = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		publishSpy.mockImplementation(async (source, options) => {
			publishing.resolve();
			await gate.promise;
			return redirected(source, options);
		});
		host = new CollabHost(ctx);
		const started = host.start(RELAY_URL, WEB_URL);
		await publishing.promise;

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		guestCleanups.push(() => guest.close());
		const welcomed = Promise.withResolvers<void>();
		const seen: string[] = [];
		const after = Promise.withResolvers<void>();
		guest.onFrame = frame => {
			if (frame.t === "welcome") welcomed.resolve();
			if (frame.t === "event" && frame.event.type === "notice") {
				seen.push(frame.event.message);
				if (frame.event.message === "after publication") after.resolve();
			}
		};
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "early-guest" });
		guest.connect();
		await welcomed.promise;

		// Session activity during the pending publication …
		state.subscribed?.({ type: "notice", level: "info", message: "during publication", source: "test" });
		gate.resolve();
		await started;
		// … and after it; frames arrive in send order, so if the first one had
		// been mirrored at all it precedes the second.
		state.subscribed?.({ type: "notice", level: "info", message: "after publication", source: "test" });
		await after.promise;

		expect(seen).toEqual(["during publication", "after publication"]);
	});

	it("stop() resolves only after a publication still in flight has been withdrawn", async () => {
		const { ctx, state } = makeHostContext();
		// Model production timing: the room is stopped (session switch) while the
		// registry work is still ahead of it. The gate opens from the host's own
		// teardown, so publication completes strictly after the room ended.
		const redirected = publishSpy.getMockImplementation();
		if (!redirected) throw new Error("publish spy has no implementation");
		const events: string[] = [];
		const publishing = Promise.withResolvers<void>();
		publishSpy.mockImplementation(async (source, options) => {
			publishing.resolve();
			await state.tornDown.promise;
			const publication = await redirected(source, options);
			const close = publication.close.bind(publication);
			publication.close = () => {
				// close() is idempotent and both teardown and the aborted start call it.
				if (!events.includes("withdrawn")) events.push("withdrawn");
				return close();
			};
			return publication;
		});
		host = new CollabHost(ctx, { instanceId: "reused-endpoint" });
		const started = host.start(RELAY_URL, WEB_URL);
		await publishing.promise;

		await host.stop("session switched").then(() => events.push("stopped"));
		await started.catch(() => {});

		// The successor room (same instance id, same endpoint path) can only be
		// started safely if the withdrawal happened before stop() resolved.
		expect(events).toEqual(["withdrawn", "stopped"]);
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
		const successor = new CollabHost(ctx, { instanceId: "reused-endpoint", generation: 2 });
		await successor.start(RELAY_URL, WEB_URL);
		expect((await registry.listCollabHosts({ dir: tmp })).map(h => h.generation)).toEqual([2]);
		await successor.stop("done");
	});

	it("keeps hosting when publication fails, surfacing a discovery warning", async () => {
		const { ctx, state } = makeHostContext();
		// Publication rejects; start() must still resolve and hosting continue.
		publishSpy.mockImplementation(() => Promise.reject(new Error("registry write failed")));
		host = new CollabHost(ctx);

		await host.start(RELAY_URL, WEB_URL);

		expect(host.link.length).toBeGreaterThan(0);
		expect(host.webLink.length).toBeGreaterThan(0);
		expect(host.participants.length).toBeGreaterThanOrEqual(1);
		// The failure is surfaced to the user via the fixture-observable seam.
		expect(state.showStatus.some(m => /discovery unavailable/i.test(m))).toBe(true);

		// Teardown is still clean even though nothing was published.
		await host.stop("done");
		expect(await registry.listCollabHosts({ dir: tmp })).toEqual([]);
	});

	it("never publishes for guests joining through the relay", async () => {
		const { ctx } = makeHostContext();
		host = new CollabHost(ctx);
		await host.start(RELAY_URL, WEB_URL);

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => socket.close());

		const joined = Promise.withResolvers<void>();
		socket.onFrame = frame => {
			if (frame.t === "welcome") joined.resolve();
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
		socket.connect();
		await joined.promise;

		// The guest is a real relay peer, but joining published nothing extra:
		// only the host's single entry exists.
		expect(host.participants.length).toBeGreaterThanOrEqual(2);
		expect(publishSpy).toHaveBeenCalledTimes(1);
		const jsonFiles = (await fs.readdir(tmp)).filter(name => name.endsWith(".json"));
		expect(jsonFiles).toHaveLength(1);
	});
});
