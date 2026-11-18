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
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
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

function selectOutputRows(
	output: string,
	width: number,
	budget: number,
	toolName: string,
	state: PreviewState,
): string[] {
	if (state === "failed") {
		const priority: string[] = [];
		const tail: string[] = [];
		const lines = output.split("\n");
		// Classify before wrapping so a narrow display cannot split the diagnostic marker.
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index]!;
			if (DIAGNOSTIC_ROW.test(line)) {
				priority.push(...wrapOutputRows(line, width).slice(0, budget - priority.length));
				if (priority.length === budget) return priority;
			} else if (tail.length < budget) {
				tail.unshift(...wrapOutputRows(line, width).slice(tail.length - budget));
			}
		}
		return [...priority, ...tail.slice(priority.length - budget)];
	}
	const rows = wrapOutputRows(output, width);
	if (state === "completed" && (toolName === "grep" || toolName === "glob")) {
		const isHit =
			toolName === "grep"
				? (row: string) => isMatchRow(row)
				: (row: string) => row.trim() !== "" && !isGroupedHeader(row);
		const hits = rows.filter(isHit);
		if (hits.length > 0) return [...hits, ...rows.filter(row => !isHit(row))].slice(0, budget);
	}
	return rows.slice(-budget);
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

type PreviewHeader = {
	height: number;
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

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui" | "statusLine">,
		private readonly availableRows: () => number = () => 6,
	) {}

	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#deadline = undefined;
		this.#session = undefined;
		this.#sessionId = undefined;
	}

	/** Synchronize even without a visible paint; close only after tool completion and activity stop. */
	observe(event: AgentSessionEvent): void {
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		)
			this.restore();
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
		const terminalAt = selected?.call.terminalAt;
		const turnRunning = this.ctx.statusLine.getTurnElapsedMs() !== null;
		// A new run does not inherit the previous run's finished preview: a source
		// terminal before the open window started is no longer retained. Running
		// sources (no terminalAt) keep their cross-run retention.
		const supersededByNewRun =
			terminalAt !== undefined && turnRunning && terminalAt < (this.ctx.statusLine.getTurnStartedAt() ?? 0);
		const deadline =
			terminalAt === undefined || turnRunning
				? undefined
				: Math.max(terminalAt, this.ctx.statusLine.getLastActivityEndAt() ?? terminalAt) + 3000;
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
		if (supersededByNewRun) return undefined;
		return deadline !== undefined && deadline <= Date.now() ? undefined : selected;
	}

	/** Header-only query: dock paints never wrap the Output body. */
	visibleCommandCallId(width: number): string | undefined {
		const header = this.#header(width);
		return header?.commandVisible ? header.callId : undefined;
	}

	#header(width: number): PreviewHeader | undefined {
		const selected = this.#source();
		if (!displayPreferences.compactToolActivity || !selected || width < 1) return undefined;
		const height = Math.max(0, Math.min(6, Math.floor(this.availableRows())));
		if (height === 0) return undefined;
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
		const gap = width >= wordWidth + separatorWidth + nameWidth ? separator : " ";
		const identityRoom = width - wordWidth - visibleWidth(gap);
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
			: [span(truncateToWidth(name, width, ""), "toolTitle strong")];
		const command = info.command ? singleLine(info.command) : "";
		const target = command || singleLine(info.detail);
		const targetRoom = identityText ? identityRoom - visibleWidth(identityText) - separatorWidth : 0;
		const targetText = target && targetRoom > 0 ? truncateMiddleToWidth(target, targetRoom) : "";
		const targetVisible = targetText !== "" && (targetText === target || targetText.replace("…", "").trim() !== "");
		if (targetVisible) spans.push(span(separator), span(targetText, "toolOutput"));
		return {
			height,
			state,
			spans,
			callId: call.toolCallId,
			commandVisible: !!command && targetVisible,
			toolName,
			output,
		};
	}

	#body(header: PreviewHeader, width: number): readonly string[] {
		return header.height > 1
			? selectOutputRows(header.output, width, header.height - 1, header.toolName, header.state)
			: [];
	}

	render(width: number): readonly string[] {
		const header = this.#header(width);
		if (!header) return [];
		const bg = getStateBgColor(PREVIEW_BLOCK_STATE[header.state]);
		const paint = (row: string) => padToWidth(row, width, value => theme.bgFill(bg, value));
		return [
			paint(spansLine(header.spans)),
			...this.#body(header, width).map(row => paint(theme.fg("toolOutput", row))),
		];
	}

	describe(cx: DescribeContext): NativeNode {
		const header = this.#header(cx.cols);
		if (!header) return { k: "rows", p: { cols: cx.cols, lines: [] } };
		const tone = backgroundChrome(getStateBgColor(PREVIEW_BLOCK_STATE[header.state])).tone;
		return col([
			text(header.spans, { wrap: "none", tone }),
			...this.#body(header, cx.cols).map(row => text([span(row, "toolOutput")], { wrap: "none", tone })),
		]);
	}
}
