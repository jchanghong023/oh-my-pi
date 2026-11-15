import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptBlock } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { WidthAwareText } from "@oh-my-pi/pi-tui/render/width-aware-text";
import { replaceTabs, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import type { TodoLoopSnapshot } from "./parser";
import type { TodoLoopAttemptEvent, TodoLoopState } from "./runner";

function clean(value: string): string {
	return replaceTabs(sanitizeText(value));
}

function completionText(event: TodoLoopAttemptEvent): string | undefined {
	if (!event.group) return undefined;
	const result = event.details?.evalResult;
	return event.text ?? (isRecord(result) && typeof result.text === "string" ? result.text : undefined);
}

function groupLabel(event: TodoLoopAttemptEvent): string {
	if (!event.group) return "TodoLoop shared background";
	return `Group ${clean(event.group.id)} · attempt ${event.attempt}/3 · ${clean(event.group.title).replace(/\s+/g, " ")}`;
}

/** The native job owns full dispatch text; the card exposes execution, not that private envelope. */
function cardDetails(event: TodoLoopAttemptEvent): TaskToolDetails {
	const details = event.details ?? {};
	const label = groupLabel(event);
	const redactAssignment = <T extends { task: string }>(entry: T): T => ({
		...entry,
		task: label,
		assignment: label,
		description: label,
	});
	const progress = Array.isArray(details.progress) ? (details.progress as AgentProgress[]).map(redactAssignment) : [];
	const results = Array.isArray(details.results) ? (details.results as SingleResult[]).map(redactAssignment) : [];
	if (event.type === "end" && results.length === 0) {
		for (const entry of progress) {
			entry.status =
				event.error || event.status === "failed"
					? "failed"
					: event.status === "cancelled"
						? "aborted"
						: "completed";
			const output = [completionText(event), event.error].filter(Boolean).join("\n");
			if (output) entry.recentOutput = [clean(output), ...entry.recentOutput];
		}
	}
	return {
		projectAgentsDir: typeof details.projectAgentsDir === "string" ? details.projectAgentsDir : null,
		totalDurationMs:
			typeof details.totalDurationMs === "number"
				? details.totalDurationMs
				: Math.max(0, ...progress.map(entry => entry.durationMs)),
		progress,
		showExecutionTrace: true,
		results,
	};
}

export class TodoLoopStatusBlock extends TranscriptBlock {
	#state: TodoLoopState;
	#snapshot?: TodoLoopSnapshot;
	#text: WidthAwareText;

	constructor(state: TodoLoopState, snapshot?: TodoLoopSnapshot) {
		super();
		this.#state = state;
		this.#snapshot = snapshot;
		this.#text = new WidthAwareText(width => this.#format(width), 0, 0);
		this.addChild(this.#text);
	}

	update(state: TodoLoopState): void {
		this.#state = state;
		this.#text.reformat();
	}

	isTranscriptBlockFinalized(): boolean {
		return (
			this.#snapshot !== undefined || !["checking", "running", "retrying", "stopping"].includes(this.#state.phase)
		);
	}

	#format(width: number): string {
		const state = this.#state;
		const lines = [
			`TodoLoop ${state.phase}`,
			`${state.completed}/${state.total} tasks · ${state.completedGroups}/${state.totalGroups} groups complete`,
			`File: ${shortenPath(state.filePath)}`,
		];
		if (state.group)
			lines.push(`Group ${state.group.id} · attempt ${state.attempt}/3 · ${state.group.title.replace(/\s+/g, " ")}`);
		if (state.current)
			lines.push(`Task ${state.current.label ?? state.current.id}: ${state.current.text.replace(/\s+/g, " ")}`);
		// Keep the live dock within six lines; execution bodies stay in native cards.
		if (state.reason) lines.push(`Reason: ${state.reason.replace(/\s+/g, " ")}`);
		if (this.#snapshot) {
			for (const group of this.#snapshot.groups) {
				lines.push(`Group ${group.id}: ${group.title.replace(/\s+/g, " ")}`);
				for (const task of group.tasks)
					lines.push(`  [${task.done ? "x" : " "}] ${task.label ?? task.id} ${task.text.replace(/\s+/g, " ")}`);
			}
			const group = this.#snapshot.groups.find(group => group.tasks.some(task => !task.done));
			const task = group?.tasks.find(task => !task.done);
			lines.push(`First incomplete group: ${group?.id ?? "none"} · task: ${task?.label ?? task?.id ?? "none"}`);
		}
		return lines.map(line => truncateToWidth(clean(line), width)).join("\n");
	}
}

/** Explicit command output, not ambient model tool activity hidden by compact display. */
export class TodoLoopTaskCard extends ToolExecutionComponent {
	override setToolActivityVisible(_visible: boolean): void {
		super.setToolActivityVisible(true);
	}
}

/** One mutable native status block; each real execution gets its own native task card. */
export class TodoLoopPresentation {
	readonly status: TodoLoopStatusBlock;
	readonly attempts = new Map<string, ToolExecutionComponent>();
	readonly #ctx: InteractiveModeContext;
	readonly #cwd: string;
	#lastCard?: ToolExecutionComponent;
	readonly #liveDetails = new Map<string, NonNullable<TodoLoopAttemptEvent["details"]>>();
	readonly #owner: InteractiveModeContext["session"];
	readonly #generation: number;
	readonly #sessionId: string;
	#closed = false;

	constructor(ctx: InteractiveModeContext, state: TodoLoopState) {
		this.#ctx = ctx;
		this.#cwd = ctx.sessionManager.getCwd();
		this.#owner = ctx.session;
		this.#generation = ctx.session.sessionGeneration;
		this.#sessionId = ctx.session.sessionId;
		this.status = new TodoLoopStatusBlock(state);
		this.#mount();
	}

	#ownsSession(): boolean {
		return (
			!this.#closed &&
			!this.#ctx.isShuttingDown &&
			this.#ctx.session === this.#owner &&
			this.#owner.sessionGeneration === this.#generation &&
			this.#owner.sessionId === this.#sessionId &&
			!this.#owner.isDisposed
		);
	}

	#mount(): void {
		if (!this.#ctx.statusContainer.children.includes(this.status)) this.#ctx.statusContainer.addChild(this.status);
		this.#ctx.ui.requestRender();
	}

	/** Move, never copy, the settled status behind every real execution card. */
	finish(): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		this.#ctx.statusContainer.removeChild(this.status);
		this.#closed = true;
		this.#ctx.present(this.status);
		this.#ctx.ui.requestRender();
	}

	/** Only detach our own dock; other commands and native loaders own their rows. */
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#ctx.statusContainer.removeChild(this.status);
		this.#ctx.ui.requestRender();
	}

	onState(state: TodoLoopState): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		this.status.update(state);
		this.#mount();
	}

	onAttempt(event: TodoLoopAttemptEvent): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		this.#mount();
		let card = this.attempts.get(event.id);
		if (event.type === "start" && !card) {
			card = new TodoLoopTaskCard(
				"task",
				{
					agent: event.group ? "task" : "scout",
					tasks: [{ agent: event.group ? "task" : "scout", task: groupLabel(event) }],
				},
				{ useBuiltInRenderer: true, transcriptPresenters: false },
				undefined,
				this.#ctx.ui,
				this.#cwd,
				event.id,
			);
			card.setArgsComplete(event.id);
			card.setExpanded(
				this.#lastCard?.isExpanded() ?? (!this.#ctx.hideToolActivity && this.#ctx.toolOutputExpanded),
			);
			this.#lastCard = card;
			card.setExecutionStarted(event.id);
			this.attempts.set(event.id, card);
			this.#ctx.present(card);
		}
		if (!card) return;
		const previousDetails = this.#liveDetails.get(event.id);
		const details = event.details ? { ...previousDetails, ...event.details } : previousDetails;
		if (details) this.#liveDetails.set(event.id, details);
		card.updateResult(
			{
				content: [{ type: "text", text: clean([completionText(event), event.error].filter(Boolean).join("\n")) }],
				details: cardDetails({ ...event, details }),
				isError: Boolean(event.error) || event.status === "failed",
			},
			event.type !== "end",
			event.id,
		);
		if (event.type === "end") {
			card.seal();
			this.#liveDetails.delete(event.id);
		}
		this.#ctx.ui.requestRender();
	}
}
