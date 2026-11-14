import type { ToolCall } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { registerSpinnerBlock, unregisterSpinnerBlock } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { col, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { replaceTabs, truncateMiddleToWidth, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { describeShimmer, type ShimmerPalette, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { type CoordinationDetails, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { isXdHelpContent, parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import { collectPendingToolCalls, TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import { summarizeCompactTool } from "./compact-tool-summary";
import { decodeStreamedToolArgs } from "./controllers/tool-args-reveal";
import type { InteractiveModeContext } from "./types";

const EMPTY_ROWS: readonly string[] = ["", ""];
/** Same sweep style and palette as the previous whole-row dock animation. */
const ACTION_SHIMMER_PALETTE: ShimmerPalette = { low: "dim", mid: "muted", high: "success", bold: true };
/** Four CJK characters occupy eight terminal columns; the detail starts two spaces later. */
const ACTION_WIDTH = 8;
const ACTION_GAP = "  ";

type ActionCategory = "thinking" | "read" | "exec" | "write" | "call";
type ActionState = "running" | "done" | "failed";

const ACTION_WORDS: Record<ActionCategory, Record<ActionState, string>> = {
	thinking: { running: "正在思考", done: "思考完成", failed: "思考失败" },
	read: { running: "正在读取", done: "读取完成", failed: "读取失败" },
	exec: { running: "正在执行", done: "执行完成", failed: "执行失败" },
	write: { running: "正在写入", done: "写入完成", failed: "写入失败" },
	call: { running: "正在调用", done: "调用完成", failed: "调用失败" },
};

type Call = {
	id: string;
	name: string;
	detail: string;
	semanticName?: string;
	waitTarget?: string;
	command?: string;
	intent?: string;
	startedAt?: number;
	endedAt?: number;
	failed?: boolean;
};
type Action = {
	id: string;
	category: ActionCategory;
	running: boolean;
	failed: boolean;
	detail: string;
	isPath: boolean;
	startedAt?: number;
};
type SessionMemory = {
	calls: Call[];
	/** Thinking phases keyed by content index; one record per independent phase. */
	thinking: Map<number, { startedAt: number; endedAt?: number; failed?: boolean; text: string }>;
	/** Arrival order of action ids; the earliest undisplayed runner fills a vacancy. */
	order: string[];
	/** Persistent two-slot layout (top, bottom); running actions keep their slot. */
	slots: [string | undefined, string | undefined];
	snapshot?: Action[];
	latestStart?: number;
};

// One bounded projection per viewed logical session; never persisted or reconstructed from ended calls.
const memories = new Map<string, SessionMemory>();

function clean(value: string): string {
	return replaceTabs(sanitizeText(plainText(value))).replace(/[\r\n]+/g, " ");
}

function fields(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Project the transport and its structured result without exposing payload or output text. */
function updateCall(call: Call, args?: unknown, result?: ToolRenderResult<unknown>): void {
	const outer = fields(args);
	const dispatch = fields(fields(result?.details).xdev);
	const path = typeof outer.path === "string" ? outer.path : undefined;
	const device = call.name === "write" && path ? parseXdUrl(unwrapHashlineHeaderPath(path)) : null;
	const help = (typeof outer.content === "string" && isXdHelpContent(outer.content)) || dispatch.mode === "help";
	const deviceName =
		device?.name ??
		(typeof dispatch.tool === "string" ? dispatch.tool : undefined) ??
		(path === undefined && call.semanticName !== call.name ? call.semanticName : undefined);
	const wrapped = call.name === "write" && !!deviceName && !help;
	const semanticName = wrapped ? deviceName! : call.name;
	const identityChanged = call.semanticName !== undefined && call.semanticName !== semanticName;
	if (identityChanged) {
		call.detail = "";
		call.command = undefined;
		call.waitTarget = undefined;
	}
	call.semanticName = semanticName;
	let effectiveArgs: unknown = args;
	let effectiveResult = result;
	if (wrapped) {
		const decoded =
			typeof outer.content === "string" && outer.content.length
				? decodeStreamedToolArgs(outer.content, { rawInput: false })
				: undefined;
		// Both sources belong only to this event; retain the resulting display facts, not their payloads.
		effectiveArgs = { ...fields(decoded), ...fields(dispatch.args) };
		effectiveResult = result ? { ...result, details: dispatch.inner } : undefined;
	}
	const target = waitTarget(semanticName, effectiveResult as ToolRenderResult<CoordinationDetails> | undefined);
	if (target) call.waitTarget = target;
	call.intent = [call.intent, outer.i, outer.intent, outer.title].find(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	if (
		!Object.keys(fields(effectiveArgs)).length &&
		!target &&
		!identityChanged &&
		(call.detail || call.command || (!path && !call.intent))
	)
		return;
	const detail = summarizeCompactTool(
		semanticName,
		effectiveArgs,
		call.intent,
		semanticName === "wait" ? call.waitTarget : undefined,
	);
	if (wrapped && !detail.detail && !detail.command && !call.detail && !call.command && path) detail.detail = path;
	if (detail.detail || detail.command) {
		call.detail = detail.detail;
		if (detail.command) call.command = detail.command;
	}
}

/** Share request-side identity and target projection without reusing an activity component. */
export function compactToolPreviewInfo(
	name: string,
	args: unknown,
	intent?: string,
	result?: ToolRenderResult<unknown>,
): { name: string; detail: string; command?: string } {
	const call: Call = { id: "", name, detail: "", intent };
	updateCall(call, args, result);
	return {
		name: call.semanticName && call.semanticName !== name ? `${name} (${call.semanticName})` : name,
		detail: call.detail,
		command: call.command,
	};
}

function waitTarget(name: string, result?: ToolRenderResult<CoordinationDetails>): string | undefined {
	if (name !== "wait" || !Array.isArray(result?.details?.jobs) || !result.details.jobs.length) return undefined;
	return waitToolRenderer.activitySummary({}, { expanded: false, isPartial: true, result }).detail;
}

function streamedArgs(block: ToolCall): unknown {
	const partial = getStreamingPartialJson(block);
	return partial === undefined
		? block.arguments
		: decodeStreamedToolArgs(partial, { rawInput: block.customWireName !== undefined });
}

function categoryOf(semanticName: string): ActionCategory {
	switch (semanticName) {
		case "read":
			return "read";
		case "bash":
			return "exec";
		case "write":
		case "edit":
		case "apply_patch":
		case "ast_edit":
			return "write";
		default:
			return "call";
	}
}

/** One-line detail for a tool action: command text, or a target summary, or the real tool name. */
function toolDetail(call: Call): { detail: string; isPath: boolean } {
	const category = categoryOf(call.semanticName ?? call.name);
	if (call.command) return { detail: clean(call.command), isPath: false };
	const target = clean(call.detail).trim();
	if (category === "read" || category === "write") {
		return { detail: target || call.name, isPath: true };
	}
	if (category === "exec") return { detail: target || call.name, isPath: false };
	// Unmapped tools must name themselves AND keep the short parameter summary; never mislabel them.
	const name =
		call.semanticName && call.semanticName !== call.name ? `${call.name} (${call.semanticName})` : call.name;
	return { detail: target ? `${name} ${target}` : name, isPath: false };
}

function thinkingSeconds(ms: number): string {
	return ms < 100 ? "用时 <0.1 秒" : `用时 ${(ms / 1000).toFixed(1)} 秒`;
}

/** Latest non-blank display line of the real thinking fragment; empty when none is displayable. */
function thinkingDetail(text: string, proseOnly: boolean): string {
	const formatted = formatThinkingForDisplay(text, proseOnly);
	if (!hasDisplayableThinking(text, formatted)) return "";
	const lines = formatted
		.split(/\r?\n/)
		.map(line => clean(line).trim())
		.filter(line => line.length > 0);
	return lines.at(-1) ?? "";
}

/** Composer-only projection of action records and the last displayed content. */
export class CompactThinkingPreview implements Component {
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#memory?: SessionMemory;
	#rows: (Action | undefined)[] = [];

	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"viewSession" | "effectiveHideThinkingBlock" | "proseOnlyThinking"
		> &
			Partial<Pick<InteractiveModeContext, "ui">>,
	) {}

	clear(): void {
		unregisterSpinnerBlock(this);
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#memory = undefined;
		this.#rows = [];
	}

	#syncSession(): void {
		const session = this.ctx.viewSession;
		const id = session.sessionManager.getSessionId();
		if (this.#session === session && this.#sessionId === id) return;
		this.clear();
		this.#session = session;
		this.#sessionId = id;
		let memory = memories.get(id);
		if (!memory) {
			memory = { calls: [], thinking: new Map(), order: [], slots: [undefined, undefined] };
			memories.set(id, memory);
		}
		this.#memory = memory;
		const pending = session.agent.state.pendingToolCalls;
		if (!pending.size) return;
		const branch = session.sessionManager.getBranch();
		const diagnostics = collectPendingToolCalls(branch);
		const existing = memory.calls.length > 0;
		const markerIndex = (callId: string): number =>
			branch.findLastIndex(
				entry =>
					entry.type === "custom" &&
					entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE &&
					!!entry.data &&
					typeof entry.data === "object" &&
					"toolCallId" in entry.data &&
					entry.data.toolCallId === callId,
			);
		const cutoff = Math.max(-1, ...memory.calls.map(call => markerIndex(call.id)));
		const stream = session.agent.state.streamMessage;
		const messages = stream ? [...session.agent.state.messages, stream] : session.agent.state.messages;
		for (const callId of pending) {
			if (memory.calls.some(call => call.id === callId)) continue;
			const diagnostic = diagnostics.find(item => item.toolCallId === callId);
			const index = markerIndex(callId);
			const entry = branch[index];
			const marker =
				entry?.type === "custom" && entry.data && typeof entry.data === "object"
					? (entry.data as Record<string, unknown>)
					: undefined;
			const timestamp =
				diagnostic?.startedAt ?? (typeof marker?.startedAt === "string" ? marker.startedAt : entry?.timestamp);
			const parsed = timestamp ? Date.parse(timestamp) : NaN;
			const startedAt = Number.isFinite(parsed) ? parsed : undefined;
			if (
				existing &&
				(index < 0 ||
					(cutoff >= 0
						? index <= cutoff
						: startedAt === undefined || (memory.latestStart !== undefined && startedAt <= memory.latestStart)))
			)
				continue;
			let block: ToolCall | undefined;
			for (let index = messages.length - 1; index >= 0 && !block; index--) {
				const message = messages[index];
				if (message?.role !== "assistant") continue;
				block = message.content.find((item): item is ToolCall => item.type === "toolCall" && item.id === callId);
			}
			const update = session.activeToolExecutionUpdates().find(item => item.toolCallId === callId);
			const name =
				block?.name ??
				diagnostic?.toolName ??
				(typeof marker?.toolName === "string" ? marker.toolName : undefined) ??
				update?.toolName;
			if (!name) continue;
			const args = block ? streamedArgs(block) : (diagnostic?.args ?? marker?.args ?? update?.args);
			const intent = diagnostic?.intent ?? (typeof marker?.intent === "string" ? marker.intent : undefined);
			const call: Call = { id: callId, name, detail: "", intent, startedAt };
			updateCall(call, args);
			if (update) updateCall(call, update.args, update.partialResult);
			this.#appendCall(call);
		}
	}

	#appendCall(call: Call): void {
		const memory = this.#memory!;
		memory.calls.push(call);
		// Bound the record set; the visible two slots are chosen by running-first selection.
		if (memory.calls.length > 16) memory.calls.shift();
		memory.order.push(call.id);
		if (call.startedAt !== undefined)
			memory.latestStart = Math.max(memory.latestStart ?? call.startedAt, call.startedAt);
	}

	#thinkingId(contentIndex: number): string {
		return `thinking:${contentIndex}`;
	}

	#startThinking(contentIndex: number, now: number): void {
		const memory = this.#memory!;
		if (memory.thinking.has(contentIndex)) return;
		memory.thinking.set(contentIndex, { startedAt: now, text: "" });
		memory.order.push(this.#thinkingId(contentIndex));
	}

	#endThinking(contentIndex: number, now: number, failed: boolean): void {
		const memory = this.#memory!;
		const phase = memory.thinking.get(contentIndex);
		if (!phase || phase.endedAt !== undefined) return;
		phase.endedAt = now;
		phase.failed = failed;
	}

	observe(event: AgentSessionEvent): void {
		if (!displayPreferences.compactToolActivity) {
			this.clear();
			return;
		}
		const now = Date.now();
		this.#syncSession();
		const memory = this.#memory!;
		const calls = memory.calls;
		if (event.type === "tool_execution_start") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call) {
				call.name = event.toolName;
				call.intent = event.intent ?? call.intent;
				updateCall(call, event.args);
				call.startedAt ??= now;
			} else {
				const next: Call = {
					id: event.toolCallId,
					name: event.toolName,
					detail: "",
					intent: event.intent,
					startedAt: now,
				};
				updateCall(next, event.args);
				this.#appendCall(next);
			}
		} else if (event.type === "tool_execution_end") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call && call.endedAt === undefined) {
				updateCall(call, undefined, event.result);
				call.endedAt = now;
				call.failed = event.isError === true || event.result?.isError === true;
			}
		} else if (event.type === "tool_execution_update") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call && call.endedAt === undefined) updateCall(call, event.args, event.partialResult);
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			const delta = event.assistantMessageEvent;
			if (delta.type === "thinking_start") {
				this.#startThinking(delta.contentIndex, now);
			} else if (delta.type === "thinking_delta") {
				this.#startThinking(delta.contentIndex, now);
				const phase = memory.thinking.get(delta.contentIndex);
				if (phase && phase.endedAt === undefined) {
					const block = event.message.content[delta.contentIndex];
					if (block?.type === "thinking") phase.text = block.thinking;
				}
			} else if (delta.type === "thinking_end") {
				this.#startThinking(delta.contentIndex, now);
				this.#endThinking(delta.contentIndex, now, false);
			} else if (delta.type === "error") {
				for (const [index, phase] of memory.thinking) {
					if (phase.endedAt === undefined) this.#endThinking(index, now, delta.reason === "error");
				}
			}
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				const call = calls.find(item => item.id === block.id && item.endedAt === undefined);
				if (!call) continue;
				updateCall(call, streamedArgs(block));
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			// A stream that ends without thinking_end (abort/error) still settles its open phase.
			const failed = event.message.stopReason === "error";
			for (const [index, phase] of memory.thinking) {
				if (phase.endedAt === undefined) this.#endThinking(index, now, failed);
			}
		}
	}

	/** Reuse the shared tool animation ticker; only visible running actions drive repaints. */
	tickSpinner(_frame: number): void {
		this.ctx.ui?.requestComponentRender(this);
	}

	render(width: number): readonly string[] {
		return this.#layoutRows(width, true);
	}

	#layoutRows(width: number, paint: boolean): readonly string[] {
		const inset = Math.min(getPaddingX(1), Math.max(0, width - 1));
		const rows = this.#renderRows(width - inset, paint);
		if (!rows.length) return rows;
		const left = padding(inset);
		return [rows[0] ? left + rows[0] : "", rows[1] ? left + rows[1] : "", ""];
	}

	/** Reconcile the active thinking phase from live state so focus restoration shows it without a fresh event. */
	#syncLiveThinking(): void {
		const memory = this.#memory!;
		const state = this.ctx.viewSession.agent.state;
		const stream = state.streamMessage;
		const index = state.activeThinkingIndex;
		if (stream?.role === "assistant" && index !== undefined) {
			const block = stream.content[index];
			if (block?.type === "thinking") {
				this.#startThinking(index, Date.now());
				const phase = memory.thinking.get(index);
				if (phase && phase.endedAt === undefined) phase.text = block.thinking;
			}
		}
	}

	/** Build the action records currently eligible for the two slots. */
	#actions(): Action[] {
		this.#syncLiveThinking();
		const memory = this.#memory!;
		const state = this.ctx.viewSession.agent.state;
		const hideThinking = this.ctx.effectiveHideThinkingBlock;
		const proseOnly = this.ctx.proseOnlyThinking;
		const actions: Action[] = [];
		for (const [index, phase] of memory.thinking) {
			if (hideThinking) continue;
			const running = phase.endedAt === undefined;
			const detail = running
				? thinkingDetail(phase.text, proseOnly)
				: thinkingSeconds(Math.max(0, (phase.endedAt ?? 0) - phase.startedAt));
			actions.push({
				id: this.#thinkingId(index),
				category: "thinking",
				running,
				failed: phase.failed === true,
				detail,
				isPath: false,
				startedAt: phase.startedAt,
			});
		}
		for (const call of memory.calls) {
			const running = call.endedAt === undefined && state.pendingToolCalls.has(call.id);
			const { detail, isPath } = toolDetail(call);
			actions.push({
				id: call.id,
				category: categoryOf(call.semanticName ?? call.name),
				running,
				failed: call.failed === true,
				detail,
				isPath,
				startedAt: call.startedAt,
			});
		}
		return actions;
	}

	/** Running-first selection with stable slots; at most two visible actions, no carousel. */
	#select(actions: Action[]): (Action | undefined)[] {
		const memory = this.#memory!;
		const byId = new Map(actions.map(action => [action.id, action]));
		memory.order = memory.order.filter(id => byId.has(id));
		for (const action of actions) if (!memory.order.includes(action.id)) memory.order.push(action.id);
		const slots = memory.slots;
		const held = (index: 0 | 1): Action | undefined => {
			const id = slots[index];
			return id === undefined ? undefined : byId.get(id);
		};
		const displayed = new Set(slots.filter((id): id is string => id !== undefined));
		const queuedRunner = (): Action | undefined => {
			for (const id of memory.order) {
				const action = byId.get(id);
				if (action?.running && !displayed.has(id)) return action;
			}
			return undefined;
		};
		const place = (index: 0 | 1, action: Action | undefined): void => {
			slots[index] = action?.id;
			if (action) displayed.add(action.id);
			else if (slots[index] !== undefined) displayed.delete(slots[index]!);
		};
		// A running action keeps its slot; vacancies fill bottom-first so the current runner stays below.
		for (const index of [1, 0] as const) {
			const current = held(index);
			if (current?.running) continue;
			const next = queuedRunner();
			if (next) place(index, next);
		}
		const runningCount = actions.filter(action => action.running).length;
		if (runningCount === 0) {
			// No runners: keep ended actions in place and fill remaining slots with the latest ended.
			const ended = memory.order.map(id => byId.get(id)!).filter(action => action && !action.running);
			for (const index of [1, 0] as const) {
				if (held(index)) continue;
				const candidate = [...ended].reverse().find(action => !displayed.has(action.id));
				if (candidate) place(index, candidate);
			}
		} else if (runningCount === 1) {
			// A lone serial runner sits on the bottom row; the latest ended action always takes the top.
			const runner = actions.find(action => action.running)!;
			if (held(0)?.running) place(0, undefined);
			if (!held(1)?.running) place(1, runner);
			const ended = memory.order.map(id => byId.get(id)!).filter(action => action && !action.running);
			const latest = ended.at(-1);
			if (latest && held(0)?.id !== latest.id) place(0, latest);
		}
		return [held(0), held(1)];
	}

	#renderRows(width: number, paint: boolean): readonly string[] {
		this.#rows = [];
		if (!displayPreferences.compactToolActivity) {
			this.clear();
			return [];
		}
		this.#syncSession();
		if (width < 1) return EMPTY_ROWS;
		const memory = this.#memory!;
		const slots = this.#select(this.#actions());
		const visible = slots.filter((action): action is Action => action !== undefined);
		if (visible.length > 0) memory.snapshot = visible.map(action => ({ ...action }));
		const animate = shimmerEnabled();
		const rows = slots.map(action => {
			this.#rows.push(action);
			if (!action) return "";
			const row = this.#buildRow(action, width);
			return this.#paintAnsi(row, paint && animate);
		});
		const needsTick = !isNativeRendering() && !!this.ctx.ui && animate && visible.some(action => action.running);
		if (needsTick) registerSpinnerBlock(this);
		else unregisterSpinnerBlock(this);
		return rows;
	}

	/** Fixed action area + two spaces + gray detail; the detail origin never moves on state change. */
	#buildRow(action: Action, width: number): { action: Action; word: string; detail: string; gap: string } {
		const full = ACTION_WORDS[action.category][action.running ? "running" : action.failed ? "failed" : "done"];
		// Normally the action area is eight columns; an extremely narrow terminal clips it safely too.
		const actionWidth = Math.min(ACTION_WIDTH, width);
		const word = truncateToWidth(full, actionWidth);
		const detailWidth = width - actionWidth - ACTION_GAP.length;
		let detail = "";
		if (detailWidth > 0 && action.detail) {
			detail = action.isPath
				? truncateMiddleToWidth(action.detail, detailWidth)
				: truncateToWidth(action.detail, detailWidth);
		}
		return { action, word, detail, gap: detail ? ACTION_GAP : "" };
	}

	#paintAnsi(row: { action: Action; word: string; detail: string; gap: string }, animate: boolean): string {
		const { action, word, detail, gap } = row;
		const paintedAction = action.running
			? animate
				? shimmerText(word, theme, ACTION_SHIMMER_PALETTE)
				: theme.fg("muted", word)
			: action.failed
				? theme.fg("error", word)
				: theme.fg("text", word);
		return paintedAction + gap + (detail ? theme.fg("dim", detail) : "");
	}

	describe(cx: DescribeContext): NativeNode {
		const inset = Math.min(getPaddingX(1), Math.max(0, cx.cols - 1));
		this.#renderRows(cx.cols - inset, false);
		const left = padding(inset);
		const animate = shimmerEnabled() && !cx.reduceMotion && cx.supports("shimmer");
		const children = this.#rows.map(action => {
			if (!action) return node("rows", { cols: cx.cols, lines: [""] });
			const built = this.#buildRow(action, cx.cols - inset);
			const label = action.running
				? animate
					? describeShimmer([{ text: built.word, palette: ACTION_SHIMMER_PALETTE }])
					: text([span(built.word, "muted")])
				: action.failed
					? text([span(built.word, "error")])
					: text([span(built.word, "text")]);
			const parts = built.detail
				? [text(left), label, text(built.gap), text([span(built.detail, "dim")])]
				: [text(left), label];
			return row(parts);
		});
		while (children.length < 2) children.push(node("rows", { cols: cx.cols, lines: [""] }));
		children.push(node("rows", { cols: cx.cols, lines: [""] }));
		return col(children);
	}
}
