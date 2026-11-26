import type { ToolCall } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { replaceTabs, truncate as truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { LocalAgentSessionEvent, ModelStage } from "../session/agent-session-events";
import { collectPendingToolCalls, TOOL_EXECUTION_START_CUSTOM_TYPE } from "../session/exit-diagnostics";
import { toolOutputSource } from "../session/live-tool-output-text";
import type { CoordinationDetails } from "../tools/details/wait";
import type { ToolResult } from "../ui/tools/contract";
import { sliceWithWidth, wrapTextWithAnsi } from "../utils/text-width";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../session/transcript/thinking-display";
import type { CompactPreviewActivity } from "./compact-tool-output-preview";
import { type CompactFileSummary, summarizeCompactTool } from "./compact-tool-summary";
import { decodeStreamedToolArgs } from "./controllers/tool-args-reveal";
import { cfgDisplayMode } from "./settings";
import type { InteractiveModeContext } from "./types";

const THINKING_LABEL_WIDTH = 14;
const ACTION_GAP = "  ";

type ToolActionCategory = "read" | "exec" | "write" | "call";
type ActionState = "running" | "done" | "failed";

const ACTION_WORDS: Record<ToolActionCategory, Record<ActionState, string>> = {
	read: { running: "Reading", done: "read OK", failed: "read failed" },
	exec: { running: "Running", done: "run OK", failed: "run failed" },
	write: { running: "Writing", done: "write OK", failed: "write failed" },
	call: { running: "Calling", done: "call OK", failed: "call failed" },
};

type Call = {
	id: string;
	name: string;
	detail: string;
	semanticName?: string;
	waitTarget?: string;
	command?: string;
	intent?: string;
	shellCommand?: string;
	file?: CompactFileSummary;
	startedAt?: number;
	endedAt?: number;
	failed?: boolean;
};
type ToolAction = {
	id: string;
	category: ToolActionCategory;
	running: boolean;
	failed: boolean;
	detail: string;
	file?: CompactFileSummary;
	previewIntent?: string;
	additional?: number;
};

type Action = ToolAction | { category: "thinking"; detail: string; stage: ModelStage; running: true };

const MODEL_WORDS: Record<ModelStage, string> = {
	waiting: "waiting",
	thinking: "thinking",
	replying: "replying",
	"tool-arguments": "preparing call",
};

type ThinkingPreview = { source: string; width: number; proseOnly: boolean; text: string };
export type CompactActionRow = {
	word: string;
	running: boolean;
	tone: string;
	detail: { text: string; tone: string }[];
};
type SessionMemory = {
	calls: Call[];
	latestStart?: number;
};

/** Retain view facts for a live session without pinning closed sessions or mixing equal IDs. */
const memories = new WeakMap<InteractiveModeContext["viewSession"], { id: string; memory: SessionMemory }>();

function clean(value: string): string {
	return replaceTabs(sanitizeText(stripEscapes(value))).replace(/[\r\n]+/g, " ");
}

function fields(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Project the transport and its structured result without exposing payload or output text. */
function updateCall(call: Call, args?: unknown, result?: ToolResult<unknown>): void {
	const outer = fields(args);
	if (call.name === "bash" && typeof outer.command === "string") call.shellCommand = outer.command;
	const source = toolOutputSource(
		call.name,
		result,
		call.shellCommand && outer.command === undefined ? { command: call.shellCommand } : outer,
	);
	// Ignore sparse updates without dispatch metadata after a mounted command was identified.
	if (!source.shellDetails?.toolCommands && call.semanticName && call.semanticName !== call.name) return;
	const { name: semanticName, dispatch } = source;
	const identityChanged = call.semanticName !== undefined && call.semanticName !== semanticName;
	if (identityChanged) {
		call.detail = "";
		call.command = undefined;
		call.waitTarget = undefined;
		call.file = undefined;
	}
	call.semanticName = semanticName;
	const effectiveArgs = dispatch?.args ?? (dispatch ? {} : outer);
	const target = waitTarget(
		semanticName,
		(dispatch && result ? { ...result, details: source.details } : result) as
			| ToolResult<CoordinationDetails>
			| undefined,
	);
	if (target) call.waitTarget = target;
	call.intent = [call.intent, outer.i, outer.intent, outer.title].find(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	if (!Object.keys(effectiveArgs).length && !target && !identityChanged && !dispatch) return;
	const detail = summarizeCompactTool(
		semanticName,
		dispatch ? effectiveArgs : call.shellCommand ? { ...outer, command: call.shellCommand } : outer,
		call.intent,
		semanticName === "wait" ? call.waitTarget : undefined,
	);
	if (detail.file || effectiveArgs.path !== undefined || effectiveArgs.file_path !== undefined)
		call.file = detail.file;
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
	result?: ToolResult<unknown>,
): { name: string; detail: string; command?: string } {
	const call: Call = { id: "", name, detail: "", intent };
	updateCall(call, args, result);
	return {
		name: call.semanticName && call.semanticName !== name ? `${name} (${call.semanticName})` : name,
		detail: call.detail,
		command: call.command,
	};
}

function waitTarget(name: string, result?: ToolResult<CoordinationDetails>): string | undefined {
	if (name !== "wait" || !Array.isArray(result?.details?.jobs)) return undefined;
	const jobs = result.details.jobs;
	return jobs.length ? jobs.map(job => job.label || job.id).join(" · ") : undefined;
}

function streamedArgs(block: ToolCall): unknown {
	const partial = getStreamingPartialJson(block);
	return partial === undefined
		? block.arguments
		: decodeStreamedToolArgs(partial, { rawInput: block.customWireName !== undefined });
}

function categoryOf(call: Call): ToolActionCategory {
	if (call.file) return call.file.category;
	return (call.semanticName ?? call.name) === "bash" ? "exec" : "call";
}

/** One-line detail for a tool action: command text, or a target summary, or the real tool name. */
function toolDetail(call: Call, category: ToolActionCategory): string {
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
export class CompactThinkingPreview {
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#memory?: SessionMemory;
	#thinkingPreview?: ThinkingPreview;

	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"viewSession" | "effectiveHideThinkingBlock" | "proseOnlyThinking" | "settings"
		>,
		private readonly asyncWaitRow?: () => string | undefined,
		private readonly compactActivity?: (width: number) => CompactPreviewActivity | undefined,
	) {}

	clear(): void {
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#memory = undefined;
		this.#thinkingPreview = undefined;
	}

	#syncSession(): void {
		const session = this.ctx.viewSession;
		const id = session.sessionManager.getSessionId();
		if (this.#session === session && this.#sessionId === id) return;
		this.clear();
		this.#session = session;
		this.#sessionId = id;
		const saved = memories.get(session);
		const memory: SessionMemory = saved?.id === id ? saved.memory : { calls: [] };
		memories.set(session, { id, memory });
		this.#memory = memory;
		const pending = session.agent.state.pendingToolCalls;
		// While not viewing this session, we may have missed tool end events.
		// Only retain unfinished calls that the current agent confirms are still active.
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

	/** Retain live calls and only the last settled tool. */
	#pruneSettled(): void {
		const memory = this.#memory!;
		let last: Call | undefined;
		for (const call of memory.calls) {
			if (call.endedAt !== undefined && call.endedAt >= (last?.endedAt ?? 0)) last = call;
		}
		memory.calls = memory.calls.filter(call => call.endedAt === undefined || call === last);
	}

	observe(event: LocalAgentSessionEvent): void {
		const now = Date.now();
		this.#syncSession();
		const memory = this.#memory!;
		const calls = memory.calls;
		if (event.type === "agent_start" && event.resumedToolCallIds?.length) {
			const resumed = event.resumedToolCallIds;
			memory.calls = calls.filter(call => !resumed.includes(call.id));
		} else if (event.type === "tool_execution_start") {
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
			this.#pruneSettled();
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

	/** The shared terminal/native projection; the layout decides how to paint its label. */
	rows(width: number): readonly (CompactActionRow | undefined)[] {
		const wait = this.asyncWaitRow?.();
		const inset = Math.min(1, Math.max(0, width - 1));
		const columns = width - inset;
		const rows = this.#visibleActions(width, inset, wait).map(action =>
			action ? this.#buildRow(action, columns) : undefined,
		);
		if (wait)
			rows[1] = { word: truncateToWidth(`Agent: ${wait}`, columns), tone: "muted", detail: [], running: true };
		return rows;
	}
	render(width: number): readonly string[] {
		if (cfgDisplayMode.get(this.ctx.settings) !== "compact") {
			this.clear();
			return [];
		}
		const left = width > 1 ? " " : "";
		const rows = this.rows(width);
		return [rows[0] ? left + this.#paintAnsi(rows[0]) : "", rows[1] ? left + this.#paintAnsi(rows[1]) : "", ""];
	}

	#thinkingDetail(stage: ModelStage | null, width: number): string {
		if (stage !== "thinking" || this.ctx.effectiveHideThinkingBlock) {
			this.#thinkingPreview = undefined;
			return "";
		}
		const { streamMessage, activeThinkingIndex } = this.ctx.viewSession.agent.state;
		const block =
			streamMessage?.role === "assistant" && activeThinkingIndex !== undefined
				? streamMessage.content[activeThinkingIndex]
				: undefined;
		if (block?.type !== "thinking") {
			this.#thinkingPreview = undefined;
			return "";
		}
		const source = block.thinking;
		const proseOnly = this.ctx.proseOnlyThinking;
		const preview = this.#thinkingPreview;
		if (preview?.source === source && preview.width === width && preview.proseOnly === proseOnly) {
			return preview.text;
		}
		const text = thinkingDetail(source, proseOnly, width);
		this.#thinkingPreview = { source, width, proseOnly, text };
		return text;
	}

	/** Show the first running call, or the last retained call when none are running. */
	#currentTool(): ToolAction | undefined {
		const { calls } = this.#memory!;
		const pending = this.ctx.viewSession.agent.state.pendingToolCalls;
		let current: Call | undefined;
		let running = 0;
		for (const call of calls) {
			if (call.endedAt !== undefined || !pending.has(call.id)) continue;
			current ??= call;
			running++;
		}
		current ??= calls.at(-1);
		if (!current) return;
		const category = categoryOf(current);
		return {
			id: current.id,
			category,
			running: running > 0,
			failed: current.failed === true,
			detail: toolDetail(current, category),
			file: current.file,
			previewIntent: category === "exec" && current.command ? clean(current.detail).trim() : undefined,
			additional: Math.max(0, running - 1),
		};
	}

	#visibleActions(width: number, inset: number, waitRow: string | undefined): (Action | undefined)[] {
		this.#syncSession();
		const contentWidth = width - inset;
		if (contentWidth < 1) return [];
		const stage = this.ctx.viewSession.modelStage;
		const detail = this.#thinkingDetail(stage, contentWidth - THINKING_LABEL_WIDTH - ACTION_GAP.length);
		const model: Action | undefined = stage ? { category: "thinking", running: true, detail, stage } : undefined;
		const agent = waitRow ? undefined : this.#currentTool();
		if (agent?.category === "exec") {
			const activity = this.compactActivity?.(width);
			if (activity?.callId === agent.id && activity.commandVisible && agent.previewIntent) {
				agent.detail = agent.previewIntent;
			}
		}
		return [model, agent];
	}

	/** Keep the path or thinking text ahead of optional detail on narrow terminals. */
	#buildRow(action: Action, width: number): CompactActionRow {
		const model = action.category === "thinking";
		const failed = !model && action.failed;
		const state = action.running ? "running" : failed ? "failed" : "done";
		const full = model
			? `Model ${MODEL_WORDS[action.stage]}`
			: `Agent: ${action.running ? "" : "Last "}${ACTION_WORDS[action.category][state]}`;
		const extra = !model && action.additional ? ` +${action.additional}` : "";
		const word = truncateToWidth(full, width);
		const runningCall = action.running && action.category === "call";
		const tone = runningCall ? "accent" : action.running ? "muted" : failed ? "error" : "dim";
		const detailWidth = width - visibleWidth(word) - ACTION_GAP.length - visibleWidth(extra);
		const detail: CompactActionRow["detail"] = [];
		if (detailWidth > 0 && action.detail) {
			if (!model && action.file) {
				const [prefix, target, suffix] = fileDetail(action.detail, action.file, detailWidth);
				if (action.running) {
					if (prefix) detail.push({ text: prefix, tone: "dim" });
					if (target) detail.push({ text: target, tone: "text" });
					if (suffix) detail.push({ text: suffix, tone: "dim" });
				} else detail.push({ text: prefix + target + suffix, tone: "dim" });
			} else {
				const value = truncateToWidth(action.detail, detailWidth);
				const tone = runningCall || model ? "text" : "dim";
				if (value) detail.push({ text: value, tone });
			}
		}
		if (extra && width - visibleWidth(word) >= visibleWidth(extra) + ACTION_GAP.length)
			detail.push({ text: extra, tone: "muted" });
		return { word, tone, detail, running: action.running };
	}

	#paintAnsi({ word, tone, detail }: CompactActionRow): string {
		const theme = currentTheme();
		let line = theme.fg(tone, word);
		if (detail.length) {
			line += ACTION_GAP;
			for (const run of detail) line += theme.fg(run.tone, run.text);
		}
		return line;
	}
}
