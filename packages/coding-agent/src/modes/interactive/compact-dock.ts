import { type Accessor, signal } from "@oh-my-pi/pi-tui";
import type { LocalAgentSessionEvent } from "../../session/agent-session-events";
import { setTodoLoopCardsExpanded } from "../../todoloop/presentation";
import { CompactFileDiff } from "../compact-file-diff";
import { CompactThinkingPreview } from "../compact-thinking-preview";
import { CompactToolOutputPreview } from "../compact-tool-output-preview";
import { cfgMotionResolved } from "../settings";
import type { InteractiveModeContext } from "../types";
import { mountCompactDock } from "./compact-dock-view";

/** Owns the live-only activity, Output and Diff projections without changing session or transcript facts. */
export class CompactDock {
	readonly #active = signal(false);
	readonly #activity: CompactThinkingPreview;
	readonly #output: CompactToolOutputPreview;
	readonly #diff: CompactFileDiff;
	readonly invalidate: () => void;
	#todoExpanded = false;

	constructor(
		private readonly ctx: InteractiveModeContext,
		asyncWaitLabel: Accessor<string | undefined>,
		interrupt: () => void,
	) {
		const invalidate = () => this.invalidate();
		this.#diff = new CompactFileDiff(
			ctx,
			() => Math.min(Math.floor(ctx.shell.size().rows / 3), this.#availableRows()),
			invalidate,
		);
		this.#output = new CompactToolOutputPreview(
			ctx,
			() => this.#availableRows() - (ctx.viewSession.getLatestTurnToolDiffs()?.length ? 3 : 0),
			(id, path, width) => this.#diff.coveredDiff(id, path, width),
			invalidate,
		);
		this.#activity = new CompactThinkingPreview(ctx, asyncWaitLabel, width => this.#output.compactActivity(width));
		this.invalidate = mountCompactDock(
			ctx.shell,
			this.#active,
			width => this.#activity.rows(width),
			width => this.#output.render(width),
			width => this.#diff.render(width),
			() => asyncWaitLabel() !== undefined,
			() => cfgMotionResolved.get(ctx.settings).shimmer ?? "classic",
			interrupt,
		);
	}

	get todoExpanded(): boolean {
		return this.#todoExpanded;
	}

	setActive(active: boolean): void {
		if (this.#active.peek() === active) return;
		this.#active.set(active);
		if (active) this.restore();
		else {
			this.#todoExpanded = false;
			this.#output.clear();
			this.#diff.close();
		}
	}

	observe(event: LocalAgentSessionEvent): void {
		// Keep running-call facts current even when the view is not showing this dock.
		this.#activity.observe(event);
		if (!this.#active.peek()) return;
		this.#output.observe(event);
		if (event.type === "agent_start" || (event.type === "message_start" && event.message.role === "user")) {
			this.#diff.sync();
		}
		this.invalidate();
	}

	restore(): void {
		if (!this.#active.peek()) return;
		this.#output.restore();
		if (this.#todoExpanded) setTodoLoopCardsExpanded(this.ctx, true);
		this.invalidate();
	}

	clear(resetMemoryFor?: InteractiveModeContext["viewSession"]): void {
		this.#activity.clear(resetMemoryFor);
		this.#output.clear();
		this.#diff.clear();
		this.invalidate();
	}

	handleKey(key: string): boolean {
		return this.#active.peek() && this.#diff.handleKey(key);
	}

	toggleDetails(): boolean {
		if (!this.#active.peek()) return false;
		if (this.#diff.toggle()) return true;
		const expanded = !this.#todoExpanded;
		if (!setTodoLoopCardsExpanded(this.ctx, expanded)) return false;
		this.#todoExpanded = expanded;
		this.ctx.showStatus(`TodoLoop output expansion: ${expanded ? "enabled" : "disabled"}`);
		return true;
	}

	#availableRows(): number {
		const draftLines = this.ctx.composer.text().split("\n", 8).length;
		return Math.max(0, this.ctx.shell.size().rows - 8 - draftLines);
	}
}
