import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import { CompactToolOutputPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-tool-output-preview";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveToolOutputSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { LiveToolOutputState } from "@oh-my-pi/pi-coding-agent/session/live-tool-output";
import { Loader } from "@oh-my-pi/pi-tui";
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
import { createInteractiveModeContext, createSessionStub } from "./helpers/interactive-mode-context";

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

/** Strip the framed block's vertical borders and uniform one-column padding, keeping relative indent. */
function frameBody(rows: readonly string[]): string[] {
	return rows.filter(row => row.startsWith("│") && row.endsWith("│")).map(row => row.slice(2, -2).trimEnd());
}

/** The native card's head text, joined from its spans. */
function nativeHead(node: NativeNode): string {
	if (node.k !== "card") throw new Error("Expected a native preview card");
	const head = node.p?.head;
	if (typeof head === "string") return head;
	return head?.map(part => part.t).join("") ?? "";
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

function liveSession(message: AssistantMessage | null = null, activeThinkingIndex?: number) {
	const listeners: Array<(event: AgentSessionEvent) => Promise<void> | void> = [];
	const updates = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();
	const agent = new Agent();
	agent.state.streamMessage = message;
	agent.state.activeThinkingIndex = activeThinkingIndex;
	const session = createSessionStub(SessionManager.inMemory(process.cwd()), settings, {
		isStreaming: message !== null,
		get state() {
			return agent.state;
		},
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		},
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [...updates.values()],
	});
	Object.defineProperty(session, "agent", { configurable: true, value: agent });
	return {
		session,
		async emit(event: AgentSessionEvent): Promise<void> {
			switch (event.type) {
				case "tool_execution_start":
				case "tool_execution_end":
				case "tool_execution_update":
				case "message_start":
				case "message_update":
				case "message_end":
				case "agent_start":
				case "agent_end":
					agent.emitExternalEvent(event, { stateOnly: true });
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
let previousDisplayPreferences: typeof chatTranscriptDisplayPreferences;

function focusFixture() {
	const main = liveSession();
	const statusLine = new StatusLineComponent<AgentSession>(main.session, statusLineHost);
	statusLines.push(statusLine);
	const ctx = createInteractiveModeContext({ session: main.session, statusLine });
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
	const dock = new CompactThinkingPreview(ctx);
	const output = new CompactToolOutputPreview(ctx);
	outputPreviews.push(output);
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
			const node = output.describe(cx);
			return {
				ansi,
				head: ansi[0] ?? "",
				body: frameBody(ansi),
				nativeHead: nativeHead(node),
				nativeBody: nativeRows(node).map(row => Bun.stripANSI(row).trimEnd()),
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
	setChatTranscriptDisplayPreferences({ hideToolActivity: true, compactToolActivity: true });
});

afterEach(() => {
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

	it("lays out a fixed eight-column action area, two spaces and a gray detail that never shifts", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "read",
			args: { path: "src/config.ts", i: "Reading raw preset table" },
			intent: "Reading raw preset table",
		});
		const running = plain(h.rows());
		expect(running[0]).toBe("");
		expect(running[1]).toBe(" 正在读取  Reading raw preset table · src/config.ts");
		expect(running[2]).toBe("");
		expect(Bun.stringWidth("正在读取")).toBe(8);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		const done = plain(h.rows());
		expect(done[1]).toBe(" 读取完成  Reading raw preset table · src/config.ts");
		// The detail origin (action area + two spaces) is identical across the state change.
		expect(done[1]!.indexOf("src/config.ts")).toBe(running[1]!.indexOf("src/config.ts"));
		for (const rows of [h.rows(), nativeRows(h.dock.describe(cx()))]) {
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
			expect(plain(h.rows())[1]).toStartWith(` ${c.running}  `);
			await live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: c.name,
				result: { content: [] },
				isError: false,
			});
			expect(plain(h.rows())[1]).toStartWith(` ${c.done}  `);
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
		expect(row).toStartWith(" 执行失败  ");
		expect(row).toContain("false");
		expect(row).not.toContain("boom");
		expect(h.rows()[1]).toContain(theme.getFgAnsi("error"));
		// A fresh call is a separate record; while it runs, the failed action stays above as the latest ended.
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "bash",
			args: { command: "true" },
		});
		expect(plain(h.rows())[0]).toStartWith(" 执行失败  ");
		expect(plain(h.rows())[1]).toStartWith(" 正在执行  ");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "b",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		// Both ended actions are retained (latest two): the failure stays above, the success below.
		expect(plain(h.rows())[0]).toStartWith(" 执行失败  ");
		expect(plain(h.rows())[1]).toStartWith(" 执行完成  ");
	});

	it("records thinking as one action, shows the latest nonblank line, then replaces it with elapsed seconds", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("older\nfirst\nlatest");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
		});
		expect(plain(h.rows())).toEqual(["", " 正在思考  latest", ""]);
		setSystemTime(15_000);
		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		expect(plain(h.rows())).toEqual(["", " 思考完成  用时 5.0 秒", ""]);
		expect(h.rendered()).not.toContain("latest");
	});

	it("formats sub-0.1s thinking as <0.1 and keeps seconds past a minute", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("quick");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
		});
		setSystemTime(10_050);
		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		expect(plain(h.rows())[1]).toBe(" 思考完成  用时 <0.1 秒");

		const slow = thinkingMessage("slow", 2);
		const live2 = liveSession(slow, 0);
		h.register("Slow", live2);
		await h.focus.focusAgent("Slow");
		await live2.emit({
			type: "message_update",
			message: slow,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: slow },
		});
		setSystemTime(80_000);
		live2.session.agent.state.activeThinkingIndex = undefined;
		await live2.emit(update(slow, "thinking_end"));
		expect(plain(h.rows())[1]).toBe(" 思考完成  用时 70.0 秒");
	});

	it("orders serial actions as latest-ended above and current-running below", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("reasoning");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
		});
		setSystemTime(15_000);
		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "r",
			toolName: "read",
			args: { path: "src/config.ts" },
		});
		expect(plain(h.rows())).toEqual([" 思考完成  用时 5.0 秒", " 正在读取  src/config.ts", ""]);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "r",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		expect(plain(h.rows())).toEqual([" 思考完成  用时 5.0 秒", " 读取完成  src/config.ts", ""]);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "x",
			toolName: "bash",
			args: { command: "rg compact packages/" },
		});
		expect(plain(h.rows())).toEqual([" 读取完成  src/config.ts", " 正在执行  rg compact packages/", ""]);
	});

	it("keeps two running actions in stable slots, fills vacancies without a carousel, and never hides a runner", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const start = (id: string) =>
			live.emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } });
		const end = (id: string) =>
			live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "bash",
				result: { content: [] },
				isError: false,
			});
		await start("A");
		await start("B");
		await start("C");
		// Bottom-first: A holds the bottom slot, B the top; C waits without rotating them.
		expect(plain(h.rows())).toEqual([" 正在执行  B", " 正在执行  A", ""]);
		await end("A");
		// A finished and a queued runner exists: C immediately fills A's bottom slot.
		expect(plain(h.rows())).toEqual([" 正在执行  B", " 正在执行  C", ""]);
		await end("B");
		// No queued runner remains: B stays static in place, C keeps running.
		expect(plain(h.rows())).toEqual([" 执行完成  B", " 正在执行  C", ""]);
		await end("C");
		expect(plain(h.rows())).toEqual([" 执行完成  B", " 执行完成  C", ""]);
	});

	it("animates only the running action word, stops it on end, and keeps the detail static", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setShimmerMode("classic");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "bash",
			args: { command: "sleep 1" },
		});
		const native = h.dock.describe(cx());
		expect(hasNativeKind(native, "shimmer")).toBe(true);
		// The shimmer node carries only the four-character action word, not the detail.
		const shimmerTexts: string[] = [];
		const visit = (node: NativeNode) => {
			if (node.k === "shimmer") shimmerTexts.push(node.p?.spans?.map(s => s.t).join("") ?? "");
			for (const child of node.c ?? []) if ("k" in child) visit(child);
		};
		visit(native);
		expect(shimmerTexts).toEqual(["正在执行"]);
		setSystemTime(500);
		const first = h.rows();
		setSystemTime(1000);
		expect(h.rows()).not.toEqual(first);
		expect(plain(h.rows())).toEqual(plain(first));
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		expect(hasNativeKind(h.dock.describe(cx()), "shimmer")).toBe(false);
		const stopped = h.rows();
		setSystemTime(1500);
		expect(h.rows()).toEqual(stopped);
	});

	it("honors disabled shimmer with static readable state words", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		setShimmerMode("disabled");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "read",
			args: { path: "a.ts" },
		});
		const first = h.rows();
		setSystemTime(500);
		expect(h.rows()).toEqual(first);
		expect(plain(first)[1]).toBe(" 正在读取  a.ts");
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
		expect(row).toStartWith(" 正在执行  ");
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

	it("middle-ellipsizes long read and write paths while keeping the file name", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const long = `src/${"nested/".repeat(20)}config.ts`;
		await live.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: long } });
		const row = plain(h.dock.render(40))[1]!;
		expect(row).toContain("…");
		expect(row).toContain("config.ts");
		expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
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
		const narrow = plain(h.dock.render(32));
		expect(narrow[0]).toContain("printf hello");
		expect(narrow[1]).toContain("宽字符");
		expect(narrow[2]).toBe("");
	});

	it("updates one record on incremental content without duplicating it or restarting thinking time", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("first");
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
		});
		setSystemTime(12_000);
		message.content = [{ type: "thinking", thinking: "first\nsecond" }];
		await live.emit(update(message, "thinking_delta"));
		expect(plain(h.rows())).toEqual(["", " 正在思考  second", ""]);
		setSystemTime(15_000);
		live.session.agent.state.activeThinkingIndex = undefined;
		await live.emit(update(message, "thinking_end"));
		// Elapsed is measured from the original phase start, not the last delta.
		expect(plain(h.rows())[1]).toBe(" 思考完成  用时 5.0 秒");
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
		expect(h.rendered()).toContain("正在思考  second phase");
		expect(h.nativeRendered()).toBe(h.rendered());
		setSystemTime(23_000);
		await live.emit(update(second, "thinking_end"));
		expect(plain(h.rows())).toEqual([" 思考完成  用时 2.0 秒", " 思考完成  用时 3.0 秒", ""]);
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
		expect(plain(h.rows())).toEqual([" 读取完成  old-a.ts", " 读取完成  old-b.ts", ""]);
		await run("new-a.ts");
		await run("new-b.ts");
		expect(plain(h.rows())).toEqual([" 读取完成  new-a.ts", " 读取完成  new-b.ts", ""]);
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("settles thinking before coalesced reply updates and excludes reply time from its duration", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("reasoning", 1);
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("正在思考");

		setSystemTime(12_000);
		const end = update(message, "thinking_end");
		live.session.agent.emitExternalEvent(end, { stateOnly: true });
		await h.ctx.eventController.dispatchSessionEvent(end);
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
		live.session.agent.emitExternalEvent(textStart, { stateOnly: true });
		await h.ctx.eventController.dispatchSessionEvent(textStart);
		await h.ctx.eventController.dispatchSessionEvent({ type: "message_end", message: reply });
		expect(plain(h.rows())).toEqual(["", " 思考完成  用时 2.0 秒", ""]);
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
		expect(plain(retained)[1]).toBe(" 读取完成  keep.ts");
		expect(hasNativeKind(h.dock.describe(cx()), "shimmer")).toBe(false);
		setSystemTime(Date.now() + 500);
		expect(h.rows()).toEqual(retained);
		await h.focus.focusAgent(MAIN_AGENT_ID);
		expect(h.rows()).toEqual(["", "", ""]);
		await h.focus.focusAgent("Worker");
		expect(plain(h.rows())[1]).toBe(" 读取完成  keep.ts");
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
		expect(h.rendered()).not.toContain("准备中");
		expect(hasNativeKind(h.dock.describe(cx()), "shimmer")).toBe(false);
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "prep",
			toolName: "read",
			args: { path: "src/宽字符.ts" },
		});
		expect(plain(h.rows())[1]).toBe(" 正在读取  src/宽字符.ts");
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
		expect(row).toStartWith(" 正在执行  ");
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
});

describe("execution-only read group activity", () => {
	it("starts and times a read created by its first execution event (P2-23)", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const ctx = createInteractiveModeContext();
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
		...options,
	};
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
		const todo = outputCall("todo", 2, "TODO_RESULT", options);
		const output = new LiveToolOutputState();
		const observe = (call: LiveToolOutputSnapshot) => {
			output.observe(
				{ type: "tool_execution_start", toolCallId: call.toolCallId, toolName: call.toolName, args: call.args },
				Date.now(),
				call.dispatchOrder,
			);
			output.observe(
				{
					type: "tool_execution_end",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					result: call.result!,
					isError: false,
				},
				Date.now(),
			);
		};
		observe(todo);
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => output.snapshot());
		h.register("TodoOutput", live);
		await h.focus.focusAgent("TodoOutput");
		expect(h.outputRows()).toEqual([[], []]);
		output.clear();
		observe(outputCall("shell", 1, "SHELL_OUTPUT"));
		observe(todo);
		const view = h.previewView();
		expect(view.head).toContain("已完成 · bash · echo shell");
		expect(view.body).toEqual(["SHELL_OUTPUT"]);
		expect(view.nativeHead).toContain("已完成 · bash · echo shell");
		expect(view.nativeBody).toEqual(["SHELL_OUTPUT"]);
	});

	it("selects by dispatch order only after real Output and replaces cumulative frames", async () => {
		const h = focusFixture();
		const live = liveSession();
		const first = outputCall("first", 1, "first output");
		const second = outputCall("second", 2, "");
		let calls = [first, second];
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => calls);
		h.register("OutputWorker", live);
		await h.focus.focusAgent("OutputWorker");
		const view = h.previewView();
		expect(view.head).toContain("运行中 · bash · echo first");
		expect(view.body).toEqual(["first output"]);
		expect(view.nativeHead).toContain("运行中 · bash · echo first");
		calls = [
			first,
			{
				...second,
				result: {
					content: [{ type: "text", text: "\x1b[31m \t\n\x1b[0m" }, { type: "image" }],
				},
			},
		];
		expect(h.previewView().head).toContain("echo first");
		calls = [
			first,
			{
				...second,
				result: {
					content: [{ type: "text", text: "Backgrounded as job bg_2; output will follow" }],
					details: { async: { jobId: "bg_2", state: "running" } },
				},
			},
		];
		expect(h.previewView().head).toContain("echo first");
		const newer = outputCall("second", 2, "one\ntwo");
		calls = [newer, outputCall("first", 1, "late first output")];
		const newerView = h.previewView();
		expect(newerView.head).toContain("echo second");
		expect(newerView.body).toEqual(["one", "two"]);
		expect(newerView.nativeBody).toEqual(["one", "two"]);
		calls = [outputCall("first", 1, "even later"), outputCall("second", 2, "one\ntwo\nthree")];
		const threeView = h.previewView();
		expect(threeView.body).toEqual(["one", "two", "three"]);
		expect(threeView.nativeBody).toEqual(["one", "two", "three"]);
	});

	it("keeps background Output live after loop completion without retained tool cards", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		let frame = outputCall("shell", 1, "0", {
			result: {
				content: [{ type: "text", text: "0" }],
				details: { async: { jobId: "bg_1", name: "BuildPackage", state: "running" } },
			},
		});
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => [frame]);
		h.register("BackgroundOutput", live);
		await h.focus.focusAgent("BackgroundOutput");
		await live.emit({ type: "agent_end", messages: [] });
		h.ctx.pendingTools.clear();
		for (let second = 1; second <= 25; second++) {
			setSystemTime(10_000 + second * 1000);
			frame = {
				...frame,
				result: {
					content: [{ type: "text", text: `tick ${second}` }],
					details: { async: { jobId: "bg_1", name: "BuildPackage", state: "running" } },
				},
			};
			await live.emit({
				type: "tool_execution_update",
				toolCallId: "shell",
				toolName: "bash",
				args: frame.args,
				partialResult: frame.result!,
			});
			const view = h.previewView();
			expect(view.head).toContain("运行中 · bash · BuildPackage · bg_1");
			expect(view.body).toEqual([`tick ${second}`]);
			expect(view.nativeHead).toContain("运行中 · bash · BuildPackage · bg_1");
		}
		expect(h.ctx.pendingTools.size).toBe(0);
	});

	it("retains completed Output while the status line is running and expires three seconds after it stops", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const terminal = outputCall("latest", 1, "completed while still working", { terminalAt: 10_000 });
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([terminal]);
		h.register("WorkingOutput", live);
		await h.focus.focusAgent("WorkingOutput");
		await live.emit({ type: "agent_start" });
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
		let calls = [old, terminal];
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => calls);
		h.register("TerminalOutput", live);
		await h.focus.focusAgent("TerminalOutput");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "latest",
			toolName: "bash",
			result: terminal.result!,
			isError: false,
		});
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		await h.focus.focusAgent(MAIN_AGENT_ID);
		vi.advanceTimersByTime(3000);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		await h.focus.focusAgent("TerminalOutput");
		expect(h.outputRows()).toEqual([[], []]);
		const rebuilt = new CompactToolOutputPreview(h.ctx);
		outputPreviews.push(rebuilt);
		expect(rebuilt.render(120)).toEqual([]);
		calls = [terminal, outputCall("old", 1, "late old"), outputCall("new-no-output", 3, "")];
		for (const rows of h.outputRows()) expect(rows).toEqual([]);
		calls = [...calls, outputCall("new-output", 4, "new Output")];
		for (const rows of h.outputRows()) {
			expect(rows.join("\n")).toContain("new Output");
		}
		vi.advanceTimersByTime(3000);
	});

	it("does not let an earlier terminal deadline close a newer Output source", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		let calls = [outputCall("done", 1, "done", { terminalAt: 10_000 })];
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => calls);
		h.register("ReplacementOutput", live);
		await h.focus.focusAgent("ReplacementOutput");
		vi.advanceTimersByTime(2000);
		calls = [outputCall("next", 2, "replacement")];
		await live.emit({
			type: "tool_execution_update",
			toolCallId: "next",
			toolName: "bash",
			args: {},
			partialResult: calls[0]!.result!,
		});
		vi.advanceTimersByTime(1000);
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("replacement");
	});

	it("shows the latest four meaningful display rows without changing the original Output", async () => {
		const h = focusFixture();
		const live = liveSession();
		const text = `discard\nfirst\n \nsecond\n\t\nthird\n${" ".repeat(150)}\nfourth\n\x1b[31m  \x1b[0m\nfifth\n{}\n---\n\x1b[31m╰──╯\x1b[0m\n✅\n\n`;
		const call = outputCall("nonblank", 1, text);
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([call]);
		h.register("NonblankOutput", live);
		await h.focus.focusAgent("NonblankOutput");
		const view = h.previewView();
		expect(view.body).toEqual(["second", "third", "fourth", "fifth"]);
		expect(view.nativeBody).toEqual(["second", "third", "fourth", "fifth"]);
		expect(call.result?.content).toEqual([{ type: "text", text }]);
	});

	it("frames output with borders and padding while preserving relative indentation", async () => {
		const h = focusFixture();
		const live = liveSession();
		const call = outputCall("aligned", 1, "\n    根节点\n      child 42\n    ---\n    {}\n");
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([call]);
		h.register("AlignedOutput", live);
		await h.focus.focusAgent("AlignedOutput");
		const view = h.previewView();
		expect(view.ansi).toHaveLength(4);
		expect(view.ansi[0]!.startsWith("╭")).toBe(true);
		expect(view.ansi.at(-1)!.startsWith("╰")).toBe(true);
		expect(view.body).toEqual(["根节点", "  child 42"]);
		expect(view.nativeBody).toEqual(["根节点", "  child 42"]);
	});

	it("does not open or replace meaningful output for symbol-only frames", async () => {
		const h = focusFixture();
		const live = liveSession();
		let calls = [outputCall("symbols", 2, "\x1b[31m{}\n---\n╰──╯\x1b[0m\n✅")];
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => calls);
		h.register("SymbolOutput", live);
		await h.focus.focusAgent("SymbolOutput");
		expect(h.outputRows()).toEqual([[], []]);
		calls = [outputCall("content", 1, "0"), ...calls];
		const view = h.previewView();
		expect(view.head).toContain("echo content");
		expect(view.body).toEqual(["0"]);
		expect(view.nativeBody).toEqual(["0"]);
	});

	it("wraps safe output before its tail window and keeps ANSI/native text identical", async () => {
		const h = focusFixture();
		const live = liveSession();
		const call = outputCall(
			"wrapped",
			1,
			"discarded\r最新\t内容\nline2\nline3\nline4\nline5\nline6\n\x1b[31m尾部中文宽字符尾部中文宽字符\x1b[0m",
		);
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([call]);
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
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([first, second, reply]);
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
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => [call]);
		h.register("GrepOutput", live);
		await h.focus.focusAgent("GrepOutput");
		const running = h.previewView();
		expect(running.head).toContain("运行中 · grep");
		expect(running.body).toEqual([
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
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([call]);
		h.register("GrepFill", live);
		await h.focus.focusAgent("GrepFill");
		const view = h.previewView();
		expect(view.body).toEqual(["*12│only hit", "# src/", " 10│context one", " 13│context two"]);
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
		let calls = [glob];
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => calls);
		h.register("GlobOutput", live);
		await h.focus.focusAgent("GlobOutput");
		const globView = h.previewView();
		expect(globView.head).toContain("已完成 · glob");
		expect(globView.body).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
		expect(globView.nativeBody).toEqual(globView.body);
		calls = [glob, wrapped];
		const wrappedView = h.previewView();
		expect(wrappedView.body).toEqual(["*12│wrapped hit", "# src/", " 10│context", " 13│context after"]);
		expect(wrappedView.nativeBody).toEqual(wrappedView.body);
	});

	it("keeps tail selection for terminal bash and zero-hit grep without error heuristics", async () => {
		const h = focusFixture();
		const live = liveSession();
		const failed = outputCall(
			"failed",
			1,
			"line one\nError: boom at step 2\nline three\nline four\nline five\nline six",
			{
				terminalAt: Date.now(),
				result: {
					content: [
						{ type: "text", text: "line one\nError: boom at step 2\nline three\nline four\nline five\nline six" },
					],
					isError: true,
				},
			},
		);
		const empty = outputCall("empty", 2, "No matches found", {
			toolName: "grep",
			args: { pattern: "missing" },
			terminalAt: Date.now(),
			result: {
				content: [{ type: "text", text: "No matches found" }],
				details: { matchCount: 0, fileCount: 0 },
			},
		});
		let calls = [failed];
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockImplementation(() => calls);
		h.register("FallbackOutput", live);
		await h.focus.focusAgent("FallbackOutput");
		const failedView = h.previewView();
		expect(failedView.head).toContain("失败 · bash");
		expect(failedView.body).toEqual(["line three", "line four", "line five", "line six"]);
		expect(failedView.nativeBody).toEqual(failedView.body);
		calls = [failed, empty];
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
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([call]);
		h.register("LongCommand", live);
		await h.focus.focusAgent("LongCommand");
		const view = h.previewView(60);
		expect(view.head).toContain("运行中 · bash · rg -n");
		expect(view.head).toContain("…");
		expect(view.head).toContain("styles.css");
		expect(Bun.stringWidth(view.ansi[0]!)).toBeLessThanOrEqual(60);
		expect(view.nativeHead).toContain("运行中 · bash · rg -n");
	});

	it("does not revive a finished preview when the next turn starts", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const done = outputCall("done", 1, "previous turn output", { terminalAt: 10_000 });
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([done]);
		h.register("TurnBoundary", live);
		await h.focus.focusAgent("TurnBoundary");
		await live.emit({ type: "agent_start" });
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("previous turn output");
		await live.emit({ type: "agent_end", messages: [] });
		// Idle: the three-second retention still applies.
		vi.advanceTimersByTime(1000);
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("previous turn output");
		// A new run opens before any new Output: the finished preview must not repaint.
		setSystemTime(12_000);
		await live.emit({ type: "agent_start" });
		expect(h.outputRows()).toEqual([[], []]);
		// The new turn's own terminal Output opens the preview again.
		const fresh = outputCall("fresh", 2, "new turn output", { terminalAt: 12_500 });
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([fresh]);
		setSystemTime(12_500);
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("new turn output");
	});

	it("keeps a still-running background source across the turn boundary", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const running = outputCall("bg", 1, "background progress");
		vi.spyOn(live.session, "getLiveToolOutputSnapshot").mockReturnValue([running]);
		h.register("RunningBoundary", live);
		await h.focus.focusAgent("RunningBoundary");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "agent_end", messages: [] });
		setSystemTime(20_000);
		await live.emit({ type: "agent_start" });
		for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("background progress");
	});
});
