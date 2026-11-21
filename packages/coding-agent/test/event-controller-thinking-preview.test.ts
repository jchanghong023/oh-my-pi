import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactFileDiff } from "@oh-my-pi/pi-coding-agent/modes/compact-file-diff";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import { CompactToolOutputPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-tool-output-preview";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type ModelStage, nextModelStage } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
	LiveToolOutputPreview,
	LiveToolOutputSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { LatestTurnFileChanges } from "@oh-my-pi/pi-coding-agent/session/latest-turn-file-changes";
import { LiveToolOutputState } from "@oh-my-pi/pi-coding-agent/session/live-tool-output";
import { toolOutputText } from "@oh-my-pi/pi-coding-agent/session/live-tool-output-text";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Loader, setSpinnerInterval, spinnerInterval } from "@oh-my-pi/pi-tui";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import { formatDuration } from "@oh-my-pi/pi-utils";
import {
	applyRenderFixtureEvent,
	createInteractiveModeContext,
	createSessionStub,
} from "./helpers/interactive-mode-context";

function nativeRows(node: NativeNode): readonly string[] {
	if (node.k === "rows" && node.p) return node.p.lines;
	if (node.k === "card") {
		return (node.c ?? []).flatMap(child => {
			if (!("k" in child)) throw new Error("Expected native card content");
			return [...nativeRows(child)];
		});
	}
	if (node.k === "text") return (node.p?.text ?? node.p?.spans?.map(span => span.t).join("") ?? "").split("\n");
	if (node.k !== "col" || !node.c) throw new Error("Expected dock rows or native activity column");
	const text = (child: NativeNode): string => {
		if (child.k === "rows") return child.p?.lines.join("") ?? "";
		if (child.k === "shimmer" || child.k === "text") {
			return child.p?.text ?? child.p?.spans?.map(span => span.t).join("") ?? "";
		}
		if (child.k === "elapsed") return formatDuration(child.p?.stopped ?? child.p?.age ?? 0);
		if (child.k === "row" && child.c) {
			return child.c
				.map(part => {
					if (!("k" in part)) throw new Error("Expected native row node");
					return text(part);
				})
				.join("");
		}
		throw new Error("Expected native activity text");
	};
	return node.c.map(child => {
		if (!("k" in child)) throw new Error("Expected native activity node");
		return text(child);
	});
}

function hasNativeKind(node: NativeNode, kind: string): boolean {
	return node.k === kind || (node.c ?? []).some(child => "k" in child && hasNativeKind(child, kind));
}

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;

function thinkingMessage(text: string, timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function update(
	message: AssistantMessage,
	phase: "thinking_delta" | "thinking_end" | "start" | "text_start",
): MessageUpdate {
	const text = message.content[0];
	if (text?.type !== "thinking") throw new Error("Expected a thinking fixture");
	const assistantMessageEvent: MessageUpdate["assistantMessageEvent"] =
		phase === "start"
			? { type: "start", partial: message }
			: phase === "text_start"
				? { type: "text_start", contentIndex: 0, partial: message }
				: phase === "thinking_end"
					? { type: "thinking_end", contentIndex: 0, content: text.thinking, partial: message }
					: { type: "thinking_delta", contentIndex: 0, delta: text.thinking, partial: message };
	return { type: "message_update", message, assistantMessageEvent };
}

function liveSession(message: AssistantMessage | null = null, activeThinkingIndex?: number, trackOutput = false) {
	const output = trackOutput ? new LiveToolOutputState() : undefined;
	const listeners: Array<(event: AgentSessionEvent) => Promise<void> | void> = [];
	const updates = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();
	const agent = new Agent();
	agent.state.streamMessage = message;
	agent.state.activeThinkingIndex = activeThinkingIndex;
	let stage: ModelStage | null = activeThinkingIndex === undefined ? null : "thinking";
	const session = createSessionStub(SessionManager.inMemory(process.cwd()), settings, {
		isStreaming: message !== null,
		get modelStage() {
			return stage;
		},
		get state() {
			return agent.state;
		},
		subscribeLocal(listener) {
			listeners.push(listener);
			return () => {};
		},
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [...updates.values()],
		getLiveToolOutputPreview: () => output?.preview(),
	});
	Object.defineProperty(session, "agent", { configurable: true, value: agent });
	return {
		session,
		async completeOutput(id: string, text: string): Promise<void> {
			await this.emit({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "bash",
				args: { command: `echo ${id}` },
			});
			await this.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "bash",
				result: { content: [{ type: "text", text }] },
				isError: false,
			});
		},
		async emit(event: AgentSessionEvent): Promise<void> {
			stage = nextModelStage(stage, event);
			const running = event.type === "agent_start";
			if (running || event.type === "agent_end") {
				output?.setRunActive(running, Date.now());
				Object.defineProperty(session, "isRunActive", { configurable: true, value: running });
			}
			output?.observe(event, Date.now());
			switch (event.type) {
				case "tool_execution_start":
				case "tool_execution_end":
				case "message_start":
				case "message_update":
				case "message_end":
				case "agent_start":
				case "agent_end":
					applyRenderFixtureEvent(agent.state, event);
			}
			if (event.type === "tool_execution_start") {
				session.sessionManager.appendCustomEntry("tool_execution_start", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startedAt: new Date().toISOString(),
					intent: event.intent,
				});
				Object.defineProperty(session, "isStreaming", { configurable: true, value: true });
			} else if (event.type === "tool_execution_update") {
				updates.set(event.toolCallId, event);
			} else if (event.type === "tool_execution_end") {
				updates.delete(event.toolCallId);
			} else if (event.type === "agent_end" || event.type === "agent_start") {
				Object.defineProperty(session, "isStreaming", { configurable: true, value: event.type === "agent_start" });
			}
			const listener = listeners.at(-1);
			if (!listener) throw new Error("Session has not been attached");
			await listener(event);
		},
	};
}

const eventControllers: EventController[] = [];
const focusControllers: SessionFocusController[] = [];
const statusLines: StatusLineComponent<AgentSession>[] = [];
const outputPreviews: CompactToolOutputPreview[] = [];
const activityDocks: CompactThinkingPreview[] = [];
let previousDisplayPreferences: typeof chatTranscriptDisplayPreferences;

function focusFixture(fileDiffRows?: () => number) {
	const main = liveSession();
	const statusLine = new StatusLineComponent<AgentSession>(main.session, statusLineHost);
	statusLines.push(statusLine);
	const ctx = createInteractiveModeContext({ session: main.session, statusLine });
	cfgDisplayMode.set(ctx.settings, "compact");
	const fileDiff = fileDiffRows && new CompactFileDiff(ctx, fileDiffRows);
	const output = new CompactToolOutputPreview(
		ctx,
		undefined,
		fileDiff ? (file, width) => fileDiff.coveredDiff(file, width) : undefined,
	);
	const dock = new CompactThinkingPreview(ctx, undefined, width => output.compactActivity(width));
	outputPreviews.push(output);
	activityDocks.push(dock);
	ctx.ui.scheduleAfter = (delay, callback) => {
		const timer = setTimeout(callback, delay);
		return { cancel: () => clearTimeout(timer) };
	};
	ctx.ensureLoadingAnimation = () => {
		if (ctx.loadingAnimation) return;
		const loader = new Loader(
			ctx.ui,
			value => value,
			value => value,
		);
		loader.stop();
		ctx.loadingAnimation = loader;
	};
	ctx.clearTransientSessionUi = () => {
		ctx.loadingAnimation?.stop();
		ctx.loadingAnimation = undefined;
		dock.clear();
	};
	ctx.hideToolActivity = true;
	ctx.chatContainer.setToolActivityVisible(false);
	const controller = new EventController(ctx);
	eventControllers.push(controller);
	ctx.eventController = controller;
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const focus = new SessionFocusController(ctx, registry, () => lifecycle);
	Object.defineProperty(ctx, "viewSession", {
		configurable: true,
		get: () => focus.target ?? ctx.session,
	});
	focusControllers.push(focus);
	Object.assign(ctx, { compactThinkingPreview: dock, compactToolOutputPreview: output });
	return {
		ctx,
		focus,
		dock,
		output,
		outputRows: (width = 120) =>
			[
				output.render(width),
				nativeRows(
					output.describe({
						cols: width,
						reduceMotion: false,
						dark: true,
						supports: () => true,
						feature: () => true,
					}),
				),
			].map(rows => rows.map(row => Bun.stripANSI(row).trimEnd())),
		previewView: (width = 120) => {
			const cx: DescribeContext = {
				cols: width,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			};
			const ansi = output.render(width).map(row => Bun.stripANSI(row).trimEnd());
			const native = nativeRows(output.describe(cx)).map(row => Bun.stripANSI(row).trimEnd());
			// Content assertions exclude the shared transcript gutter, not the tool's own indentation.
			const content = (line: string) => line.replace(/^ /, "");
			return {
				ansi,
				head: content(ansi[0] ?? ""),
				body: ansi.slice(1).map(content),
				nativeHead: content(native[0] ?? ""),
				nativeBody: native.slice(1).map(content),
			};
		},
		register(id: string, live: { session: typeof main.session }) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: live.session,
				status: "running",
			});
		},
		rendered: () => Bun.stripANSI(dock.render(60).join("\n")).trimEnd(),
		nativeRendered: () => {
			const node = dock.describe({
				cols: 60,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			});
			return Bun.stripANSI(nativeRows(node).join("\n")).trimEnd();
		},
		rows: () => dock.render(60),
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	vi.useFakeTimers();
	setChatTranscriptDisplayPreferences({ hideToolActivity: true });
});

afterEach(() => {
	for (const dock of activityDocks.splice(0)) dock.clear();
	for (const output of outputPreviews.splice(0)) output.clear();
	for (const controller of focusControllers.splice(0)) controller.dispose();
	for (const controller of eventControllers.splice(0)) controller.dispose();
	for (const statusLine of statusLines.splice(0)) statusLine.dispose();
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	setShimmerMode("classic");
	setChatTranscriptDisplayPreferences(previousDisplayPreferences);
	resetSettingsForTest();
});

describe("compact action dock", () => {
	const cx = (cols = 60): DescribeContext => ({
		cols,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => true,
	});
	const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));
	const shimmerWords = (node: NativeNode): string[] => [
		...(node.k === "shimmer" ? [node.p?.spans?.map(span => span.t).join("") ?? ""] : []),
		...(node.c ?? []).flatMap(child => ("k" in child ? shimmerWords(child) : [])),
	];
	const spanStyles = (node: NativeNode): [string, string | undefined][] => [
		...(node.k === "text" ? (node.p?.spans ?? []).map(span => [span.t, span.s] as [string, string | undefined]) : []),
		...(node.c ?? []).flatMap(child => ("k" in child ? spanStyles(child) : [])),
	];

	it("keeps the path legible and distinguishes a settled file action", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "read",
			args: { path: "workspace/src/config.ts", i: "Checking presets" },
			intent: "Checking presets",
		});
		const running = plain(h.dock.render(80));
		expect(running[0]).toBe("");
		expect(running[1]).toContain("Agent：正在读取  workspace/src/config.ts · Checking presets");
		expect(running[2]).toBe("");
		expect(h.dock.render(80)[1]).toContain(
			theme.fg("dim", "workspace/") + theme.fg("text", "src/config.ts") + theme.fg("dim", " · Checking presets"),
		);
		expect(spanStyles(h.dock.describe(cx(80)))).toEqual([
			["Agent：正在读取", "muted"],
			["workspace/", "dim"],
			["src/config.ts", "text"],
			[" · Checking presets", "dim"],
		]);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		const done = plain(h.dock.render(80));
		expect(done[1]).toBe(" Agent：上次读取完成  workspace/src/config.ts · Checking presets");
		expect(h.dock.render(80)[1]).toContain(theme.fg("dim", "Agent：上次读取完成"));
		expect(h.dock.render(80)[1]).toContain(theme.fg("dim", "workspace/src/config.ts · Checking presets"));
		expect(spanStyles(h.dock.describe(cx(80)))).toEqual([
			["Agent：上次读取完成", "dim"],
			["workspace/src/config.ts · Checking presets", "dim"],
		]);
		for (const rows of [h.dock.render(80), nativeRows(h.dock.describe(cx(80)))]) {
			expect(rows).toHaveLength(3);
			expect(rows[2]).toBe("");
			expect(Bun.stripANSI(rows[1]!)).toBe(done[1]!);
		}
	});

	it("maps each tool category to its four-character action words and falls back to 调用 for unknown tools", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const cases: Array<{ name: string; args: Record<string, unknown>; running: string; done: string }> = [
			{ name: "read", args: { path: "a.ts" }, running: "正在读取", done: "读取完成" },
			{ name: "bash", args: { command: "echo hi" }, running: "正在执行", done: "执行完成" },
			{ name: "write", args: { path: "a.ts", content: "x" }, running: "正在写入", done: "写入完成" },
			{ name: "edit", args: { path: "a.ts", input: "*** Begin Patch" }, running: "正在写入", done: "写入完成" },
			{ name: "mystery_tool", args: { query: "target" }, running: "正在调用", done: "调用完成" },
		];
		for (const [index, c] of cases.entries()) {
			const id = `cat-${index}`;
			await live.emit({ type: "tool_execution_start", toolCallId: id, toolName: c.name, args: c.args });
			expect(plain(h.rows())[1]).toStartWith(` Agent：${c.running}  `);
			await live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: c.name,
				result: { content: [] },
				isError: false,
			});
			expect(plain(h.rows())[1]).toStartWith(` Agent：上次${c.done}  `);
		}
		// An unmapped tool keeps its real name in the detail and is never labeled read/exec.
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "unknown",
			toolName: "mystery_tool",
			args: { query: "target" },
		});
		const row = plain(h.rows())[1]!;
		expect(row).toContain("mystery_tool");
		expect(row).toContain("target");
		expect(row).not.toContain("正在读取");
		expect(row).not.toContain("正在执行");
	});

	it("shows failure from isError without rejudging results, and keeps the object in the detail", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "bash",
			args: { command: "false" },
		});
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		});
		const row = plain(h.rows())[1]!;
		expect(row).toStartWith(" Agent：上次执行失败  ");
		expect(row).toContain("false");
		expect(row).not.toContain("boom");
		expect(h.rows()[1]).toContain(theme.getFgAnsi("error"));
		expect(spanStyles(h.dock.describe(cx()))).toEqual([
			["Agent：上次执行失败", "error"],
			["false", "dim"],
		]);
		// A live tool replaces the settled one on the Agent row.
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "bash",
			args: { command: "true" },
		});
		expect(plain(h.rows())[0]).toBe("");
		expect(plain(h.rows())[1]).toContain("Agent：正在执行  true");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "b",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		expect(plain(h.rows())[0]).toBe("");
		expect(plain(h.rows())[1]).toContain("Agent：上次执行完成  true");
	});

	it("separates request, thinking and reply from the tool row", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		cfgDisplayMode.set(h.ctx.settings, "clean");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "turn_start" });
		expect(h.rendered()).not.toContain("模型：");
		cfgDisplayMode.set(h.ctx.settings, "compact");
		expect(plain(h.rows())[0]).toContain("模型：等待响应");
		const reason = thinkingMessage("earlier line\nlatest model reasoning");
		await live.emit(update(reason, "thinking_delta"));
		expect(plain(h.rows())[0]).toContain("latest model reasoning");
		expect(h.nativeRendered()).toBe(h.rendered());
		h.ctx.hideThinkingBlock = true;
		expect(plain(h.rows())[0]).toContain("模型：正在思考");
		expect(h.rendered()).not.toContain("latest model reasoning");
		await live.emit({ type: "message_end", message: reason });
		await live.emit({ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: { command: "run" } });
		expect(plain(h.rows())[0]).toBe("");
		expect(plain(h.rows())[1]).toContain("Agent：正在执行");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "run",
			toolName: "bash",
			result: { content: [] },
			isError: true,
		});
		await live.emit({ type: "turn_start" });
		const reply = thinkingMessage("", 2);
		reply.content = [{ type: "text", text: "Reply" }];
		await live.emit({
			type: "message_update",
			message: reply,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reply", partial: reply },
		});
		expect(plain(h.rows())[0]).toContain("模型：正在生成回复");
		expect(plain(h.rows())[1]).toContain("Agent：上次执行失败");
		await live.emit({ type: "message_end", message: reply });
		await live.emit({ type: "agent_end", messages: [] });
		expect(plain(h.rows())[0]).toBe("");
		expect(h.rendered()).not.toContain("正在");
	});

	it("keeps the first running tool visible while indicating additional work", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		for (let i = 1; i <= 17; i++) {
			await live.emit({
				type: "tool_execution_start",
				toolCallId: `call-${i}`,
				toolName: "bash",
				args: { command: `task ${i}` },
			});
		}
		expect(plain(h.rows())[1]).toMatch(/task 1.*\+16/);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		expect(plain(h.rows())[1]).toMatch(/task 2.*\+15/);
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("reserves one row for real wrapped thinking, without moving the other runner or leaking hidden prose", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		for (const command of ["A", "B"]) {
			await live.emit({ type: "tool_execution_start", toolCallId: command, toolName: "bash", args: { command } });
		}
		expect(plain(h.rows())[1]).toMatch(/A.*\+1/);
		const message = thinkingMessage(" \t\n<!-- -->");
		await live.emit(update(message, "thinking_delta"));
		expect(plain(h.rows())[0]).toBe(" 模型：正在思考");
		expect(h.nativeRendered()).toBe(h.rendered());
		message.content = [{ type: "thinking", thinking: "```\nPRIVATE_THOUGHT\n```" }];
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).not.toContain("PRIVATE_THOUGHT");
		expect(h.nativeRendered()).toBe(h.rendered());
		message.content = [{ type: "thinking", thinking: "firstpart secondpart thirdpart final-tail\n \t\n" }];
		await live.emit(update(message, "thinking_delta"));
		const width = 45;
		for (const rows of [h.dock.render(width), nativeRows(h.dock.describe(cx(width)))]) {
			expect(plain(rows)[0]).toContain("final-tail");
			expect(plain(rows)[1]).toMatch(/A.*\+1/);
		}
		h.ctx.hideThinkingBlock = true;
		expect(h.rendered()).not.toContain("final-tail");
		expect(h.nativeRendered()).toBe(h.rendered());
		h.ctx.hideThinkingBlock = false;
		expect(h.rendered()).toContain("final-tail");
		expect(h.nativeRendered()).toBe(h.rendered());
		const wait = new Loader(
			h.ctx.ui,
			value => value,
			value => value,
			"Waiting for a job",
		);
		wait.stop();
		const dock = new CompactThinkingPreview(h.ctx, () => wait);
		try {
			const rows = plain(dock.render(60));
			expect(rows[0]).toContain("正在思考");
			expect(rows[1]).toContain("Waiting for a job");
			expect(rows.join("")).not.toContain("正在执行");
			setSystemTime(Date.now() + 1500);
			expect(rows[1]).toContain("Agent：");
			expect(shimmerWords(dock.describe(cx()))).toEqual(shimmerWords(wait.describe(cx())));
		} finally {
			dock.clear();
		}
	});

	it("starts model shimmer with the spinner and keeps it through streamed thinking and replies", async () => {
		const h = focusFixture();
		setSystemTime(10_000);
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "turn_start" });
		expect(h.ctx.statusLine.getTurnElapsedMs()).toBe(0);
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：等待响应"]);

		const reason = thinkingMessage("First thought");
		await live.emit(update(reason, "thinking_delta"));
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：正在思考"]);
		setSystemTime(10_100);
		reason.content = [{ type: "thinking", thinking: "Latest thought" }];
		await live.emit(update(reason, "thinking_delta"));
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：正在思考"]);
		expect(spanStyles(h.dock.describe(cx()))).toContainEqual(["Latest thought", "text"]);

		const reply = thinkingMessage("", 2);
		reply.content = [{ type: "text", text: "Reply" }];
		await live.emit({
			type: "message_update",
			message: reply,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reply", partial: reply },
		});
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：正在生成回复"]);
		expect(shimmerWords(h.dock.describe({ ...cx(), reduceMotion: true }))).toEqual([]);
		const ansiFrames = new Set<string>();
		for (let elapsed = 100; elapsed < 1000; elapsed += 80) {
			setSystemTime(10_000 + elapsed);
			ansiFrames.add(h.rows()[0]!);
		}
		expect(ansiFrames.size).toBeGreaterThan(1);
		expect([...ansiFrames].some(frame => frame.includes(`\x1b[1m${theme.getFgAnsi("accent")}`))).toBe(true);
		expect([...ansiFrames].map(frame => Bun.stripANSI(frame).trim())).toEqual(
			Array(ansiFrames.size).fill("模型：正在生成回复"),
		);
		await live.emit({ type: "message_end", message: reply });
		await live.emit({ type: "agent_end", messages: [reply] });
		expect(h.ctx.statusLine.getTurnElapsedMs()).toBeNull();
		expect(shimmerWords(h.dock.describe(cx()))).toEqual([]);
	});

	it("keeps running tools animated as output changes, without animating completed tools", async () => {
		const h = focusFixture();
		setSystemTime(10_000);
		const live = liveSession(null, undefined, true);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({ type: "agent_start" });
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "bash",
			toolName: "bash",
			args: { command: "echo probe" },
		});
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["Agent：正在执行"]);
		for (const text of ["First line", "Second line"]) {
			await live.emit({
				type: "tool_execution_update",
				toolCallId: "bash",
				toolName: "bash",
				args: {},
				partialResult: { content: [{ type: "text", text }] },
			});
			expect(h.previewView().body).toContain(text);
			expect(shimmerWords(h.dock.describe(cx()))).toEqual(["Agent：正在执行"]);
		}
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "bash",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		await live.emit({ type: "turn_start" });
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：等待响应"]);
		const settled = h.rows()[1];
		setSystemTime(11_200);
		expect(h.rows()[1]).toBe(settled);
		expect(Bun.stripANSI(settled!)).toContain("Agent：上次执行完成");
	});

	it("stops both live labels when the status spinner goes static", async () => {
		const h = focusFixture();
		setSystemTime(10_000);
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "a.ts" } });
		await live.emit(update(thinkingMessage("Thinking"), "thinking_delta"));
		const interval = spinnerInterval();
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：正在思考", "Agent：正在读取"]);
		try {
			setSpinnerInterval(0);
			expect(shimmerWords(h.dock.describe(cx()))).toEqual([]);
			const staticRows = h.rows();
			setSystemTime(11_500);
			expect(h.rows()).toEqual(staticRows);
		} finally {
			setSpinnerInterval(interval);
		}
		await h.focus.focusAgent(MAIN_AGENT_ID);
		expect(shimmerWords(h.dock.describe(cx()))).toEqual([]);
	});

	it("honors disabled shimmer with static readable state words", async () => {
		const h = focusFixture();
		setSystemTime(24_000);
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setShimmerMode("disabled");
		await live.emit({ type: "agent_start" });
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "read",
			args: { path: "a.ts" },
		});
		const first = h.rows();
		setSystemTime(25_500);
		expect(h.rows()).toEqual(first);
		expect(plain(first)[1]).toBe(" Agent：正在读取  a.ts");
		expect(hasNativeKind(h.dock.describe(cx()), "shimmer")).toBe(false);
	});

	it("shows the actual command folded to one line and tail-truncated, without output or elapsed", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "bash",
			args: { i: "THE_INTENT", command: "echo begin\ngit diff --stat" },
		});
		const row = plain(h.rows())[1]!;
		expect(row).toStartWith(" Agent：正在执行  ");
		expect(row).toContain("echo begin git diff --stat");
		expect(row).not.toContain("THE_INTENT");
		expect(row).not.toMatch(/\d+(?:\.\d+)?(?:ms|s|m)\b/);
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "bash",
			args: { command: "echo begin\ngit diff --stat" },
			partialResult: { content: [{ type: "text", text: "OUTPUT_MUST_NOT_APPEAR" }] },
		});
		expect(h.rendered()).not.toContain("OUTPUT_MUST_NOT_APPEAR");
	});

	it("drops file intent before clipping the path and keeps the distinguishing parent directory", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const prefix = `src/${"nested/".repeat(20)}`;
		for (const [toolName, path] of [
			["read", `${prefix}backend/config.ts`],
			["write", `${prefix}frontend/config.ts`],
		] as const) {
			await live.emit({
				type: "tool_execution_start",
				toolCallId: toolName,
				toolName,
				args: { path, i: "LONG INTENT MUST NOT CROWD OUT THE PATH" },
			});
		}
		for (const rows of [h.dock.render(40), nativeRows(h.dock.describe(cx(40)))]) {
			const [top, bottom] = plain(rows);
			expect(top).toBe("");
			expect(bottom).toContain("backend/config.ts");
			expect(rows.join("")).not.toContain("INTENT");
			expect(rows.every(row => Bun.stringWidth(row) <= 40)).toBe(true);
		}
		const styles = spanStyles(h.dock.describe(cx(40)));
		expect(styles).toContainEqual(["backend/config.ts", "text"]);
		expect(styles.filter(([value, tone]) => value.endsWith("…") && tone === "dim")).toHaveLength(1);
	});

	it("uses Bash intent only while the same call's command is visible and never hides a command without intent", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		let previewId: string | undefined = "with-intent";
		const dock = new CompactThinkingPreview(h.ctx, undefined, width =>
			width >= 50 && previewId ? { callId: previewId, commandVisible: true } : undefined,
		);
		try {
			await live.emit({
				type: "tool_execution_start",
				toolCallId: "with-intent",
				toolName: "write",
				args: { path: "xd://bash", content: '{"command":"echo raw","i":"Describe action"}' },
			});
			await live.emit({
				type: "tool_execution_update",
				toolCallId: "with-intent",
				toolName: "write",
				args: { path: "xd://bash" },
				partialResult: {
					content: [],
					details: { xdev: { mode: "execute", tool: "bash", args: { command: "echo raw" } } },
				},
			});
			for (const rows of [dock.render(60), nativeRows(dock.describe(cx(60)))]) {
				expect(plain(rows)[1]).toContain("Describe action");
				expect(plain(rows)[1]).not.toContain("echo raw");
			}
			expect(plain(dock.render(40))[1]).toContain("echo raw");
			previewId = "other-call";
			expect(plain(dock.render(60))[1]).toContain("echo raw");
			previewId = undefined;
			expect(plain(dock.render(60))[1]).toContain("echo raw");
			previewId = "no-intent";
			await live.emit({
				type: "tool_execution_end",
				toolCallId: "with-intent",
				toolName: "write",
				result: { content: [] },
				isError: false,
			});
			await live.emit({
				type: "tool_execution_start",
				toolCallId: "no-intent",
				toolName: "bash",
				args: { command: "pwd" },
			});
			expect(plain(dock.render(60))[1]).toContain("pwd");
		} finally {
			dock.clear();
		}
	});

	it("keeps wide, multiline and styled details inside one row at narrow widths without leaking color", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "mystery_tool",
			args: { i: "\u001b[31m宽字符多行意图宽字符多行意图\u001b[0m\n下一行\t内容" },
		});
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "bash",
			args: { command: "printf hello" },
		});
		for (const width of [32, 12, 8, 4, 1, 0]) {
			for (const rows of [h.dock.render(width), nativeRows(h.dock.describe(cx(width)))]) {
				expect(rows.every(row => Bun.stringWidth(row) <= Math.max(width, 0))).toBe(true);
			}
		}
		const narrow = plain(h.dock.render(44));
		expect(narrow[0]).toBe("");
		expect(narrow[1]).toContain("宽字符");
		expect(narrow[2]).toBe("");
	});

	it("shows a new message's thinking when its content index repeats", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const first = thinkingMessage("first phase", 1);
		const live = liveSession(first, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit(update(first, "thinking_delta"));
		expect(h.rendered()).toContain("正在思考");
		setSystemTime(12_000);
		await live.emit(update(first, "thinking_end"));
		await live.emit({ type: "message_end", message: first });

		const second = thinkingMessage("second phase", 2);
		setSystemTime(20_000);
		await live.emit({ type: "message_start", message: second });
		await live.emit(update(second, "thinking_delta"));
		expect(h.rendered()).toContain("模型：正在思考  second phase");
		expect(h.nativeRendered()).toBe(h.rendered());
		setSystemTime(23_000);
		await live.emit(update(second, "thinking_end"));
		expect(h.rendered()).not.toContain("phase");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("reads the live active block and drops cached text as soon as it is aborted", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const message = thinkingMessage("old reasoning");
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("old reasoning");

		const agent = live.session.agent;
		const current: AssistantMessage = {
			...message,
			content: [...message.content, { type: "thinking", thinking: "live reasoning" }],
		};
		// Update the agent stream without delivering another event to the dock.
		agent.emitExternalEvent({
			type: "message_update",
			message: current,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "live reasoning", partial: current },
		});
		expect(h.rendered()).toBe(" 模型：正在思考  live reasoning");
		expect(h.nativeRendered()).toBe(h.rendered());

		// The stream still contains both blocks and the session has not emitted a terminal event.
		agent.abort();
		expect(h.rendered()).toBe(" 模型：正在思考");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("replaces old completed rows when new tools start and finish between paints", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const run = async (id: string) => {
			await live.emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: id } });
			await live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "read",
				result: { content: [] },
				isError: false,
			});
		};
		await run("old-a.ts");
		await run("old-b.ts");
		expect(plain(h.rows())[1]).toContain("上次读取完成  old-b.ts");
		await run("new-a.ts");
		await run("new-b.ts");
		expect(plain(h.rows())[1]).toContain("上次读取完成  new-b.ts");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("does not resurrect coalesced thinking when streamed reply and its end arrive together", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("reasoning", 1);
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("正在思考");

		setSystemTime(12_000);
		await live.emit(update(message, "thinking_end"));
		setSystemTime(20_000);
		const reply: AssistantMessage = {
			...message,
			content: [...message.content, { type: "text", text: "reply" }],
		};
		const textStart: MessageUpdate = {
			type: "message_update",
			message: reply,
			assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: reply },
		};
		await live.emit(textStart);
		await live.emit({ type: "message_end", message: reply });
		expect(h.rendered()).not.toContain("思考");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("retains static content across loop end and session switch without reviving animation", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "read",
			args: { path: "keep.ts" },
		});
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		await live.emit({ type: "agent_end", messages: [] });
		const retained = h.rows();
		expect(plain(retained)[1]).toBe(" Agent：上次读取完成  keep.ts");
		expect(hasNativeKind(h.dock.describe(cx()), "shimmer")).toBe(false);
		setSystemTime(Date.now() + 500);
		expect(h.rows()).toEqual(retained);
		await h.focus.focusAgent(MAIN_AGENT_ID);
		expect(h.rows()).toEqual(["", "", ""]);
		await h.focus.focusAgent("Worker");
		expect(plain(h.rows())[1]).toBe(" Agent：上次读取完成  keep.ts");
	});

	it.each(["display tier", "focused agent"])("does not revive thinking that ended outside the %s", async change => {
		const thinking = thinkingMessage("old reasoning");
		const h = focusFixture();
		const live = liveSession(thinking, 0);
		h.register("ThinkingView", live);
		await h.focus.focusAgent("ThinkingView");
		expect(h.rendered()).toContain("old reasoning");
		if (change === "display tier") {
			cfgDisplayMode.set(h.ctx.settings, "clean");
			expect(h.dock.render(60)).toEqual([]);
			expect(nativeRows(h.dock.describe(cx()))).toEqual([]);
		} else {
			await h.focus.focusAgent(MAIN_AGENT_ID);
			expect(h.rendered()).not.toContain("old reasoning");
			expect(h.nativeRendered()).toBe(h.rendered());
		}
		await live.emit({ type: "message_end", message: thinking });
		await live.emit({ type: "agent_end", messages: [] });
		if (change === "display tier") cfgDisplayMode.set(h.ctx.settings, "compact");
		else await h.focus.focusAgent("ThinkingView");
		expect(h.rendered()).not.toContain("正在思考");
		expect(h.rendered()).not.toContain("old reasoning");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("keeps file write content out of compact chat", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("ExpandedWrite", live);
		await h.focus.focusAgent("ExpandedWrite");
		const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "expanded",
			toolName: "write",
			args: { path: "large.txt", content: body },
		});
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "expanded",
			toolName: "write",
			result: { content: [{ type: "text", text: "written" }], details: { op: "create", newText: body } },
			isError: false,
		});
		const chat = () => Bun.stripANSI(h.ctx.chatContainer.render(120).join("\n"));
		expect(chat()).not.toContain("line 60");
	});

	it("does not display parameter generation as a running action", async () => {
		const h = focusFixture();
		const message = thinkingMessage("");
		const call = { type: "toolCall" as const, id: "prep", name: "read", arguments: {} };
		setStreamingPartialJson(call, '{"path":"src/宽字符.ts"');
		message.content = [call];
		const live = liveSession(message);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
		});
		expect(h.rendered()).not.toContain("正在读取");
		expect(h.rendered()).toContain("模型：正在准备调用");
		expect(shimmerWords(h.dock.describe(cx()))).toEqual(["模型：正在准备调用"]);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "prep",
			toolName: "read",
			args: { path: "src/宽字符.ts" },
		});
		expect(plain(h.rows())[1]).toBe(" Agent：正在读取  src/宽字符.ts");
	});

	it("projects device inner targets without leaking the transport URI or private payloads", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "device",
			toolName: "write",
			args: { path: "xd://bash", content: JSON.stringify({ command: "pwd && echo done" }) },
		});
		const row = plain(h.rows())[1]!;
		expect(row).toStartWith(" Agent：正在执行  ");
		// The full inner command is shown (new spec replaces the old first-segment preview); no transport URI.
		expect(row).toContain("pwd && echo done");
		expect(row).not.toMatch(/xd:\/\//);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "private",
			toolName: "write",
			args: { path: "xd://think", content: '{"thoughts":"PRIVATE_THOUGHTS"}' },
		});
		expect(h.rendered()).not.toContain("PRIVATE_THOUGHTS");
	});

	it("labels wrapped file patches as writes and config, messaging and control transports as generic calls", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/one.ts",
			"+PRIVATE_BODY",
			"*** Add File: src/two.ts",
			"+PRIVATE_BODY",
			"*** End Patch",
		].join("\n");
		for (const [id, path, content, expected] of [
			["patch", "XD://apply_patch", JSON.stringify({ input: patch }), "正在写入  src/one.ts (2 files)"],
			["settings", "cfg://display", "PRIVATE_BODY", "正在调用  write cfg://display"],
			["message", "agent://Worker", "PRIVATE_BODY", "正在调用  write agent://Worker"],
			["control", "proc://job/kill", "PRIVATE_BODY", "正在调用  write proc://job/kill"],
			["help", "xd://write", "?", "正在调用  write xd://write"],
		] as const) {
			await live.emit({ type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path, content } });
			expect(plain(h.rows())[1]).toBe(` Agent：${expected}`);
			expect(h.rendered()).not.toContain("PRIVATE_BODY");
			await live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "write",
				result: { content: [] },
				isError: false,
			});
			expect(plain(h.rows())[1]).toContain(id === "patch" ? "写入完成" : "调用完成");
		}
	});
});

describe("execution-only read group activity", () => {
	it("starts and times a read created by its first execution event (P2-23)", async () => {
		setChatTranscriptDisplayPreferences({ hideToolActivity: false });
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const ctx = createInteractiveModeContext();
		cfgDisplayMode.set(ctx.settings, "detailed");
		const controller = new EventController(ctx);
		eventControllers.push(controller);
		const toolCx: DescribeContext = {
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		};
		try {
			// No message_update preview precedes this event (e.g. focus/join mid-tool).
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: "execution-only-read",
				toolName: "read",
				args: { path: "src/execution-only.ts" },
			});
			const group = ctx.pendingTools.get("execution-only-read");
			if (!(group instanceof ReadToolGroupComponent)) throw new Error("Expected a grouped read");
			const live = group.describe(toolCx);
			expect(live.k).toBe("tool");
			expect(live.k === "tool" ? live.p : undefined).toMatchObject({ status: "running", age: 0 });
			now = 600;
			const elapsed = group.describe(toolCx);
			expect(elapsed.k === "tool" ? elapsed.p : undefined).toMatchObject({ status: "running", age: 500 });
			group.setToolActivityVisible(false);
			expect(group.render(80)).toEqual([]);
			const hidden = group.describe(toolCx);
			expect(hidden.k === "tool" ? hidden.p : undefined).toMatchObject({
				hidden: true,
				status: "running",
				age: 500,
			});
			group.setToolActivityVisible(true);
			const visible = group.describe(toolCx);
			expect(visible.k === "tool" ? visible.p : undefined).toMatchObject({ status: "running", age: 500 });
			expect(visible.k === "tool" ? visible.p?.hidden : undefined).not.toBe(true);

			now = 1350;
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "execution-only-read",
				toolName: "read",
				result: { content: [{ type: "text", text: "export const value = 1;" }] },
				isError: false,
			});
			const done = group.describe(toolCx);
			expect(done.k).toBe("tool");
			expect(done.k === "tool" ? done.p : undefined).toMatchObject({ status: "done", took: 1250 });
			now = 2000;
			const frozen = group.describe(toolCx);
			expect(frozen.k === "tool" ? frozen.p : undefined).toMatchObject({ status: "done", took: 1250 });
		} finally {
			ctx.chatContainer.disposeChildren();
		}
	});
	it("keeps one timer across concurrent reads and freezes it when sealed", () => {
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const group = new ReadToolGroupComponent();
		const toolCx: DescribeContext = {
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		};
		group.updateArgs({ path: "first.ts" }, "first");
		group.setExecutionStarted("first");
		now = 250;
		group.updateArgs({ path: "second.ts" }, "second");
		group.setExecutionStarted("second");
		now = 400;
		group.updateResult({ content: [{ type: "text", text: "first" }] }, false, "first");
		let node = group.describe(toolCx);
		expect(node.k === "tool" ? node.p : undefined).toMatchObject({ status: "running", age: 300 });
		now = 700;
		group.seal();
		now = 1000;
		node = group.describe(toolCx);
		expect(node.k === "tool" ? node.p : undefined).toMatchObject({ status: "cancelled", took: 600 });
	});
});

function outputCall(
	id: string,
	order: number,
	text: string,
	options: Partial<LiveToolOutputSnapshot> = {},
): LiveToolOutputSnapshot {
	return {
		toolCallId: id,
		toolName: "bash",
		dispatchOrder: order,
		args: { command: `echo ${id}` },
		result: { content: [{ type: "text", text }] },
		expiresAt: options.terminalAt === undefined ? undefined : options.terminalAt + 3000,
		...options,
	};
}

function previewFixture(call: LiveToolOutputSnapshot): LiveToolOutputPreview {
	if (!call.result) throw new Error("Expected a result for the selected Output fixture");
	return { call, text: toolOutputText(call.toolName, call.result, call.args) };
}

describe("compact latest live Output consumers", () => {
	const todoRoutes: { route: string; options: Partial<LiveToolOutputSnapshot> }[] = [
		{ route: "direct", options: { toolName: "todo", args: { op: "view" } } },
		{
			route: "device result",
			options: {
				toolName: "write",
				args: {},
				result: {
					content: [{ type: "text" as const, text: "TODO_RESULT" }],
					details: { xdev: { tool: "todo", mode: "execute", inner: {} } },
				},
			},
		},
		{ route: "device path", options: { toolName: "write", args: { path: "xd://todo", content: "{}" } } },
	];
	it.each(todoRoutes)("excludes todo via $route without replacing another tool's output", async ({ options }) => {
		const h = focusFixture();
		const live = liveSession();
		const terminalAt = Date.now();
		const todo = outputCall("todo", 2, "TODO_RESULT", { ...options, terminalAt });
		const output = new LiveToolOutputState();
		output.restore([todo], false);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("TodoOutput", live);
		await h.focus.focusAgent("TodoOutput");
		expect(h.outputRows()).toEqual([[], []]);
		output.restore([outputCall("shell", 1, "SHELL_OUTPUT", { terminalAt }), todo], false);
		const view = h.previewView();
		expect(view.head).toContain("已完成 · bash · echo shell");
		expect(view.body).toEqual(["SHELL_OUTPUT"]);
		expect(view.nativeHead).toContain("已完成 · bash · echo shell");
		expect(view.nativeBody).toEqual(["SHELL_OUTPUT"]);
	});

	it("keeps the previous Output and its deadline across fully covered write receipts", async () => {
		setSystemTime(10_000);
		let diffRows = 6;
		const h = focusFixture(() => diffRows);
		const live = liveSession();
		const output = new LiveToolOutputState();
		const fileChanges = new LatestTurnFileChanges();
		const sessionId = live.session.sessionManager.getSessionId();
		const file = path.resolve(live.session.sessionManager.getCwd(), "result.txt");
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(project => output.preview(project));
		vi.spyOn(live.session, "getLatestTurnFileChanges").mockImplementation(() => fileChanges.get(sessionId));
		h.register("CoveredWrites", live);
		await h.focus.focusAgent("CoveredWrites");
		output.restore([outputCall("shell", 1, "retained Output", { terminalAt: 10_000 })], false);
		const original = h.previewView();
		expect(original).toMatchObject({
			head: "已完成 · bash · echo shell",
			body: ["retained Output"],
			nativeHead: "已完成 · bash · echo shell",
			nativeBody: ["retained Output"],
		});

		for (let i = 1; i <= 2; i++) {
			vi.advanceTimersByTime(500);
			const toolCallId = `write-${i}`;
			output.observe(
				{ type: "tool_execution_start", toolCallId, toolName: "write", args: { path: file } },
				Date.now(),
			);
			fileChanges.record(sessionId, { path: file, tool: "write", before: `${i - 1}\n`, after: `${i}\n` });
			output.observe(
				{
					type: "tool_execution_end",
					toolCallId,
					toolName: "write",
					isError: false,
					result: {
						content: [{ type: "text", text: "Successfully wrote 2 bytes to result.txt" }],
						details: { resolvedPath: file },
					},
				},
				Date.now(),
			);
			expect(h.previewView()).toEqual(original);
		}
		output.restore(output.snapshot(), false);
		expect(h.previewView()).toEqual(original);

		diffRows = 0;
		expect(h.previewView()).toMatchObject({
			body: ["Successfully wrote 2 bytes to result.txt"],
			nativeBody: ["Successfully wrote 2 bytes to result.txt"],
		});
		diffRows = 6;
		vi.advanceTimersByTime(1999);
		expect(h.previewView()).toEqual(original);
		vi.advanceTimersByTime(1);
		expect(h.outputRows()).toEqual([[], []]);
	});

	it("selects by dispatch order only after real Output and replaces cumulative frames", async () => {
		const h = focusFixture();
		const live = liveSession();
		const first = outputCall("first", 1, "first output");
		const second = outputCall("second", 2, "");
		const output = new LiveToolOutputState();
		output.restore([first, second], false);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("OutputWorker", live);
		await h.focus.focusAgent("OutputWorker");
		const view = h.previewView();
		expect(view.head).toContain("运行中 · bash · echo first");
		expect(view.body).toEqual(["first output"]);
		expect(view.nativeHead).toContain("运行中 · bash · echo first");
		output.restore(
			[
				first,
				{
					...second,
					result: {
						content: [{ type: "text", text: "\x1b[31m \t\n\x1b[0m" }, { type: "image" }],
					},
				},
			],
			false,
		);
		expect(h.previewView().head).toContain("echo first");
		output.restore(
			[
				first,
				{
					...second,
					result: {
						content: [{ type: "text", text: "Backgrounded as job bg_2; output will follow" }],
						details: { async: { jobId: "bg_2", state: "running" } },
					},
				},
			],
			false,
		);
		expect(h.previewView().head).toContain("echo first");
		const newer = outputCall("second", 2, "one\ntwo");
		output.restore([newer, outputCall("first", 1, "late first output")], false);
		const newerView = h.previewView();
		expect(newerView.head).toContain("echo second");
		expect(newerView.body).toEqual(["one", "two"]);
		expect(newerView.nativeBody).toEqual(["one", "two"]);
		output.restore([outputCall("first", 1, "even later"), outputCall("second", 2, "one\ntwo\nthree")], false);
		const threeView = h.previewView();
		expect(threeView.body).toEqual(["one", "two", "three"]);
		expect(threeView.nativeBody).toEqual(["one", "two", "three"]);
	});

	it("keeps background Output live after loop completion without retained tool cards", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession(null, undefined, true);
		const args = { command: "echo shell" };
		const details = { async: { jobId: "bg_1", state: "running" } };
		h.register("BackgroundOutput", live);
		await h.focus.focusAgent("BackgroundOutput");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "tool_execution_start", toolCallId: "shell", toolName: "bash", args });
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "shell",
			toolName: "bash",
			result: { content: [{ type: "text", text: "0" }], details },
			isError: false,
		});
		await live.emit({ type: "agent_end", messages: [] });
		h.ctx.pendingTools.clear();
		for (let second = 1; second <= 25; second++) {
			setSystemTime(10_000 + second * 1000);
			await live.emit({
				type: "tool_execution_update",
				toolCallId: "shell",
				toolName: "bash",
				args,
				partialResult: { content: [{ type: "text", text: `tick ${second}` }], details },
			});
			const view = h.previewView();
			expect(view.head).toContain("运行中 · bash · bg_1");
			expect(view.body).toEqual([`tick ${second}`]);
			expect(view.nativeHead).toContain("运行中 · bash · bg_1");
		}
		expect(h.ctx.pendingTools.size).toBe(0);
	});

	it("retains completed Output while the status line is running and expires three seconds after it stops", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession(null, undefined, true);
		h.register("WorkingOutput", live);
		await h.focus.focusAgent("WorkingOutput");
		await live.emit({ type: "agent_start" });
		await live.completeOutput("latest", "completed while still working");
		vi.advanceTimersByTime(10_000);
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("completed while still working");

		await live.emit({ type: "agent_end", messages: [] });
		vi.advanceTimersByTime(2999);
		const rebuilt = new CompactToolOutputPreview(h.ctx);
		outputPreviews.push(rebuilt);
		expect(Bun.stripANSI(rebuilt.render(120).join("\n"))).toContain("completed while still working");
		vi.advanceTimersByTime(1);
		expect(h.outputRows()).toEqual([[], []]);
		expect(rebuilt.render(120)).toEqual([]);
	});

	it("expires from terminal receipt without painting and never falls back or reopens on rebuild", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const old = outputCall("old", 1, "old still running");
		const terminal = outputCall("latest", 2, "terminal Output", { terminalAt: 10_000 });
		const output = new LiveToolOutputState();
		output.restore([old, terminal], false);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("TerminalOutput", live);
		await h.focus.focusAgent("TerminalOutput");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "latest",
			toolName: "bash",
			result: terminal.result!,
			isError: false,
		});
		cfgDisplayMode.set(h.ctx.settings, "clean");
		await h.focus.focusAgent(MAIN_AGENT_ID);
		vi.advanceTimersByTime(3000);
		cfgDisplayMode.set(h.ctx.settings, "compact");
		await h.focus.focusAgent("TerminalOutput");
		expect(h.outputRows()).toEqual([[], []]);
		const rebuilt = new CompactToolOutputPreview(h.ctx);
		outputPreviews.push(rebuilt);
		expect(rebuilt.render(120)).toEqual([]);
		const calls = [terminal, outputCall("old", 1, "late old"), outputCall("new-no-output", 3, "")];
		output.restore(calls, false);
		for (const rows of h.outputRows()) expect(rows).toEqual([]);
		output.restore([...calls, outputCall("new-output", 4, "new Output")], false);
		for (const rows of h.outputRows()) {
			expect(rows.join("\n")).toContain("new Output");
		}
		vi.advanceTimersByTime(3000);
	});

	it("does not let an earlier terminal deadline close a newer Output source", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession(null, undefined, true);
		h.register("ReplacementOutput", live);
		await h.focus.focusAgent("ReplacementOutput");
		await live.completeOutput("done", "done");
		vi.advanceTimersByTime(2000);
		await live.emit({ type: "tool_execution_start", toolCallId: "next", toolName: "bash", args: {} });
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "next",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "replacement" }] },
		});
		vi.advanceTimersByTime(1000);
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("replacement");
	});

	it("shows the latest five meaningful display rows without changing the original Output", async () => {
		const h = focusFixture();
		const live = liveSession();
		const text = `discard\nfirst\n \nsecond\n\t\nthird\n${" ".repeat(150)}\nfourth\n\x1b[31m  \x1b[0m\nfifth\n{}\n---\n\x1b[31m╰──╯\x1b[0m\n✅\n\n`;
		const call = outputCall("nonblank", 1, text);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(call));
		h.register("NonblankOutput", live);
		await h.focus.focusAgent("NonblankOutput");
		const view = h.previewView();
		expect(view.body).toEqual(["first", "second", "third", "fourth", "fifth"]);
		expect(view.nativeBody).toEqual(view.body);
		expect(call.result?.content).toEqual([{ type: "text", text }]);
	});

	it("uses a borderless header and preserves relative indentation on both paths", async () => {
		const h = focusFixture();
		const live = liveSession();
		const call = outputCall("aligned", 1, "\n    根节点\n      child 42\n    ---\n    {}\n");
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(call));
		h.register("AlignedOutput", live);
		await h.focus.focusAgent("AlignedOutput");
		const view = h.previewView();
		const rows = [" 运行中 · bash · echo aligned", " 根节点", "   child 42"];
		expect(view.ansi).toEqual(rows);
		expect(h.outputRows()[1]).toEqual(rows);
	});

	it("does not open or replace meaningful output for symbol-only frames", async () => {
		const h = focusFixture();
		const live = liveSession();
		const symbols = outputCall("symbols", 2, "\x1b[31m{}\n---\n╰──╯\x1b[0m\n✅");
		const output = new LiveToolOutputState();
		output.restore([symbols], false);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("SymbolOutput", live);
		await h.focus.focusAgent("SymbolOutput");
		expect(h.outputRows()).toEqual([[], []]);
		output.restore([outputCall("content", 1, "0"), symbols], false);
		const view = h.previewView();
		expect(view.head).toContain("echo content");
		expect(view.body).toEqual(["0"]);
		expect(view.nativeBody).toEqual(["0"]);
	});

	it("retains eligible read output through symbol, image and empty display frames", async () => {
		const h = focusFixture();
		const live = liveSession();
		const output = new LiveToolOutputState();
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("RetainedOutput", live);
		await h.focus.focusAgent("RetainedOutput");
		const start = (id: string, path: string, dispatchOrder?: number) =>
			output.observe(
				{ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } },
				Date.now(),
				dispatchOrder,
			);
		const update = (id: string, result: NonNullable<LiveToolOutputSnapshot["result"]>) =>
			output.observe(
				{ type: "tool_execution_update", toolCallId: id, toolName: "read", args: {}, partialResult: result },
				Date.now(),
			);
		start("first", "actual.txt");
		update("first", { content: [], details: { displayContent: { text: "retained body" } } });
		start("later", "other.txt");
		update("later", { content: [{ type: "image" }, { type: "text", text: "✅\n{}" }] });
		update("first", { content: [{ type: "text", text: "{}" }], details: { displayContent: { text: "—" } } });
		output.observe(
			{ type: "tool_execution_end", toolCallId: "first", toolName: "read", result: { content: [] }, isError: true },
			Date.now(),
		);
		expect(h.previewView()).toMatchObject({
			head: "失败 · read · actual.txt",
			nativeHead: "失败 · read · actual.txt",
			body: ["retained body"],
			nativeBody: ["retained body"],
		});
		update("later", { content: [{ type: "text", text: "new source" }] });
		start("stale", "stale.txt", 1);
		update("stale", { content: [{ type: "text", text: "late output" }] });
		expect(h.previewView().body).toEqual(["new source"]);
	});

	it("retains device and async facts after an empty terminal frame and rejects late startup receipts", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const output = new LiveToolOutputState();
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("AsyncOutput", live);
		await h.focus.focusAgent("AsyncOutput");
		output.observe({ type: "tool_execution_start", toolCallId: "job", toolName: "write", args: {} }, 10_000);
		const xdev = { tool: "bash", mode: "execute", args: { command: "echo active" } };
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "write",
				args: {},
				partialResult: {
					content: [
						{ type: "text", text: "Error: failed at step 2\n\nBackgrounded as job bg_1; output will follow" },
					],
					details: { xdev: { ...xdev, inner: { async: { name: "Build", jobId: "bg_1", state: "running" } } } },
				},
			},
			10_000,
		);
		const startupReceipt: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "job",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "older buffered output" }],
				details: { xdev: { ...xdev, inner: { async: { jobId: "bg_1", state: "running" } } } },
			},
			isError: false,
		};
		output.observe(startupReceipt, 10_000);
		expect(h.previewView().body).toEqual(["Error: failed at step 2"]);
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "write",
				args: {},
				partialResult: {
					content: [{ type: "text", text: "{}" }],
					details: { xdev: { tool: "bash", mode: "execute", inner: { async: { state: "failed" } } } },
				},
			},
			10_001,
		);
		output.restore(output.snapshot(), false);
		output.observe(startupReceipt, 10_002);
		expect(output.preview()?.call.terminalAt).toBe(10_001);
		const view = h.previewView();
		expect(view.head).toBe("失败 · write (bash) · bg_1 · echo active");
		expect(view.nativeHead).toBe(view.head);
		expect(view.body).toEqual(["Error: failed at step 2"]);
		expect(view.nativeBody).toEqual(view.body);
	});

	it("renormalizes a retained body when later device metadata identifies its Bash startup notice", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const output = new LiveToolOutputState();
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("LateDeviceFacts", live);
		await h.focus.focusAgent("LateDeviceFacts");
		output.observe({ type: "tool_execution_start", toolCallId: "job", toolName: "write", args: {} }, 10_000);
		const notice = "Backgrounded as job bg_1; output will follow";
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "write",
				args: {},
				partialResult: { content: [{ type: "text", text: `actual body\n\n${notice}` }] },
			},
			10_000,
		);
		expect(h.previewView().body).toEqual(["actual body", notice]);
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "write",
				args: {},
				partialResult: {
					content: [],
					details: {
						xdev: { tool: "bash", mode: "execute", inner: { async: { jobId: "bg_1", state: "running" } } },
					},
				},
			},
			10_001,
		);
		const visible = h.previewView();
		expect(visible.head).toContain("运行中 · write (bash) · bg_1");
		expect(visible.body).toEqual(["actual body"]);
		expect(visible.nativeBody).toEqual(visible.body);
		output.restore(output.snapshot(), false);
		expect(h.previewView()).toEqual(visible);
	});

	it("wraps safe output before its tail window and keeps ANSI/native text identical", async () => {
		const h = focusFixture();
		const live = liveSession();
		const call = outputCall(
			"wrapped",
			1,
			"discarded\r最新\t内容\nline2\nline3\nline4\nline5\nline6\n\x1b[31m尾部中文宽字符尾部中文宽字符\x1b[0m",
		);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(call));
		h.register("WrappedOutput", live);
		await h.focus.focusAgent("WrappedOutput");
		const view = h.previewView(18);
		expect(view.ansi).toHaveLength(6);
		for (const row of view.ansi) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(18);
		expect(view.body).toEqual(view.nativeBody);
		const text = view.ansi.join("\n");
		expect(text).not.toContain("discarded");
		expect(text).not.toContain("line2");
		expect(text).not.toContain("\t");
		expect(text).toContain("尾部中文");
		let budget = 3;
		const small = new CompactToolOutputPreview(h.ctx, () => budget);
		outputPreviews.push(small);
		expect(small.render(18)).toHaveLength(3);
		budget = 0;
		expect(small.render(18)).toEqual([]);
	});

	it("uses each read's own result and never turns out:// parameter text into Output", async () => {
		const h = focusFixture();
		const live = liveSession();
		const first = outputCall("read-first", 1, "unformatted first", {
			toolName: "read",
			args: { path: "first.txt" },
			result: {
				content: [{ type: "text", text: "1:first body" }],
				details: { displayContent: { text: "first body" } },
			},
		});
		const second = outputCall("read-second", 2, "second body", { toolName: "read", args: { path: "second.txt" } });
		const reply = outputCall("reply", 3, "", {
			toolName: "write",
			args: { path: "out://answer", content: "assistant reply stays in the transcript" },
		});
		const output = new LiveToolOutputState();
		output.restore([first, second, reply], false);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("ReadOutput", live);
		await h.focus.focusAgent("ReadOutput");
		const view = h.previewView();
		expect(view.head).toContain("运行中 · read · second.txt");
		expect(view.body).toEqual(["second body"]);
		expect(view.nativeHead).toContain("运行中 · read · second.txt");
		expect(view.ansi.join("\n")).not.toContain("first body");
		expect(view.ansi.join("\n")).not.toContain("assistant reply");
	});

	it("prefers grep hit rows after terminal and tails while running", async () => {
		const h = focusFixture();
		const live = liveSession();
		const text = [
			"# src/",
			" 10│context before",
			"*12│alpha hit one",
			" 13│context middle",
			"*14│alpha hit two",
			" 15│context after",
			"*16│alpha hit three",
			"*17│alpha hit four",
			"*18│alpha hit five",
			"*19│alpha hit six",
		].join("\n");
		let call = outputCall("search", 1, text, { toolName: "grep", args: { pattern: "alpha" } });
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => previewFixture(call));
		h.register("GrepOutput", live);
		await h.focus.focusAgent("GrepOutput");
		const running = h.previewView();
		expect(running.head).toContain("运行中 · grep");
		expect(running.body).toEqual([
			" 15│context after",
			"*16│alpha hit three",
			"*17│alpha hit four",
			"*18│alpha hit five",
			"*19│alpha hit six",
		]);
		expect(running.nativeBody).toEqual(running.body);
		call = { ...call, terminalAt: Date.now() };
		const terminal = h.previewView();
		expect(terminal.head).toContain("已完成 · grep");
		expect(terminal.body).toEqual([
			"*12│alpha hit one",
			"*14│alpha hit two",
			"*16│alpha hit three",
			"*17│alpha hit four",
			"*18│alpha hit five",
		]);
		expect(terminal.nativeBody).toEqual(terminal.body);
	});

	it("fills remaining rows with context when grep hits are fewer than the budget", async () => {
		const h = focusFixture();
		const live = liveSession();
		const text = ["# src/", " 10│context one", "*12│only hit", " 13│context two", " 14│context three"].join("\n");
		const call = outputCall("search", 1, text, {
			toolName: "grep",
			args: { pattern: "only" },
			terminalAt: Date.now(),
		});
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(call));
		h.register("GrepFill", live);
		await h.focus.focusAgent("GrepFill");
		const view = h.previewView();
		expect(view.body).toEqual(["*12│only hit", "# src/", " 10│context one", " 13│context two", " 14│context three"]);
		expect(view.nativeBody).toEqual(view.body);
	});

	it("prefers glob file rows over directory headings and device-wrapped grep keeps its inner identity", async () => {
		const h = focusFixture();
		const live = liveSession();
		const globText = ["# src/", "a.ts", "## sub/", "b.ts", "c.ts", "d.ts", "e.ts"].join("\n");
		const glob = outputCall("glob", 1, globText, {
			toolName: "glob",
			args: { pattern: "**/*.ts" },
			terminalAt: Date.now(),
		});
		const wrapped = outputCall("wrapped", 2, "# src/\n 10│context\n*12│wrapped hit\n 13│context after", {
			toolName: "write",
			args: { path: "xd://grep", content: '{"pattern":"wrapped"}' },
			result: {
				content: [{ type: "text", text: "# src/\n 10│context\n*12│wrapped hit\n 13│context after" }],
				details: { xdev: { tool: "grep", mode: "execute", inner: { matchCount: 1 } } },
			},
			terminalAt: Date.now(),
		});
		const source = vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(glob));
		h.register("GlobOutput", live);
		await h.focus.focusAgent("GlobOutput");
		const globView = h.previewView();
		expect(globView.head).toContain("已完成 · glob");
		expect(globView.body).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
		expect(globView.nativeBody).toEqual(globView.body);
		source.mockReturnValue(previewFixture(wrapped));
		const wrappedView = h.previewView();
		expect(wrappedView.body).toEqual(["*12│wrapped hit", "# src/", " 10│context", " 13│context after"]);
		expect(wrappedView.nativeBody).toEqual(wrappedView.body);
	});

	it("prioritizes real failure diagnostics ahead of later output without inventing reasons", async () => {
		const h = focusFixture();
		const live = liveSession();
		const failed = outputCall("failed", 1, "", {
			terminalAt: Date.now(),
			result: {
				content: [
					{
						type: "text",
						text: "line one\nError: boom at step 2\nline three\nline four\nline five\nline six\nline seven\nline eight",
					},
				],
				details: { reason: "not in the actual output" },
				isError: true,
			},
		});
		const empty = outputCall("empty", 2, "No matches found", {
			toolName: "grep",
			args: { pattern: "missing" },
			terminalAt: Date.now(),
			result: {
				content: [{ type: "text", text: "No matches found" }],
				details: { matchCount: 0, fileCount: 0 },
			},
		});
		const output = new LiveToolOutputState();
		output.restore([failed], false);
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("FallbackOutput", live);
		await h.focus.focusAgent("FallbackOutput");
		const failedView = h.previewView();
		expect(failedView.head).toContain("失败 · bash");
		expect(failedView.body).toEqual(["Error: boom at step 2", "line five", "line six", "line seven", "line eight"]);
		expect(failedView.nativeBody).toEqual(failedView.body);
		const [, diagnostic, context] = h.output.render(120);
		expect(diagnostic).toContain(theme.bold(theme.fg("error", "Error: boom at step 2")));
		expect(context).toContain(theme.fg("toolOutput", "line five"));
		output.restore([failed, empty], false);
		const emptyView = h.previewView();
		expect(emptyView.head).toContain("已完成 · grep");
		expect(emptyView.body).toEqual(["No matches found"]);
		expect(emptyView.nativeBody).toEqual(emptyView.body);
	});

	it("middle-truncates long commands so the header keeps both ends", async () => {
		const h = focusFixture();
		const live = liveSession();
		const command = `rg -n "backdrop-filter" ${"packages/coding-agent/src/modes/".repeat(3)}styles.css`;
		const call = outputCall("long", 1, "hit", { args: { command } });
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(call));
		h.register("LongCommand", live);
		await h.focus.focusAgent("LongCommand");
		const view = h.previewView(60);
		expect(view.head).toContain("运行中 · bash · rg -n");
		expect(view.head).toContain("…");
		expect(view.head).toContain("styles.css");
		expect(Bun.stringWidth(view.ansi[0]!)).toBeLessThanOrEqual(60);
		expect(view.nativeHead).toContain("运行中 · bash · rg -n");
		expect(h.output.compactActivity(60)).toMatchObject({ callId: "long", commandVisible: true });
		const narrow = h.previewView(17);
		expect(narrow.head).toBe("运行中 · bash");
		expect(narrow.nativeHead).toBe(narrow.head);
		expect(h.output.compactActivity(17)?.commandVisible).toBe(false);
		const headerOnly = new CompactToolOutputPreview(h.ctx, () => 1);
		outputPreviews.push(headerOnly);
		expect(headerOnly.render(60)).toHaveLength(1);
		expect(headerOnly.compactActivity(60)).toMatchObject({ commandVisible: true });
		const noSpace = new CompactToolOutputPreview(h.ctx, () => 0);
		outputPreviews.push(noSpace);
		expect(noSpace.compactActivity(60)).toBeUndefined();
	});

	it("never revives a closed preview in or after a later output-free turn", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession(null, undefined, true);
		h.register("TurnBoundary", live);
		await h.focus.focusAgent("TurnBoundary");
		await live.emit({ type: "agent_start" });
		await live.completeOutput("done", "previous turn output");
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("previous turn output");
		await live.emit({ type: "agent_end", messages: [] });
		vi.advanceTimersByTime(3000);
		expect(h.outputRows()).toEqual([[], []]);
		await live.emit({ type: "agent_start" });
		expect(h.outputRows()).toEqual([[], []]);
		await live.emit({ type: "agent_end", messages: [] });
		expect(h.outputRows()).toEqual([[], []]);
		await live.emit({ type: "agent_start" });
		await live.completeOutput("fresh", "new turn output");
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("new turn output");
	});

	it.each(["focused", "detached"])(
		"expires a %s worker's Output from its own run end, not the main run",
		async view => {
			setSystemTime(10_000);
			const h = focusFixture();
			const live = liveSession(null, undefined, true);
			h.register("FinishingWorker", live);
			Object.defineProperty(h.ctx.session, "isRunActive", { configurable: true, value: true });
			await h.focus.focusAgent("FinishingWorker");
			await live.emit({ type: "agent_start" });
			await live.completeOutput("worker", "worker result");
			if (view === "detached") await h.focus.focusAgent(MAIN_AGENT_ID);
			vi.advanceTimersByTime(10_000);
			await live.emit({ type: "agent_end", messages: [] });
			vi.advanceTimersByTime(2999);
			if (view === "detached") await h.focus.focusAgent("FinishingWorker");
			expect(h.ctx.statusLine.getTurnElapsedMs()).toBeNull();
			for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("worker result");
			vi.advanceTimersByTime(1);
			expect(h.outputRows()).toEqual([[], []]);
		},
	);

	it("keeps a still-running background source across the turn boundary", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession(null, undefined, true);
		h.register("RunningBoundary", live);
		await h.focus.focusAgent("RunningBoundary");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "tool_execution_start", toolCallId: "bg", toolName: "bash", args: {} });
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "bg",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "background progress" }],
				details: { async: { jobId: "bg", state: "running" } },
			},
			isError: false,
		});
		await live.emit({ type: "agent_end", messages: [] });
		setSystemTime(20_000);
		await live.emit({ type: "agent_start" });
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("background progress");
	});
});
