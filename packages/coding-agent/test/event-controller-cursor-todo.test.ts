import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { ToolActivityContainer } from "@oh-my-pi/pi-tui/chrome/tool-activity";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { assistantMsg } from "./utilities";

const originalDisplayPreferences = { ...chatTranscriptDisplayPreferences };
let previousDisplayPreferences = originalDisplayPreferences;

beforeEach(() => {
	previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
});

afterEach(() => {
	setChatTranscriptDisplayPreferences(previousDisplayPreferences);
});

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setChatTranscriptDisplayPreferences(originalDisplayPreferences);
});

function createFixture() {
	const ctx = createInteractiveModeContext({
		streamingComponent: new AssistantMessageComponent(),
	});
	const blocks: Component[] = [];
	const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
	vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(block => {
		blocks.push(block);
		addChild(block);
	});
	return { ctx, controller: new EventController(ctx), showWarning: vi.spyOn(ctx, "showWarning"), blocks };
}

function createPresentationFixture() {
	const f = createFixture();
	const helpers = new UiHelpers(f.ctx);
	f.ctx.eventController = f.controller;
	f.showWarning.mockImplementation(helpers.showWarning.bind(helpers));
	f.ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	f.ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	return { ...f, helpers };
}

function renderTranscript(ctx: InteractiveModeContext, width = 180): string {
	return Bun.stripANSI(ctx.chatContainer.render(width).join("\n"));
}

function expectRetirableResult(block: Component): void {
	const transcript = new TranscriptContainer();
	transcript.addChild(block);
	const batch = transcript.peekFinalizedBatch(80, 0);
	const retired = Bun.stripANSI(batch?.rows.join("\n") ?? "");
	expect(retired).toContain("done");
	expect(retired).not.toContain("running");
}

/** A cumulative `message_update` carrying one streamed tool-call block. */
function streamedToolBlock(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	precedingCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [],
): Extract<AgentSessionEvent, { type: "message_update" }> {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_start" },
		message: {
			role: "assistant",
			content: [
				...precedingCalls.map(call => ({ type: "toolCall" as const, ...call })),
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: args },
			],
		},
	} as unknown as Extract<AgentSessionEvent, { type: "message_update" }>;
}

function streamedTodoBlock(
	toolCallId: string,
	precedingCallIds: string[] = [],
): Extract<AgentSessionEvent, { type: "message_update" }> {
	return streamedToolBlock(
		toolCallId,
		"todo",
		{ todos: [] },
		precedingCallIds.map(id => ({ id, name: "todo", arguments: { todos: [] } })),
	);
}

function todoEnd(
	toolCallId: string,
	phases: { name: string; tasks: { content: string; status: string }[] }[],
): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "todo",
		isError: false,
		result: { content: [{ type: "text", text: "" }], details: { phases } },
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

function evalEnd(
	toolCallId: string,
	statusEvents?: Array<{
		op: string;
		committed?: boolean;
		phases?: { name: string; tasks: { content: string; status: string }[] }[];
	}>,
	isError = false,
): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "eval",
		isError,
		result: { content: [{ type: "text", text: "done" }], details: statusEvents ? { statusEvents } : undefined },
	} as unknown as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

function evalStart(toolCallId: string): Extract<AgentSessionEvent, { type: "tool_execution_start" }> {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName: "eval",
		args: { language: "py", code: "print('done')" },
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
}

function todoFailure(text: string, toolCallId = "todo-1"): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "todo",
		isError: true,
		result: { content: [{ type: "text", text }] },
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

describe("EventController + Cursor todo bridge", () => {
	it("sanitizes and bounds provider error text in the rendered warning", async () => {
		// Provider errors are untrusted terminal input, while the warning's own
		// prefix, stale-progress hint and row padding are presentation details.
		const f = createPresentationFixture();

		await f.controller.handleEvent(
			todoFailure(`\u001b[31mrejected:\u001b[0m\tid 4\r\n\tconflicts with ${"x".repeat(400)}`),
		);

		const warning = f.showWarning.mock.calls[0]![0];
		expect(warning).toContain("rejected:");
		expect(warning).not.toContain("\t");
		expect(warning).not.toContain("\n");
		expect(warning).not.toContain("\u001b");
		expect(warning).not.toContain("\r");
		expect(warning).not.toContain("x".repeat(400));
		for (const width of [40, 80, 180]) {
			const rows = f.ctx.chatContainer.render(width).map(row => Bun.stripANSI(row));
			expect(rows.join("\n")).toContain("rejected:");
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the standalone hint when the failure carries no text", async () => {
		// Without a detail the warning must still say the panel may be stale —
		// dropping to a bare "Todo update failed" hides that local state diverged.
		const f = createPresentationFixture();

		await f.controller.handleEvent(todoFailure(""));

		expect(renderTranscript(f.ctx)).toMatch(/progress may be stale/i);
	});

	it("settles a card whose completion arrived before the streamed block created it", async () => {
		// The Cursor bridge's `tool_execution_end` is a synchronous callback fired
		// mid-parse, while the `toolcall_start` for the same call is queued on
		// `AssistantMessageEventStream` and delivered a microtask later. When the
		// server packs start and completion into one HTTP/2 chunk, the controller
		// sees the completion FIRST — with nothing in `pendingTools` to settle.
		// Dropping it stranded the card the streamed block creates moments later,
		// animating for the rest of the session.
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));
		// Completion held: nothing rendered yet, nothing pending.
		expect(f.blocks).toHaveLength(0);
		expect(f.ctx.pendingTools.size).toBe(0);

		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));

		// Exactly one card, created by the stream and immediately settled by the
		// held completion — not left pending.
		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		// The mirror still ran: settling must not cost the panel refresh.
		expect(f.ctx.setTodos).toHaveBeenCalledWith(phases);
	});

	it("settles a fast eval completion that outruns its streamed block", async () => {
		const f = createFixture();

		await f.controller.handleEvent(evalEnd("eval-call-1"));
		await f.controller.handleEvent(
			streamedToolBlock("eval-call-1", "eval", { language: "py", code: "print('done')" }),
		);

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		const block = f.blocks[0]!;
		expect(block).toHaveProperty("isTranscriptBlockFinalized");
		expect((block as AssistantMessageComponent).isTranscriptBlockFinalized()).toBe(true);
		expectRetirableResult(block);
	});

	it("shows current Todo phases rather than a snapshot captured during Eval", async () => {
		const f = createFixture();
		const recorded = [{ name: "Old", tasks: [{ content: "Earlier", status: "completed" }] }];
		const current = [{ name: "Current", tasks: [{ content: "Later", status: "in_progress" as const }] }];
		f.ctx.viewSession.getTodoPhases = () => current;

		await f.controller.handleEvent(evalEnd("eval-todo-1", [{ op: "todo", committed: true, phases: recorded }]));

		expect(f.ctx.setTodos).toHaveBeenCalledWith(current);
	});

	it("keeps the Todo panel current when Eval fails after a nested update", async () => {
		const f = createFixture();
		const current = [{ name: "Current", tasks: [{ content: "Committed", status: "completed" as const }] }];
		f.ctx.viewSession.getTodoPhases = () => current;

		await f.controller.handleEvent(evalEnd("eval-todo-error", [{ op: "todo", committed: true }], true));

		expect(f.ctx.setTodos).toHaveBeenCalledWith(current);
	});
	it("does not restart Todo auto-clear after a nested read-only view", async () => {
		const f = createFixture();
		f.ctx.viewSession.getTodoPhases = () => [];
		await f.controller.handleEvent(evalEnd("eval-todo-view", [{ op: "todo", committed: false }]));
		expect(f.ctx.setTodos).not.toHaveBeenCalled();
	});

	it("settles a held completion when execution start creates the card", async () => {
		const f = createFixture();

		await f.controller.handleEvent(evalEnd("eval-call-1"));
		await f.controller.handleEvent(evalStart("eval-call-1"));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		const block = f.blocks[0]!;
		expect(block).toHaveProperty("isTranscriptBlockFinalized");
		expect((block as AssistantMessageComponent).isTranscriptBlockFinalized()).toBe(true);
		expectRetirableResult(block);
	});

	it("fires the failure warning exactly once when a failed completion is replayed", async () => {
		// The held completion is replayed through the full end handler to settle
		// the late-created card. Its user-facing side effects (failure warning,
		// panel refresh) already ran on first arrival — the replay must only
		// settle the component, not repeat them.
		const f = createFixture();

		await f.controller.handleEvent(todoFailure("boom"));
		expect(f.showWarning).toHaveBeenCalledTimes(1);

		await f.controller.handleEvent(streamedTodoBlock("todo-1"));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		expect(f.showWarning).toHaveBeenCalledTimes(1);
	});

	it("refreshes the panel exactly once when a successful completion is replayed", async () => {
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));

		expect(f.ctx.setTodos).toHaveBeenCalledTimes(1);
	});

	it("does not recreate the card on later cumulative stream updates", async () => {
		// `message_update` is cumulative: every subsequent update re-lists the
		// same toolCall block. After the orphaned completion settles the card
		// (removing it from `pendingTools`), a replayed block must not pass the
		// creation guard and spawn a second, forever-pending card.
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
	});

	it("still settles normally when the start precedes the completion", async () => {
		// The common ordering (start delivered first) must keep working: the
		// orphan path only exists for the packed-chunk race.
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));
		expect(f.ctx.pendingTools.size).toBe(1);

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		expect(f.ctx.setTodos).toHaveBeenCalledWith(phases);
	});

	it("restores buffered results as held completions after transcript reset", async () => {
		const pending = {
			role: "toolResult" as const,
			toolCallId: "grep-restore-1",
			toolName: "grep",
			content: [{ type: "text" as const, text: "RESTORE_MATCH_LINE" }],
			isError: false,
			timestamp: 1,
		};
		const ctx = createInteractiveModeContext({
			streamingComponent: new AssistantMessageComponent(),
			session: {
				agent: {
					getPendingToolResults: () => [pending],
				},
			},
		});
		const blocks: Component[] = [];
		const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
		vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(block => {
			blocks.push(block);
			addChild(block);
		});
		const controller = new EventController(ctx);
		const showWarning = vi.spyOn(ctx, "showWarning");

		controller.resetTranscriptAnchors();
		await controller.handleEvent(streamedToolBlock("grep-restore-1", "grep", { pattern: "restore" }));
		await controller.handleEvent(streamedToolBlock("grep-restore-1", "grep", { pattern: "restore" }));

		expect(blocks).toHaveLength(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(Bun.stripANSI(blocks[0]!.render(120).join("\n"))).toContain("RESTORE_MATCH_LINE");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("reseeds held completions from buffered results at agent_start", async () => {
		const pending = {
			role: "toolResult" as const,
			toolCallId: "grep-restore-2",
			toolName: "grep",
			content: [{ type: "text" as const, text: "AGENT_START_MATCH" }],
			isError: false,
			timestamp: 1,
		};
		const ctx = createInteractiveModeContext({
			streamingComponent: new AssistantMessageComponent(),
			session: {
				agent: {
					getPendingToolResults: () => [pending],
				},
			},
		});
		const blocks: Component[] = [];
		const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
		vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(block => {
			blocks.push(block);
			addChild(block);
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await controller.handleEvent(streamedToolBlock("grep-restore-2", "grep", { pattern: "start" }));
		await controller.handleEvent(streamedToolBlock("grep-restore-2", "grep", { pattern: "start" }));

		expect(blocks).toHaveLength(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(Bun.stripANSI(blocks[0]!.render(120).join("\n"))).toContain("AGENT_START_MATCH");
	});
});

describe("compact Todo failure projection", () => {
	/** Newest activity rows owned by the active turn. */
	function renderDock(ctx: InteractiveModeContext, width = 180): string {
		return Bun.stripANSI((ctx.chatContainer.compactToolActivityBlock()?.render(width) ?? []).join("\n"));
	}

	it("hides the warning only while its own failed execution is a dock row", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.chatContainer.setCompactTurnActive(true);
		await f.controller.handleEvent(streamedTodoBlock("todo-1"));
		await f.controller.handleEvent(todoFailure("PROVIDER_FAILURE_REASON\nFULL_DETAIL_LINE"));
		const warning = f.ctx.chatContainer.children.at(-1) as ToolActivityContainer;

		const compact = renderTranscript(f.ctx);
		expect(f.ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent)).toHaveLength(1);
		expect(compact).not.toContain("PROVIDER_FAILURE_REASON");
		expect(compact).not.toContain("FULL_DETAIL_LINE");
		expect(renderDock(f.ctx)).not.toBe("");
		expect(warning.render(180)).toHaveLength(0);
		f.ctx.chatContainer.nativeBlocks();
		expect(warning.describe().p?.hidden).toBe(true);
		expect(f.ctx.setTodos).not.toHaveBeenCalled();

		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		const detailed = renderTranscript(f.ctx);
		expect(detailed).toContain("FULL_DETAIL_LINE");
		expect(warning.render(180).length).toBeGreaterThan(0);
		expect(warning.describe().p?.hidden).not.toBe(true);

		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(renderTranscript(f.ctx)).not.toContain("PROVIDER_FAILURE_REASON");
		expect(warning.describe().p?.hidden).toBe(true);
		f.ctx.chatContainer.setToolActivityVisible(false);
		expect(renderTranscript(f.ctx)).not.toContain("PROVIDER_FAILURE_REASON");
		f.ctx.chatContainer.setToolActivityVisible(true);
		expect(renderTranscript(f.ctx)).not.toContain("PROVIDER_FAILURE_REASON");
		expect(warning.describe().p?.hidden).toBe(true);
	});

	it("keeps independent warnings, unknown identities and separate identical failures", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.chatContainer.setCompactTurnActive(true);
		const ids = ["todo-1", "todo-2"];
		for (const [index, id] of ids.entries()) {
			await f.controller.handleEvent(streamedTodoBlock(id, ids.slice(0, index)));
			await f.controller.handleEvent(todoFailure("SAME_FAILURE_REASON", id));
		}
		f.ctx.showWarning("SAME_FAILURE_REASON");
		f.ctx.showWarning("SAME_FAILURE_REASON", {
			hideWithToolActivity: true,
			toolFailure: { toolCallId: "unknown-call" },
		});
		f.ctx.showWarning("SAME_FAILURE_REASON", {
			hideWithToolActivity: true,
			toolFailure: { toolCallId: "" },
		});
		expect(renderTranscript(f.ctx).match(/SAME_FAILURE_REASON/g)).toHaveLength(3);
		expect(f.ctx.setTodos).not.toHaveBeenCalled();
	});

	it("does not merge a warning into a pending or successful execution with the same identity", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.chatContainer.setCompactTurnActive(true);
		await f.controller.handleEvent(streamedTodoBlock("todo-1"));
		f.ctx.showWarning("UNMERGED_REASON", {
			hideWithToolActivity: true,
			toolFailure: { toolCallId: "todo-1" },
		});
		expect(renderTranscript(f.ctx)).toContain("UNMERGED_REASON");
		await f.controller.handleEvent(todoEnd("todo-1", []));
		expect(renderTranscript(f.ctx)).toContain("UNMERGED_REASON");
	});

	it("keeps an already committed warning visible instead of rewriting scrollback", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		await f.controller.handleEvent(todoFailure("LATE_FAILURE_REASON"));
		const warning = f.ctx.chatContainer.children[0] as ToolActivityContainer;
		const batch = f.ctx.chatContainer.peekFinalizedBatch(180, 0);
		expect(batch?.rows.join("\n")).toContain("LATE_FAILURE_REASON");
		f.ctx.chatContainer.acknowledgeFinalizedBatch(batch!.id);
		f.ctx.chatContainer.setCompactTurnActive(true);
		await f.controller.handleEvent(streamedTodoBlock("todo-1"));
		await f.controller.handleEvent(todoFailure("LATE_FAILURE_REASON", "todo-1"));

		// The failed execution is docked now, but the warning already entered
		// immutable history; hiding it would require clearing and replaying.
		expect(warning.render(180).length).toBeGreaterThan(0);
		expect(warning.describe().p?.hidden).not.toBe(true);
		expect(f.ctx.chatContainer.peekReplayBatch(180)).toBeUndefined();
		expect(f.ctx.pendingTools.size).toBe(0);
		expect(f.ctx.setTodos).not.toHaveBeenCalled();
	});

	it("keeps a rebuilt warning independent until its exact failed execution is docked", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.viewSession.buildTranscriptSessionContext = () => f.ctx.sessionManager.buildSessionContext();
		await f.controller.handleEvent(todoFailure("REBUILD_FAILURE_REASON"));
		await f.helpers.renderInitialMessages();
		expect(renderTranscript(f.ctx)).toContain("REBUILD_FAILURE_REASON");
		f.ctx.chatContainer.setCompactTurnActive(true);
		await f.controller.handleEvent(streamedTodoBlock("todo-1"));
		expect(renderTranscript(f.ctx)).not.toContain("REBUILD_FAILURE_REASON");
		expect(f.ctx.pendingTools.size).toBe(0);
	});

	it.each(["detailed", "clean"] as const)("drops stale warnings on %s replay", async presentation => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.addMessageToChat = f.helpers.addMessageToChat.bind(f.helpers);
		const failure = todoFailure("HISTORY_FAILURE_REASON\nPRESERVED_DETAIL_LINE");
		await f.controller.handleEvent(streamedTodoBlock("todo-1"));
		await f.controller.handleEvent(failure);
		const context: SessionContext = {
			...f.ctx.sessionManager.buildSessionContext(),
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { todos: [] } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					timestamp: 1,
					stopReason: "toolUse",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{
					role: "toolResult",
					toolCallId: "todo-1",
					toolName: "todo",
					content: [{ type: "text", text: "HISTORY_FAILURE_REASON\nPRESERVED_DETAIL_LINE" }],
					isError: true,
					timestamp: 2,
				},
				assistantMsg("FINAL_ANSWER_AFTER_FAILURE"),
			],
		};
		const storedResult = JSON.stringify(context.messages[1]);
		f.ctx.viewSession.buildTranscriptSessionContext = () => context;
		await f.helpers.renderInitialMessages();
		// Compact replay keeps the warning as the failure trace; history hides tool rows.
		expect(renderTranscript(f.ctx)).toContain("HISTORY_FAILURE_REASON");
		setChatTranscriptDisplayPreferences({
			compactToolActivity: presentation === "clean",
			hideToolActivity: presentation === "clean",
		});
		f.ctx.hideToolActivity = presentation === "clean";
		f.ctx.chatContainer.setToolActivityVisible(!f.ctx.hideToolActivity);
		await f.helpers.renderInitialMessages();
		const rebuilt = renderTranscript(f.ctx);
		expect(rebuilt).toContain("FINAL_ANSWER_AFTER_FAILURE");
		expect(rebuilt).not.toContain("Warning:");
		if (presentation === "clean") expect(rebuilt).not.toContain("HISTORY_FAILURE_REASON");
		// Revealing clean history must not resurrect a warning retained while hidden.
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		f.ctx.hideToolActivity = false;
		f.ctx.chatContainer.setToolActivityVisible(true);
		const detailed = renderTranscript(f.ctx);
		expect(detailed.match(/HISTORY_FAILURE_REASON/g)).toHaveLength(1);
		expect(detailed).toContain("PRESERVED_DETAIL_LINE");
		expect(detailed.indexOf("PRESERVED_DETAIL_LINE")).toBeLessThan(detailed.indexOf("FINAL_ANSWER_AFTER_FAILURE"));
		expect(detailed).not.toContain("Warning:");
		await f.helpers.renderInitialMessages();
		expect(renderTranscript(f.ctx)).not.toContain("Warning:");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(renderTranscript(f.ctx)).not.toContain("HISTORY_FAILURE_REASON");
		expect(JSON.stringify(context.messages[1])).toBe(storedResult);
		expect(f.ctx.setTodos).not.toHaveBeenCalled();
	});

	it("does not treat a different successful update as recovery of the failed execution", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.chatContainer.setCompactTurnActive(true);
		await f.controller.handleEvent(streamedTodoBlock("todo-1"));
		await f.controller.handleEvent(todoFailure("UNRESOLVED_FAILURE_REASON"));
		await f.controller.handleEvent(streamedTodoBlock("todo-success", ["todo-1"]));
		await f.controller.handleEvent(todoEnd("todo-success", []));
		const rendered = renderTranscript(f.ctx);
		expect(rendered).not.toContain("UNRESOLVED_FAILURE_REASON");
		expect(renderDock(f.ctx)).not.toBe("");
	});

	it("keeps a warning visible once newer calls evict its failed execution from the dock", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const f = createPresentationFixture();
		f.ctx.chatContainer.setCompactTurnActive(true);
		const ids = ["todo-1", "todo-2", "todo-3"];
		for (const [index, id] of ids.entries()) {
			await f.controller.handleEvent(streamedTodoBlock(id, ids.slice(0, index)));
			await f.controller.handleEvent(todoFailure(id === "todo-1" ? "EVICTED_REASON" : `LATER_REASON_${id}`, id));
		}
		const rendered = renderTranscript(f.ctx);
		expect(rendered).toContain("EVICTED_REASON");
		expect(rendered).not.toContain("LATER_REASON_todo-2");
		expect(rendered).not.toContain("LATER_REASON_todo-3");
		expect(renderDock(f.ctx)).not.toBe("");
		expect(f.ctx.setTodos).not.toHaveBeenCalled();
	});
});
