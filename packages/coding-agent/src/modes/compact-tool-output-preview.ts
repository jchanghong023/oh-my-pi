import type { Component } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { col, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { plainText, spansLine } from "@oh-my-pi/pi-tui/native/spans";
import { backgroundChrome } from "@oh-my-pi/pi-tui/native/tone";
import { truncateMiddleToWidth, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/render/render-utils";
import type { State } from "@oh-my-pi/pi-tui/render/types";
import { getStateBgColor, padToWidth } from "@oh-my-pi/pi-tui/render/utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme/theme";
import { isGroupedHeader, isMatchRow } from "@oh-my-pi/pi-tui/tools/grouped-file-output";
import { isToolOutputRow, toolOutputSource, toolOutputText } from "@oh-my-pi/pi-tui/tools/output-preview";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { getPaddingX, padding, visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import type { LiveToolOutputSnapshot } from "../session/agent-session-handle";
import { compactToolPreviewInfo } from "./compact-thinking-preview";
import type { InteractiveModeContext } from "./types";

function singleLine(value: string): string {
	return plainText(value)
		.replace(/[\r\n]+/g, " ")
		.trim();
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

const PREVIEW_STATE_COLOR: Record<PreviewState, ThemeColor> = {
	running: "accent",
	completed: "success",
	failed: "error",
	cancelled: "warning",
};

/** Map the preview lifecycle onto the shared output-block visual state. */
const PREVIEW_BLOCK_STATE: Record<PreviewState, State> = {
	running: "running",
	completed: "success",
	failed: "error",
	cancelled: "pending",
};

export interface CompactPreviewActivity {
	callId: string;
	commandVisible: boolean;
	outputChangedAt?: number;
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
export class CompactToolOutputPreview implements Component {
	#timer?: NodeJS.Timeout;
	#deadline?: number;
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#outputText = new WeakMap<ToolRenderResult<unknown>, string>();
	#recentOutput?: { callId: string; text: string; changedAt: number };

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui">,
		private readonly availableRows: () => number = () => 6,
	) {}

	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#deadline = undefined;
		this.#session = undefined;
		this.#sessionId = undefined;
		this.#recentOutput = undefined;
	}

	/** Synchronize even without a visible paint; close only after tool completion and activity stop. */
	observe(event: AgentSessionEvent): void {
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			const selected = this.#source();
			if (!selected || selected.call.terminalAt !== undefined) {
				this.#recentOutput = undefined;
				return;
			}
			if (selected.call.toolCallId !== event.toolCallId) return;
			if (this.#recentOutput?.callId !== event.toolCallId || this.#recentOutput.text !== selected.output) {
				this.#recentOutput = { callId: event.toolCallId, text: selected.output, changedAt: Date.now() };
			}
		}
	}

	restore(): void {
		this.#source();
	}

	#source(): { call: LiveToolOutputSnapshot; output: string } | undefined {
		const session = this.ctx.viewSession;
		const sessionId = session.sessionManager.getSessionId();
		if (session !== this.#session || sessionId !== this.#sessionId) {
			this.clear();
			this.#session = session;
			this.#sessionId = sessionId;
		}
		let selected: { call: LiveToolOutputSnapshot; output: string } | undefined;
		for (const call of session.getLiveToolOutputSnapshot()) {
			if (!call.result || (selected && call.dispatchOrder <= selected.call.dispatchOrder)) continue;
			let output = this.#outputText.get(call.result);
			if (output === undefined) {
				output = toolOutputText(call.toolName, call.result, call.args);
				this.#outputText.set(call.result, output);
			}
			if (output) selected = { call, output };
		}
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
						this.ctx.ui.requestRender();
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
			outputChangedAt:
				header.height > 1 && this.#recentOutput?.callId === header.callId
					? this.#recentOutput.changedAt
					: undefined,
		};
	}

	#header(width: number): PreviewHeader | undefined {
		const selected = this.#source();
		if (!displayPreferences.compactToolActivity || !selected || width < 1) return undefined;
		const height = Math.max(0, Math.min(6, Math.floor(this.availableRows())));
		if (height === 0) return undefined;
		const inset = Math.min(getPaddingX(1), width - 1);
		const contentWidth = width - inset;
		const { call, output } = selected;
		const info = compactToolPreviewInfo(call.toolName, call.args, call.intent, call.result);
		const { name: toolName, details } = toolOutputSource(call.toolName, call.result);
		const job = isRecord(details?.async) ? details.async : undefined;
		const state: PreviewState =
			call.terminalAt === undefined
				? "running"
				: job?.state === "cancelled" || details?.cancelled === true
					? "cancelled"
					: call.result?.isError || job?.state === "failed"
						? "failed"
						: "completed";
		const name = singleLine(info.name);
		const nameWidth = visibleWidth(name);
		const jobIdentity = [job?.name, job?.jobId]
			.map(value => (typeof value === "string" ? singleLine(value) : ""))
			.filter(Boolean)
			.join(" · ");
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
		const spans = identityText
			? [span(word, `${PREVIEW_STATE_COLOR[state]} strong`), span(gap), span(identityText, "toolTitle strong")]
			: [span(truncateToWidth(name, contentWidth, ""), "toolTitle strong")];
		const command = info.command ? singleLine(info.command) : "";
		const target = command || singleLine(info.detail);
		const targetRoom = identityText ? identityRoom - visibleWidth(identityText) - separatorWidth : 0;
		const targetText = target && targetRoom > 0 ? truncateMiddleToWidth(target, targetRoom) : "";
		const targetVisible = targetText !== "" && (targetText === target || targetText.replace("…", "").trim() !== "");
		if (targetVisible) spans.push(span(separator), span(targetText, "toolOutput"));
		return {
			height,
			contentWidth,
			left: padding(inset),
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
		const bg = getStateBgColor(PREVIEW_BLOCK_STATE[header.state]);
		const paint = (row: string) => padToWidth(header.left + row, width, value => theme.bgFill(bg, value));
		const { lines, diagnosticCount } = this.#body(header);
		return [
			paint(spansLine(header.spans)),
			...lines.map((line, i) =>
				paint(i < diagnosticCount ? theme.bold(theme.fg("error", line)) : theme.fg("toolOutput", line)),
			),
		];
	}

	describe(cx: DescribeContext): NativeNode {
		const header = this.#header(cx.cols);
		if (!header) return { k: "rows", p: { cols: cx.cols, lines: [] } };
		const tone = backgroundChrome(getStateBgColor(PREVIEW_BLOCK_STATE[header.state])).tone;
		const { lines, diagnosticCount } = this.#body(header);
		return col([
			text([span(header.left), ...header.spans], { wrap: "none", tone }),
			...lines.map((line, i) =>
				text([span(header.left), span(line, i < diagnosticCount ? "error strong" : "toolOutput")], {
					wrap: "none",
					tone,
				}),
			),
		]);
	}
}
