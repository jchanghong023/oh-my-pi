import type { ToolCall } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { registerSpinnerBlock, unregisterSpinnerBlock } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { col, elapsed, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { describeShimmer, type ShimmerPalette, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import { collectPendingToolCalls, TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import { decodeStreamedToolArgs } from "./controllers/tool-args-reveal";
import type { InteractiveModeContext } from "./types";

const EMPTY_ROWS: readonly string[] = ["", ""];
const THINKING_SHIMMER_PALETTE: ShimmerPalette = { low: "dim", mid: "muted", high: "success", bold: true };
type Call = { id: string; name: string; detail: string; intent?: string; startedAt?: number; endedAt?: number };
type ToolRow = { id: string; name: string; detail: string; duration?: number; preparing?: boolean };
type Snapshot = { kind: "thinking"; rows: readonly string[] } | { kind: "tool"; rows: ToolRow[] };
type SessionMemory = {
	calls: Call[];
	snapshot?: Snapshot;
	latestStart?: number;
	undisplayedDispatch?: boolean;
	turnDispatched?: boolean;
};

// One bounded projection per viewed logical session; never persisted or reconstructed from ended calls.
const memories = new Map<string, SessionMemory>();

function clean(value: string): string {
	return replaceTabs(sanitizeText(plainText(value))).replace(/[\r\n]+/g, " ");
}

function summary(args: unknown, intent?: unknown): string {
	const fields = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	const choices = [
		intent,
		fields.i,
		fields.intent,
		fields.title,
		fields.command,
		fields.path,
		fields.target,
		fields.url,
		fields.query,
		fields.pattern,
	];
	if (typeof fields.path === "string" && fields.path.startsWith("xd://") && typeof fields.content === "string") {
		try {
			const inner: unknown = JSON.parse(fields.content);
			if (inner && typeof inner === "object" && !Array.isArray(inner)) {
				const payload = inner as Record<string, unknown>;
				choices.splice(4, 0, payload.i, payload.intent, payload.title, payload.command);
				choices.push(payload.path, payload.target, payload.url, payload.query);
			}
		} catch {
			// Partial arguments may not yet contain a complete device payload.
		}
	}
	const value = choices.find(item => typeof item === "string" && item.trim());
	return typeof value === "string" ? value : "";
}

function streamedArgs(block: ToolCall): unknown {
	const partial = getStreamingPartialJson(block);
	return partial === undefined
		? block.arguments
		: decodeStreamedToolArgs(partial, { rawInput: block.customWireName !== undefined });
}

function duration(call: Call, now: number): number | undefined {
	return call.startedAt === undefined ? undefined : Math.max(0, (call.endedAt ?? now) - call.startedAt);
}

/** Fit one call independently, reserving the duration before truncating its description. */
function toolLine(item: ToolRow, width: number, historical: boolean): { body: string; suffix: string } {
	const identity = clean(item.name);
	const prefix = !historical && item.preparing ? `${identity} · 准备中` : identity;
	const suffix = item.duration === undefined ? "" : ` · ${formatDuration(item.duration)}`;
	if (visibleWidth(prefix) + visibleWidth(suffix) >= width) {
		if (visibleWidth(suffix) >= width) return { body: truncateToWidth(prefix + suffix, width), suffix: "" };
		return { body: truncateToWidth(prefix, width - visibleWidth(suffix)), suffix };
	}
	const detail = clean(item.detail).trim();
	const available = width - visibleWidth(prefix) - visibleWidth(suffix);
	const body = detail && available > 3 ? `${prefix} · ${truncateToWidth(detail, available - 3)}` : prefix;
	return { body, suffix };
}

/** Composer-only projection of actual dispatches and the last displayed content. */
export class CompactThinkingPreview implements Component {
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#memory?: SessionMemory;
	#nativeRows: { body: string; suffix: string; duration?: number; running: boolean }[] = [];
	#workingActive = false;

	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"viewSession" | "effectiveHideThinkingBlock" | "proseOnlyThinking" | "statusLine"
		> &
			Partial<Pick<InteractiveModeContext, "ui">>,
	) {}

	clear(): void {
		const snapshot = this.#memory?.snapshot;
		if (snapshot?.kind === "tool" && this.#session) {
			const now = Date.now();
			for (const item of snapshot.rows) {
				const call = this.#memory!.calls.find(candidate => candidate.id === item.id);
				if (call && (call.endedAt !== undefined || this.#session.agent.state.pendingToolCalls.has(call.id))) {
					item.duration = duration(call, now);
				}
			}
		}
		unregisterSpinnerBlock(this);
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#memory = undefined;
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
			memory = { calls: [] };
			memories.set(id, memory);
		}
		this.#memory = memory;
		const pending = session.agent.state.pendingToolCalls;
		if (!pending.size) return;
		const branch = session.sessionManager.getBranch();
		const diagnostics = collectPendingToolCalls(branch);
		const existing = memory.calls.length > 0;
		const markerIndex = (id: string): number =>
			branch.findLastIndex(
				entry =>
					entry.type === "custom" &&
					entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE &&
					!!entry.data &&
					typeof entry.data === "object" &&
					"toolCallId" in entry.data &&
					entry.data.toolCallId === id,
			);
		const cutoff = Math.max(-1, ...memory.calls.map(call => markerIndex(call.id)));
		const stream = session.agent.state.streamMessage;
		const messages = stream ? [...session.agent.state.messages, stream] : session.agent.state.messages;
		for (const id of pending) {
			if (memory.calls.some(call => call.id === id)) continue;
			const diagnostic = diagnostics.find(item => item.toolCallId === id);
			const index = markerIndex(id);
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
				block = message.content.find((item): item is ToolCall => item.type === "toolCall" && item.id === id);
			}
			const update = session.activeToolExecutionUpdates().find(item => item.toolCallId === id);
			const name =
				block?.name ??
				diagnostic?.toolName ??
				(typeof marker?.toolName === "string" ? marker.toolName : undefined) ??
				update?.toolName;
			if (!name) continue;
			const args = block ? streamedArgs(block) : (diagnostic?.args ?? marker?.args ?? update?.args);
			const intent = diagnostic?.intent ?? (typeof marker?.intent === "string" ? marker.intent : undefined);
			this.#appendCall({ id, name, detail: summary(args, intent), intent, startedAt });
		}
	}

	#appendCall(call: Call): void {
		const memory = this.#memory!;
		memory.calls.push(call);
		if (memory.calls.length > 2) memory.calls.shift();
		if (call.startedAt !== undefined)
			memory.latestStart = Math.max(memory.latestStart ?? call.startedAt, call.startedAt);
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
		if (event.type === "turn_start") {
			memory.turnDispatched = false;
		} else if (event.type === "tool_execution_start") {
			memory.turnDispatched = true;
			const call = calls.find(item => item.id === event.toolCallId);
			if (call) {
				call.name = event.toolName;
				call.intent = event.intent;
				call.detail = summary(event.args, event.intent);
				call.startedAt ??= now;
			} else {
				this.#appendCall({
					id: event.toolCallId,
					name: event.toolName,
					detail: summary(event.args, event.intent),
					intent: event.intent,
					startedAt: now,
				});
			}
			memory.undisplayedDispatch = true;
		} else if (event.type === "tool_execution_end") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call && call.endedAt === undefined) call.endedAt = now;
		} else if (event.type === "tool_execution_update") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call && call.endedAt === undefined) {
				const detail = summary(event.args, call.intent);
				if (detail) call.detail = detail;
			}
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				const call = calls.find(item => item.id === block.id && item.endedAt === undefined);
				if (!call) continue;
				const detail = summary(streamedArgs(block), call.intent);
				if (detail) call.detail = detail;
			}
		}
	}

	/** Reuse the shared tool animation ticker for ANSI elapsed and thinking repaint. */
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

	#renderRows(width: number, paint: boolean): readonly string[] {
		this.#nativeRows = [];
		this.#workingActive = false;
		if (!displayPreferences.compactToolActivity) {
			this.clear();
			return [];
		}
		this.#syncSession();
		if (width < 1) return EMPTY_ROWS;
		const session = this.ctx.viewSession;
		const state = session.agent.state;
		this.#workingActive = this.ctx.statusLine.getTurnElapsedMs() !== null;
		const stream = state.streamMessage;
		const memory = this.#memory!;
		let thinkingRows: string[] | undefined;
		if (
			!this.ctx.effectiveHideThinkingBlock &&
			stream?.role === "assistant" &&
			state.activeThinkingIndex !== undefined
		) {
			const block = stream.content[state.activeThinkingIndex];
			if (block?.type === "thinking") {
				const formatted = formatThinkingForDisplay(block.thinking, this.ctx.proseOnlyThinking);
				if (hasDisplayableThinking(block.thinking, formatted)) {
					// Only visible, nonblank display rows may replace previously displayed activity.
					const rows = wrapTextWithAnsi(replaceTabs(sanitizeText(plainText(formatted))), width)
						.filter(row => row.trim().length > 0)
						.slice(-2);
					if (rows.length > 0) thinkingRows = rows;
				}
			}
		}
		const now = Date.now();
		const running = (call: Call) => call.endedAt === undefined && state.pendingToolCalls.has(call.id);
		const displayDuration = (call: Call): number | undefined => {
			if (running(call) || call.endedAt !== undefined) return duration(call, now);
			return memory.snapshot?.kind === "tool"
				? memory.snapshot.rows.find(item => item.id === call.id)?.duration
				: undefined;
		};
		const activeCalls = memory.calls.some(running);
		let rows: string[];
		if (thinkingRows) {
			rows = thinkingRows;
			while (rows.length < 2) rows.push("");
			memory.snapshot = { kind: "thinking", rows: [...rows] };
			memory.undisplayedDispatch = false;
		} else if (activeCalls) {
			const items = memory.calls.map(call => ({
				id: call.id,
				name: call.name,
				detail: call.detail,
				duration: displayDuration(call),
			}));
			memory.snapshot = { kind: "tool", rows: items.map(item => ({ ...item })) };
			memory.undisplayedDispatch = false;
			this.#nativeRows = items.map((item, index) => ({
				...toolLine(item, width, false),
				duration: item.duration,
				running: running(memory.calls[index]!),
			}));
			rows = this.#nativeRows.map(item => item.body + item.suffix);
		} else if (
			!memory.turnDispatched &&
			session.isStreaming &&
			stream?.role === "assistant" &&
			stream.content.some(block => block.type === "toolCall" && !memory.calls.some(call => call.id === block.id))
		) {
			const block = stream.content.findLast(
				(item): item is ToolCall => item.type === "toolCall" && !memory.calls.some(call => call.id === item.id),
			)!;
			const item: ToolRow = {
				id: block.id,
				name: block.name,
				detail: summary(streamedArgs(block)),
				preparing: true,
			};
			memory.snapshot = { kind: "tool", rows: [{ ...item }] };
			this.#nativeRows = [{ ...toolLine(item, width, false), running: true }];
			rows = [this.#nativeRows[0]!.body, ""];
		} else {
			if (memory.undisplayedDispatch) {
				memory.snapshot = {
					kind: "tool",
					rows: memory.calls.map(call => ({
						id: call.id,
						name: call.name,
						detail: call.detail,
						duration: displayDuration(call),
					})),
				};
				memory.undisplayedDispatch = false;
			}
			const snapshot = memory.snapshot;
			if (!snapshot || (snapshot.kind === "thinking" && this.ctx.effectiveHideThinkingBlock)) rows = [...EMPTY_ROWS];
			else if (snapshot.kind === "thinking")
				rows = [truncateToWidth(snapshot.rows[0] ?? "", width), truncateToWidth(snapshot.rows[1] ?? "", width)];
			else {
				for (const item of snapshot.rows) {
					const call = memory.calls.find(candidate => candidate.id === item.id && candidate.endedAt !== undefined);
					if (call) item.duration = duration(call, now);
				}
				this.#nativeRows = snapshot.rows.map(item => ({
					...toolLine(item, width, true),
					duration: item.duration,
					running: false,
				}));
				rows = this.#nativeRows.map(item => item.body + item.suffix);
			}
		}
		while (rows.length < 2) rows.push("");
		const needsTick =
			!isNativeRendering() &&
			!!this.ctx.ui &&
			(activeCalls || (this.#workingActive && rows.some(Boolean) && shimmerEnabled()));
		if (needsTick) registerSpinnerBlock(this);
		else unregisterSpinnerBlock(this);
		if (!paint) return rows;
		if (!this.#workingActive) return rows.map(value => (value ? theme.fg("dim", value) : value));
		if (!shimmerEnabled()) return rows;
		return rows.map(value => (value ? shimmerText(value, theme, THINKING_SHIMMER_PALETTE) : value));
	}

	describe(cx: DescribeContext): NativeNode {
		const rows = this.#layoutRows(cx.cols, false);
		if (this.#nativeRows.length) {
			const inset = padding(Math.min(getPaddingX(1), Math.max(0, cx.cols - 1)));
			const children = this.#nativeRows.map(item => {
				const body = inset + item.body;
				const label =
					this.#workingActive && shimmerEnabled() && !cx.reduceMotion && cx.supports("shimmer")
						? describeShimmer([{ text: body, palette: THINKING_SHIMMER_PALETTE }])
						: this.#workingActive
							? text(body)
							: text([span(body, "dim")]);
				if (!item.suffix || item.duration === undefined) return label;
				const timer = elapsed(item.duration, !item.running);
				return this.#workingActive
					? row([label, text(" · "), timer])
					: row([label, text([span(" · ", "dim")]), node(timer.k, { ...timer.p, tone: "muted" }, timer.c)]);
			});
			while (children.length < 3) children.push(node("rows", { cols: cx.cols, lines: [""] }));
			return col(children);
		}
		if (!this.#workingActive) {
			return col(
				rows.map(value => (value ? text([span(value, "dim")]) : node("rows", { cols: cx.cols, lines: [""] }))),
			);
		}
		if (!shimmerEnabled() || cx.reduceMotion || !cx.supports("shimmer")) {
			return { k: "rows", p: { cols: cx.cols, lines: rows } };
		}
		return col(
			rows.map(value =>
				value
					? describeShimmer([{ text: value, palette: THINKING_SHIMMER_PALETTE }])
					: node("rows", { cols: cx.cols, lines: [""] }),
			),
		);
	}
}
