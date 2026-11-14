import type { Component } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { span } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { plainText, rowsText } from "@oh-my-pi/pi-tui/native/spans";
import { describeOutputBlock, outputBlockContentWidth, renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { replaceTabs, truncateMiddleToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/render/render-utils";
import type { State } from "@oh-my-pi/pi-tui/render/types";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme/theme";
import { isGroupedHeader, isMatchRow } from "@oh-my-pi/pi-tui/tools/grouped-file-output";
import { toolOutputText } from "@oh-my-pi/pi-tui/tools/output-preview";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import type { LiveToolOutputSnapshot } from "../session/agent-session-handle";
import { compactToolPreviewInfo } from "./compact-thinking-preview";
import type { InteractiveModeContext } from "./types";

function singleLine(value: string): string {
	return replaceTabs(sanitizeText(plainText(value))).replace(/[\r\n]+/g, " ");
}

function compactOutputText(output: string): string {
	const lines = output.split("\n").filter(line => /[\p{L}\p{N}]/u.test(line));
	if (lines.length === 0) return "";
	let indent = Number.POSITIVE_INFINITY;
	for (const line of lines) indent = Math.min(indent, line.length - line.trimStart().length);
	return lines.map(line => line.slice(indent)).join("\n");
}

/** Inner tool identity and details behind an existing device dispatch; direct calls pass through. */
function effectiveTool(
	toolName: string,
	result: ToolRenderResult<unknown> | undefined,
): { name: string; details: Record<string, unknown> | undefined } {
	const details = isRecord(result?.details) ? result.details : undefined;
	const dispatch = isRecord(details?.xdev) ? details.xdev : undefined;
	if (toolName === "write" && typeof dispatch?.tool === "string" && dispatch.mode !== "help")
		return { name: dispatch.tool, details: isRecord(dispatch.inner) ? dispatch.inner : undefined };
	return { name: toolName, details };
}

/**
 * Terminal selection for structured native searches: hit rows first (original order), then the
 * remaining rows fill the budget. No hit rows falls back to the tail window; other tools tail.
 */
function selectOutputRows(rows: readonly string[], budget: number, toolName: string, terminal: boolean): string[] {
	if (terminal && (toolName === "grep" || toolName === "glob")) {
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
				output = compactOutputText(toolOutputText(call.toolName, call.result, call.args));
				this.#outputText.set(call.result, output);
			}
			if (output.trim()) selected = { call, output };
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

	/** Shared ANSI/native projection of the selected source within the row budget. */
	#projection(width: number): { state: PreviewState; head: string; headSpans: TspSpan[]; body: string[] } | undefined {
		const selected = this.#source();
		if (!displayPreferences.compactToolActivity || !selected || width < 1) return undefined;
		const height = Math.max(0, Math.min(6, Math.floor(this.availableRows())));
		if (height === 0) return undefined;
		const { call, output } = selected;
		const info = compactToolPreviewInfo(call.toolName, call.args, call.intent, call.result);
		const effective = effectiveTool(call.toolName, call.result);
		const details = effective.details;
		const job = isRecord(details?.async) ? details.async : undefined;
		const state: PreviewState =
			call.terminalAt === undefined
				? "running"
				: job?.state === "cancelled" || details?.cancelled === true
					? "cancelled"
					: call.result?.isError || job?.state === "failed"
						? "failed"
						: "completed";
		const identity = [
			info.name,
			typeof job?.name === "string" ? job.name : undefined,
			typeof job?.jobId === "string" ? job.jobId : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		const target = singleLine(info.command || info.detail);
		// The frame's top bar embeds the header: ╭─── + " label " + ───╮.
		const labelRoom = Math.max(0, width - 10);
		const word = PREVIEW_STATE_WORD[state];
		const identityRoom = Math.max(0, labelRoom - visibleWidth(word) - 3);
		const identityText = truncateMiddleToWidth(identity, identityRoom);
		const targetRoom = target ? labelRoom - visibleWidth(word) - visibleWidth(identityText) - 6 : 0;
		const targetText = target && targetRoom >= 1 ? truncateMiddleToWidth(target, targetRoom) : "";
		const headParts = [word, identityText, targetText].filter(Boolean);
		const head = headParts.join(" · ");
		const headSpans = [
			span(word, PREVIEW_STATE_COLOR[state]),
			...(identityText ? [span(" · "), span(identityText, "muted")] : []),
			...(targetText ? [span(" · "), span(targetText, "dim")] : []),
		];
		// Two border rows leave the rest for output; the frame owns left/right padding.
		const bodyBudget = Math.max(0, height - 2);
		const contentWidth = outputBlockContentWidth(width);
		const body =
			bodyBudget > 0
				? selectOutputRows(
						wrapTextWithAnsi(output, contentWidth).filter(row => /[\p{L}\p{N}]/u.test(row)),
						bodyBudget,
						effective.name,
						call.terminalAt !== undefined,
					)
				: [];
		return { state, head, headSpans, body };
	}

	render(width: number): readonly string[] {
		const projection = this.#projection(width);
		if (!projection) return [];
		return renderOutputBlock(
			{
				header: projection.head,
				state: PREVIEW_BLOCK_STATE[projection.state],
				sections: [{ lines: projection.body }],
				width,
			},
			theme,
		);
	}

	describe(cx: DescribeContext): NativeNode {
		const projection = this.#projection(cx.cols);
		if (!projection) return { k: "rows", p: { cols: cx.cols, lines: [] } };
		return describeOutputBlock({
			head: projection.headSpans,
			state: PREVIEW_BLOCK_STATE[projection.state],
			sections: [{ body: [rowsText(projection.body)] }],
		});
	}
}
