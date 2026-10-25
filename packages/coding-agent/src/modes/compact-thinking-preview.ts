import type { Component } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { InteractiveModeContext } from "./types";

/** A live composer projection, never a transcript child or a retained thinking snapshot. */
export class CompactThinkingPreview implements Component {
	constructor(
		private readonly ctx: Pick<
			InteractiveModeContext,
			"streamingComponent" | "viewSession" | "effectiveHideThinkingBlock"
		>,
	) {}

	render(width: number): readonly string[] {
		// A completed thinking block remains the message tail until the next block
		// arrives; transient reveal updates alone do not mean it is still active.
		if (
			this.ctx.effectiveHideThinkingBlock ||
			this.ctx.viewSession.isAborting ||
			this.ctx.viewSession.agent.state.activeThinkingIndex === undefined
		) {
			return [];
		}
		return this.ctx.streamingComponent?.renderCompactThinkingPreview(width) ?? [];
	}

	describe(cx: DescribeContext): NativeNode {
		return { k: "rows", p: { cols: cx.cols, lines: this.render(cx.cols) } };
	}
}
