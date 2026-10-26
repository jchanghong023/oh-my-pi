import type { Component } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { InteractiveModeContext } from "./types";

const EMPTY_THINKING_ROW: readonly string[] = [""];

/** A live composer projection, never a transcript child or a retained thinking snapshot. */
export class CompactThinkingPreview implements Component {
	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"streamingComponent" | "viewSession" | "effectiveHideThinkingBlock"
		>,
	) {}

	render(width: number): readonly string[] {
		if (!displayPreferences.compactToolActivity || displayPreferences.hideToolActivity) return [];
		// A completed thinking block remains the message tail until the next block
		// arrives; transient reveal updates alone do not mean it is still active.
		if (
			this.ctx.effectiveHideThinkingBlock ||
			this.ctx.viewSession.isAborting ||
			this.ctx.viewSession.agent.state.activeThinkingIndex === undefined
		) {
			return EMPTY_THINKING_ROW;
		}
		const rows = this.ctx.streamingComponent?.renderCompactThinkingPreview(width);
		return rows?.length ? rows : EMPTY_THINKING_ROW;
	}

	describe(cx: DescribeContext): NativeNode {
		return { k: "rows", p: { cols: cx.cols, lines: this.render(cx.cols) } };
	}
}
