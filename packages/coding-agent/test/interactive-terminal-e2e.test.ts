import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { postmortem, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, transcriptText } from "./helpers/mode-terminal";

function dump(label: string, rows: readonly string[]): void {
	console.log(`==== ${label} ====`);
	for (const [i, row] of rows.entries()) console.log(String(i).padStart(3), JSON.stringify(row));
}

describe("libkitty end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;
	let releaseSessionEffects: (() => void) | undefined;

	/** The real interactive mode on a `columns`×`rows` in-memory terminal (kitty's VT engine). */
	function start(columns: number, rows: number): void {
		term = createModeTerminal({ columns, rows, settings: session.settings });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, term.frame);
	}
	/** Scrollback, then the viewport. */
	const buffer = (): string[] => [...term.scrollback(), ...term.screen()];
	const viewport = (): string[] => term.screen();

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-libkitty-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const settings = Settings.isolated();
		cfgDisplayMode.set(settings, "detailed");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		start(120, 32);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		releaseSessionEffects?.();
		releaseSessionEffects = undefined;
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("finishes root disposal and reports a registered host teardown failure", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const failure = new Error("Owned native host teardown unavailable");
		mode.registerHostShutdown(async () => {
			throw failure;
		});
		const dispose = vi.spyOn(session, "dispose");
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const error = vi.spyOn(mode, "showError");
		try {
			await mode.shutdown();
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(session.isDisposed).toBe(true);
			expect(error.mock.calls.some(([text]) => text.includes(failure.message))).toBe(true);
			expect(quit).not.toHaveBeenCalled();
		} finally {
			dispose.mockRestore();
			quit.mockRestore();
			error.mockRestore();
		}
	});

	it("restores an aborted ordinary root submission without overwriting newer text or images", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		const dispatch = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const dropPrompt = async (text: string, updateDraft?: () => void) => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const normalization = vi
				.spyOn(imageLoading, "normalizeModelContextImages")
				.mockImplementation(async images => {
					started.resolve();
					await release.promise;
					return images;
				});
			const pending = session.prompt(text, { images: [image] });
			try {
				await withTimeout(started.promise, 2_000, "Image admission never started");
				updateDraft?.();
				await session.abort();
			} finally {
				release.resolve();
				await pending;
				normalization.mockRestore();
			}
		};
		try {
			await dropPrompt("recovered ordinary draft");
			expect(mode.composer.expandedText()).toBe("recovered ordinary draft");
			expect(mode.composer.pendingImages).toEqual([image]);
			const newer = { ...image, data: "AQ==" };
			await dropPrompt("must not overwrite the newer draft", () => {
				mode.composer.clearDraft();
				mode.composer.setText("newer ordinary draft");
				mode.composer.pendingImages.push(newer);
			});
			expect(mode.composer.expandedText()).toBe("newer ordinary draft");
			expect(mode.composer.pendingImages).toEqual([newer]);
			await dropPrompt("must not overwrite a newer image-only draft", () => mode.composer.setText(""));
			expect(mode.composer.expandedText()).toBe("");
			expect(mode.composer.pendingImages).toEqual([newer]);
			expect(session.messages).toEqual([]);
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			dispatch.mockRestore();
		}
	});

	it("preserves a retired long reply and Todo HUD through manual and automatic thinking shake", async () => {
		mode.stop();
		term.dispose();
		cfgDisplayMode.set(session.settings, "compact");
		start(120, 16);
		const reasoning = "SHAKE_RETIRED_REASONING";
		const first = "Answer marker 1.";
		const last = "Answer marker 35.";
		const answer = Array.from({ length: 35 }, (_, i) => `Answer marker ${i + 1}.`).join("\n\n");
		session.sessionManager.appendMessage({ role: "user", content: "Show the answer", timestamp: 1 });
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: reasoning },
				{ type: "text", text: answer },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		await mode.init({ suppressWelcomeIntro: true });
		mode.setTodos([{ name: "Review", tasks: [{ content: "Review answer", status: "in_progress" }] }]);
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		await term.waitFor(() => term.scrollback().some(row => row.trim() === first) && term.text().includes(last));
		const expectReplayed = () => {
			expect(buffer().filter(row => row.trim() === first)).toHaveLength(1);
			expect(buffer().filter(row => row.trim() === last)).toHaveLength(1);
			expect(term.text()).not.toContain(reasoning);
			expect(viewport().some(row => row.includes("Review answer"))).toBe(true);
		};
		expectReplayed();
		await mode.handleShakeCommand("thinking");
		await term.waitFor(() => term.text().includes("Dropped 1 thinking block"));
		expectReplayed();

		for (const errorMessage of [undefined, "Auto-shake only partially reclaimed context"]) {
			await mode.eventController.handleEvent({
				type: "auto_compaction_end",
				action: "shake",
				result: undefined,
				aborted: false,
				willRetry: true,
				skipped: false,
				...(errorMessage ? { errorMessage } : {}),
			});
			await term.waitFor(() => term.text().includes(errorMessage ?? "Auto-shake completed"));
			expectReplayed();
		}
	});

	it("paints the submitted user message before any model reply", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const pending = mode.getUserInput();
		await term.settle();

		term.type("hi there omp");
		await term.settle();
		term.press("enter");
		const input = await pending;
		expect(input.text).toBe("hi there omp");

		// The optimistic user-message block must be on the physical screen now,
		// before any assistant output exists.
		await term.waitFor(() => viewport().some(row => row.includes("hi there omp")));
		const rows = viewport();
		const hits = rows.filter(row => row.includes("hi there omp"));
		if (hits.length !== 1) dump("viewport after submit", rows);
		expect(hits.length).toBe(1);
	});

	it("keeps the whole buffer clean across non-overflowing width resizes", async () => {
		term.resize(140, 40);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		term.type("MARKER_DRAFT");
		await term.waitFor(() => viewport().some(row => row.includes("MARKER_DRAFT")));

		term.resize(120, 40);
		await Bun.sleep(300);
		await term.settle();
		term.resize(110, 40);
		await Bun.sleep(300);
		await term.settle();

		// Content always fit the screen, so the terminal never pushed live rows
		// into scrollback: the entire buffer must hold exactly one copy.
		const rows = buffer();
		const drafts = rows.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after resizes", rows);
		expect(drafts.length).toBe(1);
		const welcomes = rows.filter(row => row.includes("vtest"));
		expect(welcomes.length).toBe(1);
	});

	it("keeps the screen exact through an overflowing shrink", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		term.type("MARKER_DRAFT");
		await term.waitFor(() => viewport().some(row => row.includes("MARKER_DRAFT")));

		// Width+height shrink: the live viewport rewraps taller than the new
		// screen, so the terminal itself pushes stale top rows into scrollback.
		// Those pushed rows are unreachable to an inline app; the contract is an
		// exact screen and no duplicate of the bottom-anchored rows anywhere.
		term.resize(88, 26);
		await Bun.sleep(300);
		await term.settle();

		const rows = viewport();
		const editors = rows.filter(row => row.includes("MARKER_DRAFT"));
		if (editors.length !== 1) dump("viewport after overflowing shrink", rows);
		expect(editors.length).toBe(1);
		expect(rows.filter(row => row.includes("vtest")).length).toBeLessThanOrEqual(1);
		expect(buffer().filter(row => row.includes("MARKER_DRAFT")).length).toBe(1);
	});

	it("keeps one editor through a drag storm, shrink, and grow", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		term.type("MARKER_DRAFT");
		await term.waitFor(() => viewport().some(row => row.includes("MARKER_DRAFT")));

		// `tui.resizeScrollback` defaults to "rebuild".
		// Drag storm: several unsettled steps inside one settle window.
		term.resize(112, 30);
		await Bun.sleep(30);
		term.resize(104, 28);
		await Bun.sleep(30);
		term.resize(96, 24);
		await Bun.sleep(300);
		await term.settle();
		// Height-only shrink, then a combined grow back out.
		term.resize(96, 18);
		await Bun.sleep(300);
		await term.settle();

		// Observe only paints after the final resize begins: the initial frame
		// used this same size and must not satisfy the completion condition.
		let rebuiltSize: string | undefined;
		const removePaintListener = mode.shell.host!.onFrame(frame => {
			if (frame.reset && !frame.alt) rebuiltSize = `${frame.columns}x${frame.rows}`;
		});
		try {
			term.resize(120, 32);
			await term.waitFor(() => rebuiltSize === "120x32");
			// The polling helper times out without throwing. Require the actual
			// normal-buffer replay before checking for duplicate transcript rows.
			expect(rebuiltSize).toBe("120x32");

			const rows = buffer();
			const drafts = rows.filter(row => row.includes("MARKER_DRAFT"));
			if (drafts.length !== 1) dump("scroll buffer after drag storm", rows);
			expect(drafts.length).toBe(1);
			expect(viewport().filter(row => row.includes("vtest")).length).toBeLessThanOrEqual(1);

			// The editor is still live: typing paints into the one surviving editor.
			term.type("X");
			await term.waitFor(() => viewport().some(row => row.includes("MARKER_DRAFTX")));
			expect(viewport().filter(row => row.includes("MARKER_DRAFTX")).length).toBe(1);
		} finally {
			removePaintListener();
		}
	});

	it("preserves the complete unsent draft, caret and attachments across display rebuilds", async () => {
		const history = { role: "user", content: "DRAFT_HISTORY_MARKER", timestamp: 1 } as const;
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const call: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			content: [
				{ type: "toolCall", id: "draft-tool", name: "bash", arguments: { command: "echo DRAFT_TOOL_MARKER" } },
			],
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "draft-tool",
			toolName: "bash",
			content: [{ type: "text", text: "DRAFT_TOOL_RESULT" }],
			isError: false,
			timestamp: 3,
		};
		for (const message of [history, call, result]) session.sessionManager.appendMessage(message);
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		releaseSessionEffects = bindEffects(session.settings);
		await mode.init({ suppressWelcomeIntro: true });
		await mode.renderInitialMessages();
		void mode.getUserInput();
		await term.settle();

		const prompt = vi.spyOn(session, "prompt");
		try {
			const draft = `First line of unsent input\n${"full long draft content ".repeat(16)}\nFINAL_DRAFT_SUFFIX`;
			const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
			mode.composer.setText(draft);
			mode.composer.pendingImages.push(image);
			mode.composer.pendingImageLinks.push("local://draft-image.png");
			mode.composer.setCursor(draft.length - 2);
			const cursor = mode.composer.cursor();
			const messages = structuredClone(session.messages);
			for (const display of ["compact", "clean", "detailed"] as const) {
				cfgDisplayMode.set(session.settings, display);
				await term.settle();
				expect(cfgDisplayMode.get(session.settings)).toBe(display);
				expect(mode.composer.text()).toBe(draft);
				expect(mode.composer.expandedText()).toBe(draft);
				expect(mode.composer.cursor()).toBe(cursor);
				expect(mode.composer.pendingImages).toEqual([image]);
				expect(mode.composer.pendingImageLinks).toEqual(["local://draft-image.png"]);
				expect(session.messages).toEqual(messages);
				const transcript = transcriptText(mode.shell);
				expect(transcript.match(/DRAFT_HISTORY_MARKER/g)).toHaveLength(1);
				expect(transcript.includes("DRAFT_TOOL_MARKER")).toBe(display === "detailed");
				if (display !== "detailed") expect(transcript).not.toContain("DRAFT_TOOL_RESULT");
			}
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			prompt.mockRestore();
		}
	});

	it("keeps completed thinking out of native scrollback across Alt+P toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const THINK = "RETIRED_REASONING_MARKER";
		const thinkingMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: THINK },
				{ type: "text", text: "First visible answer." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};

		// A short viewport forces the oldest finalized blocks into immutable
		// terminal history, which is where the regression hid (a plain viewport
		// repaint leaves retired rows untouched).
		mode.stop();
		term.dispose();
		cfgDisplayMode.set(session.settings, "compact");
		start(120, 10);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();

		// Observed reasoning unlocks Alt+P even when the model level is off.
		mode.noteDisplayableThinkingContent(thinkingMessage);
		mode.addMessageToChat(thinkingMessage);
		expect(mode.hasDisplayableThinkingContent).toBe(true);
		for (let i = 0; i < 12; i++) {
			mode.addMessageToChat(assistantText(`Filler answer number ${i} occupying a transcript row.`));
		}

		const committedRows = () => term.scrollback();
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes("First visible answer.")); i++) {
			await term.settle();
		}
		expect(committedRows().some(row => row.includes("First visible answer."))).toBe(true);
		expect(buffer().some(row => row.includes(THINK))).toBe(false);

		// A live editor draft must survive the toggle's history rebuild.
		term.type("LIVE_EDITOR_DRAFT");
		await term.waitFor(() => viewport().some(row => row.includes("LIVE_EDITOR_DRAFT")));

		for (const hidden of [true, false]) {
			term.press("alt+p");
			await term.settle();
			expect(cfgHideThinkingBlock.get(session.settings)).toBe(hidden);
			expect(buffer().some(row => row.includes(THINK))).toBe(false);
			expect(buffer().filter(row => row.includes("First visible answer."))).toHaveLength(1);
			expect(viewport().some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
		}
	});
	it("hides tool activity already retired to native scrollback when the real shortcut toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const TOOL_MARKER = "RETIRED_TOOL_ACTIVITY_MARKER";
		const callId = "retired-tool-call";
		const toolCall: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `printf ${TOOL_MARKER}` } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: TOOL_MARKER }],
			isError: false,
			timestamp: 2,
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 3,
		});

		mode.stop();
		term.dispose();
		start(120, 10);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();

		// Tool visibility is a global input-controller action; it reads the live keybindings.
		mode.keybindings.setUserBindings({ "app.tools.toggleVisibility": "alt+o" });
		mode.renderSessionContext({
			messages: [
				toolCall,
				toolResult,
				...Array.from({ length: 12 }, (_, i) =>
					assistantText(`Filler answer number ${i} occupying a transcript row.`),
				),
			],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});

		const committedRows = () => term.scrollback();
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(TOOL_MARKER)); i++) {
			await term.settle();
		}
		expect(committedRows().some(row => row.includes(TOOL_MARKER))).toBe(true);

		term.type("LIVE_EDITOR_DRAFT");
		await term.waitFor(() => viewport().some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Alt+O is the configured app.tools.toggleVisibility binding from this test's keybinding manager.
		term.press("alt+o");
		await term.waitFor(() => !buffer().some(row => row.includes(TOOL_MARKER)));
		expect(mode.hideToolActivity).toBe(true);
		expect(buffer().some(row => row.includes(TOOL_MARKER))).toBe(false);
		expect(viewport().some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});
});
