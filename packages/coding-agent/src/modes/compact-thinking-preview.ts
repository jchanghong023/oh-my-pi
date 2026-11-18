import type { ToolCall } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import type { Component, RenderTimer } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { registerSpinnerBlock, unregisterSpinnerBlock } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { col, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme, type ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { describeShimmer, type ShimmerPalette, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { type CoordinationDetails, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { isXdHelpContent, parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { getPaddingX, padding, sliceWithWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import { collectPendingToolCalls, TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import type { CompactPreviewActivity } from "./compact-tool-output-preview";
import { type CompactFileSummary, summarizeCompactTool } from "./compact-tool-summary";
import { decodeStreamedToolArgs } from "./controllers/tool-args-reveal";
import type { InteractiveModeContext } from "./types";

const ACTION_SHIMMER_PALETTE: ShimmerPalette = { low: "muted", mid: "muted", high: "text" };
const ACTION_QUIET_MS = 1500;
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
	embeddedIntent?: string;
	file?: CompactFileSummary;
	startedAt?: number;
	motionStartedAt?: number;
	endedAt?: number;
	failed?: boolean;
};
type Action = {
	id: string;
	category: ActionCategory;
	running: boolean;
	failed: boolean;
	detail: string;
	file?: CompactFileSummary;
	previewIntent?: string;
	startedAt?: number;
};
type ThinkingPhase = {
	startedAt: number;
	endedAt?: number;
	failed?: boolean;
	text: string;
	preview?: { source: string; width: number; proseOnly: boolean; text: string };
};
type ActionRow = {
	word: string;
	tone: ThemeColor;
	detail: { text: string; tone: ThemeColor }[];
};
type SessionMemory = {
	calls: Call[];
	/** Thinking phases keyed by message timestamp and content index. */
	thinking: Map<string, ThinkingPhase>;
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
	const outerPath = outer.path ?? outer.file_path;
	const path = typeof outerPath === "string" ? outerPath : undefined;
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
		call.file = undefined;
		call.embeddedIntent = undefined;
	}
	call.semanticName = semanticName;
	let effectiveArgs = outer;
	let effectiveResult = result;
	if (wrapped) {
		const decoded =
			typeof outer.content === "string" && outer.content.length
				? decodeStreamedToolArgs(outer.content, { rawInput: false })
				: undefined;
		// Both sources belong only to this event; retain the resulting display facts, not their payloads.
		effectiveArgs = { ...fields(decoded), ...fields(dispatch.args) };
		call.embeddedIntent ??= [effectiveArgs.i, effectiveArgs.intent, effectiveArgs.title].find(
			(value): value is string => typeof value === "string" && !!value.trim(),
		);
		effectiveResult = result ? { ...result, details: dispatch.inner } : undefined;
	}
	const target = waitTarget(semanticName, effectiveResult as ToolRenderResult<CoordinationDetails> | undefined);
	if (target) call.waitTarget = target;
	call.intent = [call.intent, outer.i, outer.intent, outer.title].find(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	if (
		!Object.keys(effectiveArgs).length &&
		!target &&
		!identityChanged &&
		(call.detail || call.command || (!path && !call.intent))
	)
		return;
	const detail = summarizeCompactTool(
		semanticName,
		effectiveArgs,
		call.intent ?? call.embeddedIntent,
		semanticName === "wait" ? call.waitTarget : undefined,
	);
	if (detail.file || effectiveArgs.path !== undefined || effectiveArgs.file_path !== undefined)
		call.file = detail.file;
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

function categoryOf(call: Call): ActionCategory {
	if (call.file) return call.file.category;
	return (call.semanticName ?? call.name) === "bash" ? "exec" : "call";
}

/** One-line detail for a tool action: command text, or a target summary, or the real tool name. */
function toolDetail(call: Call, category: ActionCategory): string {
	if (call.file) return clean(call.file.path).trim();
	if (call.command) return clean(call.command);
	const target = clean(call.detail).trim();
	if (category === "exec") return target || call.name;
	// Unmapped tools must name themselves AND keep the short parameter summary; never mislabel them.
	const name =
		call.semanticName && call.semanticName !== call.name ? `${call.name} (${call.semanticName})` : call.name;
	return target ? `${name} ${target}` : name;
}

function thinkingSeconds(ms: number): string {
	return ms < 100 ? "用时 <0.1 秒" : `用时 ${(ms / 1000).toFixed(1)} 秒`;
}

/** Latest nonblank wrapped row, using the same visible thinking prose as the transcript. */
function thinkingDetail(text: string, proseOnly: boolean, width: number): string {
	if (width <= 0) return "";
	const formatted = formatThinkingForDisplay(text, proseOnly);
	if (!hasDisplayableThinking(text, formatted)) return "";
	let end = formatted.length;
	while (end > 0) {
		const start = formatted.lastIndexOf("\n", end - 1) + 1;
		const line = clean(formatted.slice(start, end)).trim();
		if (line && !/^[.…\s]+$/.test(line)) {
			const tail = wrapTextWithAnsi(line, width)
				.findLast(row => row.trim() && visibleWidth(row) <= width)
				?.trim();
			if (tail) return tail;
		}
		end = start - 1;
	}
	return "";
}

/** Keep the same truncation, with separate runs for path context and its distinguishing tail. */
function fileDetail(path: string, file: CompactFileSummary, width: number): [string, string, string] {
	const count = file.countSuffix;
	const fullWidth = visibleWidth(path + count);
	const basename = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const parent = Math.max(path.lastIndexOf("/", basename - 1), path.lastIndexOf("\\", basename - 1));
	const tail = path.slice(parent + 1);
	if (fullWidth <= width) {
		const intent = file.intent && clean(file.intent).trim();
		return [
			path.slice(0, parent + 1),
			tail,
			intent && fullWidth + 3 + visibleWidth(intent) <= width ? `${count} · ${intent}` : count,
		];
	}
	// Keep the parent and basename intact when they fit, spending spare cells on the prefix.
	const pathWidth = visibleWidth(path);
	const countWidth = visibleWidth(count);
	const showCount = width - countWidth >= Math.min(pathWidth, 8);
	const room = showCount ? width - countWidth : width;
	const suffix = showCount ? count : "";
	if (pathWidth <= room) return [path.slice(0, parent + 1), tail, suffix];
	const tailWidth = visibleWidth(tail);
	if (tailWidth < room - 1) {
		const prefix = sliceWithWidth(path, 0, room - tailWidth - 1, true).text;
		return [`${prefix}…`, tail, suffix];
	}
	return ["…", sliceWithWidth(path, pathWidth - room + 1, room - 1, true).text, suffix];
}

/** Composer-only projection of action records and the last displayed content. */
export class CompactThinkingPreview implements Component {
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#memory?: SessionMemory;
	#shownThinking?: { id: string; source: string; text: string; width: number; proseOnly: boolean; changedAt?: number };
	#quietWake?: { deadline: number; timer: RenderTimer };

	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"viewSession" | "effectiveHideThinkingBlock" | "proseOnlyThinking"
		> &
			Partial<Pick<InteractiveModeContext, "ui">>,
		private readonly asyncWaitRow?: () => Loader | undefined,
		private readonly compactActivity?: (width: number) => CompactPreviewActivity | undefined,
	) {}

	clear(): void {
		this.#cancelQuietWake();
		unregisterSpinnerBlock(this);
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#memory = undefined;
		this.#shownThinking = undefined;
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
			const call: Call = {
				id: callId,
				name,
				detail: "",
				intent,
				startedAt,
				motionStartedAt: startedAt === undefined ? Date.now() : undefined,
			};
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

	#startThinking(messageTimestamp: number, contentIndex: number, now: number): string {
		const memory = this.#memory!;
		const id = `thinking:${messageTimestamp}:${contentIndex}`;
		if (!memory.thinking.has(id)) {
			memory.thinking.set(id, { startedAt: now, text: "" });
			memory.order.push(id);
		}
		return id;
	}

	#endThinking(id: string, now: number, failed: boolean): void {
		const memory = this.#memory!;
		const phase = memory.thinking.get(id);
		if (!phase || phase.endedAt !== undefined) return;
		phase.endedAt = now;
		phase.failed = failed;
		phase.text = "";
		phase.preview = undefined;
		if (this.#shownThinking?.id === id) this.#shownThinking = undefined;
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
				this.#startThinking(event.message.timestamp, delta.contentIndex, now);
			} else if (delta.type === "thinking_delta") {
				const id = this.#startThinking(event.message.timestamp, delta.contentIndex, now);
				const phase = memory.thinking.get(id);
				if (phase && phase.endedAt === undefined) {
					const block = event.message.content[delta.contentIndex];
					if (block?.type === "thinking") phase.text = block.thinking;
				}
			} else if (delta.type === "thinking_end") {
				const id = this.#startThinking(event.message.timestamp, delta.contentIndex, now);
				this.#endThinking(id, now, false);
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

	/** Reuse the shared ANSI ticker only while the dock has an eligible shimmer. */
	tickSpinner(_frame: number): void {
		if (shimmerEnabled() && displayPreferences.compactToolActivity) this.ctx.ui?.requestComponentRender(this);
		else unregisterSpinnerBlock(this);
	}

	render(width: number): readonly string[] {
		const waitRow = this.asyncWaitRow?.();
		const inset = Math.min(getPaddingX(1), Math.max(0, width - 1));
		const { slots, activity } = this.#visibleActions(width, inset, waitRow);
		const animated = !isNativeRendering()
			? this.#selectMotion(slots, activity, width - inset, !waitRow && shimmerEnabled())
			: undefined;
		if (animated !== undefined && this.ctx.ui) registerSpinnerBlock(this);
		else unregisterSpinnerBlock(this);
		if (!displayPreferences.compactToolActivity) return [];
		const left = padding(inset);
		const rows = slots.map(action =>
			action ? left + this.#paintAnsi(this.#buildRow(action, width - inset), action.id === animated) : "",
		);
		const waiting = waitRow ? truncateToWidth(waitRow.inlineText(), width) : "";
		return [rows[0] ?? "", waiting || (rows[1] ?? ""), ""];
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.asyncWaitRow?.()?.handleNativeEvent(event);
	}

	/** Reconcile the active thinking phase from live state so focus restoration shows it without a fresh event. */
	#syncLiveThinking(now: number): void {
		const memory = this.#memory!;
		const state = this.ctx.viewSession.agent.state;
		const stream = state.streamMessage;
		const index = state.activeThinkingIndex;
		if (stream?.role === "assistant" && index !== undefined) {
			const block = stream.content[index];
			if (block?.type === "thinking") {
				const id = this.#startThinking(stream.timestamp, index, now);
				const phase = memory.thinking.get(id);
				if (phase && phase.endedAt === undefined) phase.text = block.thinking;
			}
		}
	}

	/** Build the action records currently eligible for the two slots. */
	#actions(detailWidth: number): Action[] {
		this.#syncLiveThinking(Date.now());
		const memory = this.#memory!;
		const state = this.ctx.viewSession.agent.state;
		const hideThinking = this.ctx.effectiveHideThinkingBlock;
		const proseOnly = this.ctx.proseOnlyThinking;
		const actions: Action[] = [];
		let activeThinking: Action | undefined;
		for (const [id, phase] of memory.thinking) {
			if (hideThinking) continue;
			const running = phase.endedAt === undefined;
			let detail: string;
			if (running) {
				let preview = phase.preview;
				if (preview?.source !== phase.text || preview.width !== detailWidth || preview.proseOnly !== proseOnly) {
					preview = {
						source: phase.text,
						width: detailWidth,
						proseOnly,
						text: thinkingDetail(phase.text, proseOnly, detailWidth),
					};
					phase.preview = preview;
				}
				detail = preview.text;
			} else detail = thinkingSeconds(Math.max(0, (phase.endedAt ?? 0) - phase.startedAt));
			const action: Action = {
				id,
				category: "thinking",
				running,
				failed: phase.failed === true,
				detail,
				startedAt: phase.startedAt,
			};
			if (running) {
				if (detail || !activeThinking?.detail) activeThinking = action;
			} else {
				actions.push(action);
			}
		}
		for (const call of memory.calls) {
			const running = call.endedAt === undefined && state.pendingToolCalls.has(call.id);
			const category = categoryOf(call);
			actions.push({
				id: call.id,
				category,
				running,
				failed: call.failed === true,
				detail: toolDetail(call, category),
				file: call.file,
				previewIntent: category === "exec" && call.command ? clean(call.detail).trim() : undefined,
				startedAt: call.startedAt ?? call.motionStartedAt,
			});
		}
		// Blank or hidden prose cannot displace an existing tool or completed action.
		if (activeThinking && (activeThinking.detail || actions.length === 0)) actions.push(activeThinking);
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
		const displayed = (id: string): boolean => slots[0] === id || slots[1] === id;
		const queuedRunner = (): Action | undefined => {
			for (const id of memory.order) {
				const action = byId.get(id);
				if (action?.running && !displayed(id)) return action;
			}
			return undefined;
		};
		const place = (index: 0 | 1, action: Action | undefined): void => {
			slots[index] = action?.id;
		};
		for (const index of [0, 1] as const) if (!held(index)) place(index, undefined);
		const thinking = actions.find(action => action.category === "thinking" && action.running && action.detail);
		if (thinking && !displayed(thinking.id)) {
			// Prefer a vacancy; if two tools already occupy the dock, keep the bottom runner.
			const index = !held(1)?.running ? 1 : 0;
			place(index, thinking);
		}
		// A running action keeps its slot; vacancies fill bottom-first so the current runner stays below.
		for (const index of [1, 0] as const) {
			const current = held(index);
			if (current?.running) continue;
			const next = queuedRunner();
			if (next) place(index, next);
		}
		const runningCount = actions.filter(action => action.running).length;
		if (runningCount === 0) {
			// Keep settled slots stable unless newer actions completed between paints.
			const ended = memory.order.map(id => byId.get(id)!).filter(action => action && !action.running);
			const latest = ended.slice(-2);
			if (latest.some(action => !displayed(action.id))) {
				place(0, latest.length === 2 ? latest[0] : undefined);
				place(1, latest.at(-1));
			}
		} else if (runningCount === 1) {
			// Keep the surviving runner in its slot and use the other for the latest completion.
			const settledIndex = held(0)?.running ? 1 : 0;
			const latest = memory.order.findLast(id => byId.get(id)?.running === false);
			place(settledIndex, latest === undefined ? undefined : byId.get(latest));
		}
		return [held(0), held(1)];
	}

	#visibleActions(
		width: number,
		inset: number,
		waitRow: Loader | undefined,
	): { slots: (Action | undefined)[]; activity?: CompactPreviewActivity } {
		if (!displayPreferences.compactToolActivity) {
			this.clear();
			return { slots: [] };
		}
		this.#syncSession();
		const contentWidth = width - inset;
		if (contentWidth < 1) return { slots: [] };
		const memory = this.#memory!;
		const slots = this.#select(this.#actions(contentWidth - ACTION_WIDTH - ACTION_GAP.length));
		const visible = slots.filter((action): action is Action => action !== undefined);
		if (visible.length > 0) memory.snapshot = visible.map(action => ({ ...action }));
		// Waiting belongs to the session, not to a completed tool. Reserve the
		// lower slot without adding the wait to action history or the snapshot.
		if (waitRow) {
			slots[0] =
				slots.find(action => action?.category === "thinking" && action.running && action.detail) ??
				(slots[1]?.running ? slots[1] : slots[0]?.running ? slots[0] : (slots[1] ?? slots[0]));
			slots[1] = undefined;
		}
		const activity = slots.some(action => action?.category === "exec") ? this.compactActivity?.(width) : undefined;
		if (activity?.commandVisible) {
			const index = slots.findIndex(action => action?.id === activity.callId && action.previewIntent);
			if (index !== -1) {
				const action = slots[index]!;
				slots[index] = { ...action, detail: action.previewIntent! };
			}
		}
		return { slots, activity };
	}

	#selectMotion(
		slots: (Action | undefined)[],
		activity: CompactPreviewActivity | undefined,
		width: number,
		animate: boolean,
	): string | undefined {
		const now = Date.now();
		let deadline = 0;
		let candidate: string | undefined;
		for (const action of slots) {
			if (!action?.running) continue;
			// The lower slot wins when both running actions are quiet.
			candidate = action.id;
			let progressAt: number | undefined;
			if (action.category === "thinking") progressAt = this.#thinkingProgress(action, width, now);
			else if (action.category === "exec" && action.id === activity?.callId) progressAt = activity.outputChangedAt;
			deadline = Math.max(deadline, Math.max(action.startedAt ?? 0, progressAt ?? 0) + ACTION_QUIET_MS);
		}
		if (!animate || width < ACTION_WIDTH || candidate === undefined || deadline <= now) {
			this.#cancelQuietWake();
			return animate && width >= ACTION_WIDTH ? candidate : undefined;
		}
		// Native shimmers are clocked by the terminal, but it needs a new frame
		// to receive the first shimmer node after progress stops.
		if (deadline !== this.#quietWake?.deadline) {
			this.#cancelQuietWake();
			const ui = this.ctx.ui;
			if (ui) {
				const timer = ui.scheduleAfter(deadline - now, () => {
					this.#quietWake = undefined;
					if (
						displayPreferences.compactToolActivity &&
						shimmerEnabled() &&
						this.#session === this.ctx.viewSession &&
						this.#sessionId === this.ctx.viewSession.sessionManager.getSessionId()
					) {
						ui.requestComponentRender(this);
					}
				});
				this.#quietWake = { deadline, timer };
			}
		}
		return undefined;
	}

	#cancelQuietWake(): void {
		this.#quietWake?.timer.cancel();
		this.#quietWake = undefined;
	}

	#thinkingProgress(action: Action, width: number, now: number): number | undefined {
		const previous = this.#shownThinking;
		const proseOnly = this.ctx.proseOnlyThinking;
		const source = this.#memory!.thinking.get(action.id)!.text;
		const sameAction = previous?.id === action.id;
		const sameLayout = previous?.width === width && previous.proseOnly === proseOnly;
		if (sameAction && sameLayout && previous.source === source) return previous.changedAt;
		let changedAt = sameAction ? previous.changedAt : undefined;
		// Reflowing the same prose is not progress. If input and layout changed
		// together, compare both inputs at the new width.
		if (action.detail) {
			if (!sameAction) changedAt = now;
			else if (previous.source !== source) {
				const previousDetail = sameLayout
					? previous.text
					: thinkingDetail(previous.source, proseOnly, width - ACTION_WIDTH - ACTION_GAP.length);
				if (previousDetail !== action.detail) changedAt = now;
			}
		}
		this.#shownThinking = { id: action.id, source, text: action.detail, width, proseOnly, changedAt };
		return changedAt;
	}

	/** Fixed action area and two spaces; style does not change the detail origin. */
	#buildRow(action: Action, width: number): ActionRow {
		const full = ACTION_WORDS[action.category][action.running ? "running" : action.failed ? "failed" : "done"];
		const actionWidth = Math.min(ACTION_WIDTH, width);
		const word = truncateToWidth(full, actionWidth);
		const tone = action.running ? "muted" : action.failed ? "error" : "dim";
		const detailWidth = width - actionWidth - ACTION_GAP.length;
		const detail: ActionRow["detail"] = [];
		if (detailWidth > 0 && action.detail) {
			if (action.file) {
				const [prefix, target, suffix] = fileDetail(action.detail, action.file, detailWidth);
				if (action.running) {
					if (prefix) detail.push({ text: prefix, tone: "dim" });
					if (target) detail.push({ text: target, tone: "text" });
					if (suffix) detail.push({ text: suffix, tone: "dim" });
				} else detail.push({ text: prefix + target + suffix, tone: "dim" });
			} else {
				const value = truncateToWidth(action.detail, detailWidth);
				const tone = action.running && action.category === "thinking" ? "text" : "dim";
				if (value) detail.push({ text: value, tone });
			}
		}
		return { word, tone, detail };
	}

	#paintAnsi({ word, tone, detail }: ActionRow, animate: boolean): string {
		let line = animate ? shimmerText(word, theme, ACTION_SHIMMER_PALETTE) : theme.fg(tone, word);
		if (detail.length) {
			line += ACTION_GAP;
			for (const run of detail) line += theme.fg(run.tone, run.text);
		}
		return line;
	}

	describe(cx: DescribeContext): NativeNode {
		const waitRow = this.asyncWaitRow?.();
		const inset = Math.min(getPaddingX(1), Math.max(0, cx.cols - 1));
		const { slots, activity } = this.#visibleActions(cx.cols, inset, waitRow);
		const left = padding(inset);
		const animated = this.#selectMotion(
			slots,
			activity,
			cx.cols - inset,
			!waitRow && shimmerEnabled() && !cx.reduceMotion && cx.supports("shimmer"),
		);
		unregisterSpinnerBlock(this);
		const children = slots.map(action => {
			if (!action) return node("rows", { cols: cx.cols, lines: [""] });
			const built = this.#buildRow(action, cx.cols - inset);
			const label =
				animated === action.id
					? describeShimmer([{ text: built.word, palette: ACTION_SHIMMER_PALETTE }])
					: text([span(built.word, built.tone)]);
			const parts = built.detail.length
				? [text(left), label, text(ACTION_GAP), text(built.detail.map(run => span(run.text, run.tone)))]
				: [text(left), label];
			return row(parts);
		});
		while (children.length < 2) children.push(node("rows", { cols: cx.cols, lines: [""] }));
		if (waitRow && displayPreferences.compactToolActivity) children[1] = waitRow.describe(cx);
		children.push(node("rows", { cols: cx.cols, lines: [""] }));
		return col(children);
	}
}
