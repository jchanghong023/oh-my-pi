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
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { describeShimmer, type ShimmerPalette, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { type CoordinationDetails, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { isXdHelpContent, parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import { lexShellCommand } from "../tools/shell-tokenize";
import { collectPendingToolCalls, TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import { summarizeCompactTool } from "./compact-tool-summary";
import { decodeStreamedToolArgs } from "./controllers/tool-args-reveal";
import type { InteractiveModeContext } from "./types";

const EMPTY_ROWS: readonly string[] = ["", ""];
const THINKING_SHIMMER_PALETTE: ShimmerPalette = { low: "dim", mid: "muted", high: "success", bold: true };
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
	backgroundJobId?: string;
};
type ToolRow = {
	id: string;
	name: string;
	semanticName?: string;
	detail: string;
	command?: string;
	duration?: number;
	preparing?: boolean;
	backgroundJobId?: string;
};
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

/** Keep shell spelling intact; only shorten flat command lists with an unambiguous boundary. */
function shellPreview(command: string): string {
	if (/[()`]/u.test(command) || /(?:^|\s)(?:for|while|until|if|case|select|function)\s/u.test(command)) return command;
	let offset = 0;
	for (const token of lexShellCommand(command)) {
		if (token.kind === "separator") {
			const operator = /&&|\|\||[;|&\n]/u.exec(token.raw);
			if (operator) {
				const index = offset + operator.index;
				if (command[index] === "&" && /[<>]/u.test(command[index - 1] ?? "")) {
					offset += token.raw.length;
					continue;
				}
				const first = command.slice(0, index).trimEnd();
				if (first && command.slice(index + operator[0].length).trim()) return `${first} ${operator[0]} …`;
			}
		}
		offset += token.raw.length;
	}
	return command;
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

function duration(call: Call, now: number): number | undefined {
	return call.startedAt === undefined ? undefined : Math.max(0, (call.endedAt ?? now) - call.startedAt);
}

/** Fit one call independently, reserving the duration before truncating its description. */
function toolLine(
	item: ToolRow,
	width: number,
	historical: boolean,
): { body: string; suffix: string; timerPrefix?: string } {
	const identity = clean(item.name);
	const prefix = !historical && item.preparing ? `${identity} · 准备中` : identity;
	const timerPrefix = item.backgroundJobId
		? ` · ${clean(item.backgroundJobId)} · 提交 `
		: (item.semanticName ?? item.name) === "wait"
			? " · 等待 "
			: " · ";
	const suffix = item.duration === undefined ? "" : `${timerPrefix}${formatDuration(item.duration)}`;
	if (visibleWidth(prefix) + visibleWidth(suffix) >= width) {
		if (visibleWidth(suffix) >= width) return { body: truncateToWidth(prefix + suffix, width), suffix: "" };
		return { body: truncateToWidth(prefix, width - visibleWidth(suffix)), suffix, timerPrefix };
	}
	const available = width - visibleWidth(prefix) - visibleWidth(suffix);
	let detail = clean(item.detail).trim();
	if (item.command) {
		const semanticName = item.semanticName ?? item.name;
		const shell = semanticName === "bash" || (semanticName === "wait" && item.command.startsWith("[bash] "));
		const raw = clean(shell ? shellPreview(item.command) : item.command).trim();
		const command = shell ? truncateToWidth(raw, TRUNCATE_LENGTHS.SHORT) : raw;
		const intentWidth = Math.min(TRUNCATE_LENGTHS.SHORT, Math.floor((available - 6) / 3));
		detail = detail && intentWidth > 0 ? `${truncateToWidth(detail, intentWidth)} · ${command}` : command;
	}
	const body = detail && available > 3 ? `${prefix} · ${truncateToWidth(detail, available - 3)}` : prefix;
	return { body, suffix, timerPrefix };
}

/** Composer-only projection of actual dispatches and the last displayed content. */
export class CompactThinkingPreview implements Component {
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#memory?: SessionMemory;
	#nativeRows: { body: string; suffix: string; timerPrefix?: string; duration?: number; running: boolean }[] = [];
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
			const call: Call = { id, name, detail: "", intent, startedAt };
			updateCall(call, args);
			if (update) updateCall(call, update.args, update.partialResult);
			this.#appendCall(call);
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
			memory.undisplayedDispatch = true;
		} else if (event.type === "tool_execution_end") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call && call.endedAt === undefined) {
				updateCall(call, undefined, event.result);
				call.endedAt = now;
				if (call.semanticName === "bash") {
					const details = fields(event.result.details);
					const inner = call.name === "write" ? fields(fields(details.xdev).inner) : details;
					const async = fields(inner.async);
					if (async.state === "running" && typeof async.jobId === "string") call.backgroundJobId = async.jobId;
				}
			}
		} else if (event.type === "tool_execution_update") {
			const call = calls.find(item => item.id === event.toolCallId);
			if (call && call.endedAt === undefined) updateCall(call, event.args, event.partialResult);
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				const call = calls.find(item => item.id === block.id && item.endedAt === undefined);
				if (!call) continue;
				updateCall(call, streamedArgs(block));
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
				semanticName: call.semanticName,
				detail: call.detail,
				command: call.command,
				duration: displayDuration(call),
				backgroundJobId: call.backgroundJobId,
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
			const call: Call = { id: block.id, name: block.name, detail: "" };
			updateCall(call, streamedArgs(block));
			const item: ToolRow = {
				id: call.id,
				name: call.name,
				semanticName: call.semanticName,
				detail: call.detail,
				command: call.command,
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
						semanticName: call.semanticName,
						detail: call.detail,
						command: call.command,
						duration: displayDuration(call),
						backgroundJobId: call.backgroundJobId,
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
					if (call) {
						item.detail = call.detail;
						item.command = call.command;
						item.semanticName = call.semanticName;
						item.duration = duration(call, now);
						item.backgroundJobId = call.backgroundJobId;
					}
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
					? row([label, text(item.timerPrefix ?? " · "), timer])
					: row([
							label,
							text([span(item.timerPrefix ?? " · ", "dim")]),
							node(timer.k, { ...timer.p, tone: "muted" }, timer.c),
						]);
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
