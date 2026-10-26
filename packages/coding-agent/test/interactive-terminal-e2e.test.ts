import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgDisplayCompactToolActivity,
	cfgDisplayHideToolActivity,
	cfgStartupQuiet,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { peekSpecDrivenController } from "@oh-my-pi/pi-coding-agent/spec-driven/controller";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function dump(label: string, rows: readonly string[]): void {
	console.log(`==== ${label} ====`);
	for (const [i, row] of rows.entries()) console.log(String(i).padStart(3), JSON.stringify(row));
}

describe("libkitty end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let releaseSessionEffects: (() => void) | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-libkitty-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		// Keep the welcome header visible for the resize assertions.
		cfgStartupQuiet.set(Settings.instance, false);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			// Native /dev requires the root session's real manager; session.dispose owns teardown.
			ownedAsyncJobManager: new AsyncJobManager({}),
		});
		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await peekSpecDrivenController(session.sessionManager)?.dispose();
		mode?.stop();
		// Settle fixture-owned input after assertions so its keepalive is disposed.
		mode?.onInputCallback?.({ text: "", cancelled: true, started: false });
		await Promise.resolve();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		releaseSessionEffects?.();
		releaseSessionEffects = undefined;
		resetSettingsForTest();
	});

	async function emptyDev() {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager);
		if (!controller) throw new Error("Expected native dev controller");
		return controller;
	}

	it("shows rejected Dev subcommands before a controller exists and entry conflicts in ordinary chat", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const rows = () => plainRows(term.getViewport()).join("\n");
		await mode.handleDevInput("/dev next");
		await term.waitForRender(() => rows().includes("请先输入 /dev"));
		expect(peekSpecDrivenController(session.sessionManager)).toBeUndefined();
		const failure = vi.spyOn(mode, "showError");
		mode.loopModeEnabled = true;
		await mode.handleDevInput("/dev");
		await term.waitForRender(() => rows().includes("协同开发操作失败"));
		expect(failure).toHaveBeenCalled();
		expect(peekSpecDrivenController(session.sessionManager)?.inputMode()).not.toBe("dev");
		expect(rows()).not.toContain("Dev ·");
	});

	it("finishes root disposal and reports failure when Dev disposal rejects", async () => {
		const controller = await emptyDev();
		const failure = new Error("Dev teardown unavailable");
		vi.spyOn(controller, "dispose").mockRejectedValue(failure);
		const rootDispose = vi.spyOn(session, "dispose");
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const showError = vi.spyOn(mode, "showError");
		await mode.shutdown();
		expect(rootDispose).toHaveBeenCalledTimes(1);
		expect(session.isDisposed).toBe(true);
		expect(showError.mock.calls.some(call => call[0].includes(failure.message))).toBe(true);
		expect(quit).not.toHaveBeenCalled();
	});

	it("restores dropped drafts only from the adopted session and restores the binding after rollback", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const stage = new AgentSession({
			agent: new Agent({
				initialState: { model: session.model!, systemPrompt: ["Stage"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: session.modelRegistry,
		});
		const rootHooks = vi.spyOn(session, "setPromptDropped");
		const stageHooks = vi.spyOn(stage, "setPromptDropped");
		try {
			await mode.bindMainSession(stage);
			const stageDrop = stageHooks.mock.calls.findLast(call => call[0])?.[0];
			expect(stageDrop).toBeDefined();
			const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
			stageDrop!({ text: "recovered stage draft", images: [image] });
			expect(mode.editor.getText()).toBe("recovered stage draft");
			expect(mode.editor.pendingImages).toEqual([image]);
			mode.editor.setText("new user draft");
			stageDrop!({ text: "must not overwrite" });
			expect(mode.editor.getText()).toBe("new user draft");
			await mode.bindMainSession(session);
			mode.editor.setText("");
			stageDrop!({ text: "hidden stage late drop" });
			expect(mode.editor.getText()).toBe("");
			expect(stageHooks.mock.calls.at(-1)?.[0]).toBeUndefined();
			const subscribe = vi.spyOn(stage, "subscribe").mockImplementationOnce(() => {
				throw new Error("stage subscription failed");
			});
			await expect(mode.bindMainSession(stage)).rejects.toThrow("stage subscription failed");
			subscribe.mockRestore();
			expect(mode.session).toBe(session);
			const rootDrop = rootHooks.mock.calls.findLast(call => call[0])?.[0];
			rootDrop!({ text: "recovered root draft" });
			expect(mode.editor.getText()).toBe("recovered root draft");
			const rolledBackDrop = stageHooks.mock.calls.findLast(call => call[0])?.[0];
			mode.editor.setText("");
			rolledBackDrop!({ text: "rolled-back stage late drop" });
			expect(mode.editor.getText()).toBe("");
		} finally {
			await mode.bindMainSession(session);
			await stage.dispose();
		}
	});

	it("shows an empty native Dev surface only after entry and restores ordinary root history on exit", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "ORDINARY_ROOT_HISTORY", timestamp: Date.now() });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		await mode.init({ suppressWelcomeIntro: true });
		const rows = () => plainRows(term.getViewport()).join("\n");
		await term.waitForRender(() => rows().includes("ORDINARY_ROOT_HISTORY"));
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager)!;
		await term.waitForRender(() => rows().includes("Dev ·") && !rows().includes("ORDINARY_ROOT_HISTORY"));
		const clear = vi.spyOn(mode, "resetTranscript");
		controller.publishObservation();
		mode.showDevCommandStatus("progress without a transcript switch");
		controller.publishObservation();
		expect(clear).not.toHaveBeenCalled();
		expect(session.sessionManager.buildSessionContext().messages).toHaveLength(1);
		await controller.exit();
		await term.waitForRender(() => rows().includes("ORDINARY_ROOT_HISTORY"));
		expect(
			rows()
				.split("\n")
				.filter(row => row.includes("ORDINARY_ROOT_HISTORY")),
		).toHaveLength(1);
	});

	it("extends the existing session info viewer with full material and diagnostics without sending drafts", async () => {
		const controller = await emptyDev();
		const snapshot = controller.observation();
		const fullError = `FULL_ERROR_START ${"diagnostic ".repeat(60)} FULL_ERROR_END`;
		await Bun.write(
			path.join(tempDir.path(), "solution.md"),
			"# Candidates\n\n## candidate-alpha\n\nFULL_MATERIAL_END",
		);
		vi.spyOn(controller, "observation").mockReturnValue({
			...snapshot,
			error: fullError,
			status: {
				...snapshot.status,
				paths: { requirements: [], solution: "solution.md", plan: "plan.md", report: "report.md" },
			},
		});
		const report = vi.spyOn(mode, "showSessionInfo");
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		const next = vi.spyOn(controller, "next");
		const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		mode.editor.setText("UNSENT_VIEWER_DRAFT");
		mode.editor.pendingImages.push(image);
		mode.editor.pendingImageLinks.push(undefined);
		expect(await mode.handleDevInput("/session", { images: [image] })).toBe(true);
		expect(report).toHaveBeenCalledTimes(1);
		const overlay = mode.ui.overlayStack.at(-1)?.component;
		if (!overlay?.describe) throw new Error("Expected native session info viewer");
		const content = JSON.stringify(overlay.describe({ supports: () => false } as never));
		expect(content).toContain(session.sessionId);
		expect(content).toContain("Provider");
		expect(content).toContain("读取错误");
		expect(content).toContain("FULL_ERROR_START");
		expect(content).toContain("FULL_ERROR_END");
		expect(content).toContain("candidate-alpha");
		expect(content).toContain("FULL_MATERIAL_END");
		expect(content).toContain("/dev next");
		expect(mode.editor.getExpandedText()).toBe("UNSENT_VIEWER_DRAFT");
		expect(mode.editor.pendingImages).toEqual([image]);
		expect(next).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(session.messages).toEqual([]);
	});

	it("keeps empty Dev input and attachments without calling a model or opening a panel", async () => {
		const controller = await emptyDev();
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		const panel = vi.spyOn(mode, "showHookCustom");
		const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		mode.editor.setText("unsent requirement");
		mode.editor.pendingImages.push(image);
		mode.editor.pendingImageLinks.push(undefined);
		await mode.handleDevInput("unsent requirement", { images: [image] });
		expect(mode.editor.getExpandedText()).toContain("unsent requirement");
		expect(mode.editor.pendingImages).toEqual([image]);
		expect(controller.status().phase).toBe("idle");
		expect(prompt).not.toHaveBeenCalled();
		expect(panel).not.toHaveBeenCalled();
		expect(session.messages).toEqual([]);
		expect(mode.ui.hasOverlay()).toBe(false);
	});

	for (const [width, height] of [
		[100, 28],
		[120, 36],
	] as const) {
		it(`keeps three Dev lines and the composer visible at ${width}x${height} and after resize`, async () => {
			term.resize(width, height);
			const controller = await emptyDev();
			const widget = vi.spyOn(mode, "setHookWidget");
			mode.editor.setText("NATIVE_DRAFT");
			controller.publishObservation();
			const rows = () => plainRows(term.getViewport());
			await term.waitForRender(() => rows().some(row => row.includes("Dev ·")));
			const call = widget.mock.calls.findLast(call => call[0] === "native-dev-input" && call[1]);
			expect(typeof call?.[1]).toBe("function");
			if (typeof call?.[1] !== "function") throw new Error("Expected native widget factory");
			expect(call[1](mode.ui, {} as never).render(width)).toHaveLength(3);
			expect(rows().filter(row => row.includes("Dev ·"))).toHaveLength(1);
			expect(rows().some(row => row.includes("NATIVE_DRAFT"))).toBe(true);
			term.resize(width === 100 ? 120 : 100, height === 28 ? 36 : 28);
			controller.publishObservation();
			await term.waitForRender();
			expect(mode.editor.getExpandedText()).toBe("NATIVE_DRAFT");
			expect(rows().filter(row => row.includes("Dev ·"))).toHaveLength(1);
			expect(mode.ui.hasOverlay()).toBe(false);
		});
	}

	it("binds real native session, manager and agent without copying replies into root", async () => {
		const controller = await emptyDev();
		const stage = new AgentSession({
			agent: new Agent({
				initialState: { model: session.model!, systemPrompt: ["Stage"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: session.modelRegistry,
			ownedAsyncJobManager: new AsyncJobManager({}),
		});
		try {
			const settle = vi
				.spyOn(stage, "settleInFlightMessagePersistence")
				.mockRejectedValueOnce(new Error("storage unavailable"));
			await expect(mode.bindMainSession(stage)).rejects.toThrow("storage unavailable");
			expect(mode.session).toBe(session);
			expect(mode.sessionManager).toBe(session.sessionManager);
			settle.mockRestore();
			stage.sessionManager.appendMessage({ role: "user", content: "STAGE_NATIVE_MESSAGE", timestamp: Date.now() });
			stage.agent.replaceMessages(stage.sessionManager.buildSessionContext().messages);
			mode.editor.setText("preserved draft");
			await mode.bindMainSession(stage);
			expect(mode.session).toBe(stage);
			expect(mode.sessionManager).toBe(stage.sessionManager);
			expect(mode.agent).toBe(stage.agent);
			expect(mode.settings).toBe(stage.settings);
			expect(mode.viewSession).toBe(stage);
			await term.waitForRender(() =>
				plainRows(term.getViewport()).some(row => row.includes("STAGE_NATIVE_MESSAGE")),
			);
			expect(plainRows(term.getViewport()).filter(row => row.includes("STAGE_NATIVE_MESSAGE"))).toHaveLength(1);
			const native = vi.spyOn(controller, "nativeSession").mockReturnValue(stage);
			const guard = vi.spyOn(controller, "checkConversationAllowed").mockResolvedValue();
			const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
			mode.editor.pendingImages.push(image);
			mode.editor.pendingImageLinks.push(undefined);
			expect(await mode.handleDevInput("preserved draft", { images: [image] })).toBe(false);
			expect(guard).toHaveBeenCalledTimes(1);
			expect(mode.editor.pendingImages).toEqual([image]);
			native.mockRestore();
			guard.mockRestore();
			expect(session.messages).toEqual([]);
			expect(session.sessionManager.getEntries().some(entry => entry.type === "message")).toBe(false);
			await mode.bindMainSession(session);
			expect(mode.session).toBe(session);
			expect(mode.sessionManager).toBe(session.sessionManager);
			expect(mode.agent).toBe(session.agent);
			expect(mode.editor.getExpandedText()).toBe("preserved draft");
		} finally {
			await mode.bindMainSession(session);
			await stage.dispose();
		}
	});

	it("exit restores ordinary native history and removes Dev chrome without submitting a reply", async () => {
		const controller = await emptyDev();
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		mode.editor.setText("ordinary draft");
		await controller.exit();
		expect(mode.session).toBe(session);
		expect(mode.agent).toBe(session.agent);
		expect(mode.sessionManager).toBe(session.sessionManager);
		expect(mode.editor.getExpandedText()).toBe("ordinary draft");
		expect(prompt).not.toHaveBeenCalled();
		await term.waitForRender();
		expect(plainRows(term.getViewport()).some(row => row.includes("Dev ·"))).toBe(false);
	});

	it("paints the submitted user message before any model reply", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const pending = mode.getUserInput();
		await term.waitForRender();
		term.sendInput("hi there omp");
		await term.waitForRender();
		term.sendInput("\r");
		const input = await pending;
		expect(input.text).toBe("hi there omp");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("hi there omp")));
		expect(plainRows(term.getViewport()).filter(row => row.includes("hi there omp"))).toHaveLength(1);
	});

	it("keeps the whole buffer clean across non-overflowing width resizes", async () => {
		term.resize(140, 40);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		term.resize(120, 40);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(110, 40);
		await Bun.sleep(300);
		await term.waitForRender();

		// Content always fit the screen, so the terminal never pushed live rows
		// into scrollback: the entire buffer must hold exactly one copy.
		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after resizes", buffer);
		expect(drafts.length).toBe(1);
		const welcomes = buffer.filter(row => row.includes("vtest"));
		expect(welcomes.length).toBe(1);
	});

	it("keeps the screen exact through an overflowing shrink", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Width+height shrink: the live viewport rewraps taller than the new
		// screen, so the terminal itself pushes stale top rows into scrollback.
		// Those pushed rows are unreachable to an inline app; the contract is an
		// exact screen and no duplicate of the bottom-anchored rows anywhere.
		term.resize(88, 26);
		await Bun.sleep(300);
		await term.waitForRender();

		const viewport = plainRows(term.getViewport());
		const editors = viewport.filter(row => row.includes("MARKER_DRAFT"));
		if (editors.length !== 1) dump("viewport after overflowing shrink", viewport);
		expect(editors.length).toBe(1);
		expect(viewport.filter(row => row.includes("vtest")).length).toBeLessThanOrEqual(1);
		const buffer = plainRows(term.getScrollBuffer());
		expect(buffer.filter(row => row.includes("MARKER_DRAFT")).length).toBe(1);
	});

	it("keeps one editor through a drag storm, shrink, and grow", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		mode.ui.setResizeScrollback("rebuild");
		// Drag storm: several unsettled steps inside one settle window.
		term.resize(112, 30);
		await Bun.sleep(30);
		term.resize(104, 28);
		await Bun.sleep(30);
		term.resize(96, 24);
		await Bun.sleep(300);
		await term.waitForRender();
		// Height-only shrink, then a combined grow back out.
		term.resize(96, 18);
		await Bun.sleep(300);
		await term.waitForRender();

		// Observe only paints after the final resize begins: the initial frame
		// used this same size and must not satisfy the completion condition.
		let rebuiltSize: string | undefined;
		const removePaintListener = mode.ui.addPaintListener(paint => {
			if (paint.reset && !paint.alt) rebuiltSize = `${paint.columns}x${paint.rows}`;
		});
		try {
			term.resize(120, 32);
			await term.waitForRender(() => rebuiltSize === "120x32");
			// The polling helper times out without throwing. Require the actual
			// normal-buffer replay before checking for duplicate transcript rows.
			expect(rebuiltSize).toBe("120x32");

			const buffer = plainRows(term.getScrollBuffer());
			const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
			if (drafts.length !== 1) dump("scroll buffer after drag storm", buffer);
			expect(drafts.length).toBe(1);
			const viewport = plainRows(term.getViewport());
			expect(viewport.filter(row => row.includes("vtest")).length).toBeLessThanOrEqual(1);

			// The editor is still live: typing paints into the one surviving editor.
			term.sendInput("X");
			await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFTX")));
			expect(plainRows(term.getViewport()).filter(row => row.includes("MARKER_DRAFTX")).length).toBe(1);
		} finally {
			removePaintListener();
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

		// Force finalized answers into immutable terminal history; completed
		// reasoning must never accompany them, even when visibility is toggled.
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Observed reasoning unlocks Alt+P but completed turns stay history-hidden.
		mode.noteDisplayableThinkingContent(thinkingMessage);
		mode.addMessageToChat(thinkingMessage);
		for (let i = 0; i < 12; i++) {
			mode.addMessageToChat(assistantText(`Filler answer number ${i} occupying a transcript row.`));
		}

		// Drive retirement until the first visible answer reaches native scrollback.
		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes("First visible answer.")); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes("First visible answer."))).toBe(true);
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);

		// A live editor draft must survive visibility changes.
		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Neither hiding nor showing current thinking may replay completed reasoning.
		for (let i = 0; i < 2; i++) {
			term.sendInput("\x1bp");
			await term.waitForRender();
			expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);
			expect(plainRows(term.getScrollBuffer()).some(row => row.includes("First visible answer."))).toBe(true);
			expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
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

		// This shortcut test inspects detailed tool output, not compact summaries.
		cfgDisplayCompactToolActivity.set(session.settings, false);
		cfgDisplayHideToolActivity.set(session.settings, false);
		// Direct AgentSession construction bypasses the SDK's process-wide settings binding.
		releaseSessionEffects = bindEffects(session.settings);
		expect(chatTranscriptDisplayPreferences.compactToolActivity).toBe(false);
		expect(chatTranscriptDisplayPreferences.hideToolActivity).toBe(false);
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

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

		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(TOOL_MARKER)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(TOOL_MARKER))).toBe(true);

		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Alt+O is the configured app.tools.toggleVisibility binding from this test's keybinding manager.
		term.sendInput("\x1bo");
		await term.waitForRender(() => !plainRows(term.getScrollBuffer()).some(row => row.includes(TOOL_MARKER)));
		expect(mode.hideToolActivity).toBe(true);
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(TOOL_MARKER))).toBe(false);
		expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});
	it("preserves a retired long reply and Todo HUD when shaking hidden thinking", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const answer = Array.from({ length: 35 }, (_, index) => `Answer marker ${index + 1}`);
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SHAKE_RETIRED_REASONING" },
				{ type: "text", text: answer.join("\n") },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};
		term = new VirtualTerminal(120, 16);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		session.sessionManager.appendMessage({ role: "user", content: "Show the answer", timestamp: 0 });
		session.sessionManager.appendMessage(message);
		await mode.init({ suppressWelcomeIntro: true });
		mode.setTodos([{ content: "Review answer", status: "in_progress" }]);
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		await term.waitForRender(() => plainRows(term.getScrollBuffer()).some(row => row.includes("Answer marker 35")));

		const buffer = () => plainRows(term.getScrollBuffer());
		expect(buffer().some(row => row.includes("SHAKE_RETIRED_REASONING"))).toBe(false);
		await mode.handleShakeCommand("thinking");
		await term.waitForRender();

		const rows = buffer();
		expect(rows.some(row => row.includes("SHAKE_RETIRED_REASONING"))).toBe(false);
		expect(rows.filter(row => row.trim() === "Answer marker 1")).toHaveLength(1);
		expect(rows.filter(row => row.trim() === "Answer marker 35")).toHaveLength(1);
		expect(plainRows(term.getViewport()).some(row => row.includes("Review answer"))).toBe(true);

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
			await term.waitForRender();
			expect(buffer().filter(row => row.trim() === "Answer marker 1")).toHaveLength(1);
			expect(plainRows(term.getViewport()).some(row => row.includes("Review answer"))).toBe(true);
		}
	});
});
