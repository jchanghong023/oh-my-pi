/**
 * Contract: text a guest submits through `prompt` is dispatched on the host by
 * shape, not forwarded to the model — slash commands (builtins, `/skill:<name>`,
 * extension/custom commands), `!`/`!!` shell, and `$`/`$$` python run on the
 * host machine, an unknown command comes back as a targeted error, and only
 * free text keeps the `collab-prompt` path. `/move` directory suggestions are
 * served from the host filesystem to writable guests only.
 *
 * Runs over the in-process relay + fake WebSocket transport (real AES-GCM
 * sealing, real CollabHost/CollabSocket) with a stubbed TUI context, so the
 * wire frames and the dispatch decisions are both exercised end to end.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
// Registers the capability providers `buildAvailableSlashCommands` reads the
// host's palette from (builtins + file commands under the session cwd).
import "@oh-my-pi/pi-coding-agent/discovery";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface HostHarness {
	ctx: InteractiveModeContext;
	/** Prompts that reached the mirrored session as collab messages. */
	prompts: { text: string; from?: string }[];
	/** Inputs handed to `AgentSession.prompt` (extension/custom commands). */
	modelPrompts: string[];
	/** `!`/`!!` submissions, as the editor would have run them. */
	bash: { command: string; isExcluded: boolean }[];
	/** `$`/`$$` submissions. */
	python: { code: string; isExcluded: boolean }[];
	nextPrompt(): Promise<{ text: string; from?: string }>;
	nextBash(): Promise<{ command: string; isExcluded: boolean }>;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || !("text" in block)) continue;
		if (block.type !== "text" || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("");
}

/** Minimal InteractiveModeContext double: only the members the host and dispatch touch. */
function makeHostContext(cwd: string): HostHarness {
	const prompts: { text: string; from?: string }[] = [];
	const modelPrompts: string[] = [];
	const bash: { command: string; isExcluded: boolean }[] = [];
	const python: { code: string; isExcluded: boolean }[] = [];
	const promptWaiters: ((value: { text: string; from?: string }) => void)[] = [];
	const bashWaiters: ((value: { command: string; isExcluded: boolean }) => void)[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-guest-commands",
			getCwd: () => cwd,
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-guest-commands", timestamp: new Date().toISOString(), cwd },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			sessionName: "guest-commands",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			// Palette sources: no extension runner, no custom commands, no skills.
			customCommands: [],
			skills: [],
			setSlashCommands: () => {},
			prompt: (text: string) => {
				modelPrompts.push(text);
				return Promise.resolve(true);
			},
			promptCustomMessage: (message: { content?: unknown; details?: { from?: string } }) => {
				const record = { text: messageText(message.content), from: message.details?.from };
				prompts.push(record);
				for (const waiter of promptWaiters.splice(0)) waiter(record);
				return Promise.resolve(true);
			},
			abort: () => Promise.resolve(),
		},
		handleBashCommand: (command: string, isExcluded = false) => {
			const record = { command, isExcluded };
			bash.push(record);
			for (const waiter of bashWaiters.splice(0)) waiter(record);
			return Promise.resolve();
		},
		handlePythonCommand: (code: string, isExcluded = false) => {
			python.push({ code, isExcluded });
			return Promise.resolve();
		},
		refreshSlashCommandState: () => Promise.resolve(),
		editor: { setText: () => {}, addToHistory: () => {} },
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const nextPrompt = (): Promise<{ text: string; from?: string }> => {
		const { promise, resolve } = Promise.withResolvers<{ text: string; from?: string }>();
		promptWaiters.push(resolve);
		return promise;
	};
	const nextBash = (): Promise<{ command: string; isExcluded: boolean }> => {
		const { promise, resolve } = Promise.withResolvers<{ command: string; isExcluded: boolean }>();
		bashWaiters.push(resolve);
		return promise;
	};
	return { ctx, prompts, modelPrompts, bash, python, nextPrompt, nextBash };
}

/**
 * Frames this harness ignores: debounced broadcasts (state/agents/entry/event/
 * bus) and the snapshot train that follows every welcome. `commands` is kept —
 * tests await it to know the palette reached the guest.
 */
const NOISE_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (NOISE_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

/** Join, then consume the welcome and the palette the host sends after it. */
async function joinReady(link: string, name: string): Promise<TestGuest> {
	const guest = await joinAsGuest(link, name);
	guestCleanups.push(() => guest.socket.close());
	const welcome = await guest.nextFrame();
	if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
	const commands = await guest.nextFrame();
	if (commands.t !== "commands") throw new Error(`expected commands, got ${commands.t}`);
	// Builtins come from the code-level registry, so a missing `move` means the
	// palette build failed and dispatch fell back to permissive mode.
	expect(commands.commands.map(command => command.name)).toContain("move");
	return guest;
}

const guestCleanups: (() => void)[] = [];
let tmp: string;
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-commands-"));
	await fs.mkdir(path.join(tmp, "subdir"));
	harness = makeHostContext(tmp);
	host = new CollabHost(harness.ctx);
	// Port is irrelevant: the fake transport routes by the `role` query param.
	await host.start("ws://localhost:8789");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.prompts.length = 0;
	harness.modelPrompts.length = 0;
	harness.bash.length = 0;
	harness.python.length = 0;
});

afterAll(async () => {
	// Restore the real transport first so the global is clean even if stop() throws.
	uninstallInMemoryRelay();
	await host.stop("test done");
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("collab guest commands", () => {
	it("answers an unknown slash command with a targeted error instead of prompting the model", async () => {
		const guest = await joinReady(host.link, "writer");

		guest.socket.send({ t: "prompt", text: "/nosuchcmd" });
		const reply = await guest.nextFrame();

		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("unknown command");
		expect(reply.message).toContain("nosuchcmd");
		expect(harness.prompts).toEqual([]);
		expect(harness.modelPrompts).toEqual([]);
	});

	it("keeps plain text on the collab-prompt path", async () => {
		const guest = await joinReady(host.link, "writer");
		const prompted = harness.nextPrompt();

		guest.socket.send({ t: "prompt", text: "hello" });
		const prompt = await prompted;

		expect(prompt.text).toBe("hello");
		expect(prompt.from).toBe("writer");
	});

	it("runs guest shell submissions on the host with the editor's exclusion semantics", async () => {
		const guest = await joinReady(host.link, "writer");

		const plain = harness.nextBash();
		guest.socket.send({ t: "prompt", text: "!echo hi" });
		expect(await plain).toEqual({ command: "echo hi", isExcluded: false });

		const excluded = harness.nextBash();
		guest.socket.send({ t: "prompt", text: "!!echo secret" });
		expect(await excluded).toEqual({ command: "echo secret", isExcluded: true });

		expect(harness.prompts).toEqual([]);
		expect(harness.modelPrompts).toEqual([]);
	});

	it("serves /move directory candidates to writable guests", async () => {
		const guest = await joinReady(host.link, "writer");

		guest.socket.send({ t: "browse-dirs", reqId: 7, prefix: "sub" });
		const reply = await guest.nextFrame();

		if (reply.t !== "dir-suggestions") throw new Error(`expected dir-suggestions, got ${reply.t}`);
		expect(reply.reqId).toBe(7);
		expect(reply.entries).toEqual([{ path: path.join(tmp, "subdir"), label: "subdir/" }]);
		expect(path.isAbsolute(reply.entries[0]!.path)).toBe(true);
	});

	it("refuses directory listings on a read-only link", async () => {
		const guest = await joinReady(host.viewLink, "viewer");

		guest.socket.send({ t: "browse-dirs", reqId: 8, prefix: "" });
		const reply = await guest.nextFrame();

		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("read-only link");
	});
});
