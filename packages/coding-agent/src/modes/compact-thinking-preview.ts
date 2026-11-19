import type { ToolCall } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, spinnerAnimated } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-tui/chat/thinking-display";
import type { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { col, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme, type ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { describeShimmer, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { type CoordinationDetails, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { isXdHelpContent, parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { getPaddingX, padding, sliceWithWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent, ModelStage } from "../session/agent-session-events";
import { collectPendingToolCalls, TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import type { CompactPreviewActivity } from "./compact-tool-output-preview";
import { type CompactFileSummary, summarizeCompactTool } from "./compact-tool-summary";
import { decodeStreamedToolArgs } from "./controllers/tool-args-reveal";
import type { InteractiveModeContext } from "./types";

const THINKING_LABEL_WIDTH = 14;
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
	stage?: ModelStage;
	additional?: number;
};

const MODEL_WORDS: Record<ModelStage, string> = {
	waiting: "等待响应",
	thinking: "正在思考",
	replying: "正在生成回复",
	"tool-arguments": "正在准备调用",
};

type ThinkingPhase = {
	ended?: true;
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
	latestStart?: number;
};

/** Retain view facts for a live session without pinning closed sessions or mixing equal IDs. */
const memories = new WeakMap<InteractiveModeContext["viewSession"], { id: string; memory: SessionMemory }>();

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

	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"viewSession" | "effectiveHideThinkingBlock" | "proseOnlyThinking" | "statusLine"
		>,
		private readonly asyncWaitRow?: () => Loader | undefined,
		private readonly compactActivity?: (width: number) => CompactPreviewActivity | undefined,
	) {}

	clear(): void {
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
		const saved = memories.get(session);
		const memory: SessionMemory = saved?.id === id ? saved.memory : { calls: [], thinking: new Map() };
		memories.set(session, { id, memory });
		this.#memory = memory;
		const pending = session.agent.state.pendingToolCalls;
		// While not viewing this session, we may have missed thinking or tool end events.
		// Only retain unfinished records that the current agent confirms are still active.
		const state = session.agent.state;
		const active =
			state.streamMessage?.role === "assistant" && state.activeThinkingIndex !== undefined
				? `thinking:${state.streamMessage.timestamp}:${state.activeThinkingIndex}`
				: undefined;
		for (const [key, phase] of memory.thinking) {
			if (!phase.ended && key !== active) memory.thinking.delete(key);
		}
		memory.calls = memory.calls.filter(call => call.endedAt !== undefined || pending.has(call.id));
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
			};
			updateCall(call, args);
			if (update) updateCall(call, update.args, update.partialResult);
			this.#appendCall(call);
		}
	}

	#appendCall(call: Call): void {
		const memory = this.#memory!;
		memory.calls.push(call);
		if (call.startedAt !== undefined)
			memory.latestStart = Math.max(memory.latestStart ?? call.startedAt, call.startedAt);
	}

	#startThinking(messageTimestamp: number, contentIndex: number): string {
		const memory = this.#memory!;
		const id = `thinking:${messageTimestamp}:${contentIndex}`;
		if (!memory.thinking.has(id)) {
			memory.thinking.set(id, { text: "" });
		}
		return id;
	}

	#endThinking(id: string): void {
		const memory = this.#memory!;
		const phase = memory.thinking.get(id);
		if (!phase || phase.ended) return;
		phase.ended = true;
		phase.text = "";
		phase.preview = undefined;
	}

	/** Retain live calls and only the last settled tool. */
	#pruneSettled(): void {
		const memory = this.#memory!;
		let last: Call | undefined;
		for (const call of memory.calls) {
			if (call.endedAt !== undefined && call.endedAt >= (last?.endedAt ?? 0)) last = call;
		}
		memory.calls = memory.calls.filter(call => call.endedAt === undefined || call === last);
		for (const [id, phase] of memory.thinking) {
			if (phase.ended) memory.thinking.delete(id);
		}
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
				this.#startThinking(event.message.timestamp, delta.contentIndex);
			} else if (delta.type === "thinking_delta") {
				const id = this.#startThinking(event.message.timestamp, delta.contentIndex);
				const phase = memory.thinking.get(id);
				if (phase && !phase.ended) {
					const block = event.message.content[delta.contentIndex];
					if (block?.type === "thinking") phase.text = block.thinking;
				}
			} else if (delta.type === "thinking_end") {
				const id = this.#startThinking(event.message.timestamp, delta.contentIndex);
				this.#endThinking(id);
			} else if (delta.type === "error") {
				for (const id of memory.thinking.keys()) this.#endThinking(id);
			}
			for (const block of event.message.content) {
				if (block.type !== "toolCall") continue;
				const call = calls.find(item => item.id === block.id && item.endedAt === undefined);
				if (!call) continue;
				updateCall(call, streamedArgs(block));
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			// A stream that ends without thinking_end (abort/error) still settles its open phase.
			for (const id of memory.thinking.keys()) this.#endThinking(id);
		}
		if (
			event.type === "tool_execution_end" ||
			(event.type === "message_end" && event.message.role === "assistant") ||
			(event.type === "message_update" &&
				(event.assistantMessageEvent.type === "thinking_end" || event.assistantMessageEvent.type === "error"))
		) {
			this.#pruneSettled();
		}
	}

	/** Match the status spinner's active window; the working loader drives ANSI repaint. */
	#activityAnimating(): boolean {
		return spinnerAnimated() && shimmerEnabled() && this.ctx.statusLine.getTurnElapsedMs() !== null;
	}

	render(width: number): readonly string[] {
		const waitRow = this.asyncWaitRow?.();
		const inset = Math.min(getPaddingX(1), Math.max(0, width - 1));
		const slots = this.#visibleActions(width, inset, waitRow);
		const animate = !isNativeRendering() && this.#activityAnimating();
		if (!displayPreferences.compactToolActivity) return [];
		const left = padding(inset);
		const rows = slots.map(action =>
			action ? left + this.#paintAnsi(this.#buildRow(action, width - inset), animate && action.running) : "",
		);
		const waiting = waitRow ? left + truncateToWidth(`Agent：${waitRow.inlineText()}`, width - inset) : "";
		return [rows[0] ?? "", waiting || (rows[1] ?? ""), ""];
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.asyncWaitRow?.()?.handleNativeEvent(event);
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
				const id = this.#startThinking(stream.timestamp, index);
				const phase = memory.thinking.get(id);
				if (phase && !phase.ended) phase.text = block.thinking;
			}
		}
	}

	/** Build the action records currently eligible for the two slots. */
	#actions(detailWidth: number): Action[] {
		this.#syncLiveThinking();
		const memory = this.#memory!;
		const state = this.ctx.viewSession.agent.state;
		const hideThinking = this.ctx.effectiveHideThinkingBlock;
		const proseOnly = this.ctx.proseOnlyThinking;
		const actions: Action[] = [];
		let activeThinking: Action | undefined;
		for (const [id, phase] of memory.thinking) {
			if (hideThinking || phase.ended) continue;
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
			if (preview.text || !activeThinking?.detail) {
				activeThinking = {
					id,
					category: "thinking",
					running: true,
					failed: false,
					detail: preview.text,
				};
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
			});
		}
		if (activeThinking) actions.push(activeThinking);
		return actions;
	}

	/** The model and Agent own separate rows; a settled tool never stands in for a running one. */
	#select(actions: Action[]): (Action | undefined)[] {
		const session = this.ctx.viewSession;
		const thinking = actions.find(action => action.category === "thinking");
		const tools = actions.filter(action => action.category !== "thinking");
		const running = tools.filter(action => action.running);
		const current = running[0] ?? tools.at(-1);
		const stage = session.modelStage;
		const model: Action | undefined = stage
			? {
					id: thinking?.id ?? "model",
					category: "thinking",
					running: true,
					failed: false,
					detail: stage === "thinking" ? (thinking?.detail ?? "") : "",
					stage,
				}
			: undefined;
		return [model, current && { ...current, additional: Math.max(0, running.length - 1) }];
	}

	#visibleActions(width: number, inset: number, waitRow: Loader | undefined): (Action | undefined)[] {
		if (!displayPreferences.compactToolActivity) {
			this.clear();
			return [];
		}
		this.#syncSession();
		const contentWidth = width - inset;
		if (contentWidth < 1) return [];
		const slots = this.#select(this.#actions(contentWidth - THINKING_LABEL_WIDTH - ACTION_GAP.length));
		if (waitRow) slots[1] = undefined;
		const agent = slots[1];
		const activity = agent?.category === "exec" ? this.compactActivity?.(width) : undefined;
		if (agent && activity?.callId === agent.id && activity.commandVisible && agent.previewIntent) {
			slots[1] = { ...agent, detail: agent.previewIntent };
		}
		return slots;
	}

	/** Keep the path or thinking text ahead of optional detail on narrow terminals. */
	#buildRow(action: Action, width: number): ActionRow {
		const model = action.category === "thinking";
		const state = action.running ? "running" : action.failed ? "failed" : "done";
		const full = model
			? `模型：${MODEL_WORDS[action.stage ?? "thinking"]}`
			: `Agent：${action.running ? "" : "上次"}${ACTION_WORDS[action.category][state]}`;
		const extra = action.additional ? ` +${action.additional}` : "";
		const word = truncateToWidth(full, width);
		const runningCall = action.running && action.category === "call";
		const tone = runningCall ? "accent" : action.running ? "muted" : action.failed ? "error" : "dim";
		const detailWidth = width - visibleWidth(word) - ACTION_GAP.length - visibleWidth(extra);
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
				const tone = runningCall || (action.running && model) ? "text" : "dim";
				if (value) detail.push({ text: value, tone });
			}
		}
		if (extra && width - visibleWidth(word) >= visibleWidth(extra) + ACTION_GAP.length)
			detail.push({ text: extra, tone: "muted" });
		return { word, tone, detail };
	}

	#paintAnsi({ word, tone, detail }: ActionRow, animate: boolean): string {
		let line = animate ? shimmerText(word, theme) : theme.fg(tone, word);
		if (detail.length) {
			line += ACTION_GAP;
			for (const run of detail) line += theme.fg(run.tone, run.text);
		}
		return line;
	}

	describe(cx: DescribeContext): NativeNode {
		if (!displayPreferences.compactToolActivity) {
			this.clear();
			return node("rows", { cols: cx.cols, lines: [] });
		}
		const waitRow = this.asyncWaitRow?.();
		const inset = Math.min(getPaddingX(1), Math.max(0, cx.cols - 1));
		const slots = this.#visibleActions(cx.cols, inset, waitRow);
		const left = padding(inset);
		const animate = this.#activityAnimating() && !cx.reduceMotion && cx.supports("shimmer");
		const children = slots.map(action => {
			if (!action) return node("rows", { cols: cx.cols, lines: [""] });
			const built = this.#buildRow(action, cx.cols - inset);
			const label =
				animate && action.running ? describeShimmer([{ text: built.word }]) : text([span(built.word, built.tone)]);
			const parts = built.detail.length
				? [text(left), label, text(ACTION_GAP), text(built.detail.map(run => span(run.text, run.tone)))]
				: [text(left), label];
			return row(parts);
		});
		while (children.length < 2) children.push(node("rows", { cols: cx.cols, lines: [""] }));
		if (waitRow) {
			const prefix = truncateToWidth("Agent：", cx.cols - inset);
			const rest = cx.cols - inset - visibleWidth(prefix);
			children[1] = row([text(left + prefix), ...(rest > 0 ? [waitRow.describe({ ...cx, cols: rest })] : [])]);
		}
		children.push(node("rows", { cols: cx.cols, lines: [""] }));
		return col(children);
	}
}
