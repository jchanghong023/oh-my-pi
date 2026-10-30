import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { paintCompactThinking } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { isSettledJobFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { nonEmptyTailLines } from "@oh-my-pi/pi-tui/render/output-pane";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { InteractiveModeContext } from "./types";

const EMPTY_THINKING_ROW: readonly string[] = ["", ""];

/** A live composer projection, never a transcript child or a retained thinking snapshot. */
export class CompactThinkingPreview implements Component {
	#sourceRows?: readonly string[];
	#rows: readonly string[] = EMPTY_THINKING_ROW;
	#toolUpdate?: Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
	#toolWidth = 0;
	#toolRows: readonly string[] = [];

	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"streamingComponent" | "viewSession" | "effectiveHideThinkingBlock"
		>,
	) {}

	render(width: number): readonly string[] {
		if (!displayPreferences.compactToolActivity || displayPreferences.hideToolActivity) {
			this.#sourceRows = undefined;
			this.#rows = EMPTY_THINKING_ROW;
			return [];
		}
		// Thinking keeps its existing rendering and takes precedence over tool output.
		let rows: readonly string[] | undefined;
		if (!this.ctx.viewSession.isAborting) {
			if (
				!this.ctx.effectiveHideThinkingBlock &&
				this.ctx.viewSession.agent.state.activeThinkingIndex !== undefined
			) {
				rows = this.ctx.streamingComponent?.renderCompactThinkingPreview(width);
			}
			if (!rows?.length) rows = this.#renderToolOutput(width);
		}
		if (!rows?.length) {
			this.#sourceRows = undefined;
			this.#rows = EMPTY_THINKING_ROW;
			return EMPTY_THINKING_ROW;
		}
		if (rows !== this.#sourceRows) {
			this.#sourceRows = rows;
			this.#rows = [rows[0]!, ""];
		}
		return this.#rows;
	}

	#renderToolOutput(width: number): readonly string[] | undefined {
		const session = this.ctx.viewSession;
		const updates = session.activeToolExecutionUpdates();
		for (let index = updates.length - 1; index >= 0; index--) {
			const update = updates[index]!;
			if (update.toolName !== "bash" && update.toolName !== "eval") continue;
			const result = update.partialResult as AgentToolResult<unknown>;
			if (isSettledJobFrame(result.details) && !session.agent.state.pendingToolCalls.has(update.toolCallId)) {
				continue;
			}
			if (update === this.#toolUpdate && width === this.#toolWidth) return this.#toolRows;
			const output =
				update.toolName === "eval"
					? (result.details as EvalToolDetails | undefined)?.cells?.findLast(cell => cell.status === "running")
							?.output
					: textContent(result.content, "\n");
			const lastLine = output === undefined ? undefined : nonEmptyTailLines(output, 1)[0];
			if (lastLine === undefined) continue;
			const line = truncateToWidth(replaceTabs(sanitizeText(lastLine)), Math.max(0, width - 2));
			if (!line.trim()) continue;
			this.#toolUpdate = update;
			this.#toolWidth = width;
			this.#toolRows = [paintCompactThinking(` ${line}`)];
			return this.#toolRows;
		}
		this.#toolUpdate = undefined;
		return undefined;
	}

	describe(cx: DescribeContext): NativeNode {
		return { k: "rows", p: { cols: cx.cols, lines: this.render(cx.cols) } };
	}
}
