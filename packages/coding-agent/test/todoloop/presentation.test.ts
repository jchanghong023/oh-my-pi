import { beforeAll, describe, expect, it } from "bun:test";
import { jsx } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { AsyncJobDetails } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { cfgDisplayMode } from "../../src/modes/settings";
import type { AgentProgress } from "../../src/task/task-details";
import { setTodoLoopCardsExpanded, TodoLoopPresentation, todoLoopStatusView } from "../../src/todoloop/presentation";
import type { TodoLoopState } from "../../src/todoloop/runner";
import { printRows } from "../../src/ui/print-rows";
import { initTheme } from "../../src/ui/theme/service";
import { attachTerminal, createInteractiveModeContext, renderTranscript } from "../helpers/interactive-mode-context";

const task = {
	id: "3.2",
	text: "Implement\tthe current item\nwithout repeating a dispatch prompt",
	done: false,
	line: 3,
};
const nextTask = { ...task, id: "3.3", text: "Finish the next group item", line: 4 };
const group = { id: "3", title: "Implementation", tasks: [task, nextTask] };
const initial: TodoLoopState = {
	phase: "running",
	filePath: "/work/todo.md",
	completed: 7,
	total: 18,
	completedGroups: 2,
	totalGroups: 4,
	group,
	current: task,
	attempt: 2,
};

beforeAll(() => {
	initTheme();
});

function fixture(width = 120, rows = 28) {
	const ctx = createInteractiveModeContext({ settings: Settings.isolated(), hideToolActivity: true });
	cfgDisplayMode.set(ctx.settings, "compact");
	const term = attachTerminal(ctx, { columns: width, rows });
	return {
		ctx,
		term,
		text() {
			term.render();
			return term.screen().join("\n");
		},
	};
}

describe("TodoLoop transcript presentation", () => {
	it("updates live progress on the same dock and existing attempt block", () => {
		const h = fixture();
		try {
			const p = new TodoLoopPresentation(h.ctx, initial);
			const id = "multi-task-group";
			p.onAttempt({ type: "start", id, group, attempt: 2 });
			const [card] = h.ctx.shell.transcript.blocks();
			expect(card).toBeDefined();
			const [widget] = h.ctx.hud.widgets.above();
			const progressedGroup = { ...group, tasks: [{ ...task, done: true }, nextTask] };
			p.onState({ ...initial, completed: 8, group: progressedGroup, current: nextTask });
			p.onAttempt({ type: "update", id, group: progressedGroup, attempt: 2, text: "First item verified" });
			expect(h.ctx.shell.transcript.blocks()).toEqual([card]);
			expect(h.ctx.hud.widgets.above()).toEqual([widget]);
			const live = h.text();
			for (const marker of ["8/18", "2/4", "3.3"]) expect(live).toContain(marker);
			expect(live).not.toContain("Task 3.2");
			p.onState({
				...initial,
				completed: 9,
				completedGroups: 3,
				group: { ...group, tasks: group.tasks.map(task => ({ ...task, done: true })) },
				current: undefined,
			});
			const waiting = h.text();
			for (const marker of ["Group 3", "2/3", "9/18", "3/4"]) expect(waiting).toContain(marker);
			expect(waiting).not.toMatch(/\bTask 3\.[23]:/);
			expect(h.ctx.shell.transcript.blocks()).toEqual([card]);
		} finally {
			h.term.dispose();
		}
	});

	it("updates only its live status and records one immutable terminal snapshot", () => {
		const h = fixture();
		try {
			const p = new TodoLoopPresentation(h.ctx, initial);
			const [status] = h.ctx.hud.widgets.above();
			for (const phase of [
				"retrying",
				"stopping",
				"stopped",
				"settlement_failed",
				"file_error",
				"failed",
				"completed",
			] as const) {
				p.onState({ ...initial, phase, reason: "real\treason from execution" });
				expect(h.ctx.shell.transcript.blocks()).toHaveLength(0);
				expect(h.ctx.hud.widgets.above()).toEqual([status]);
				const text = h.text();
				for (const marker of [phase, "7/18", "3.2", "2/3", "real"]) expect(text).toContain(marker);
				expect(text).not.toContain("\t");
			}
			p.finish();
			p.finish();
			p.onState({ ...initial, phase: "running" });
			expect(h.ctx.shell.transcript.blocks()).toHaveLength(1);
			expect(h.ctx.hud.widgets.above()).toHaveLength(0);
			expect(h.text()).toContain("TodoLoop completed");
		} finally {
			h.term.dispose();
		}
	});

	it.each(["failed", "settlement_failed", "stopped", "completed"] as const)(
		"keeps %s settlement, the draft, and committed history on a 42×28 terminal",
		phase => {
			const h = fixture(42);
			try {
				h.ctx.composer.setText("KEEP MY DRAFT");
				for (let i = 0; i < 50; i++) h.ctx.present(() => jsx("text", { text: `Committed history ${i}` }));
				h.term.render();
				const history = [...h.term.history()];
				expect(history.length).toBeGreaterThan(0);
				h.ctx.hud.widgets.set("other", () => jsx("text", { text: "Other command status" }));
				const p = new TodoLoopPresentation(h.ctx, initial);
				for (const attempt of [1, 2, 3]) {
					const id = `narrow-${attempt}`;
					p.onAttempt({ type: "start", id, group, attempt });
					p.onAttempt({
						type: "end",
						id,
						group,
						attempt,
						status: "failed",
						text: "Actual output",
						error: "Actual error",
					});
				}
				p.onState({ ...initial, phase: "stopping", attempt: 3, reason: "Waiting for actual settlement" });
				const stopping = h.text();
				for (const marker of [
					"TodoLoop stopping",
					"7/18",
					"todo.md",
					"Task 3.2",
					"3/3",
					"Waiting for actual settlement",
					"KEEP MY DRAFT",
				])
					expect(stopping).toContain(marker);
				p.onState({ ...initial, phase, attempt: 3, reason: "Real settlement reason" });
				p.finish();
				const settled = h.text();
				for (const marker of [
					`TodoLoop ${phase}`,
					"7/18",
					"todo.md",
					"Task 3.2",
					"3/3",
					"Real settlement reason",
					"Other command status",
					"KEEP MY DRAFT",
				])
					expect(settled).toContain(marker);
				expect(h.term.history().slice(0, history.length)).toEqual(history);
				expect(
					renderTranscript(h.ctx)
						.join("\n")
						.match(/TodoLoop /g),
				).toHaveLength(1);
			} finally {
				h.term.dispose();
			}
		},
	);

	it.each(["session", "shutdown"] as const)("detaches only its own widget on %s and rejects late callbacks", cause => {
		const ctx = createInteractiveModeContext({ session: { sessionGeneration: 0 } });
		ctx.hud.widgets.set("other", () => jsx("text", { text: "Unrelated status" }));
		const p = new TodoLoopPresentation(ctx, initial);
		if (cause === "session")
			Object.defineProperty(ctx.session, "sessionGeneration", { value: ctx.session.sessionGeneration + 1 });
		else Object.defineProperty(ctx, "isShuttingDown", { value: true });
		p.onState({ ...initial, phase: "stopping" });
		p.onAttempt({ type: "start", id: "late-old-owner", group, attempt: 3 });
		p.finish();
		p.dispose();
		expect(ctx.hud.widgets.above().map(widget => widget.key)).toEqual(["other"]);
		expect(ctx.shell.transcript.blocks()).toHaveLength(0);
	});

	it.each([8, 16, 24, 40])("bounds and sanitizes status at width %i", width => {
		const state = { ...initial, phase: "failed" as const, reason: "failure\twith control\u001b[2J characters" };
		const rows = printRows(() => todoLoopStatusView(() => state), width);
		expect(rows.length).toBeLessThanOrEqual(6);
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(row).not.toMatch(/\t|\u001b\[2J/);
		}
	});

	it.each(["completed", "failed"] as const)(
		"projects actual eval progress and %s result without leaking the task envelope",
		status => {
			const ctx = createInteractiveModeContext();
			const p = new TodoLoopPresentation(ctx, initial);
			const id = `eval-bridge-${status}`;
			const privatePrompt = "PRIVATE EVAL DISPATCH ENVELOPE";
			const progress: AgentProgress = {
				index: 0,
				id,
				agent: "task",
				agentSource: "project",
				status: "running",
				task: privatePrompt,
				assignment: privatePrompt,
				description: privatePrompt,
				currentTool: "read",
				currentToolArgs: "src/real-consumer.ts",
				recentTools: [{ tool: "bash", args: "real-command", isError: true, endMs: 10 }],
				recentOutput: ["real live tool output"],
				toolCount: 2,
				requests: 1,
				tokens: 5,
				cost: 0,
				durationMs: 12,
			};
			p.onAttempt({ type: "start", id, group, attempt: 2 });
			p.onAttempt({ type: "update", id, group, attempt: 2, details: { progress: [progress] } });
			expect(setTodoLoopCardsExpanded(ctx, true)).toBe(true);
			const live = renderTranscript(ctx, 140).join("\n");
			for (const marker of ["read", "src/real-consumer.ts", "real live tool output"]) expect(live).toContain(marker);
			expect(live).not.toContain(privatePrompt);
			const output = "real eval completion output";
			const error = status === "failed" ? "real eval execution error" : undefined;
			const details: AsyncJobDetails | undefined =
				status === "completed" ? { evalResult: { text: output } } : undefined;
			p.onAttempt({
				type: "end",
				id,
				group,
				attempt: 2,
				details,
				text: status === "failed" ? output : undefined,
				error,
				status,
			});
			const final = renderTranscript(ctx, 140).join("\n");
			for (const marker of [output, "real-command", "real live tool output"]) expect(final).toContain(marker);
			if (error) expect(final).toContain(error);
			expect(final).not.toContain(privatePrompt);
			expect(progress.task).toBe(privatePrompt);
			expect(progress.status).toBe("running");
		},
	);

	it("keeps retry attempt cards visible in compact and expands them without exposing ordinary tools", () => {
		const ctx = createInteractiveModeContext({ settings: Settings.isolated(), hideToolActivity: true });
		cfgDisplayMode.set(ctx.settings, "compact");
		const p = new TodoLoopPresentation(ctx, initial);
		for (const attempt of [1, 2]) {
			const id = `compact-attempt-${attempt}`;
			p.onAttempt({ type: "start", id, group, attempt });
			p.onAttempt({
				type: "end",
				id,
				group,
				attempt,
				text: `real compact output ${attempt}`,
				error: attempt === 1 ? "real compact error" : undefined,
				status: attempt === 1 ? "failed" : "completed",
			});
		}
		const cards = [...ctx.shell.transcript.blocks()];
		expect(cards).toHaveLength(2);
		expect(cards[0]).not.toBe(cards[1]);
		const collapsed = renderTranscript(ctx).join("\n");
		for (const marker of ["Group 3", "attempt 1/3", "attempt 2/3"]) expect(collapsed).toContain(marker);
		expect(collapsed).not.toContain("real compact output 1");
		expect(setTodoLoopCardsExpanded(ctx, true)).toBe(true);
		const expanded = renderTranscript(ctx).join("\n");
		for (const marker of [
			"attempt 1/3",
			"attempt 2/3",
			"real compact output 1",
			"real compact output 2",
			"real compact error",
		])
			expect(expanded).toContain(marker);
		expect(expanded).not.toContain("without repeating a dispatch prompt");
		expect(setTodoLoopCardsExpanded(ctx, false)).toBe(true);
		expect(ctx.shell.transcript.blocks()).toEqual(cards);
		expect(renderTranscript(ctx).join("\n")).not.toContain("real compact output 1");
	});
});
