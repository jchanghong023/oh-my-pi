import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { AsyncJobDetails } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { InputController } from "../../src/modes/controllers/input-controller";
import { cfgDisplayMode } from "../../src/modes/settings";
import { TodoLoopPresentation, TodoLoopStatusBlock } from "../../src/todoloop/presentation";
import type { TodoLoopState } from "../../src/todoloop/runner";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { VirtualRenderScheduler } from "../../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const task = {
	id: "3.2",
	text: "Implement\tthe current item\nwithout repeating a complete dispatch prompt",
	done: false,
	line: 3,
};
const nextTask = { ...task, id: "3.3", text: "Finish the next group item", line: 4 };
const group = { id: "3", title: "Implementation", tasks: [task, nextTask] };
const initial: TodoLoopState = {
	phase: "running",
	filePath: "/workspace/a long directory/tasks.md",
	completed: 7,
	total: 18,
	completedGroups: 2,
	totalGroups: 4,
	group,
	current: task,
	attempt: 2,
};
const displayPreferences = { ...chatTranscriptDisplayPreferences };
afterEach(() => setChatTranscriptDisplayPreferences(displayPreferences));
beforeAll(async () => {
	await initTheme(false);
});

const nativeContext: DescribeContext = {
	cols: 100,
	reduceMotion: true,
	dark: true,
	supports: () => true,
	feature: () => true,
};

/** Follow the same component boundaries as native reconciliation, including container visibility. */
function nativeNodes(child: NativeChild, cx = nativeContext): NativeNode[] {
	const node = "k" in child ? child : child.describe?.(cx);
	if (!node || (node.p as { hidden?: boolean } | undefined)?.hidden) return [];
	return [{ ...node, c: undefined }, ...(node.c ?? []).flatMap(child => nativeNodes(child, cx))];
}

describe("TodoLoop native transcript presentation", () => {
	it("updates live group progress across tasks on the same dock and agent card", () => {
		const ctx = createInteractiveModeContext();
		const presentation = new TodoLoopPresentation(ctx, initial);
		const status = presentation.status;
		const id = "multi-task-group";
		presentation.onAttempt({ type: "start", id, group, attempt: 2 });
		const card = presentation.attempts.get(id)!;
		const progressedGroup = { ...group, tasks: [{ ...task, done: true }, nextTask] };
		presentation.onState({ ...initial, completed: 8, group: progressedGroup, current: nextTask });
		presentation.onAttempt({ type: "update", id, group: progressedGroup, attempt: 2, text: "First item verified" });
		expect(ctx.statusContainer.children).toEqual([status]);
		expect(ctx.chatContainer.children).toEqual([card]);
		expect(presentation.attempts.get(id)).toBe(card);
		const live = status.render(100).join("\n");
		expect(live).toContain("8/18");
		expect(live).toContain("2/4");
		expect(live).toContain("3.3");
		expect(live).not.toContain("Task 3.2");
		const completedGroup = { ...group, tasks: group.tasks.map(task => ({ ...task, done: true })) };
		presentation.onState({
			...initial,
			completed: 9,
			completedGroups: 3,
			group: completedGroup,
			current: undefined,
		});
		const waiting = status.render(100).join("\n");
		expect(waiting).toContain("Group 3");
		expect(waiting).toContain("2/3");
		expect(waiting).toContain("9/18");
		expect(waiting).toContain("3/4");
		expect(waiting).not.toContain("Task ");
		expect(status.isTranscriptBlockFinalized()).toBe(false);
		expect(presentation.attempts.size).toBe(1);
		expect(ctx.chatContainer.children).toEqual([card]);
	});

	it("mutates one status block through retry and settlement without adding status logs", () => {
		const ctx = createInteractiveModeContext();
		const presentation = new TodoLoopPresentation(ctx, initial);
		for (const phase of [
			"retrying",
			"stopping",
			"stopped",
			"settlement_failed",
			"file_error",
			"failed",
			"completed",
		] as const) {
			presentation.onState({ ...initial, phase, reason: "real\treason from execution" });
			expect(ctx.chatContainer.children).toHaveLength(0);
			expect(ctx.statusContainer.children).toEqual([presentation.status]);
			const text = presentation.status.render(100).join("\n");
			expect(text).toContain(phase);
			expect(text).toContain("7/18");
			expect(text).toContain("3.2");
			expect(text).toContain("2/3");
			expect(text).toContain("real");
			expect(text).not.toContain("\t");
			expect(presentation.status.isTranscriptBlockFinalized()).toBe(phase !== "retrying" && phase !== "stopping");
		}
		presentation.finish();
		expect(ctx.chatContainer.children).toEqual([presentation.status]);
		expect(ctx.statusContainer.children).toHaveLength(0);
		presentation.finish();
		presentation.onState({ ...initial, phase: "running" });
		expect(ctx.chatContainer.children).toEqual([presentation.status]);
		expect(presentation.status.render(100).join("\n")).toContain("completed");
	});

	it.each(["failed", "settlement_failed", "stopped", "completed"] as const)(
		"keeps %s and live stopping visible in the 42x28 software terminal budget",
		async phase => {
			setChatTranscriptDisplayPreferences({ hideToolActivity: true, compactToolActivity: true });
			const terminal = new VirtualTerminal(42, 28);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true, completeScrollback: false },
			});
			const ctx = createInteractiveModeContext({ hideToolActivity: true });
			ctx.ui.requestRender = () => composer.ui.requestRender();
			const otherStatus = new Text("Other command status", 0, 0);
			ctx.statusContainer.addChild(otherStatus);
			const editor = new Container();
			editor.addChild(new Text("❯ \n\nFixed footer hints\nEsc interrupt · Ctrl+O expand", 0, 0));
			composer.setRuntimeChildren([ctx.chatContainer, ctx.statusContainer, editor], {
				transientChrome: [editor],
				billedChrome: [ctx.statusContainer],
				nativeDock: [ctx.statusContainer, editor],
			});
			composer.start({ playWelcomeIntro: false });
			try {
				for (let i = 0; i < 50; i++) ctx.present(new Text(`Committed native history ${i}`, 0, 0));
				await scheduler.settle(terminal);
				const history = terminal.getScrollBuffer().filter(line => line.includes("Committed native history"));
				const presentation = new TodoLoopPresentation(ctx, { ...initial, filePath: "/work/todo.md" });
				const status = presentation.status;
				for (const attempt of [1, 2, 3]) {
					const id = `narrow-${attempt}`;
					presentation.onAttempt({ type: "start", id, group, attempt });
					presentation.onAttempt({
						type: "end",
						id,
						group,
						attempt,
						status: "failed",
						text: Array.from({ length: 20 }, (_, i) => `Actual native output ${attempt}:${i}`).join("\n"),
						error: "Actual execution error",
					});
					await scheduler.settle(terminal);
				}
				presentation.onState({
					...initial,
					filePath: "/work/todo.md",
					phase: "stopping",
					attempt: 3,
					reason: "Waiting for actual settlement",
				});
				await scheduler.settle(terminal);
				expect(ctx.statusContainer.children).toEqual([otherStatus, status]);
				expect(ctx.chatContainer.children).not.toContain(status);
				let view = terminal.getViewport().join("\n");
				for (const fact of [
					"TodoLoop stopping",
					"7/18",
					"todo.md",
					"Task 3.2",
					"3/3",
					"Waiting for actual settlement",
				])
					expect(view).toContain(fact);
				expect(view).toContain("Fixed footer hints");
				presentation.onState({
					...initial,
					filePath: "/work/todo.md",
					phase,
					attempt: 3,
					reason: "Real settlement reason",
				});
				presentation.finish();
				await scheduler.settle(terminal);
				expect(ctx.statusContainer.children).toEqual([otherStatus]);
				expect(ctx.chatContainer.children.at(-1)).toBe(status);
				expect(ctx.chatContainer.children.filter(child => child === status)).toHaveLength(1);
				view = terminal.getViewport().join("\n");
				for (const fact of [`TodoLoop ${phase}`, "7/18", "todo.md", "Task 3.2", "3/3", "Real settlement reason"])
					expect(view).toContain(fact);
				expect(
					terminal
						.getScrollBuffer()
						.join("\n")
						.match(/TodoLoop /g),
				).toHaveLength(1);
				expect(
					terminal
						.getScrollBuffer()
						.filter(line => line.includes("Committed native history"))
						.slice(0, history.length),
				).toEqual(history);
				const row = terminal.getViewport().findIndex(line => line.includes(`TodoLoop ${phase}`));
				expect(terminal.getViewportRowBackgroundColumns(row)).toHaveLength(0);
			} finally {
				composer.stop();
			}
		},
	);

	it.each(["session", "shutdown"] as const)("detaches only its own dock on %s and rejects late callbacks", cause => {
		const ctx = createInteractiveModeContext();
		const other = new Text("Unrelated status", 0, 0);
		ctx.statusContainer.addChild(other);
		const presentation = new TodoLoopPresentation(ctx, initial);
		if (cause === "session")
			Object.defineProperty(ctx.session, "sessionGeneration", { value: ctx.session.sessionGeneration + 1 });
		else Object.defineProperty(ctx, "isShuttingDown", { value: true });
		presentation.onState({ ...initial, phase: "stopping" });
		presentation.onAttempt({ type: "start", id: "late-old-owner", group, attempt: 3 });
		presentation.finish();
		presentation.dispose();
		expect(ctx.statusContainer.children).toEqual([other]);
		expect(ctx.chatContainer.children).toHaveLength(0);
		expect(presentation.attempts.size).toBe(0);
	});

	it.each([8, 16, 24, 40])("bounds sanitized status output at width %i", width => {
		const status = new TodoLoopStatusBlock({
			...initial,
			phase: "failed",
			reason: "failure\twith control\u001b[2J characters and a long reason",
		});
		expect(status.render(width).length).toBeLessThanOrEqual(6);
		for (const line of status.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\u001b[2J");
		}
		const text = status.render(24).join("\n");
		expect(text).toContain("Task 3.2");
		expect(text).toContain("2/3");
		expect(text).toContain("failure");
	});

	it("renders native result details without exposing the dispatched assignment", () => {
		const ctx = createInteractiveModeContext();
		const presentation = new TodoLoopPresentation(ctx, initial);
		const id = "native-details-agent";
		const privatePrompt = "PRIVATE FULL DISPATCH ENVELOPE";
		const details = {
			projectAgentsDir: null,
			totalDurationMs: 12,
			results: [
				{
					index: 0,
					id,
					agent: "task",
					agentSource: "project",
					task: privatePrompt,
					assignment: privatePrompt,
					description: privatePrompt,
					exitCode: 0,
					output: "real native output",
					stderr: "",
					truncated: false,
					durationMs: 12,
					tokens: 5,
					requests: 1,
				},
			],
		};
		presentation.onAttempt({ type: "start", id, group, attempt: 2 });
		presentation.onAttempt({ type: "end", id, group, attempt: 2, details, status: "completed" });
		const card = presentation.attempts.get(id)!;
		card.setExpanded(true);
		const text = card.render(100).join("\n");
		expect(text).toContain("real native output");
		expect(text).not.toContain(privatePrompt);
		expect(details.results[0]!.task).toBe(privatePrompt);
	});

	it.each(["completed", "failed"] as const)(
		"renders real eval-bridge progress and %s completion without a task results envelope",
		status => {
			const ctx = createInteractiveModeContext();
			const presentation = new TodoLoopPresentation(ctx, initial);
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
			const details: AsyncJobDetails = { progress: [progress] };
			presentation.onAttempt({ type: "start", id, group, attempt: 2 });
			presentation.onAttempt({ type: "update", id, group, attempt: 2, details });
			const card = presentation.attempts.get(id)!;
			card.setExpanded(true);
			const liveText = card.render(140).join("\n");
			expect(liveText).toContain("read");
			expect(liveText).toContain("src/real-consumer.ts");
			expect(liveText).toContain("real live tool output");
			expect(liveText).not.toContain(privatePrompt);
			const liveNative = JSON.stringify(nativeNodes(ctx.chatContainer));
			expect(liveNative).toContain("src/real-consumer.ts");
			expect(liveNative).toContain("real live tool output");
			expect(liveNative).not.toContain(privatePrompt);

			const output = "real eval completion output";
			const error = status === "failed" ? "real eval execution error" : undefined;
			const finalDetails: AsyncJobDetails | undefined =
				status === "completed" ? { evalResult: { text: output } } : undefined;
			presentation.onAttempt({
				type: "end",
				id,
				group,
				attempt: 2,
				details: finalDetails,
				text: status === "failed" ? output : undefined,
				error,
				status,
			});
			const finalText = card.render(140).join("\n");
			expect(finalText).toContain(output);
			if (error) expect(finalText).toContain(error);
			expect(finalText).not.toContain(privatePrompt);
			expect(finalText).toContain("bash");
			expect(finalText).toContain("real-command");
			expect(finalText).toContain("real live tool output");
			const native = JSON.stringify(nativeNodes(ctx.chatContainer));
			expect(native).toContain(output);
			expect(native).toContain("real-command");
			expect(native).toContain("real live tool output");
			if (error) expect(native).toContain(error);
			expect(native).not.toContain(privatePrompt);
			expect(progress.status).toBe("running");
			expect(progress.task).toBe(privatePrompt);
			for (const width of [16, 24, 40]) {
				for (const line of ctx.chatContainer.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line).not.toContain("\t");
				}
			}
			const ordinaryView = taskToolRenderer.describeResult(
				{
					content: [{ type: "text", text: output }],
					details: {
						projectAgentsDir: null,
						totalDurationMs: 12,
						results: [],
						progress: [{ ...progress, status }],
					},
				},
				{ expanded: true, isPartial: false },
			);
			expect(JSON.stringify(ordinaryView)).not.toContain("real-command");
			expect(JSON.stringify(ordinaryView)).not.toContain("real live tool output");
		},
	);
	it("keeps separate expandable native cards for retries and carries real output and errors", () => {
		const ctx = createInteractiveModeContext();
		const presentation = new TodoLoopPresentation(ctx, initial);
		for (const attempt of [1, 2]) {
			const id = `real-agent-${attempt}`;
			presentation.onAttempt({ type: "start", id, group, attempt });
			presentation.onAttempt({ type: "update", id, group, attempt, text: `progress ${attempt}` });
			presentation.onAttempt({
				type: "end",
				id,
				group,
				attempt,
				text: `actual result ${attempt}`,
				error: attempt === 2 ? "actual\terror" : undefined,
				status: attempt === 2 ? "failed" : "completed",
			});
		}
		expect(ctx.chatContainer.children).toHaveLength(2);
		const first = presentation.attempts.get("real-agent-1")!;
		const second = presentation.attempts.get("real-agent-2")!;
		expect(first).toBeInstanceOf(ToolExecutionComponent);
		expect(second).toBeInstanceOf(ToolExecutionComponent);
		expect(first).not.toBe(second);
		first.setExpanded(true);
		second.setExpanded(true);
		const firstText = first.render(100).join("\n");
		const secondText = second.render(100).join("\n");
		expect(firstText).toContain("actual result 1");
		expect(firstText).toContain("Group 3");
		expect(firstText).toContain("attempt 1/3");
		expect(secondText).toContain("Group 3");
		expect(secondText).toContain("attempt 2/3");
		expect(secondText).toContain("actual");
		expect(secondText).toContain("error");
		expect(secondText).not.toContain("\t");
		expect(firstText + secondText).not.toContain("without repeating a complete dispatch prompt");
	});

	it.each([true, false])(
		"keeps command cards visible in compact native display (data-first=%s) and routes Ctrl+O",
		dataFirst => {
			const ctx = createInteractiveModeContext({ settings: Settings.isolated(), hideToolActivity: true });
			cfgDisplayMode.set(ctx.settings, "compact");
			setChatTranscriptDisplayPreferences({ hideToolActivity: true, compactToolActivity: true });
			ctx.chatContainer.setToolActivityVisible(false);
			const controller = new InputController(ctx);
			const presentation = new TodoLoopPresentation(ctx, initial);
			const ordinary = new ToolExecutionComponent(
				"task",
				{ tasks: [{ agent: "task", task: "ordinary ambient task" }] },
				{ useBuiltInRenderer: true },
				undefined,
				ctx.ui,
			);
			ctx.present(ordinary);
			const cx = { ...nativeContext, supports: () => dataFirst };
			for (const attempt of [1, 2]) {
				const id = `compact-attempt-${attempt}`;
				presentation.onAttempt({ type: "start", id, group, attempt });
				presentation.onAttempt({
					type: "end",
					id,
					group,
					attempt,
					text: `real compact output ${attempt}`,
					error: attempt === 1 ? "real compact error" : undefined,
					status: attempt === 1 ? "failed" : "completed",
				});
			}
			const cards = nativeNodes(ctx.chatContainer, cx).filter(node => node.k === (dataFirst ? "tool" : "card"));
			expect(cards).toHaveLength(2);
			for (const card of cards) expect(card.p).toMatchObject({ collapsed: true });
			expect(JSON.stringify(nativeNodes(ctx.chatContainer, cx))).not.toContain("ordinary ambient task");
			expect(ctx.chatContainer.render(100).join("\n")).toContain("Group 3");
			controller.toggleToolOutputExpansion();
			for (const card of nativeNodes(ctx.chatContainer, cx).filter(
				node => node.k === (dataFirst ? "tool" : "card"),
			)) {
				expect(card.p).toMatchObject({ collapsed: false });
			}
			for (const card of presentation.attempts.values()) expect(card.isExpanded()).toBe(true);
			expect(ordinary.isExpanded()).toBe(false);
			const expanded = ctx.chatContainer.render(100).join("\n");
			expect(expanded).toContain("real compact output 1");
			expect(expanded).toContain("real compact output 2");
			expect(expanded).toContain("real compact error");
			controller.toggleToolOutputExpansion();
			for (const card of presentation.attempts.values()) expect(card.isExpanded()).toBe(false);
			expect(
				nativeNodes(ctx.chatContainer, cx).filter(node => node.k === (dataFirst ? "tool" : "card")),
			).toHaveLength(2);
			presentation.onAttempt({ type: "start", id: "later-attempt", group, attempt: 3 });
			controller.toggleToolOutputExpansion();
			for (const card of presentation.attempts.values()) expect(card.isExpanded()).toBe(true);
			presentation.onAttempt({ type: "start", id: "next-group", group: { ...group, id: "4" }, attempt: 1 });
			expect(presentation.attempts.get("next-group")!.isExpanded()).toBe(true);
		},
	);
});
