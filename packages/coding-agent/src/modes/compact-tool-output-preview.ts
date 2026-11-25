import * as path from "node:path";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import {
	padTo,
	replaceTabs,
	spaces,
	truncate as truncateToWidth,
	truncateMiddle as truncateMiddleToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { LocalAgentSessionEvent } from "../session/agent-session-events";
import type { LiveToolOutputPreview, LiveToolOutputSnapshot } from "../session/agent-session-handle";
import { isToolOutputRow, mayBeCoveredByFileDiff, toolOutputSource } from "../session/live-tool-output-text";
import { unwrapHashlineHeaderPath } from "../tools/hashline-format";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { isGroupedHeader, isMatchRow } from "../ui/tools/grouped-output";
import { wrapTextWithAnsi } from "../utils/text-width";
import { compactToolPreviewInfo } from "./compact-thinking-preview";
import { cfgDisplayMode } from "./settings";
import type { InteractiveModeContext } from "./types";

function singleLine(value: string): string {
	return replaceTabs(sanitizeText(stripEscapes(value).replace(/[\r\n]+/g, " "))).trim();
}

// Match explicit diagnostics in actual failed output, never infer a cause from tool metadata.
const DIAGNOSTIC_ROW =
	/(?:^\s*|:\s*|\]\s*)(?:fatal(?: error)?|[\w.]*error|exception|panic|failed|reason|错误|失败|原因)\s*[:：]|^\s*\[(?:error|fatal)\]|\b(?:failed to|command not found|permission denied|no such file or directory|timed out)\b/iu;

function wrapOutputRows(output: string, width: number): string[] {
	const rows = wrapTextWithAnsi(output, width);
	// The wrapper can emit an intact wide grapheme in a one-column viewport.
	return (width < 3 ? rows.map(row => truncateToWidth(row, width, "")) : rows).filter(isToolOutputRow);
}

type OutputRows = { lines: readonly string[]; diagnosticCount: number };

function selectOutputRows(
	output: string,
	width: number,
	budget: number,
	toolName: string,
	state: PreviewState,
): OutputRows {
	if (state === "failed") {
		const priority: string[] = [];
		const tail: string[] = [];
		const lines = output.split("\n");
		// Classify before wrapping so a narrow display cannot split the diagnostic marker.
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index]!;
			if (DIAGNOSTIC_ROW.test(line)) {
				priority.push(...wrapOutputRows(line, width).slice(0, budget - priority.length));
				if (priority.length === budget) return { lines: priority, diagnosticCount: priority.length };
			} else if (tail.length < budget) {
				tail.unshift(...wrapOutputRows(line, width).slice(tail.length - budget));
			}
		}
		return { lines: [...priority, ...tail.slice(priority.length - budget)], diagnosticCount: priority.length };
	}
	const rows = wrapOutputRows(output, width);
	if (state === "completed" && (toolName === "grep" || toolName === "glob")) {
		const isHit =
			toolName === "grep"
				? (row: string) => isMatchRow(row)
				: (row: string) => row.trim() !== "" && !isGroupedHeader(row);
		const hits = rows.filter(isHit);
		if (hits.length > 0)
			return { lines: [...hits, ...rows.filter(row => !isHit(row))].slice(0, budget), diagnosticCount: 0 };
	}
	return { lines: rows.slice(-budget), diagnosticCount: 0 };
}

/** Preview lifecycle state derived from the real terminal facts. */
type PreviewState = "running" | "completed" | "failed" | "cancelled";

/** Chinese status word shown in the frame header, aligned with the activity dock vocabulary. */
const PREVIEW_STATE_WORD: Record<PreviewState, string> = {
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

const PREVIEW_STATE_COLOR: Record<PreviewState, string> = {
	running: "accent",
	completed: "muted",
	failed: "error",
	cancelled: "warning",
};

/** Map the preview lifecycle onto the shared output-block visual state. */
const PREVIEW_BLOCK_BG: Record<PreviewState, string> = {
	running: "toolPendingBg",
	completed: "toolSuccessBg",
	failed: "toolErrorBg",
	cancelled: "toolPendingBg",
};

export interface CompactPreviewActivity {
	callId: string;
	commandVisible: boolean;
}

type PreviewHeader = {
	height: number;
	contentWidth: number;
	left: string;
	state: PreviewState;
	spans: TspSpan[];
	callId: string;
	commandVisible: boolean;
	toolName: string;
	output: string;
};

/** A text-only projection of session execution facts, independent of transcript tool cards. */
export class CompactToolOutputPreview {
	#timer?: NodeJS.Timeout;
	#deadline?: number;
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#numberedDiff?: { diff: string; rows: Set<string> };

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "shell" | "settings">,
		private readonly availableRows: () => number = () => 6,
		private readonly coveredDiff?: (toolCallId: string, file: string, width: number) => string | undefined,
		private readonly onChange: () => void = () => {},
	) {}

	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#deadline = undefined;
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#numberedDiff = undefined;
	}

	/** Synchronize even without a visible paint; close only after tool completion and activity stop. */
	observe(event: LocalAgentSessionEvent): void {
		if (
			(event.type === "agent_start" && event.resumedToolCallIds?.length) ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			this.#source(this.ctx.shell.size().columns);
		}
	}

	restore(): void {
		this.#source(this.ctx.shell.size().columns);
	}

	#source(width: number): LiveToolOutputPreview | undefined {
		const session = this.ctx.viewSession;
		const sessionId = session.sessionManager.getSessionId();
		if (session !== this.#session || sessionId !== this.#sessionId) {
			this.clear();
			this.#session = session;
			this.#sessionId = sessionId;
		}
		const selected = session.getLiveToolOutputPreview(
			this.coveredDiff ? ({ call, text }) => this.#withoutCoveredOutput(call, text, width) : undefined,
		);
		const deadline = selected?.call.expiresAt;
		if (this.#deadline !== deadline) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#deadline = deadline;
			if (deadline !== undefined && deadline > Date.now()) {
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					if (
						this.ctx.viewSession === session &&
						this.ctx.viewSession.sessionManager.getSessionId() === sessionId &&
						this.#deadline === deadline
					)
						this.onChange();
				}, deadline - Date.now());
				this.#timer.unref?.();
			}
		}
		return deadline !== undefined && deadline <= Date.now() ? undefined : selected;
	}

	/** Header-only query: dock paints never wrap the Output body. */
	compactActivity(width: number): CompactPreviewActivity | undefined {
		const header = this.#header(width);
		if (!header) return undefined;
		return {
			callId: header.callId,
			commandVisible: header.commandVisible,
		};
	}

	#withoutCoveredOutput(call: LiveToolOutputSnapshot, output: string, width: number): string {
		if (!this.coveredDiff || call.terminalAt === undefined || !mayBeCoveredByFileDiff(call)) return output;
		const { details, name } = toolOutputSource(call.toolName, call.result, call.args);
		if (!details) return output;

		const cwd = this.ctx.viewSession.sessionManager.getCwd();
		const targets = new Map<string, string>();
		const conflicts =
			name === "write" && Array.isArray(details.conflictChanges) ? details.conflictChanges : undefined;
		const results = conflicts ?? (Array.isArray(details.perFileResults) ? details.perFileResults : [details]);
		for (const result of results) {
			if (!isRecord(result)) continue;
			const file = name === "write" && !conflicts ? result.resolvedPath : result.path;
			if (typeof file !== "string" || !path.isAbsolute(file)) continue;
			const diff = this.coveredDiff(call.toolCallId, file, width);
			if (diff === undefined) continue;
			if (result.op === "delete" ? diff !== "" : !diff || (name !== "write" && !result.diff)) continue;
			targets.set(file, diff);
			targets.set(formatPathRelativeToCwd(file, cwd), diff);
		}
		if (!targets.size) return output;

		const lines: string[] = [];
		let numbered: ReadonlySet<string> | undefined;
		let taggedHeader: string | undefined;
		const patchHeader = "Success. Updated the following files:";
		const patchReceipt = output.startsWith(`${patchHeader}\n`);
		let inWarnings = false;
		for (const line of output.split("\n")) {
			if (patchReceipt && line === patchHeader) {
				taggedHeader = line;
				continue;
			}
			if (line === "Warnings:") inWarnings = true;
			if (!inWarnings) {
				if (patchReceipt && /^[AMD] /u.test(line) && targets.has(line.slice(2))) continue;
				if (line.startsWith("Deleted ") && targets.get(line.slice("Deleted ".length)) === "") continue;
				const target = unwrapHashlineHeaderPath(line);
				if (target !== line) {
					const diff = targets.get(target);
					if (diff) {
						taggedHeader = line;
						numbered = this.#numberedDiffRows(diff);
						continue;
					}
					taggedHeader = undefined;
					numbered = undefined;
				}
				if (name === "write") {
					const receipt = /^Successfully wrote \d+ bytes to (.+)$/u.exec(line);
					if (receipt && targets.has(receipt[1]!)) continue;
				} else if (numbered?.has(line)) {
					continue;
				}
			}
			if (taggedHeader) lines.push(taggedHeader);
			taggedHeader = undefined;
			lines.push(line);
		}
		return lines.join("\n");
	}

	#numberedDiffRows(diff: string): Set<string> {
		if (this.#numberedDiff?.diff === diff) return this.#numberedDiff.rows;
		const rows = new Set<string>();
		let offset = 0;
		for (const line of diff.split("\n")) {
			const match = /^([-+ ])\s*(\d+)\|(.*)$/u.exec(line);
			if (!match) continue;
			const [, marker, n, content] = match;
			rows.add(replaceTabs(line).trimStart());
			if (marker === "-") {
				offset--;
			} else {
				rows.add(`${marker === "+" ? n : Number(n) + offset}:${replaceTabs(content!)}`);
				if (marker === "+") offset++;
			}
		}
		this.#numberedDiff = { diff, rows };
		return rows;
	}

	#header(width: number): PreviewHeader | undefined {
		const selected = this.#source(width);
		if (cfgDisplayMode.get(this.ctx.settings) !== "compact" || !selected || width < 1) return undefined;
		const height = Math.max(0, Math.min(6, Math.floor(this.availableRows())));
		if (height === 0) return undefined;
		const inset = Math.min(1, width - 1);
		const contentWidth = width - inset;
		const { call, text: output } = selected;
		const source = toolOutputSource(call.toolName, call.result, call.args);
		const info = compactToolPreviewInfo(call.toolName, call.args, call.intent, call.result);
		const { name: toolName, details, shellDetails } = source;
		const lifecycle = shellDetails ?? details;
		const job = isRecord(lifecycle?.async) ? lifecycle.async : undefined;
		const state: PreviewState =
			call.terminalAt === undefined
				? "running"
				: job?.state === "cancelled" || lifecycle?.cancelled === true
					? "cancelled"
					: call.result?.isError || job?.state === "failed"
						? "failed"
						: "completed";
		const name = singleLine(info.name);
		const nameWidth = visibleWidth(name);
		const jobIdentity = typeof job?.jobId === "string" ? singleLine(job.jobId) : "";
		const word = PREVIEW_STATE_WORD[state];
		const wordWidth = visibleWidth(word);
		const separator = " · ";
		const separatorWidth = visibleWidth(separator);
		const gap = contentWidth >= wordWidth + separatorWidth + nameWidth ? separator : " ";
		const identityRoom = contentWidth - wordWidth - visibleWidth(gap);
		const jobRoom = identityRoom - nameWidth - separatorWidth;
		const identityText =
			identityRoom < nameWidth
				? truncateToWidth(name, identityRoom, "")
				: jobIdentity && jobRoom > 1
					? `${name}${separator}${truncateMiddleToWidth(jobIdentity, jobRoom)}`
					: name;
		// At widths where status and source cannot both be legible, retain the source.
		const statusStyle =
			state === "completed" ? PREVIEW_STATE_COLOR.completed : `${PREVIEW_STATE_COLOR[state]} strong`;
		const spans = identityText
			? [{ t: word, s: statusStyle }, { t: gap }, { t: identityText, s: "toolTitle strong" }]
			: [{ t: truncateToWidth(name, contentWidth, ""), s: "toolTitle strong" }];
		const command = info.command ? singleLine(info.command) : "";
		const target = command || singleLine(info.detail);
		const targetRoom = identityText ? identityRoom - visibleWidth(identityText) - separatorWidth : 0;
		const targetText = target && targetRoom > 0 ? truncateMiddleToWidth(target, targetRoom) : "";
		const targetVisible = targetText !== "" && (targetText === target || targetText.replace("…", "").trim() !== "");
		if (targetVisible) spans.push({ t: separator }, { t: targetText, s: "toolOutput" });
		return {
			height,
			contentWidth,
			left: spaces(inset),
			state,
			spans,
			callId: call.toolCallId,
			commandVisible: !!command && targetVisible,
			toolName,
			output,
		};
	}

	#body(header: PreviewHeader): OutputRows {
		return header.height > 1
			? selectOutputRows(header.output, header.contentWidth, header.height - 1, header.toolName, header.state)
			: { lines: [], diagnosticCount: 0 };
	}

	render(width: number): readonly string[] {
		const header = this.#header(width);
		if (!header) return [];
		const theme = currentTheme();
		const bg = PREVIEW_BLOCK_BG[header.state];
		const paint = (row: string) => header.left + theme.bgFill(bg, padTo(row, header.contentWidth));
		const { lines, diagnosticCount } = this.#body(header);
		return [
			paint(header.spans.map(span => theme.style(span.s, span.t)).join("")),
			...lines.map((line, i) => paint(theme.style(i < diagnosticCount ? "error strong" : "toolOutput", line))),
		];
	}
}
