import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setImmediate } from "node:timers/promises";
import type {
	AgentSnapshot,
	AssistantMessage,
	GuestFrame,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { open, seal } from "../src/lib/codec";
import { COLLAB_PROTO, encodeBase64Url, packEnvelope, unpackEnvelope } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(entryCount = 0, readOnly?: boolean): HostFrame {
	return { t: "welcome", proto: COLLAB_PROTO, header: HEADER, state: STATE, agents: AGENTS, entryCount, readOnly };
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = []): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}

describe("GuestClient frame apply", () => {
	it("throws on an invalid link", () => {
		expect(() => new GuestClient("not a link", "tester")).toThrow();
	});

	it("welcome populates the snapshot and goes live", () => {
		const userEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const client = liveClient([userEntry]);
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.header).toEqual(HEADER);
		expect(snap.entries).toEqual([userEntry]);
		expect(snap.state).toEqual(STATE);
		expect(snap.agents).toEqual(AGENTS);
		expect(snap.working).toBe(false);
		expect(snap.stream).toBeNull();
		expect(snap.activeTools.size).toBe(0);
	});

	it("welcome readOnly flag lands in the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(false);
		client.applyFrameForTest(welcomeFrame(0, true));
		expect(client.getSnapshot().readOnly).toBe(true);
	});

	it("times out stalled snapshot chunks and resets the clock on progress", () => {
		vi.useFakeTimers();
		try {
			const firstEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(2));
			expect(client.getSnapshot().phase).toBe("waiting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("waiting");
			client.applyFrameForTest(snapshotChunk([firstEntry], false));
			expect(client.getSnapshot().entries).toEqual([]);
			expect(client.getSnapshot().phase).toBe("waiting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("waiting");
			vi.advanceTimersByTime(1);
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("ended");
			expect(snap.endedReason).toBe("timed out waiting for the host's session snapshot");

			const completeClient = new GuestClient(LINK, "tester");
			completeClient.applyFrameForTest(welcomeFrame(1));
			completeClient.applyFrameForTest(snapshotChunk([firstEntry]));
			vi.advanceTimersByTime(30_000);
			expect(completeClient.getSnapshot().phase).toBe("live");
			expect(completeClient.getSnapshot().entries).toEqual([firstEntry]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the transcript on screen through a resync and swaps it in on the final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "again", timestamp: 2 });
		const client = liveClient([e1]);

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		expect(client.getSnapshot().entries).toEqual([e1]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("publishes live entries that arrive mid-snapshot after the snapshot, not inside it", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const live = messageEntry("live", { role: "user", content: "live", timestamp: 3 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "entry", entry: live });
		expect(client.getSnapshot().entries).toEqual([]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2, live]);
	});

	it("drops the finished stream ghost when its entry lands mid-snapshot", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const message = assistantMessage("hello");
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		client.applyFrameForTest({ t: "entry", entry: messageEntry("a1", message) });
		client.applyFrameForTest(snapshotChunk([e2]));

		const snap = client.getSnapshot();
		expect(snap.entries).toEqual([e1, e2, messageEntry("a1", message)]);
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
	});

	it("completes the snapshot once every promised entry arrived, even without a final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1, e2], false));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
	});

	it("message_update sets the stream ghost (synthesizing a missed start)", () => {
		const client = liveClient();
		const partial = assistantMessage("hel");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message: partial } });
		const snap = client.getSnapshot();
		expect(snap.stream).toEqual(partial);
		expect(snap.streamDone).toBe(false);
	});

	it("message_end keeps the ghost until the matching entry lands", () => {
		const client = liveClient();
		const message = assistantMessage("hello");
		client.applyFrameForTest({ t: "event", event: { type: "message_update", message } });
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		let snap = client.getSnapshot();
		expect(snap.streamDone).toBe(true);
		expect(snap.stream).toEqual(message);

		client.applyFrameForTest({ t: "entry", entry: messageEntry("e2", message) });
		snap = client.getSnapshot();
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
		expect(snap.entries).toHaveLength(1);
	});

	it("tool start/update/end maintains activeTools", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		let tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.toolName).toBe("bash");
		expect(tool?.intent).toBe("Listing");

		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: "src",
			},
		});
		tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.partialResult).toBe("src");

		client.applyFrameForTest({
			t: "event",
			event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "src\ntest" },
		});
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("agent_start/agent_end and state reconcile the working flag", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot().working).toBe(true);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().working).toBe(false);
	});
	it("a state frame recovers a stuck-idle guest when agent_start was dropped", () => {
		// The host begins streaming mid-turn, but the matching `agent_start`
		// never arrived (e.g. dropped on a reconnect). Before the fix nothing
		// set `working` true except `agent_start`, so the guest stayed idle.
		const client = liveClient();
		expect(client.getSnapshot().working).toBe(false);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } });
		expect(client.getSnapshot().working).toBe(true);
	});

	it("an idle state frame clears a pinned tool card when tool_execution_end was dropped", () => {
		// Host reports idle, but the matching `tool_execution_end` was dropped,
		// leaving a stuck tool card. The authoritative idle signal must clear it.
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		expect(client.getSnapshot().activeTools.size).toBe(1);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("bus progress frames update the progress map", () => {
		const client = liveClient();
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			task: "do things",
			progress: {
				index: 0,
				id: "Sub1",
				agent: "task",
				status: "running",
				task: "do things",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 100,
				cost: 0.01,
				durationMs: 1000,
			},
		};
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload });
		expect(client.getSnapshot().progress.get("Sub1")).toEqual(payload);
	});

	it("bye keeps the page alive for the replacement room instead of ending it", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "bye", reason: "session switched" });
		const snap = client.getSnapshot();
		// The relay closes this socket and the same link rejoins the host's new
		// room: the page must stay in the reconnect loop, not the ended state.
		expect(snap.phase).toBe("reconnecting");
		expect(snap.endedReason).toBeNull();
		expect(snap.notices.at(-1)).toMatchObject({ level: "info", message: "session switched" });
	});

	it("commands frames publish the palette the host advertised", () => {
		const client = liveClient();
		expect(client.getSnapshot().commands).toEqual([]);
		const commands = [
			{ name: "dump", description: "Return full transcript", input: { hint: "[raw]" } },
			{ name: "skill:reviewer", aliases: ["review"] },
		];
		client.applyFrameForTest({ t: "commands", commands });
		expect(client.getSnapshot().commands).toEqual(commands);
	});

	it("a reconnect welcome drops the previous room's palette until the new one arrives", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "commands", commands: [{ name: "dump" }] });
		expect(client.getSnapshot().commands).toHaveLength(1);

		client.applyFrameForTest(welcomeFrame());
		expect(client.getSnapshot().commands).toEqual([]);
	});

	it("fetchDirSuggestions round-trips a browse-dirs request", async () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = liveClient();
			const pending = client.fetchDirSuggestions("sub");
			const request = sent[0];
			if (request?.t !== "browse-dirs") throw new Error(`expected browse-dirs, got ${request?.t}`);
			expect(request.prefix).toBe("sub");

			client.applyFrameForTest({
				t: "dir-suggestions",
				reqId: request.reqId,
				entries: [{ path: "/tmp/sub", label: "sub/" }],
			});
			expect(await pending).toEqual([{ path: "/tmp/sub", label: "sub/" }]);
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("fetchDirSuggestions resolves null when the host never answers", async () => {
		vi.useFakeTimers();
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
		try {
			const client = liveClient();
			const pending = client.fetchDirSuggestions("");
			vi.advanceTimersByTime(10_000);
			expect(await pending).toBeNull();
		} finally {
			sendSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("never requests host directories through a view link or while disconnected", async () => {
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
		try {
			const viewer = new GuestClient(LINK, "viewer");
			viewer.applyFrameForTest(welcomeFrame(0, true));
			expect(await viewer.fetchDirSuggestions("")).toBeNull();
			viewer.sendPrompt("unauthorized");
			viewer.sendAbort();
			viewer.sendAgentCmd("kill", "main");
			viewer.sendUiResponse(1, "unauthorized");
			const writer = liveClient();
			writer.applyFrameForTest({ t: "bye", reason: "rotated" });
			expect(await writer.fetchDirSuggestions("")).toBeNull();
			expect(sendSpy).not.toHaveBeenCalled();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("settles directory requests when the page is explicitly closed", async () => {
		const client = liveClient();
		const pending = client.fetchDirSuggestions("sub");
		client.close();
		expect(await pending).toBeNull();
		expect(client.getSnapshot().phase).toBe("ended");
	});

	it("a bye during a partial snapshot clears its timer, palette and old dialogs", () => {
		vi.useFakeTimers();
		try {
			const client = liveClient();
			client.applyFrameForTest(welcomeFrame(2));
			client.applyFrameForTest({ t: "commands", commands: [{ name: "old-command" }] });
			client.applyFrameForTest({ t: "ui-request", request: { reqId: 1, kind: "editor", title: "Old dialog" } });
			client.applyFrameForTest({ t: "bye", reason: "rotated" });
			expect(client.getSnapshot()).toMatchObject({
				phase: "reconnecting",
				uiRequest: null,
				commands: [],
				loading: null,
			});
			vi.advanceTimersByTime(30_000);
			expect(client.getSnapshot().phase).toBe("reconnecting");
			client.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("disables prompting while a replacement welcome is still downloading", () => {
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
		const client = liveClient();
		try {
			client.applyFrameForTest(welcomeFrame(2));
			client.sendPrompt("during resync");
			expect(client.getSnapshot().phase).toBe("waiting");
			expect(sendSpy).not.toHaveBeenCalled();
		} finally {
			client.close();
			sendSpy.mockRestore();
		}
	});

	it("error frames append notices", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "error", message: "boom" });
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "boom" });
	});

	it("auto_retry_end failure surfaces an error notice", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "x" },
		});
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "x" });
	});

	it("a pre-welcome error (hello rejection, e.g. protocol mismatch) ends the session with the host's reason", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest({
			t: "error",
			message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${COLLAB_PROTO - 1}`,
		});
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toContain("protocol mismatch");
		expect(snap.endedReason).toContain(`v${COLLAB_PROTO}`);
	});

	it("tracks host UI requests and sends responses", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = liveClient();
			const request = {
				reqId: 7,
				kind: "select" as const,
				title: "Continue?",
				options: ["Yes", { label: "No", description: "Stop here" }],
				selectionMarker: "radio" as const,
			};
			client.applyFrameForTest({ t: "ui-request", request });
			expect(client.getSnapshot().uiRequest).toEqual(request);

			client.sendUiResponse(7, "Yes");
			expect(sent).toEqual([{ t: "ui-response", reqId: 7, value: "Yes" }]);
			expect(client.getSnapshot().uiRequest).toBeNull();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("clears pending host UI requests when the host ends them", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Other", prefill: "draft" },
		});
		expect(client.getSnapshot().uiRequest?.reqId).toBe(8);
		client.applyFrameForTest({ t: "ui-request-end", reqId: 8 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("queues overlapping host UI requests until the active one resolves", () => {
		const client = liveClient();
		const first = { reqId: 9, kind: "select" as const, title: "First?", options: ["A"] };
		const second = { reqId: 10, kind: "editor" as const, title: "Second?", prefill: "draft" };
		client.applyFrameForTest({ t: "ui-request", request: first });
		client.applyFrameForTest({ t: "ui-request", request: second });
		expect(client.getSnapshot().uiRequest).toEqual(first);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 9 });
		expect(client.getSnapshot().uiRequest).toEqual(second);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 10 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("resends update one active or queued dialog instead of asking the same question twice", () => {
		const client = liveClient();
		const first = { reqId: 1, kind: "editor" as const, title: "First", prefill: "draft" };
		const second = { reqId: 2, kind: "select" as const, title: "Second", options: ["Yes"] };
		for (const request of [first, first, second, { ...second, options: ["No"] }]) {
			client.applyFrameForTest({ t: "ui-request", request });
		}
		client.applyFrameForTest({ t: "ui-request-end", reqId: 1 });
		expect(client.getSnapshot().uiRequest).toEqual({ ...second, options: ["No"] });
		client.applyFrameForTest({ t: "ui-request-end", reqId: 2 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("does not send cancelled or old-room UI responses to a replacement host", () => {
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => {});
		try {
			const client = liveClient();
			client.applyFrameForTest({ t: "ui-request", request: { reqId: 1, kind: "editor", title: "Old" } });
			client.applyFrameForTest({ t: "ui-request-end", reqId: 1 });
			client.sendUiResponse(1, "late");
			client.applyFrameForTest({ t: "bye", reason: "rotated" });
			client.sendUiResponse(1, "late");
			client.sendPrompt("stale");
			client.sendAgentCmd("kill", "main");
			client.sendAbort();
			expect(sendSpy).not.toHaveBeenCalled();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("snapshot reference is stable between frames and replaced per frame", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		const after = client.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.agents).not.toBe(before.agents);
		// Non-entry frames must not invalidate entry identity: Transcript's
		// memo and useSyncExternalStore skip their O(n) scans per token.
		expect(after.entries).toBe(before.entries);
	});

	it("replaces the entries reference when entry frames arrive", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "entry",
			entry: {
				type: "message",
				id: "m-new",
				parentId: null,
				timestamp: "2026-06-12T00:00:02Z",
				message: { role: "user", content: "hi", timestamp: 2 },
			},
		});
		const after = client.getSnapshot();
		expect(after.entries).not.toBe(before.entries);
		expect(after.entries).toHaveLength(before.entries.length + 1);
	});
});

describe("browser connection generation fences", () => {
	const nativeWebSocket = globalThis.WebSocket;
	const clients: GuestClient[] = [];
	const sockets: CollabSocket[] = [];
	class TestWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		static instances: TestWebSocket[] = [];
		readyState = TestWebSocket.CONNECTING;
		binaryType = "arraybuffer";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onclose: ((event: CloseEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		sent: Uint8Array[] = [];
		received = Promise.withResolvers<Uint8Array>();

		constructor(readonly url: string) {
			TestWebSocket.instances.push(this);
		}
		open(): void {
			this.readyState = TestWebSocket.OPEN;
			this.onopen?.(new Event("open"));
		}
		send(bytes: Uint8Array): void {
			this.sent.push(bytes);
			this.received.resolve(bytes);
		}
		deliver(bytes: Uint8Array): void {
			this.onmessage?.(new MessageEvent("message", { data: bytes.slice().buffer }));
		}
		close(code = 1000, reason = "closed"): void {
			this.readyState = TestWebSocket.CLOSED;
			this.onclose?.(new CloseEvent("close", { code, reason }));
		}
	}

	beforeEach(() => {
		TestWebSocket.instances = [];
		globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
	});
	afterEach(() => {
		for (const client of clients.splice(0)) client.close();
		for (const socket of sockets.splice(0)) socket.close();
		globalThis.WebSocket = nativeWebSocket;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("settles old-room round trips and dialogs after an unexpected transport drop", async () => {
		vi.useFakeTimers();
		const client = new GuestClient(LINK, "writer");
		clients.push(client);
		client.connect();
		TestWebSocket.instances[0]!.open();
		client.applyFrameForTest(welcomeFrame());
		client.applyFrameForTest({ t: "commands", commands: [{ name: "old" }] });
		client.applyFrameForTest({ t: "ui-request", request: { reqId: 1, kind: "editor", title: "Old" } });
		const dirs = client.fetchDirSuggestions("sub");
		const transcript = client.fetchTranscript("subagent", 0);
		TestWebSocket.instances[0]!.close(1006, "network drop");
		expect(await dirs).toBeNull();
		expect(await transcript).toBeNull();
		expect(client.getSnapshot()).toMatchObject({ phase: "reconnecting", uiRequest: null, commands: [] });
	});

	it("drops a dialog response still being sealed when its connection is replaced", async () => {
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
		const encryption = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, data) => {
			entered.resolve();
			await release.promise;
			return encrypt(algorithm, key, data);
		});
		const socket = new CollabSocket({ wsUrl: "ws://localhost/r/roomroomroom1234", role: "guest", key });
		sockets.push(socket);
		try {
			socket.connect();
			const old = TestWebSocket.instances[0]!;
			old.open();
			socket.send({ t: "ui-response", reqId: 1, value: "old answer" });
			await entered.promise;
			socket.close();
			socket.connect();
			const replacement = TestWebSocket.instances[1]!;
			replacement.open();
			socket.send({ t: "hello", name: "writer", proto: COLLAB_PROTO });
			release.resolve();
			const envelope = await replacement.received.promise;
			const unpacked = unpackEnvelope(envelope);
			if (!unpacked) throw new Error("encrypted browser send is missing its envelope");
			const frame = await open(key, unpacked.payload);
			expect(frame).toMatchObject({ t: "hello" });
			await setImmediate();
			expect(old.sent).toEqual([]);
			expect(replacement.sent).toHaveLength(1);
		} finally {
			release.resolve();
			encryption.mockRestore();
		}
	});

	it("ignores a late decryption failure from the dropped socket instead of ending the new one", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const bytes = packEnvelope(1, await seal(key, welcomeFrame()));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		let first = true;
		const decryption = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (algorithm, key, data) => {
			if (!first) return decrypt(algorithm, key, data);
			first = false;
			entered.resolve();
			await release.promise;
			throw new Error("old corrupted frame");
		});
		const socket = new CollabSocket({ wsUrl: "ws://localhost/r/roomroomroom1234", role: "guest", key });
		sockets.push(socket);
		const welcome = Promise.withResolvers<HostFrame>();
		socket.onFrame = frame => welcome.resolve(frame);
		try {
			socket.connect();
			const old = TestWebSocket.instances[0]!;
			old.open();
			old.deliver(bytes);
			await entered.promise;
			old.close(1006, "dropped");
			vi.advanceTimersByTime(1_000);
			const replacement = TestWebSocket.instances[1]!;
			replacement.open();
			release.resolve();
			replacement.deliver(bytes);
			expect((await welcome.promise).t).toBe("welcome");
			expect(socket.isOpen).toBe(true);
		} finally {
			release.resolve();
			decryption.mockRestore();
		}
	});
});
