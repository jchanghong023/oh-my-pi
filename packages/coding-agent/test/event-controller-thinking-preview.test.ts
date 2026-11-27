import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactThinkingPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-thinking-preview";
import { CompactToolOutputPreview } from "@oh-my-pi/pi-coding-agent/modes/compact-tool-output-preview";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { cfgDisplayMode, cfgDisplayShimmer, cfgTuiSpinnerInterval } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type ModelStage, nextModelStage } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
	LiveToolOutputPreview,
	LiveToolOutputSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { TurnToolDiff } from "@oh-my-pi/pi-coding-agent/session/latest-turn-tool-diffs";
import { LiveToolOutputState } from "@oh-my-pi/pi-coding-agent/session/live-tool-output";
import { toolOutputText } from "@oh-my-pi/pi-coding-agent/session/live-tool-output-text";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatBackgroundNotice } from "@oh-my-pi/pi-coding-agent/tools/details/bash";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { AppFrame } from "../src/modes/interactive/frame";
import { initTheme } from "../src/ui/theme/service";
import {
	applyRenderFixtureEvent,
	createInteractiveModeContext,
	createSessionStub,
	renderTranscript,
} from "./helpers/interactive-mode-context";

function nativeDockRows(width: number, view: CompactThinkingPreview | CompactToolOutputPreview): readonly string[] {
	const activity = view instanceof CompactThinkingPreview ? view : undefined;
	const output = view instanceof CompactToolOutputPreview ? view : undefined;
	if (activity && activity.render(width).length === 0) return [];
	const frame = new AppFrame({ version: "test", shape: "box", quiet: true });
	vi.spyOn(frame.shell, "size").mockReturnValue({ columns: width, rows: 40 });
	frame.mountCompactPresentation(
		() => true,
		columns => activity?.rows(columns) ?? [],
		columns => output?.render(columns) ?? [],
		() => [],
		() => false,
		() => "classic",
		() => {},
	);
	const native = new Reconciler(
		frame.shell.surface,
		"frame",
		{ cols: () => width, rows: () => 40, hasFeature: () => true },
		() => {},
	);
	try {
		type NativeProps = { role?: string; lines?: string[]; text?: string; spans?: { t: string }[] };
		const nodes = new Map<string, TspNode>();
		const children = new Map<string, string[]>();
		const textOps = new Map<string, string>();
		let target: string | undefined;
		const role = activity ? "omp.compact.activity" : "omp.compact.output";
		const add = (parent: string, node: TspNode): void => {
			nodes.set(node.id, node);
			if ((node.p as NativeProps | undefined)?.role === role) target = node.id;
			const siblings = children.get(parent);
			if (siblings) siblings.push(node.id);
			else children.set(parent, [node.id]);
			// An add carries the entire new subtree, not one op per descendant.
			for (const child of node.c ?? []) add(node.id, child);
		};
		for (const op of native.reconcile().ops) {
			if (op[0] === "text") {
				const [, id, mode, text] = op;
				textOps.set(id, mode === "append" ? (textOps.get(id) ?? "") + text : text);
				continue;
			}
			if (op[0] !== "add") continue;
			const [, , parent, , node] = op;
			add(parent, node);
		}
		if (!target) throw new Error(`Missing native ${role} rows`);
		if (output) return (nodes.get(target)?.p as NativeProps | undefined)?.lines ?? [];
		const text = (id: string): string => {
			const p = nodes.get(id)?.p as NativeProps | undefined;
			return (
				p?.spans?.map(span => span.t).join("") ??
				textOps.get(id) ??
				p?.text ??
				children.get(id)?.map(text).join("") ??
				""
			);
		};
		return (children.get(target) ?? []).map(id => text(id).trimEnd());
	} finally {
		native.dispose();
		frame.shell.surface.dispose();
	}
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
const outputPreviews: CompactToolOutputPreview[] = [];
const activityDocks: CompactThinkingPreview[] = [];

function focusFixture(fileDiffRows?: () => number) {
	const main = liveSession();
	const ctx = createInteractiveModeContext({ session: main.session, hideToolActivity: true }, fileDiffRows);
	cfgDisplayMode.set(ctx.settings, "compact");
	const { compactThinkingPreview: dock, compactToolOutputPreview: output } = ctx;
	outputPreviews.push(output);
	activityDocks.push(dock);
	const controller = new EventController(ctx, event => {
		dock.observe(event);
		output.observe(event);
		ctx.refreshCompactPresentation();
	});
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
	return {
		ctx,
		focus,
		dock,
		output,
		outputRows: (width = 120) =>
			[output.render(width), nativeDockRows(width, output)].map(rows =>
				rows.map(row => Bun.stripANSI(row).trimEnd()),
			),
		previewView: (width = 120) => {
			const ansi = output.render(width).map(row => Bun.stripANSI(row).trimEnd());
			const native = nativeDockRows(width, output).map(row => Bun.stripANSI(row).trimEnd());
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
		nativeRendered: (width = 60) => Bun.stripANSI(nativeDockRows(width, dock).join("\n")).trimEnd(),
		nativeRows: (width = 60) => nativeDockRows(width, dock),
		rows: (width = 60) => dock.render(width),
	};
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	vi.useFakeTimers();
});

afterEach(() => {
	for (const dock of activityDocks.splice(0)) dock.clear();
	for (const output of outputPreviews.splice(0)) output.clear();
	for (const controller of focusControllers.splice(0)) controller.dispose();
	for (const controller of eventControllers.splice(0)) controller.dispose();
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("compact action dock", () => {
	const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));

	it("keeps the running path legible and preserves the dock spacing after it settles", async () => {
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
		const theme = currentTheme();
		const running = plain(h.dock.render(80));
		expect(running[0]).toBe("");
		expect(running[1]).toContain("Agent: Reading  workspace/src/config.ts · Checking presets");
		expect(running[2]).toBe("");
		expect(h.dock.render(80)[1]).toContain(
			theme.fg("dim", "workspace/") + theme.fg("text", "src/config.ts") + theme.fg("dim", " · Checking presets"),
		);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "read",
			result: { content: [] },
			isError: false,
		});
		for (const rows of [h.dock.render(80), h.nativeRows(80)]) expect(plain(rows)).toEqual(["", "", ""]);
	});

	it("labels edits as writes and falls back to Calling for unknown tools", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const cases = [
			{ name: "edit", args: { path: "a.ts", input: "*** Begin Patch" }, running: "Writing" },
			{ name: "mystery_tool", args: { query: "target" }, running: "Calling" },
		] as const;
		for (const [index, c] of cases.entries()) {
			const id = `cat-${index}`;
			await live.emit({ type: "tool_execution_start", toolCallId: id, toolName: c.name, args: c.args });
			const row = plain(h.rows())[1]!;
			expect(row).toStartWith(` Agent: ${c.running}  `);
			if (c.name === "mystery_tool") {
				expect(row).toContain(c.name);
				expect(row).toContain(c.args.query);
			}
			await live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: c.name,
				result: { content: [] },
				isError: false,
			});
			expect(plain(h.rows())[1]).toBe("");
		}
	});

	it("keeps the object in running detail and clears the activity on failure", async () => {
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
		expect(plain(h.rows())[1]).toBe(" Agent: Running  false");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		});
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)).toEqual(["", "", ""]);
	});

	it("separates request, thinking and reply from the tool row", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		cfgDisplayMode.set(h.ctx.settings, "clean");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "turn_start" });
		expect(h.rendered()).not.toContain("Model ");
		cfgDisplayMode.set(h.ctx.settings, "compact");
		expect(plain(h.rows())[0]).toContain("Model waiting");
		const reason = thinkingMessage("earlier line\nlatest model reasoning");
		await live.emit(update(reason, "thinking_delta"));
		expect(plain(h.rows())[0]).toContain("latest model reasoning");
		expect(h.nativeRendered()).toBe(h.rendered());
		h.ctx.hideThinkingBlock = true;
		expect(plain(h.rows())[0]).toContain("Model thinking");
		expect(h.rendered()).not.toContain("latest model reasoning");
		await live.emit({ type: "message_end", message: reason });
		await live.emit({ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: { command: "run" } });
		expect(plain(h.rows())[0]).toBe("");
		expect(plain(h.rows())[1]).toContain("Agent: Running");
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
		expect(plain(h.rows())[0]).toContain("Model replying");
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)[1]).toBe("");
		await live.emit({ type: "message_end", message: reply });
		await live.emit({ type: "agent_end", messages: [] });
		expect(plain(h.rows())[0]).toBe("");
		expect(h.rendered()).not.toContain("Agent: Running");
	});

	it("keeps the first running tool visible while indicating additional work", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		for (let i = 1; i <= 3; i++) {
			await live.emit({
				type: "tool_execution_start",
				toolCallId: `call-${i}`,
				toolName: "bash",
				args: { command: `task ${i}` },
			});
		}
		expect(plain(h.rows())[1]).toMatch(/task 1.*\+2/);
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		expect(plain(h.rows())[1]).toMatch(/task 2.*\+1/);
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
		expect(plain(h.rows())[0]).toBe(" Model thinking");
		expect(h.nativeRendered()).toBe(h.rendered());
		message.content = [{ type: "thinking", thinking: "```\nPRIVATE_THOUGHT\n```" }];
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).not.toContain("PRIVATE_THOUGHT");
		expect(h.nativeRendered()).toBe(h.rendered());
		message.content = [{ type: "thinking", thinking: "firstpart secondpart thirdpart final-tail\n \t\n" }];
		await live.emit(update(message, "thinking_delta"));
		const width = 45;
		for (const rows of [h.dock.render(width), h.nativeRows(width)]) {
			expect(plain(rows)[0]).toContain("final-tail");
			expect(plain(rows)[1]).toMatch(/A.*\+1/);
		}
		h.ctx.hideThinkingBlock = true;
		expect(h.rendered()).not.toContain("final-tail");
		expect(h.nativeRendered()).toBe(h.rendered());
		h.ctx.hideThinkingBlock = false;
		expect(h.rendered()).toContain("final-tail");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("starts model shimmer with the spinner and keeps it through streamed thinking and replies", async () => {
		const h = focusFixture();
		const theme = currentTheme();
		const env = staticEnvironment(theme);
		const assertShimmer = (label: string, detail = "") => {
			const activity = h.ctx.shell.surface
				.dock()
				.flatMap(node => node.children())
				.find(node => node.props().role === "omp.compact.activity");
			if (!activity) throw new Error("Missing terminal compact activity");
			const ansiFrames = new Set<string>();
			for (let elapsed = 100; elapsed < 1_400; elapsed += 80) {
				env.setNow(10_000 + elapsed);
				ansiFrames.add(renderBlock(activity, 60, { env }).rows[0]!);
			}
			expect(ansiFrames.size).toBeGreaterThan(1);
			expect([...ansiFrames].some(frame => frame.includes(theme.fgSgr("accent")))).toBe(true);
			expect(new Set([...ansiFrames].map(frame => Bun.stripANSI(frame).trim()))).toEqual(
				new Set([detail ? `${label}  ${detail}` : label]),
			);
		};
		setSystemTime(10_000);
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit({ type: "agent_start" });
		await live.emit({ type: "turn_start" });
		expect(h.rendered()).toContain("Model waiting");
		assertShimmer("Model waiting");

		const reason = thinkingMessage("First thought");
		await live.emit(update(reason, "thinking_delta"));
		expect(h.nativeRendered()).toContain("Model thinking");
		setSystemTime(10_100);
		reason.content = [{ type: "thinking", thinking: "Latest thought" }];
		await live.emit(update(reason, "thinking_delta"));
		expect(h.rendered()).toContain("Latest thought");
		expect(h.nativeRendered()).toBe(h.rendered());
		assertShimmer("Model thinking", "Latest thought");

		const reply = thinkingMessage("", 2);
		reply.content = [{ type: "text", text: "Reply" }];
		await live.emit({
			type: "message_update",
			message: reply,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reply", partial: reply },
		});
		expect(h.rendered()).toContain("Model replying");
		assertShimmer("Model replying");
		await live.emit({ type: "message_end", message: reply });
		await live.emit({ type: "agent_end", messages: [reply] });
		expect(h.rendered()).not.toContain("Model ");
	});

	it("keeps running tools animated as output changes and clears the Agent row after completion", async () => {
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
		expect(h.rendered()).toContain("Agent: Running");
		for (const text of ["First line", "Second line"]) {
			await live.emit({
				type: "tool_execution_update",
				toolCallId: "bash",
				toolName: "bash",
				args: {},
				partialResult: { content: [{ type: "text", text }] },
			});
			expect(h.previewView().body).toContain(text);
			expect(h.nativeRendered()).toContain("Agent: Running");
		}
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "bash",
			toolName: "bash",
			result: { content: [] },
			isError: false,
		});
		await live.emit({ type: "turn_start" });
		expect(h.rendered()).toContain("Model waiting");
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)[1]).toBe("");
		setSystemTime(11_200);
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)[1]).toBe("");
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
		expect(h.rendered()).toContain("Model thinking");
		expect(h.rendered()).toContain("Agent: Reading");
		cfgTuiSpinnerInterval.set(h.ctx.settings, 0);
		const staticRows = h.rows();
		setSystemTime(11_500);
		expect(h.rows()).toEqual(staticRows);
		await h.focus.focusAgent(MAIN_AGENT_ID);
		expect(h.rendered()).not.toContain("Agent: Reading");
	});

	it("honors disabled shimmer with static readable state words", async () => {
		const h = focusFixture();
		setSystemTime(24_000);
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		cfgDisplayShimmer.set(h.ctx.settings, "disabled");
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
		expect(plain(first)[1]).toBe(" Agent: Reading  a.ts");
		expect(h.nativeRendered()).toBe(h.rendered());
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
		for (const rows of [h.dock.render(40), h.nativeRows(40)]) {
			const [top, bottom] = plain(rows);
			expect(top).toBe("");
			expect(bottom).toContain("backend/config.ts");
			expect(rows.join("")).not.toContain("INTENT");
			expect(rows.every(row => Bun.stringWidth(row) <= 40)).toBe(true);
		}
		expect(h.rows(40)[1]).toContain(currentTheme().fg("text", "backend/config.ts"));
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
				toolName: "bash",
				args: { command: "echo raw\npwd", i: "Describe action" },
			});
			for (const rows of [dock.render(60), nativeDockRows(60, dock)]) {
				expect(plain(rows)[1]).toContain("Describe action");
				expect(plain(rows)[1]).not.toContain("echo raw");
			}
			expect(plain(dock.render(40))[1]).toContain("echo raw pwd");
			previewId = "other-call";
			expect(plain(dock.render(60))[1]).toContain("echo raw");
			previewId = undefined;
			expect(plain(dock.render(60))[1]).toContain("echo raw");
			previewId = "no-intent";
			await live.emit({
				type: "tool_execution_end",
				toolCallId: "with-intent",
				toolName: "bash",
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
		const width = 12;
		for (const rows of [h.dock.render(width), h.nativeRows(width)]) {
			expect(rows.every(row => Bun.stringWidth(row) <= width)).toBe(true);
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
		expect(h.rendered()).toContain("Model thinking");
		setSystemTime(12_000);
		await live.emit(update(first, "thinking_end"));
		await live.emit({ type: "message_end", message: first });

		const second = thinkingMessage("second phase", 2);
		setSystemTime(20_000);
		await live.emit({ type: "message_start", message: second });
		await live.emit(update(second, "thinking_delta"));
		expect(h.rendered()).toContain("Model thinking  second phase");
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
		expect(h.rendered()).toBe(" Model thinking  live reasoning");
		expect(h.nativeRendered()).toBe(h.rendered());

		// The stream still contains both blocks and the session has not emitted a terminal event.
		agent.abort();
		expect(h.rendered()).toBe(" Model thinking");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("leaves the Agent row empty when tools start and finish between paints", async () => {
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
		expect(plain(h.rows())[1]).toBe("");
		await run("new-a.ts");
		await run("new-b.ts");
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)[1]).toBe("");
	});

	it("does not resurrect coalesced thinking when streamed reply and its end arrive together", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const message = thinkingMessage("reasoning", 1);
		const live = liveSession(message, 0);
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		await live.emit(update(message, "thinking_delta"));
		expect(h.rendered()).toContain("Model thinking");

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
		expect(h.rendered()).not.toContain("Model thinking");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it("does not revive a settled action after loop end and session switch", async () => {
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
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)).toEqual(["", "", ""]);
		await h.focus.focusAgent(MAIN_AGENT_ID);
		expect(h.rows()).toEqual(["", "", ""]);
		await h.focus.focusAgent("Worker");
		for (const rows of [h.rows(), h.nativeRows()]) expect(plain(rows)).toEqual(["", "", ""]);
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
			expect(h.nativeRows()).toEqual([]);
		} else {
			await h.focus.focusAgent(MAIN_AGENT_ID);
			expect(h.rendered()).not.toContain("old reasoning");
			expect(h.nativeRendered()).toBe(h.rendered());
		}
		await live.emit({ type: "message_end", message: thinking });
		await live.emit({ type: "agent_end", messages: [] });
		if (change === "display tier") cfgDisplayMode.set(h.ctx.settings, "compact");
		else await h.focus.focusAgent("ThinkingView");
		expect(h.rendered()).not.toContain("Model thinking");
		expect(h.rendered()).not.toContain("old reasoning");
		expect(h.nativeRendered()).toBe(h.rendered());
	});

	it.each(["compact", "detailed"] as const)("respects file write visibility in %s chat", async mode => {
		const h = focusFixture();
		const compact = mode === "compact";
		cfgDisplayMode.set(h.ctx.settings, mode);
		h.ctx.hideToolActivity = compact;
		const live = liveSession();
		h.register("Writer", live);
		await h.focus.focusAgent("Writer");

		const file = "large.txt";
		const firstLine = "WRITE_SOURCE_START";
		const lastLine = "WRITE_SOURCE_END";
		const body = [firstLine, ...Array.from({ length: 58 }, () => "filler line"), lastLine].join("\n");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "write",
			toolName: "write",
			args: { path: file, content: body },
		});
		if (compact) expect(renderTranscript(h.ctx).join("\n")).not.toContain("WRITE_SOURCE_");
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "write",
			toolName: "write",
			result: {
				content: [{ type: "text", text: `Successfully wrote ${body.length} bytes to ${file}` }],
				details: { resolvedPath: path.resolve(file) },
			},
			isError: false,
		});

		const collapsed = renderTranscript(h.ctx).join("\n");
		if (compact) {
			expect(plain(h.rows())[1]).toBe("");
			expect(collapsed).not.toContain("WRITE_SOURCE_");
		} else {
			expect(collapsed).toContain(firstLine);
			expect(collapsed).not.toContain(lastLine);
			new InputController(h.ctx).toggleToolOutputExpansion();
			expect(renderTranscript(h.ctx).join("\n")).toContain(lastLine);
		}
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
		expect(h.rendered()).not.toContain("Agent: Reading");
		expect(h.rendered()).toContain("Model preparing call");
		expect(h.nativeRendered()).toContain("Model preparing call");
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "prep",
			toolName: "read",
			args: { path: "src/宽字符.ts" },
		});
		expect(plain(h.rows())[1]).toBe(" Agent: Reading  src/宽字符.ts");
	});

	it("uses structured mounted command arguments and keeps mixed shell operations as Bash", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("Worker", live);
		await h.focus.focusAgent("Worker");
		const mount = {
			tool: "ast_grep",
			mode: "execute" as const,
			exitCode: 0,
			args: { pat: "const $NAME = 7", path: "fixture.ts" },
		};
		const sole = 'ast_grep --json \'{"pat":"const $NAME = 7","path":"fixture.ts","other":"PRIVATE_PAYLOAD"}\'';
		const mixed = "ast_grep --path fixture.ts; echo done";
		for (const [id, command, expected] of [
			["sole", sole, "Calling  bash (ast_grep) const $NAME = 7 · fixture.ts"],
			["mixed", mixed, `Running  ${mixed}`],
		] as const) {
			const args = { command };
			await live.emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args });
			const result = { content: [], details: { toolCommands: [mount] } };
			await live.emit({
				type: "tool_execution_update",
				toolCallId: id,
				toolName: "bash",
				args: {},
				partialResult: result,
			});
			expect(plain(h.rows(100))[1]).toBe(` Agent: ${expected}`);
			expect(h.rendered()).not.toContain("PRIVATE_PAYLOAD");
			await live.emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result, isError: false });
		}
	});

	it("labels mounted file patches as writes and keeps URL transports as generic calls", async () => {
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
			["patch", "apply_patch", patch, "Writing  src/one.ts (2 files)"],
			["settings", "cfg://display", "PRIVATE_BODY", "Calling  write cfg://display"],
		] as const) {
			const toolName = id === "patch" ? "bash" : "write";
			const args = id === "patch" ? { command: "apply_patch @patch.txt" } : { path, content };
			const result =
				id === "patch"
					? {
							content: [],
							details: {
								toolCommands: [{ tool: path, mode: "execute", exitCode: 0, args: { input: content } }],
							},
						}
					: { content: [] };
			await live.emit({ type: "tool_execution_start", toolCallId: id, toolName, args });
			await live.emit({ type: "tool_execution_update", toolCallId: id, toolName, args, partialResult: result });
			expect(plain(h.rows())[1]).toBe(` Agent: ${expected}`);
			expect(h.rendered()).not.toContain("PRIVATE_BODY");
			await live.emit({
				type: "tool_execution_end",
				toolCallId: id,
				toolName,
				result,
				isError: false,
			});
			expect(plain(h.rows())[1]).toBe("");
		}
	});
});

describe("execution-only read group activity", () => {
	it("starts and settles a read created by its first execution event", async () => {
		const ctx = createInteractiveModeContext();
		cfgDisplayMode.set(ctx.settings, "detailed");
		const controller = new EventController(ctx);
		eventControllers.push(controller);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "execution-only-read",
			toolName: "read",
			args: { path: "src/execution-only.ts" },
		});
		const group = ctx.pendingTools.get("execution-only-read")?.group;
		if (!group) throw new Error("Expected a grouped read");
		expect(group.status(group.entries())).toBe("running");
		expect(renderTranscript(ctx).join("\n")).toContain("src/execution-only.ts");
		group.setActivityVisible(false);
		expect(renderTranscript(ctx).join("\n")).not.toContain("src/execution-only.ts");
		expect(group.status(group.entries())).toBe("running");
		group.setActivityVisible(true);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "execution-only-read",
			toolName: "read",
			result: { content: [{ type: "text", text: "export const value = 1;" }] },
			isError: false,
		});
		expect(group.status(group.entries())).toBe("done");
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
			route: "sole Bash command",
			options: {
				toolName: "bash",
				args: { command: "todo --op view" },
				result: {
					content: [{ type: "text" as const, text: "TODO_RESULT" }],
					details: { toolCommands: [{ tool: "todo", mode: "execute", exitCode: 0, inner: {} }] },
				},
			},
		},
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
		expect(view.head).toContain("Done · bash · echo shell");
		expect(view.body).toEqual(["SHELL_OUTPUT"]);
		expect(view.nativeHead).toContain("Done · bash · echo shell");
		expect(view.nativeBody).toEqual(["SHELL_OUTPUT"]);
	});

	it("updates the TODO panel from a successful command even when a later shell step fails", async () => {
		const h = focusFixture();
		const live = liveSession();
		h.register("TodoOutput", live);
		await h.focus.focusAgent("TodoOutput");
		const setTodos = vi.spyOn(h.ctx, "setTodos");
		const command = 'todo --json \'{"op":"init","items":["Work"]}\'; false';
		const phases = [{ name: "Work", tasks: [{ content: "Work", status: "pending" }] }];
		await live.emit({
			type: "tool_execution_start",
			toolCallId: "todo-bash",
			toolName: "bash",
			args: { command },
		});
		await live.emit({
			type: "tool_execution_end",
			toolCallId: "todo-bash",
			toolName: "bash",
			isError: true,
			result: {
				content: [],
				details: {
					toolCommands: [{ tool: "todo", mode: "execute", exitCode: 0, inner: { op: "init", phases } }],
				},
			},
		});
		expect(setTodos).toHaveBeenCalledWith(phases);
	});

	it("deduplicates only the latest original edit receipt in the folded diff", async () => {
		setSystemTime(10_000);
		let diffRows = 6;
		const h = focusFixture(() => diffRows);
		const live = liveSession();
		const output = new LiveToolOutputState();
		const changes: TurnToolDiff[] = [];
		const file = path.resolve(live.session.sessionManager.getCwd(), "result.txt");
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(project => output.preview(project));
		vi.spyOn(live.session, "getLatestTurnToolDiffs").mockReturnValue(changes);
		h.register("CoveredEdits", live);
		await h.focus.focusAgent("CoveredEdits");
		output.restore([outputCall("shell", 1, "retained Output", { terminalAt: 10_000 })], false);
		const original = h.previewView();
		expect(original).toMatchObject({
			head: "Done · bash · echo shell",
			body: ["retained Output"],
			nativeHead: "Done · bash · echo shell",
			nativeBody: ["retained Output"],
		});
		const earlier = {
			body: ["[result.txt#ABCD]", "1:updated_1"],
			nativeBody: ["[result.txt#ABCD]", "1:updated_1"],
		};

		for (let i = 1; i <= 2; i++) {
			vi.advanceTimersByTime(500);
			const toolCallId = `edit-${i}`;
			output.observe(
				{ type: "tool_execution_start", toolCallId, toolName: "edit", args: { path: file } },
				Date.now(),
			);
			const details = {
				path: file,
				diff: `-1|original_${i}\n+1|updated_${i}`,
				firstChangedLine: 1,
			};
			changes.push({ toolCallId, ...details });
			output.observe(
				{
					type: "tool_execution_end",
					toolCallId,
					toolName: "edit",
					isError: false,
					result: {
						content: [{ type: "text", text: `[result.txt#ABCD]\n1:updated_${i}` }],
						details,
					},
				},
				Date.now(),
			);
			if (i === 1) expect(h.previewView()).toEqual(original);
			else expect(h.previewView()).toMatchObject(earlier);
		}
		output.restore(output.snapshot(), false);
		expect(h.previewView()).toMatchObject(earlier);

		diffRows = 0;
		expect(h.previewView()).toMatchObject({
			body: ["[result.txt#ABCD]", "1:updated_2"],
			nativeBody: ["[result.txt#ABCD]", "1:updated_2"],
		});
		diffRows = 6;
		vi.advanceTimersByTime(2499);
		expect(h.previewView()).toMatchObject(earlier);
		vi.advanceTimersByTime(1);
		expect(h.outputRows()).toEqual([[], []]);

		const toolCallId = "write-same-path";
		output.observe({ type: "tool_execution_start", toolCallId, toolName: "write", args: { path: file } }, Date.now());
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
		expect(h.previewView()).toMatchObject({
			body: ["Successfully wrote 2 bytes to result.txt"],
			nativeBody: ["Successfully wrote 2 bytes to result.txt"],
		});
		vi.advanceTimersByTime(3000);
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
		expect(view.head).toContain("Running · bash · echo first");
		expect(view.body).toEqual(["first output"]);
		expect(view.nativeHead).toContain("Running · bash · echo first");
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
			expect(view.head).toContain("Running · bash · bg_1");
			expect(view.body).toEqual([`tick ${second}`]);
			expect(view.nativeHead).toContain("Running · bash · bg_1");
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
		const rows = [" Running · bash · echo aligned", " 根节点", "   child 42"];
		expect(view.ansi).toEqual(rows);
		expect(h.outputRows()[1]).toEqual(rows);
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
			head: "Failed · read · actual.txt",
			nativeHead: "Failed · read · actual.txt",
			body: ["retained body"],
			nativeBody: ["retained body"],
		});
		update("later", { content: [{ type: "text", text: "new source" }] });
		start("stale", "stale.txt", 1);
		update("stale", { content: [{ type: "text", text: "late output" }] });
		expect(h.previewView().body).toEqual(["new source"]);
	});

	it("retains Bash async facts after an empty terminal frame and rejects late startup receipts", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const output = new LiveToolOutputState();
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("AsyncOutput", live);
		await h.focus.focusAgent("AsyncOutput");
		output.observe(
			{ type: "tool_execution_start", toolCallId: "job", toolName: "bash", args: { command: "echo active" } },
			10_000,
		);
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "bash",
				args: {},
				partialResult: {
					content: [
						{
							type: "text",
							text: `Error: failed at step 2\n\n${formatBackgroundNotice("bg_1", 300, "incoming message")}`,
						},
					],
					details: { async: { name: "Build", jobId: "bg_1", state: "running" } },
				},
			},
			10_000,
		);
		const startupReceipt: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "job",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "older buffered output" }],
				details: { async: { jobId: "bg_1", state: "running" } },
			},
			isError: false,
		};
		output.observe(startupReceipt, 10_000);
		expect(h.previewView().body).toEqual(["Error: failed at step 2"]);
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "bash",
				args: {},
				partialResult: {
					content: [{ type: "text", text: "{}" }],
					details: { async: { state: "failed" } },
				},
			},
			10_001,
		);
		output.restore(output.snapshot(), false);
		output.observe(startupReceipt, 10_002);
		expect(output.preview()?.call.terminalAt).toBe(10_001);
		const view = h.previewView();
		expect(view.head).toBe("Failed · bash · bg_1 · echo active");
		expect(view.nativeHead).toBe(view.head);
		expect(view.body).toEqual(["Error: failed at step 2"]);
		expect(view.nativeBody).toEqual(view.body);
	});

	it("renormalizes a retained body when later Bash metadata identifies its startup notice", async () => {
		setSystemTime(10_000);
		const h = focusFixture();
		const live = liveSession();
		const output = new LiveToolOutputState();
		vi.spyOn(live.session, "getLiveToolOutputPreview").mockImplementation(() => output.preview());
		h.register("LateBashFacts", live);
		await h.focus.focusAgent("LateBashFacts");
		output.observe({ type: "tool_execution_start", toolCallId: "job", toolName: "bash", args: {} }, 10_000);
		const notice = formatBackgroundNotice("bg_1", undefined);
		output.observe(
			{
				type: "tool_execution_update",
				toolCallId: "job",
				toolName: "bash",
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
				toolName: "bash",
				args: {},
				partialResult: {
					content: [],
					details: {
						async: { jobId: "bg_1", state: "running" },
					},
				},
			},
			10_001,
		);
		const visible = h.previewView();
		expect(visible.head).toContain("Running · bash · bg_1");
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
		expect(view.head).toContain("Running · read · second.txt");
		expect(view.body).toEqual(["second body"]);
		expect(view.nativeHead).toContain("Running · read · second.txt");
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
		expect(running.head).toContain("Running · grep");
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
		expect(terminal.head).toContain("Done · grep");
		expect(terminal.body).toEqual([
			"# src/",
			"*12│alpha hit one",
			"*14│alpha hit two",
			"*16│alpha hit three",
			"*17│alpha hit four",
		]);
		expect(terminal.nativeBody).toEqual(terminal.body);
	});

	it("prioritizes glob and sole Bash grep hits but keeps mixed shell output in shell order", async () => {
		const h = focusFixture();
		const live = liveSession();
		const globText = ["# src/", "a.ts", "## sub/", "b.ts", "c.ts", "d.ts", "e.ts"].join("\n");
		const glob = outputCall("glob", 1, globText, {
			toolName: "glob",
			args: { pattern: "**/*.ts" },
			terminalAt: Date.now(),
		});
		const wrapped = outputCall("wrapped", 2, "# src/\n 10│context\n*12│wrapped hit\n 13│context after", {
			args: { command: "grep --pattern wrapped" },
			result: {
				content: [{ type: "text", text: "# src/\n 10│context\n*12│wrapped hit\n 13│context after" }],
				details: { toolCommands: [{ tool: "grep", mode: "execute", exitCode: 0, inner: { matchCount: 1 } }] },
			},
			terminalAt: Date.now(),
		});
		const source = vi.spyOn(live.session, "getLiveToolOutputPreview").mockReturnValue(previewFixture(glob));
		h.register("GlobOutput", live);
		await h.focus.focusAgent("GlobOutput");
		const globView = h.previewView();
		expect(globView.head).toContain("Done · glob");
		expect(globView.body).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
		expect(globView.nativeBody).toEqual(globView.body);
		source.mockReturnValue(previewFixture(wrapped));
		const wrappedView = h.previewView();
		expect(wrappedView.head).toContain("bash (grep)");
		expect(wrappedView.body).toEqual(["# src/", " 10│context", "*12│wrapped hit", " 13│context after"]);
		expect(wrappedView.nativeBody).toEqual(wrappedView.body);
		const mixed = { ...wrapped, args: { command: "grep --pattern wrapped | cat" } };
		source.mockReturnValue(previewFixture(mixed));
		const mixedView = h.previewView();
		expect(mixedView.head).toContain("bash · grep --pattern wrapped | cat");
		expect(mixedView.body).toEqual(["# src/", " 10│context", "*12│wrapped hit", " 13│context after"]);
		expect(mixedView.nativeBody).toEqual(mixedView.body);
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
		expect(failedView.head).toContain("Failed · bash");
		expect(failedView.body).toEqual(["Error: boom at step 2", "line five", "line six", "line seven", "line eight"]);
		expect(failedView.nativeBody).toEqual(failedView.body);
		const [, diagnostic, context] = h.output.render(120);
		expect(diagnostic).toContain(currentTheme().style("error strong", "Error: boom at step 2"));
		expect(context).toContain(currentTheme().fg("toolOutput", "line five"));
		output.restore([failed, empty], false);
		const emptyView = h.previewView();
		expect(emptyView.head).toContain("Done · grep");
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
		expect(view.head).toContain("Running · bash · rg -n");
		expect(view.head).toContain("…");
		expect(view.head).toContain("styles.css");
		expect(Bun.stringWidth(view.ansi[0]!)).toBeLessThanOrEqual(60);
		expect(view.nativeHead).toContain("Running · bash · rg -n");
		expect(h.output.compactActivity(60)).toMatchObject({ callId: "long", commandVisible: true });
		const narrow = h.previewView(17);
		expect(narrow.head).toBe("Running · bash");
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
			for (const rows of h.outputRows()) expect(rows.join("\n")).toContain("worker result");
			vi.advanceTimersByTime(1);
			expect(h.outputRows()).toEqual([[], []]);
		},
	);
});
