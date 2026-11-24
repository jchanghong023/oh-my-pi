import { effect, jsx, type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentProgress, SingleResult, TaskToolDetails } from "../task/task-details";
import { settledRevision, type TranscriptBlock } from "../ui/shell/transcript";
import { createTaskRecordPresenter } from "../ui/tools/task";
import { toolCallDetail } from "../ui/tools/task/rows";
import { ToolBlock, ToolCall } from "../ui/transcript/tool-block";
import { shortenPath } from "../utils/render-utils";
import { replaceTabs } from "../utils/text-width";
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

function attemptText(event: TodoLoopAttemptEvent, details: TaskToolDetails): string {
	const lines = [completionText(event), event.error];
	if (event.type === "end" && event.group) {
		for (const progress of details.progress ?? []) {
			for (const tool of progress.recentTools.toReversed()) {
				const detail = toolCallDetail(tool.intent, tool.args, tool.argsKey);
				lines.push(detail ? `${tool.tool}: ${detail}` : tool.tool);
			}
			lines.push(...progress.recentOutput.toReversed());
		}
	}
	return clean(lines.filter(Boolean).join("\n"));
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
	// Keep the last actual progress frame; the command record carries the outcome separately.
	if (event.type === "end" && results.length === 0) {
		for (const entry of progress) {
			entry.status =
				event.error || event.status === "failed"
					? "failed"
					: event.status === "cancelled"
						? "aborted"
						: "completed";
		}
	}
	return {
		projectAgentsDir: typeof details.projectAgentsDir === "string" ? details.projectAgentsDir : null,
		totalDurationMs:
			typeof details.totalDurationMs === "number"
				? details.totalDurationMs
				: Math.max(0, ...progress.map(entry => entry.durationMs)),
		progress,
		results,
	};
}

function statusLines(state: TodoLoopState, snapshot?: TodoLoopSnapshot): string[] {
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
	if (snapshot) {
		for (const group of snapshot.groups) {
			lines.push(`Group ${group.id}: ${group.title.replace(/\s+/g, " ")}`);
			for (const task of group.tasks)
				lines.push(`  [${task.done ? "x" : " "}] ${task.label ?? task.id} ${task.text.replace(/\s+/g, " ")}`);
		}
		const group = snapshot.groups.find(group => group.tasks.some(task => !task.done));
		const task = group?.tasks.find(task => !task.done);
		lines.push(`First incomplete group: ${group?.id ?? "none"} · task: ${task?.label ?? task?.id ?? "none"}`);
	}
	return lines;
}

export function todoLoopStatusView(state: () => TodoLoopState, snapshot?: TodoLoopSnapshot): JSXNode {
	return jsx("col", {
		children: () =>
			statusLines(state(), snapshot).map(line => jsx("text", { text: clean(line), wrap: "none", truncate: "end" })),
	});
}

// Explicit command cards are not part of the model's tool activity. Index each native
// block without retaining it after transcript replacement.
const attemptsByBlock = new WeakMap<TranscriptBlock, ToolCall>();

export function setTodoLoopCardsExpanded(ctx: InteractiveModeContext, expanded: boolean): boolean {
	let found = false;
	const { transcript } = ctx.shell;
	transcript.redraw(transcript.blocks(), block => {
		const card = attemptsByBlock.get(block);
		if (!card) return false;
		found = true;
		if (card.state().expanded === expanded && card.facts.fold() === undefined) return false;
		card.setExpanded(expanded);
		return true;
	});
	return found;
}

/** One mutable native status block; each real execution gets its own native task card. */
export class TodoLoopPresentation {
	readonly #state;
	readonly #attempts = new Map<string, { block: TranscriptBlock; card: ToolCall }>();
	readonly #ctx: InteractiveModeContext;
	readonly #widgetKey = `todoloop:${crypto.randomUUID()}`;
	#lastCard?: ToolCall;
	readonly #liveDetails = new Map<string, NonNullable<TodoLoopAttemptEvent["details"]>>();
	readonly #owner: InteractiveModeContext["session"];
	readonly #generation: number;
	readonly #sessionId: string;
	#closed = false;

	constructor(ctx: InteractiveModeContext, state: TodoLoopState) {
		this.#ctx = ctx;
		this.#owner = ctx.session;
		this.#generation = ctx.session.sessionGeneration;
		this.#sessionId = ctx.session.sessionId;
		this.#state = signal(state);
		ctx.hud.widgets.set(this.#widgetKey, () => todoLoopStatusView(this.#state));
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

	/** Remove the live status and leave one final snapshot behind the execution cards. */
	finish(): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		const state = this.#state.peek();
		this.dispose();
		this.#ctx.present(() => todoLoopStatusView(() => state));
	}

	/** Only detach our own dock; other commands and native loaders own their rows. */
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#ctx.hud.widgets.set(this.#widgetKey, undefined);
	}

	onState(state: TodoLoopState): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		this.#state.set(state);
	}

	onAttempt(event: TodoLoopAttemptEvent): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		let attempt = this.#attempts.get(event.id);
		if (event.type === "start" && !attempt) {
			const agent = event.group ? "task" : "scout";
			const label = groupLabel(event);
			const card = new ToolCall({
				id: event.id,
				name: "task",
				args: { agent, tasks: [{ agent, task: label }] },
				presenter: createTaskRecordPresenter(label),
			});
			card.setArgsComplete();
			let globalExpanded = this.#ctx.toolOutputExpanded;
			card.setExpanded(this.#lastCard?.state().expanded ?? (!this.#ctx.hideToolActivity && globalExpanded));
			this.#lastCard = card;
			card.setExecutionStarted();
			const block = this.#ctx.present(
				() => {
					effect(() => {
						const expanded = this.#ctx.toolOutputExpanded;
						if (!this.#ctx.hideToolActivity && expanded !== globalExpanded) card.setExpanded(expanded);
						globalExpanded = expanded;
					});
					const revise = settledRevision();
					let expanded = card.state().expanded;
					effect(() => {
						const next = card.state().expanded;
						if (next === expanded) return;
						expanded = next;
						untrack(revise);
					});
					return ToolBlock({ call: card });
				},
				{ live: true },
			);
			attempt = { card, block };
			this.#attempts.set(event.id, attempt);
			attemptsByBlock.set(block, card);
		}
		if (!attempt) return;
		const { card, block } = attempt;
		const previousDetails = this.#liveDetails.get(event.id);
		const details = event.details ? { ...previousDetails, ...event.details } : previousDetails;
		if (details) this.#liveDetails.set(event.id, details);
		const snapshot = { ...event, details };
		const taskDetails = cardDetails(snapshot);
		card.updateResult(
			{
				content: [{ type: "text", text: attemptText(snapshot, taskDetails) }],
				details: taskDetails,
				isError: Boolean(event.error) || event.status === "failed",
			},
			event.type !== "end",
		);
		if (event.type === "end") {
			card.seal();
			this.#ctx.shell.transcript.settle(block);
			this.#liveDetails.delete(event.id);
		}
	}
}
