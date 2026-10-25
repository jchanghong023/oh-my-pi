/**
 * Contract: renderInitialMessages renders the display transcript, never the
 * provider context. Compact mode preserves compacted conversation prose without
 * replaying its tool, thinking, or auxiliary UI records.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback because the TUI's initial
 * paint preserves it, so the cold-launch render must request a
 * scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisplayCollapseCompacted, cfgDisplayCompactToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext, RenderSessionContextOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext, StrippedToolCallsMarker } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { type Component, Container, Image, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	// afterEach resets Settings, but renderInitialMessages reads the global
	// Settings (display.collapseCompacted) — re-init before every test.
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

const originalImageProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
	vi.restoreAllMocks();
});

function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

interface RenderInitialMessagesTestContext {
	ctx: InteractiveModeContext;
	transcriptSpy: Mock<(options?: { collapseCompactedHistory?: boolean }) => SessionContext>;
	llmContextSpy: Mock<() => SessionContext>;
	renderSessionContextSpy: Mock<(...args: unknown[]) => Promise<void>>;
}

/** Build a minimal InteractiveModeContext mock, returning spies for assertions. */
function makeCtx(): RenderInitialMessagesTestContext {
	const transcriptSpy = vi.fn(() => makeEmptyContext());
	const llmContextSpy = vi.fn(() => makeEmptyContext());
	const renderSessionContextSpy = vi.fn(async () => {});
	const chatContainer = new TranscriptContainer();

	const ctx = {
		chatContainer,
		pendingMessagesContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap<AgentMessage, Component>(),
		pendingTools: new Map(),
		hideToolActivity: false,
		initialChatRendered: true,
		session: { buildTranscriptSessionContext: transcriptSpy },
		viewSession: {
			buildTranscriptSessionContext: transcriptSpy,
			hasBuiltInTool: () => true,
			sessionManager: {
				buildSessionContext: llmContextSpy,
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			buildSessionContext: llmContextSpy,
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
		},
		renderSessionContextIncrementally: renderSessionContextSpy,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
		resetTranscript: () => ctx.chatContainer.disposeChildren(),
	} as unknown as InteractiveModeContext;

	return { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy };
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const pngImage: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return { ...makeEmptyContext(), messages };
}

function countImageComponents(component: Component): number {
	const own = component instanceof Image ? 1 : 0;
	if (!("children" in component) || !Array.isArray(component.children)) return own;
	return own + component.children.reduce((count, child) => count + countImageComponents(child), 0);
}

function hasImageComponent(component: Component): boolean {
	return countImageComponents(component) > 0;
}

function makeRenderCtx(
	transcript: SessionContext,
	showImages = true,
	hideToolActivity = false,
	compactToolActivity = false,
): { ctx: InteractiveModeContext; chatContainer: TranscriptContainer } {
	cfgDisplayCompactToolActivity.override(Settings.instance, compactToolActivity);
	setChatTranscriptDisplayPreferences({ compactToolActivity, hideToolActivity });
	const chatContainer = new TranscriptContainer();
	chatContainer.setToolActivityVisible(!hideToolActivity);
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		updatePendingMessagesDisplay: () => helpers.updatePendingMessagesDisplay(),
		compactionQueuedMessages: [],
		keybindings: { getKeys: () => [] },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap<AgentMessage, Component>(),
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => {
			ctx.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
			ctx.chatContainer.disposeChildren();
		},
		present: (content: Component | readonly Component[]) => {
			const components = Array.isArray(content) ? content : [content];
			for (const component of components) ctx.chatContainer.addChild(component);
		},
		// Rebuild paths honor terminal.showImages since the native-image work;
		// keep it on so the image-replay contracts below stay meaningful.
		settings: Settings.isolated({
			"terminal.showImages": showImages,
			"display.hideToolActivity": hideToolActivity,
			"display.compactToolActivity": compactToolActivity,
			"composer.recallClearedDrafts": false,
		}),
		toolOutputExpanded: false,
		hideToolActivity,
		hideThinkingBlock: false,
		assistantImagesVisible: showImages,
		tableChartsVisible: true,
		focusedAgentId: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			buildTranscriptSessionContext: () => transcript,
			activeToolExecutionUpdates: () => [],
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
			extensionRunner: undefined,
			sessionManager: {
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
				putBlobSync: vi.fn(() => ({
					hash: "hash",
					path: "/tmp/hash",
					displayPath: "/tmp/hash.png",
					ref: "blob:sha256:hash",
				})),
			},
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
			putBlobSync: vi.fn(() => ({
				hash: "hash",
				path: "/tmp/hash",
				displayPath: "/tmp/hash.png",
				ref: "blob:sha256:hash",
			})),
		},
		addMessageToChat: (message: AgentMessage, options?: { imageLinks?: readonly (string | undefined)[] }) =>
			helpers.addMessageToChat(message, options),
		renderSessionContext: (context: SessionContext, options?: RenderSessionContextOptions) =>
			helpers.renderSessionContext(context, options),
		renderSessionContextIncrementally: (
			context: SessionContext,
			options: RenderSessionContextOptions,
			renderChunk?: () => void,
		) => helpers.renderSessionContextIncrementally(context, options, renderChunk),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	return { ctx, chatContainer };
}

describe("UiHelpers.renderInitialMessages — compacted conversation", () => {
	it("restores old prose without tool or auxiliary UI and reverses the projection on mode changes", async () => {
		using tempDir = TempDir.createSync("@pi-compacted-conversation-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "ORIGINAL_USER_REQUEST" }, pngImage],
			timestamp: 1,
		});
		session.appendMessage({
			role: "user",
			content: "SYSTEM_INJECTED_HISTORY",
			synthetic: true,
			timestamp: 1,
		});
		session.appendMessage({
			role: "user",
			content: "AGENT_ATTRIBUTED_HISTORY",
			attribution: "agent",
			timestamp: 1,
		});
		session.appendMessage({
			role: "custom",
			customType: "skill-prompt",
			content: "DIRECT_EXPANDED_SKILL_BODY",
			display: true,
			attribution: "user",
			details: { name: "direct-audit", args: "original.ts" },
			timestamp: 1,
		});
		const oldAssistant: AssistantMessage = {
			...assistantToolCall("old-read", "read", { path: "OLD_TOOL_PATH" }),
			content: [
				{ type: "thinking", thinking: "OLD_PRIVATE_THINKING" },
				{ type: "text", text: "OLD_PROSE_BEFORE_TOOL" },
				{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "OLD_TOOL_PATH" } },
				{ type: "text", text: "OLD_PROSE_AFTER_TOOL" },
			],
			stopReason: "error",
			errorMessage: "OLD_ASSISTANT_ERROR_UI",
		};
		session.appendMessage(oldAssistant);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "old-read",
			toolName: "read",
			content: [{ type: "text", text: "OLD_TOOL_OUTPUT" }],
			isError: true,
			timestamp: 2,
		});
		session.appendCustomMessageEntry("launch-completion", "OLD_NOTICE_UI", true);
		session.appendCustomMessageEntry(
			"skill-prompt",
			"EXPANDED_SKILL_BODY",
			true,
			{ name: "audit", args: "source.ts" },
			"user",
		);
		const kept = session.appendMessage({ role: "user", content: "KEPT_USER_REQUEST", timestamp: 3 });
		session.appendCompaction("COMPACTION_SUMMARY_UI", undefined, kept, 1000);
		session.appendMessage(
			assistantToolCall("recent-write", "write", { path: "recent.txt", content: "RECENT_FILE_BODY" }),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "recent-write",
			toolName: "write",
			content: [{ type: "text", text: "RECENT_TOOL_RESULT" }],
			isError: false,
			timestamp: 4,
		});
		const { ctx, chatContainer } = makeRenderCtx(makeEmptyContext(), true, false, true);
		vi.spyOn(ctx.viewSession, "buildTranscriptSessionContext").mockImplementation(options =>
			session.buildSessionContext({ transcript: true, ...options }),
		);
		const helpers = new UiHelpers(ctx);
		const before = JSON.stringify(session.getEntries());
		const assertCompact = () => {
			const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
			for (const text of [
				"ORIGINAL_USER_REQUEST",
				"OLD_PROSE_BEFORE_TOOL",
				"OLD_PROSE_AFTER_TOOL",
				"/skill:audit source.ts",
				"/skill:direct-audit original.ts",
				"KEPT_USER_REQUEST",
			])
				expect(rendered).toContain(text);
			for (const text of [
				"recent.txt",
				"RECENT_FILE_BODY",
				"OLD_PRIVATE_THINKING",
				"OLD_TOOL_PATH",
				"OLD_TOOL_OUTPUT",
				"OLD_NOTICE_UI",
				"EXPANDED_SKILL_BODY",
				"OLD_ASSISTANT_ERROR_UI",
				"COMPACTION_SUMMARY_UI",
				"SYSTEM_INJECTED_HISTORY",
				"AGENT_ATTRIBUTED_HISTORY",
				"DIRECT_EXPANDED_SKILL_BODY",
			])
				expect(rendered).not.toContain(text);
			expect(hasImageComponent(chatContainer)).toBeFalse();
		};
		await helpers.renderInitialMessages();
		assertCompact();

		cfgDisplayCollapseCompacted.override(Settings.instance, false);
		cfgDisplayCompactToolActivity.override(Settings.instance, false);
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		await helpers.renderInitialMessages();
		const detailed = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(detailed).toContain("OLD_TOOL_PATH");
		expect(detailed).toContain("OLD_NOTICE_UI");
		expect(detailed).toContain("recent.txt");
		expect(detailed).toContain("RECENT_FILE_BODY");

		cfgDisplayCompactToolActivity.override(Settings.instance, true);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		await helpers.renderInitialMessages();
		assertCompact();
		expect(JSON.stringify(session.getEntries())).toBe(before);
	});

	it("keeps an idle session's compacted background task routable until its final update", async () => {
		using tempDir = TempDir.createSync("@pi-compacted-background-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "start a background task", timestamp: 1 });
		session.appendMessage(assistantToolCall("old-background", "task", { i: "BACKGROUND_TASK_LABEL", task: "work" }));
		const runningDetails = { async: { state: "running", jobId: "background-job", type: "task" } };
		session.appendMessage({
			role: "toolResult",
			toolCallId: "old-background",
			toolName: "task",
			content: [{ type: "text", text: "background task started" }],
			details: runningDetails,
			isError: false,
			timestamp: 2,
		});
		const kept = session.appendMessage({ role: "user", content: "continue", timestamp: 3 });
		session.appendCompaction("summary", undefined, kept, 1000);
		const { ctx, chatContainer } = makeRenderCtx(makeEmptyContext(), false, false, true);
		let update: Extract<AgentSessionEvent, { type: "tool_execution_update" }> = {
			type: "tool_execution_update",
			toolCallId: "old-background",
			toolName: "task",
			args: { i: "BACKGROUND_TASK_LABEL", task: "work" },
			partialResult: {
				content: [{ type: "text", text: "running progress" }],
				details: runningDetails,
			},
		};
		vi.spyOn(ctx.viewSession, "activeToolExecutionUpdates").mockImplementation(() => [update]);
		vi.spyOn(ctx.viewSession, "buildTranscriptSessionContext").mockImplementation(options =>
			session.buildSessionContext({ transcript: true, ...options }),
		);
		const helpers = new UiHelpers(ctx);
		await helpers.renderInitialMessages();
		const handle = ctx.pendingTools.get("old-background");
		expect(handle).toBeDefined();
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("BACKGROUND_TASK_LABEL");
		handle!.updateResult(
			{
				content: [{ type: "text", text: "later progress" }],
				details: runningDetails,
			},
			true,
			"old-background",
		);
		expect(ctx.pendingTools.get("old-background")).toBe(handle);
		update = {
			...update,
			partialResult: {
				content: [{ type: "text", text: "finished" }],
				details: { async: { ...runningDetails.async, state: "completed" } },
			},
		};
		await helpers.renderInitialMessages();
		expect(ctx.pendingTools.has("old-background")).toBeFalse();
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).not.toContain("BACKGROUND_TASK_LABEL");
	});
});

describe("UiHelpers.renderInitialMessages — clearTerminalHistory", () => {
	it("never clears scrollback when clearTerminalHistory is unset", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		await new UiHelpers(ctx).renderInitialMessages();
		const clearedCall = (ctx.ui.requestRender as Mock<(...a: unknown[]) => void>).mock.calls.find(
			([force, opts]) => force === true && (opts as { clearScrollback?: boolean } | undefined)?.clearScrollback,
		);
		expect(clearedCall).toBeUndefined();
	});
});

describe("UiHelpers.renderInitialMessages — queued messages", () => {
	it("keeps the queued-message bar after a mid-turn rebuild such as rewind (#13680)", async () => {
		const { ctx } = makeRenderCtx(makeEmptyContext());
		vi.spyOn(ctx.viewSession, "getQueuedMessages").mockReturnValue({
			steering: ["steer now"],
			followUp: ["queued one", "queued two"],
			liveSteered: 0,
		});

		await new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });

		const pending = Bun.stripANSI(ctx.pendingMessagesContainer.render(100).join("\n"));
		expect(pending).toContain("steer now");
		expect(pending).toContain("queued one");
		expect(pending).toContain("queued two");
	});
});

describe("UiHelpers.renderInitialMessages — responsiveness", () => {
	// Count the chunk boundaries an idle rebuild produces: each boundary calls
	// `renderChunk` and then awaits a macrotask, so a positive count proves the
	// rebuild handed control back to the event loop mid-replay instead of
	// running as one uninterruptible turn. Drives `renderSessionContextIncrementally`
	// directly (the layer that owns the chunk counter) so the assertion is
	// deterministic and never races a timer.
	async function countRebuildChunks(messages: AgentMessage[]): Promise<number> {
		const transcript = transcriptWith(messages);
		const { ctx } = makeRenderCtx(transcript);
		let chunks = 0;
		await new UiHelpers(ctx).renderSessionContextIncrementally(transcript, { updateFooter: true }, () => {
			chunks++;
		});
		return chunks;
	}

	it("splits a large plain transcript rebuild across event-loop turns", async () => {
		await Settings.init({ inMemory: true });
		const messages: AgentMessage[] = Array.from({ length: 256 }, (_, index) => ({
			role: "user",
			content: `message ${index}`,
			timestamp: index,
		}));
		expect(await countRebuildChunks(messages)).toBeGreaterThan(0);
	});

	it("keeps the complete transcript visible until an incremental replacement is ready", async () => {
		await Settings.init({ inMemory: true });
		const messages: AgentMessage[] = Array.from({ length: 256 }, (_, index) => ({
			role: "user",
			content: `replacement ${index}`,
			timestamp: index,
		}));
		const { ctx, chatContainer } = makeRenderCtx(transcriptWith(messages));
		const helpers = new UiHelpers(ctx);
		helpers.addMessageToChat({
			role: "user",
			content: "VISIBLE_OLD_TRANSCRIPT",
			timestamp: -1,
		});
		const requestRender = ctx.ui.requestRender as Mock<(...args: unknown[]) => void>;

		const replay = helpers.renderInitialMessages({ clearTerminalHistory: true });

		const duringReplay = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(duringReplay).toContain("VISIBLE_OLD_TRANSCRIPT");
		expect(duringReplay).not.toContain("replacement 0");
		expect(requestRender.mock.calls.some(([force]) => force === true)).toBeFalse();

		await replay;

		const afterReplay = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(afterReplay).not.toContain("VISIBLE_OLD_TRANSCRIPT");
		expect(afterReplay).toContain("replacement 255");
		expect(requestRender.mock.calls.filter(([force]) => force === true)).toEqual([[true, { clearScrollback: true }]]);
	});

	it("commits only the latest replay when a second one starts mid-replay", async () => {
		// Leaving a focused subagent while its transcript is still replaying starts
		// the main session's replay on top of it. Overlapping replays captured each
		// other's staged container as the visible one, so the screen kept rows of
		// both sessions, lost the head of the older one, and cleared scrollback twice.
		await Settings.init({ inMemory: true });
		let current = transcriptWith(
			Array.from({ length: 320 }, (_, index) => ({ role: "user", content: `SUBAGENT-${index}`, timestamp: index })),
		);
		const { ctx, chatContainer } = makeRenderCtx(current);
		vi.spyOn(ctx.viewSession, "buildTranscriptSessionContext").mockImplementation(() => current);
		const helpers = new UiHelpers(ctx);
		const firstChunk = Promise.withResolvers<void>();
		const renderIncrementally = ctx.renderSessionContextIncrementally;
		ctx.renderSessionContextIncrementally = (context, options) =>
			renderIncrementally(context, options, () => firstChunk.resolve());
		const requestRender = ctx.ui.requestRender as Mock<(...args: unknown[]) => void>;

		const subagentReplay = helpers.renderInitialMessages({ clearTerminalHistory: true });
		await firstChunk.promise;
		current = transcriptWith(
			Array.from({ length: 3 }, (_, index) => ({ role: "user", content: `MAIN-${index}`, timestamp: index })),
		);
		const mainReplay = helpers.renderInitialMessages({ clearTerminalHistory: true });
		await Promise.all([subagentReplay, mainReplay]);

		const rendered = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(ctx.chatContainer).toBe(chatContainer);
		expect(rendered).not.toContain("SUBAGENT-");
		expect(rendered.match(/MAIN-\d+/g)).toEqual(["MAIN-0", "MAIN-1", "MAIN-2"]);
		expect(requestRender.mock.calls.filter(([force]) => force === true)).toEqual([[true, { clearScrollback: true }]]);
		expect(ctx.initialChatRendered).toBeTrue();
	});

	it("reopens live display when a replay fails before it starts rebuilding", async () => {
		// The display gate closes when a replay is requested; a replay that throws
		// while reading the transcript must not leave live messages hidden.
		await Settings.init({ inMemory: true });
		const { ctx } = makeRenderCtx(transcriptWith([{ role: "user", content: "hello", timestamp: 0 }]));
		vi.spyOn(ctx.viewSession, "buildTranscriptSessionContext").mockImplementation(() => {
			throw new Error("transcript unavailable");
		});
		ctx.initialChatRendered = true;
		const helpers = new UiHelpers(ctx);

		await expect(helpers.renderInitialMessages()).rejects.toThrow("transcript unavailable");
		expect(ctx.initialChatRendered).toBeTrue();
	});

	it("yields across a large parallel read-result batch", async () => {
		// Regression: a single assistant turn whose results are all grouped `read`
		// toolResults replays entirely through the `isReadGroupResult` early
		// `continue`. A trailing per-message yield is skipped by every one of
		// those results, so the whole batch would rebuild in one uninterruptible
		// event-loop turn and the chunk counter would never trip (zero chunks).
		// The top-of-loop yield must still hand control back between results.
		await Settings.init({ inMemory: true });
		const readCalls = Array.from({ length: 128 }, (_, index) => ({
			type: "toolCall" as const,
			id: `read-${index}`,
			name: "read",
			arguments: { path: `src/file-${index}.ts` },
		}));
		const assistant: AssistantMessage = {
			role: "assistant",
			content: readCalls,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const messages: AgentMessage[] = [assistant];
		for (let index = 0; index < 128; index++) {
			messages.push({
				role: "toolResult",
				toolCallId: `read-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `contents ${index}` }],
				isError: false,
				timestamp: index + 2,
			});
		}
		expect(await countRebuildChunks(messages)).toBeGreaterThan(0);
	});
});

describe("UiHelpers.renderInitialMessages — image replay", () => {
	it("hides idle compact image reads while retaining active call restoration and detailed images", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("legacy-image", "read", { path: "legacy.png" }),
			{
				role: "toolResult",
				toolCallId: "legacy-image",
				toolName: "read",
				content: [pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const original = structuredClone(transcript.messages);
		for (const display of ["compact", "detailed", "clean"] as const) {
			const hidden = display === "clean";
			const { ctx, chatContainer } = makeRenderCtx(transcript, true, hidden, display !== "detailed");
			await new UiHelpers(ctx).renderInitialMessages();
			const ansi = Bun.stripANSI(chatContainer.render(100).join("\n"));
			const native = chatContainer
				.nativeBlocks()
				.map(block =>
					JSON.stringify(
						block.describe?.({
							cols: 100,
							reduceMotion: true,
							dark: true,
							supports: () => true,
							feature: () => false,
						}),
					),
				)
				.join("\n");
			if (display === "compact") {
				expect(ansi).not.toContain("legacy.png");
				expect(native).not.toContain("legacy.png");
				const group = chatContainer.children.find(child => child instanceof ReadToolGroupComponent);
				expect(group?.getCompactToolCount()).toBe(1);
				expect(hasImageComponent(chatContainer)).toBe(false);
				expect(native).not.toContain('"k":"image"');
				chatContainer.setCompactTurnActive(true);
				expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("legacy.png");
				expect(
					JSON.stringify(
						chatContainer.compactToolActivityBlock()?.describe?.({
							cols: 120,
							reduceMotion: true,
							dark: true,
							supports: () => false,
							feature: () => false,
						}),
					),
				).toContain("legacy.png");
				chatContainer.setCompactTurnActive(false);
				expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).not.toContain("legacy.png");
			} else if (hidden) {
				expect(ansi).not.toContain("legacy.png");
				expect(hasImageComponent(chatContainer)).toBe(false);
			} else {
				expect(hasImageComponent(chatContainer)).toBe(true);
			}
			expect(transcript.messages).toEqual(original);
			chatContainer.disposeChildren();
		}
	});

	it("restores eval image blocks onto rebuilt tool output", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("eval-image", "eval", { language: "py", code: "print(image)" }),
			{
				role: "toolResult",
				toolCallId: "eval-image",
				toolName: "eval",
				content: [{ type: "text", text: "(1 image; no text output)" }, pngImage],
				details: {
					language: "python",
					cells: [{ index: 0, code: "print(image)", output: "image 1: 1x1", status: "complete" }],
				},
				isError: false,
				timestamp: 2,
			},
		]);

		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("image 1: 1x1");
	});

	it("restores manual Bash image blocks from persisted message content", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			{
				role: "bashExecution",
				command: "emit-image",
				output: "generated",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				images: [pngImage],
				timestamp: 1,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(countImageComponents(chatContainer)).toBe(1);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("$ emit-image");
	});

	it("preserves hidden read images so enabling them later can replay the image", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": false } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-hidden", "read", { path: "hidden.png" }),
			{
				role: "toolResult",
				toolCallId: "read-hidden",
				toolName: "read",
				content: [{ type: "text", text: "Read image: hidden.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, false);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(false);
		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		assistant?.setImagesVisible(true);
		expect(hasImageComponent(chatContainer)).toBe(true);
	});

	it("preserves tool-result images while tool activity is hidden so revealing it can replay the image", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-tool-hidden", "read", { path: "tool-hidden.png" }),
			{
				role: "toolResult",
				toolCallId: "read-tool-hidden",
				toolName: "read",
				content: [{ type: "text", text: "Read image: tool-hidden.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, true, true);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(false);
		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		assistant?.setToolResultImagesVisible(true);
		expect(hasImageComponent(chatContainer)).toBe(true);
	});

	it("replays reopened session image blocks through the cold-start rebuild path", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		using tempDir = TempDir.createSync("@pi-render-initial-image-replay-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage(assistantToolCall("read-reopened", "read", { path: "reopened.png" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "read-reopened",
			toolName: "read",
			content: [{ type: "text", text: "Read image: reopened.png" }, pngImage],
			isError: false,
			timestamp: 2,
		});
		session.appendMessage(assistantToolCall("eval-reopened", "eval", { language: "py", code: "print(image)" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "eval-reopened",
			toolName: "eval",
			content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
			details: {
				language: "python",
				cells: [{ index: 0, code: "print(image)", output: "image 1: 1x1", status: "complete" }],
			},
			isError: false,
			timestamp: 4,
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reloaded = await SessionManager.open(sessionFile);
		const transcript = reloaded.buildSessionContext({ transcript: true });
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });

		expect(countImageComponents(chatContainer)).toBe(2);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read reopened.png");
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});

describe("UiHelpers.renderInitialMessages — hidden tool activity", () => {
	it("hides replayed tool cards without discarding them from the persisted transcript", async () => {
		const toolCallId = "replayed-hidden-tool";
		const toolArgumentMarker = "REPLAYED TOOL ARGUMENT MARKER";
		const toolResultMarker = "REPLAYED TOOL RESULT MARKER";
		const narrationMarker = "ASSISTANT NARRATION STAYS VISIBLE";
		const finalMarker = "FINAL ASSISTANT RESPONSE STAYS VISIBLE";
		const transcript = transcriptWith([
			{
				...assistantToolCall(toolCallId, "contract_probe", { value: toolArgumentMarker }),
				content: [
					{ type: "text", text: narrationMarker },
					{ type: "toolCall", id: toolCallId, name: "contract_probe", arguments: { value: toolArgumentMarker } },
				],
			},
			{
				role: "toolResult",
				toolCallId,
				toolName: "contract_probe",
				content: [{ type: "text", text: toolResultMarker }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: finalMarker }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 3,
			},
		]);

		const hidden = makeRenderCtx(transcript, true, true);
		await new UiHelpers(hidden.ctx).renderInitialMessages();
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).toContain(narrationMarker);
		expect(hiddenRender).toContain(finalMarker);
		expect(hiddenRender).not.toContain(toolArgumentMarker);
		expect(hiddenRender).not.toContain(toolResultMarker);

		const visible = makeRenderCtx(transcript, true, false);
		await new UiHelpers(visible.ctx).renderInitialMessages();
		const visibleRender = Bun.stripANSI(visible.chatContainer.render(120).join("\n"));
		expect(visibleRender).toContain(toolArgumentMarker);
		expect(visibleRender).toContain(toolResultMarker);
	});

	it("hides and restores persisted internal activity blocks", async () => {
		const transcript = transcriptWith([
			{
				role: "custom",
				customType: "async-result",
				content: "",
				display: true,
				details: { jobId: "ASYNC_JOB_MARKER", type: "bash", label: "async marker" },
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "lsp-late-diagnostic",
				content: "",
				display: true,
				details: {
					files: [
						{
							path: "/tmp/internal.ts",
							summary: "1 error(s)",
							errored: true,
							messages: ["internal.ts:1:1 [error] [typescript] LATE_DIAGNOSTIC_MARKER (2322)"],
						},
					],
				},
				timestamp: 2,
			},
			{
				role: "custom",
				customType: "launch-completion",
				content: "LAUNCH_COMPLETION_MARKER",
				display: true,
				timestamp: 3,
			},
		]);

		const hidden = makeRenderCtx(transcript, true, true);
		await new UiHelpers(hidden.ctx).renderInitialMessages();
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).not.toContain("ASYNC_JOB_MARKER");
		expect(hiddenRender).not.toContain("LATE_DIAGNOSTIC_MARKER");
		expect(hiddenRender).not.toContain("LAUNCH_COMPLETION_MARKER");

		const visible = makeRenderCtx(transcript, true, false);
		await new UiHelpers(visible.ctx).renderInitialMessages();
		const visibleRender = Bun.stripANSI(visible.chatContainer.render(120).join("\n"));
		expect(visibleRender).toContain("ASYNC_JOB_MARKER");
		expect(visibleRender).toContain("LATE_DIAGNOSTIC_MARKER");
		expect(visibleRender).toContain("LAUNCH_COMPLETION_MARKER");
	});

	it("keeps normal warnings visible and hides warnings tied to tool activity", () => {
		const hidden = makeRenderCtx(makeEmptyContext(), true, true);
		const hiddenHelpers = new UiHelpers(hidden.ctx);
		hiddenHelpers.showWarning("NORMAL_WARNING_MARKER");
		hiddenHelpers.showWarning("TODO_WARNING_MARKER", { hideWithToolActivity: true });
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).toContain("NORMAL_WARNING_MARKER");
		expect(hiddenRender).not.toContain("TODO_WARNING_MARKER");

		const visible = makeRenderCtx(makeEmptyContext(), true, false);
		new UiHelpers(visible.ctx).showWarning("TODO_WARNING_MARKER", { hideWithToolActivity: true });
		expect(Bun.stripANSI(visible.chatContainer.render(120).join("\n"))).toContain("TODO_WARNING_MARKER");
	});

	it("hides the stripped-tool-calls placeholder with tool activity and restores it on reveal", async () => {
		const strippedAssistant: AgentMessage & StrippedToolCallsMarker = {
			role: "assistant",
			content: [{ type: "text", text: "narration" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
			strippedToolCalls: 2,
		};
		const transcript = transcriptWith([strippedAssistant]);

		const hidden = makeRenderCtx(transcript, true, true);
		await new UiHelpers(hidden.ctx).renderInitialMessages();
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).not.toContain(
			"elided — no result on this branch",
		);

		// A live reveal must restore the placeholder without a transcript rebuild.
		hidden.chatContainer.setToolActivityVisible(true);
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).toContain(
			"2 tool calls elided — no result on this branch",
		);
	});
});

describe("UiHelpers.renderSessionContext — error-stop tool calls", () => {
	it("keeps the synthetic assistant error result instead of replaying a later tool result", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "error-tool",
						name: "eval",
						arguments: { language: "py", code: "raise RuntimeError('boom')" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "error",
				errorMessage: "synthetic assistant stop error",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "error-tool",
				toolName: "eval",
				content: [{ type: "text", text: "late tool result must not replace the assistant stop error" }],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("synthetic assistant stop error");
		expect(rendered).not.toContain("late tool result must not replace the assistant stop error");
	});
});

describe("UiHelpers.renderSessionContext — mid-stream tool call rebuild", () => {
	it("decodes streamed write content from partialJson, not the provider's stale parsed arguments", async () => {
		// A transcript rebuild (theme change, settings edit, focus replay) can land
		// while a write's args still stream. The provider re-parses `arguments`
		// only every STREAMING_JSON_PARSE_MIN_GROWTH bytes, so the parsed snapshot
		// lags the raw buffer. The rebuilt preview must decode from the buffer —
		// exactly like the live reveal path — or the write body freezes at the
		// last throttled parse until more bytes arrive.
		await Settings.init({ inMemory: true });
		const staleContent = "line one of the streamed write";
		const grownBuffer = `{"path":"/tmp/mid.ts","content":"${staleContent}\\nGROWN_TAIL_SENTINEL`;
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "write-mid",
						name: "write",
						// Provider-parsed snapshot from BEFORE the buffer grew.
						arguments: { path: "/tmp/mid.ts", content: staleContent },
						[kStreamingPartialJson]: grownBuffer,
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("GROWN_TAIL_SENTINEL");
	});
});

describe("UiHelpers.renderInitialMessages — replay convergence (issue #7811)", () => {
	/** getEntries mock whose returned array grows on every call, simulating a
	 * source that persists a new session entry during every replay pass. */
	function growingEntriesCtx(): RenderInitialMessagesTestContext {
		const made = makeCtx();
		let calls = 0;
		const getEntries = vi.fn(() => {
			calls++;
			return Array.from({ length: calls }, () => ({ type: "message" }));
		});
		(made.ctx.viewSession.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;
		(made.ctx.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;
		return made;
	}

	it("terminates when entries are persisted during every replay pass", async () => {
		// Regression: the replay restart loop was unbounded. A source persisting
		// one entry per pass made the entry-count check permanently false, so a
		// large resumed session replayed from scratch forever at 100% CPU
		// (issue #7811). The loop must give up after a bounded number of
		// restarts and accept the transcript it just replayed.
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy } = growingEntriesCtx();

		await new UiHelpers(ctx).renderInitialMessages();

		// The initial pass plus four retries reaches the five-attempt cap.
		expect(transcriptSpy).toHaveBeenCalledTimes(5);
		expect(ctx.initialChatRendered).toBeTrue();
	});

	it("still replays once more when a single entry lands mid-replay", async () => {
		// The intended reconciliation must survive the cap: one entry persisted
		// during the first pass triggers exactly one restart against the fresh
		// context, then the stable entry count exits the loop.
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy } = makeCtx();
		const lengths = [0, 1, 1, 1, 1, 1, 1, 1];
		let call = 0;
		const getEntries = vi.fn(() => {
			const length = lengths[Math.min(call, lengths.length - 1)]!;
			call++;
			return Array.from({ length }, () => ({ type: "message" }));
		});
		(ctx.viewSession.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;
		(ctx.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;

		await new UiHelpers(ctx).renderInitialMessages();

		// Initial context build + exactly one reconciliation restart.
		expect(transcriptSpy).toHaveBeenCalledTimes(2);
		expect(ctx.initialChatRendered).toBeTrue();
	});
});
describe("UiHelpers.renderInitialMessages — prompt history isolation", () => {
	it("never calls editor.addToHistory when rendering past user messages", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{ role: "user", content: "first user prompt", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "reply 1" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "second user prompt", timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "text", text: "reply 2" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 4,
			},
		]);
		const { ctx } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(ctx.editor.addToHistory).not.toHaveBeenCalled();
	});
});
