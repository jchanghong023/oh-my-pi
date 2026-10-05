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
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as skillCommand from "@oh-my-pi/pi-coding-agent/modes/skill-command";
import type { AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as availableCommands from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
// Registers the capability providers `buildAvailableSlashCommands` reads the
// host's palette from (builtins + file commands under the session cwd).
import "@oh-my-pi/pi-coding-agent/discovery";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface HostHarness {
	ctx: InteractiveModeContext;
	state: { sessionId: string; cwd: string; isStreaming: boolean; draft: string };
	/** Prompts that reached the mirrored session as collab messages. */
	prompts: { text: string; from?: string }[];
	/** Inputs handed to `AgentSession.prompt` (extension/custom commands). */
	modelPrompts: string[];
	modelPromptOptions: (PromptOptions | undefined)[];
	/** `!`/`!!` submissions, as the editor would have run them. */
	bash: { command: string; isExcluded: boolean }[];
	/** `$`/`$$` submissions. */
	python: { code: string; isExcluded: boolean }[];
	/** TUI-only handlers the guest dispatcher reached, by command name. */
	tui: string[];
	nextPrompt(): Promise<{ text: string; from?: string }>;
	nextBash(): Promise<{ command: string; isExcluded: boolean }>;
	nextTui(): Promise<string>;
	nextPython(): Promise<{ code: string; isExcluded: boolean }>;
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
function makeHostContext(cwd: string, settings: InteractiveModeContext["settings"]): HostHarness {
	const prompts: { text: string; from?: string }[] = [];
	const state = { sessionId: "sess-guest-commands", cwd, isStreaming: false, draft: "host draft" };
	const modelPrompts: string[] = [];
	const modelPromptOptions: (PromptOptions | undefined)[] = [];
	const bash: { command: string; isExcluded: boolean }[] = [];
	const python: { code: string; isExcluded: boolean }[] = [];
	const tui: string[] = [];
	const promptWaiters: ((value: { text: string; from?: string }) => void)[] = [];
	const bashWaiters: ((value: { command: string; isExcluded: boolean }) => void)[] = [];
	const tuiWaiters: ((value: string) => void)[] = [];
	const pythonWaiters: ((value: { code: string; isExcluded: boolean }) => void)[] = [];
	let subscribed: ((event: AgentSessionEvent) => void) | undefined;
	const ctx = {
		// A real (in-memory) settings handle: the settings registry's
		// derivations (`cfgCollabDisplayName` et al.) require a registered
		// scope, and a bare `{ get }` stub reads as `undefined`.
		settings,
		sessionManager: {
			getSessionId: () => state.sessionId,
			getCwd: () => state.cwd,
			snapshotForReplication: () => ({
				header: { type: "session", id: state.sessionId, timestamp: new Date().toISOString(), cwd: state.cwd },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			get isStreaming() {
				return state.isStreaming;
			},
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			sessionName: "guest-commands",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (callback: (event: AgentSessionEvent) => void) => {
				subscribed = callback;
				return () => {
					subscribed = undefined;
				};
			},
			emitNotice: (level: "info" | "warning" | "error", message: string, source?: string) => {
				subscribed?.({ type: "notice", level, message, source });
			},
			// Palette sources: no extension runner, no custom commands, no skills.
			// `buildAvailableSlashCommands` reads the session's own `sessionManager`.
			sessionManager: { getCwd: () => state.cwd },
			customCommands: [],
			skills: [],
			setSlashCommands: () => {},
			setForcedToolChoice: () => {},
			prompt: (text: string, options?: PromptOptions) => {
				modelPrompts.push(text);
				modelPromptOptions.push(options);
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
			const record = { code, isExcluded };
			python.push(record);
			for (const waiter of pythonWaiters.splice(0)) waiter(record);
			return Promise.resolve();
		},
		// `/new` has no ACP handler: its TUI handler rotates the session on the
		// host screen, which here means reaching this recorder.
		handleClearCommand: () => {
			tui.push("new");
			for (const waiter of tuiWaiters.splice(0)) waiter("new");
			return Promise.resolve();
		},
		handleMoveCommand: (target?: string) => {
			tui.push("move");
			if (target) state.cwd = path.resolve(state.cwd, target);
			for (const waiter of tuiWaiters.splice(0)) waiter("move");
			return Promise.resolve();
		},
		showModelSelector: () => {
			tui.push("model");
			for (const waiter of tuiWaiters.splice(0)) waiter("model");
		},
		handleResetContextCommand: () => {
			tui.push("clear");
			for (const waiter of tuiWaiters.splice(0)) waiter("clear");
			return Promise.resolve();
		},
		showOAuthSelector: (mode: "login" | "logout", provider?: string) => {
			const action = `${mode}:${provider ?? "select-provider"}`;
			tui.push(action);
			for (const waiter of tuiWaiters.splice(0)) waiter(action);
			return Promise.resolve();
		},
		skillCommands: new Map<string, Skill>(),
		refreshSlashCommandState: () => Promise.resolve(),
		editor: {
			setText: (text: string) => {
				state.draft = text;
			},
			addToHistory: () => {},
		},
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
	const nextTui = (): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		tuiWaiters.push(resolve);
		return promise;
	};
	const nextPython = (): Promise<{ code: string; isExcluded: boolean }> => {
		const { promise, resolve } = Promise.withResolvers<{ code: string; isExcluded: boolean }>();
		pythonWaiters.push(resolve);
		return promise;
	};
	return {
		ctx,
		state,
		prompts,
		modelPrompts,
		modelPromptOptions,
		bash,
		python,
		tui,
		nextPrompt,
		nextBash,
		nextTui,
		nextPython,
	};
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
	nextNotice(): Promise<string>;
}

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	const noticeWaiters: ((message: string) => void)[] = [];
	socket.onFrame = frame => {
		if (frame.t === "event" && frame.event.type === "notice") {
			const waiter = noticeWaiters.shift();
			if (waiter) waiter(frame.event.message);
		}
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
	const nextNotice = (): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		noticeWaiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame, nextNotice };
}

/** Join, then consume the welcome and the palette the host sends after it. */
async function joinReady(link: string, name: string): Promise<TestGuest & { palette: string[] }> {
	const guest = await joinAsGuest(link, name);
	guestCleanups.push(() => guest.socket.close());
	const welcome = await guest.nextFrame();
	if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
	const commands = await guest.nextFrame();
	if (commands.t !== "commands") throw new Error(`expected commands, got ${commands.t}`);
	const palette = commands.commands.map(command => command.name);
	// Builtins come from the code-level registry, so a missing `move` means the
	// palette build failed and dispatch fell back to permissive mode.
	expect(palette).toContain("move");
	return { ...guest, palette };
}

const guestCleanups: (() => void)[] = [];
let tmp: string;
let harness: HostHarness;
let host: CollabHost;
let publishSpy: Mock<typeof registry.publishCollabHost>;

beforeAll(async () => {
	const settings = Settings.isolated();
	installInMemoryRelay();
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-commands-"));
	await fs.mkdir(path.join(tmp, "subdir"));
	const publish = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		publish(source, { ...options, dir: path.join(tmp, "hosts") }),
	);
	harness = makeHostContext(tmp, settings);
	host = new CollabHost(harness.ctx);
	// Port is irrelevant: the fake transport routes by the `role` query param.
	await host.start("ws://localhost:8789");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.prompts.length = 0;
	harness.modelPrompts.length = 0;
	harness.modelPromptOptions.length = 0;
	harness.state.sessionId = "sess-guest-commands";
	harness.state.cwd = tmp;
	harness.state.isStreaming = false;
	harness.state.draft = "host draft";
	harness.ctx.skillCommands.clear();
	harness.bash.length = 0;
	harness.python.length = 0;
	harness.tui.length = 0;
	(harness.ctx.session.customCommands as LoadedCustomCommand[]).length = 0;
});

afterAll(async () => {
	// Restore the real transport first so the global is clean even if stop() throws.
	uninstallInMemoryRelay();
	try {
		await host.stop("test done");
	} finally {
		publishSpy.mockRestore();
		await fs.rm(tmp, { recursive: true, force: true });
	}
});

describe("collab guest commands", () => {
	it("refreshes the palette when a guest rejoins after commands change", async () => {
		const first = await joinReady(host.link, "writer-before");
		expect(first.palette).not.toContain("fresh-command");
		(harness.ctx.session.customCommands as LoadedCustomCommand[]).push({
			command: { name: "fresh-command", description: "Added after the first join" },
		} as LoadedCustomCommand);

		const second = await joinReady(host.link, "writer-after");
		expect(second.palette).toContain("fresh-command");
		second.socket.send({ t: "prompt", text: "/fresh-command" });
		for (let attempt = 0; attempt < 50 && harness.modelPrompts.length === 0; attempt++) await Bun.sleep(10);
		expect(harness.modelPrompts).toEqual(["/fresh-command"]);
	});

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

	it("rejects arguments on an argument-free builtin instead of sending it to the model", async () => {
		const guest = await joinReady(host.link, "writer");
		guest.socket.send({ t: "prompt", text: "/new unwanted-args" });
		expect(await guest.nextFrame()).toMatchObject({ t: "error", message: "invalid arguments for /new" });
		expect(harness.prompts).toEqual([]);
		expect(harness.modelPrompts).toEqual([]);
		expect(harness.tui).toEqual([]);
	});

	it("does not allow a failed command inventory to forward unknown slash text to the model", async () => {
		const palette = spyOn(availableCommands, "buildAvailableSlashCommands").mockRejectedValue(
			new Error("palette unavailable"),
		);
		try {
			const guest = await joinAsGuest(host.link, "writer");
			guestCleanups.push(() => guest.socket.close());
			expect((await guest.nextFrame()).t).toBe("welcome");
			guest.socket.send({ t: "prompt", text: "/nosuchcmd" });
			const reply = await guest.nextFrame();
			expect(reply).toMatchObject({ t: "error" });
			if (reply.t !== "error") throw new Error("expected command failure");
			expect(reply.message).toContain("palette unavailable");
			expect(harness.modelPrompts).toEqual([]);
		} finally {
			palette.mockRestore();
		}
	});

	it("keeps residual command text out of the model after the expansion limit", async () => {
		const guest = await joinReady(host.link, "writer");
		guest.socket.send({ t: "prompt", text: `${"/force bash ".repeat(4)}/nosuchcmd` });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error("expected command expansion error");
		expect(reply.message).toContain("command expansion exceeded");
		expect(harness.prompts).toEqual([]);
		expect(harness.modelPrompts).toEqual([]);
	});

	it("steers file and custom command prompts when the host is already streaming", async () => {
		(harness.ctx.session.customCommands as LoadedCustomCommand[]).push({
			command: { name: "during-turn", description: "Prompt during a turn" },
		} as LoadedCustomCommand);
		const guest = await joinReady(host.link, "writer");
		harness.state.isStreaming = true;
		guest.socket.send({ t: "prompt", text: "/during-turn" });
		await guest.socket.flush();
		// Host-side frame decryption is asynchronous: a single setImmediate does
		// not cover it, so poll for the steered submission like the palette test.
		for (let attempt = 0; attempt < 50 && harness.modelPrompts.length === 0; attempt++) await Bun.sleep(10);
		expect(harness.modelPrompts).toEqual(["/during-turn"]);
		expect(harness.modelPromptOptions[0]).toMatchObject({ streamingBehavior: "steer", throwOnDrop: true });
	});

	it("drops a skill command if its asynchronous load completes after the room's session changes", async () => {
		const filePath = path.join(tmp, "skill.txt");
		await fs.writeFile(filePath, "Review the active diff.");
		harness.ctx.skillCommands.set("skill:audit", {
			name: "audit",
			description: "",
			filePath,
			baseDir: tmp,
			source: "test",
		});
		const guest = await joinReady(host.link, "writer");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const built = Promise.withResolvers<void>();
		const build = skillCommand.buildSkillCommandPrompt;
		const delayed = spyOn(skillCommand, "buildSkillCommandPrompt").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			try {
				return await build(...args);
			} finally {
				built.resolve();
			}
		});
		try {
			guest.socket.send({ t: "prompt", text: "/skill:audit" });
			await entered.promise;
			harness.state.sessionId = "replacement-session";
			release.resolve();
			await built.promise;
			await setImmediate();
			expect(harness.prompts).toEqual([]);
		} finally {
			release.resolve();
			delayed.mockRestore();
		}
	});

	it("advertises the TUI-only builtins its dispatcher runs on the host screen", async () => {
		const guest = await joinReady(host.link, "writer");

		// These carry no ACP handler, so the ACP palette omits them; the guest
		// dispatcher still runs them, so they must be discoverable in the menu.
		for (const name of ["new", "resume", "fork", "exit"]) expect(guest.palette).toContain(name);
	});

	it("runs a TUI-only builtin on the host instead of rejecting it", async () => {
		const guest = await joinReady(host.link, "writer");
		const ran = harness.nextTui();

		guest.socket.send({ t: "prompt", text: "/new" });

		expect(await ran).toBe("new");
		expect(harness.prompts).toEqual([]);
		expect(harness.modelPrompts).toEqual([]);
	});

	it("opens the host model picker without erasing its in-progress draft", async () => {
		const guest = await joinReady(host.link, "writer");
		const ran = harness.nextTui();
		guest.socket.send({ t: "prompt", text: "/model" });
		expect(await ran).toBe("model");
		expect(harness.state.draft).toBe("host draft");
	});

	it("clears through the host's transcript reset pipeline without erasing its local draft", async () => {
		const guest = await joinReady(host.link, "writer");
		const cleared = harness.nextTui();
		guest.socket.send({ t: "prompt", text: "/clear" });
		expect(await cleared).toBe("clear");
		expect(harness.state.draft).toBe("host draft");
		expect(harness.modelPrompts).toEqual([]);
	});

	it.each([
		["/logout", "logout:select-provider"],
		["/logout anthropic", "logout:anthropic"],
	])("keeps %s on the host's provider/account selection path", async (command, expected) => {
		const guest = await joinReady(host.link, "writer");
		const selected = harness.nextTui();
		guest.socket.send({ t: "prompt", text: command });
		expect(await selected).toBe(expected);
		expect(harness.state.draft).toBe("host draft");
		expect(harness.modelPrompts).toEqual([]);
	});

	it("reports unavailable reasoning controls in the browser instead of opening a nonexistent picker", async () => {
		const guest = await joinReady(host.link, "writer");
		const notice = guest.nextNotice();
		guest.socket.send({ t: "prompt", text: "/effort" });
		expect(await notice).toContain("no adjustable thinking level");
		expect(harness.tui).toEqual([]);
		expect(harness.modelPrompts).toEqual([]);
	});

	it("uses interactive relocation and emits a success notice without erasing the host draft", async () => {
		const guest = await joinReady(host.link, "writer");
		const notice = guest.nextNotice();
		guest.socket.send({ t: "prompt", text: "/move subdir" });
		expect(await notice).toBe(`Moved to ${path.join(tmp, "subdir")}.`);
		expect(harness.tui).toEqual(["move"]);
		expect(harness.state.draft).toBe("host draft");
	});

	it("opens the host directory picker when /move has no argument", async () => {
		const guest = await joinReady(host.link, "writer");
		const ran = harness.nextTui();
		guest.socket.send({ t: "prompt", text: "/move" });
		expect(await ran).toBe("move");
		expect(harness.state.cwd).toBe(tmp);
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

	it("runs Python submissions with the same exclusion semantics as the editor", async () => {
		const guest = await joinReady(host.link, "writer");
		const plain = harness.nextPython();
		guest.socket.send({ t: "prompt", text: "$ print('hello')" });
		expect(await plain).toEqual({ code: "print('hello')", isExcluded: false });
		const excluded = harness.nextPython();
		guest.socket.send({ t: "prompt", text: "$$ print('secret')" });
		expect(await excluded).toEqual({ code: "print('secret')", isExcluded: true });
		expect(harness.prompts).toEqual([]);
	});

	it("refuses shell and Python execution through a view-only link", async () => {
		const guest = await joinReady(host.viewLink, "viewer");
		for (const text of ["!echo secret", "$$ print('secret')"]) {
			guest.socket.send({ t: "prompt", text });
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error("expected read-only rejection");
			expect(reply.message).toContain("read-only link");
		}
		expect(harness.bash).toEqual([]);
		expect(harness.python).toEqual([]);
		expect(harness.prompts).toEqual([]);
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
