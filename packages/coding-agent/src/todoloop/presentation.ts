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

function statusLines(state: TodoLoopState): string[] {
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
	return lines;
}

export function todoLoopStatusView(state: () => TodoLoopState): JSXNode {
	return jsx("col", {
		children: () =>
			statusLines(state()).map(line => jsx("text", { text: clean(line), wrap: "none", truncate: "end" })),
	});
}

function todoLoopCheckLines(state: TodoLoopState, snapshot?: TodoLoopSnapshot): string[] {
	const lines = statusLines(state);
	if (snapshot) {
		for (const group of snapshot.groups) {
			lines.push(`Group ${group.id}: ${group.title}`);
			for (const task of group.tasks)
				lines.push(`  [${task.done ? "x" : " "}] ${task.label ?? task.id} ${task.text}`);
		}
		const group = snapshot.groups.find(group => group.tasks.some(task => !task.done));
		const task = group?.tasks.find(task => !task.done);
		lines.push(`First incomplete group: ${group?.id ?? "none"} · task: ${task?.label ?? task?.id ?? "none"}`);
	}
	return lines;
}

function wrappedStatusView(lines: string[]): JSXNode {
	return jsx("col", { children: lines.map(line => jsx("text", { text: clean(line), wrap: "word" })) });
}

// Explicit command cards are not part of the model's tool activity. Index each native
// block without retaining it after transcript replacement.
const attemptsByBlock = new WeakMap<TranscriptBlock, ToolCall>();

export function isLiveTodoLoopCard(block: TranscriptBlock): boolean {
	const card = attemptsByBlock.get(block);
	return card !== undefined && card.facts.settledAt() === undefined;
}

interface TodoLoopViewRecord {
	draw: () => JSXNode;
	card?: ToolCall;
	live?: boolean;
	block?: TranscriptBlock;
}

interface TodoLoopViewRecords {
	session: InteractiveModeContext["session"];
	id: string;
	generation: number;
	pending: TodoLoopViewRecord[];
	widget?: { key: string; draw: () => JSXNode; visible: boolean };
}

const recordsByContext = new WeakMap<InteractiveModeContext, TodoLoopViewRecords>();
const suspendedViews = new WeakSet<InteractiveModeContext>();

function ownsSession(ctx: InteractiveModeContext, records: TodoLoopViewRecords): boolean {
	return (
		!ctx.isShuttingDown &&
		ctx.session === records.session &&
		ctx.session.sessionId === records.id &&
		ctx.session.sessionGeneration === records.generation &&
		!ctx.session.isDisposed
	);
}

function canPresent(ctx: InteractiveModeContext, records: TodoLoopViewRecords): boolean {
	return !ctx.collabGuest && !suspendedViews.has(ctx) && ctx.viewSession === records.session;
}

function syncWidget(ctx: InteractiveModeContext, records: TodoLoopViewRecords): void {
	const widget = records.widget;
	if (!widget) return;
	const visible = ownsSession(ctx, records) && canPresent(ctx, records);
	if (visible === widget.visible) return;
	widget.visible = visible;
	ctx.hud.widgets.set(widget.key, visible ? widget.draw : undefined);
}

function getViewRecords(ctx: InteractiveModeContext): TodoLoopViewRecords {
	const previous = recordsByContext.get(ctx);
	if (previous && ownsSession(ctx, previous)) return previous;
	if (previous) syncWidget(ctx, previous);
	const records: TodoLoopViewRecords = {
		session: ctx.session,
		id: ctx.session.sessionId,
		generation: ctx.session.sessionGeneration,
		pending: [],
	};
	recordsByContext.set(ctx, records);
	return records;
}

function mountRecord(ctx: InteractiveModeContext, record: TodoLoopViewRecord): void {
	record.block = ctx.present(record.draw, { live: record.live });
	if (record.card) attemptsByBlock.set(record.block, record.card);
}

function appendRecord(ctx: InteractiveModeContext, records: TodoLoopViewRecords, record: TodoLoopViewRecord): void {
	if (canPresent(ctx, records)) mountRecord(ctx, record);
	else records.pending.push(record);
}

export function presentTodoLoopCheck(
	ctx: InteractiveModeContext,
	state: TodoLoopState,
	snapshot?: TodoLoopSnapshot,
): void {
	const lines = todoLoopCheckLines(state, snapshot);
	appendRecord(ctx, getViewRecords(ctx), { draw: () => wrappedStatusView(lines) });
}

/** Focus changed but the shared transcript still owns the previous view until replay commits. */
export function suspendTodoLoopView(ctx: InteractiveModeContext): void {
	suspendedViews.add(ctx);
	const records = recordsByContext.get(ctx);
	if (records) syncWidget(ctx, records);
}

/** Resume the dock and deliver output that never reached the transcript. */
export function restoreTodoLoopView(ctx: InteractiveModeContext): void {
	suspendedViews.delete(ctx);
	const records = recordsByContext.get(ctx);
	if (!records) return;
	syncWidget(ctx, records);
	if (!ownsSession(ctx, records)) {
		recordsByContext.delete(ctx);
		return;
	}
	if (!canPresent(ctx, records)) return;
	for (const entry of records.pending) mountRecord(ctx, entry);
	records.pending.length = 0;
}

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
	readonly #attempts = new Map<string, TodoLoopViewRecord & { card: ToolCall }>();
	readonly #ctx: InteractiveModeContext;
	readonly #widgetKey = `todoloop:${crypto.randomUUID()}`;
	#lastCard?: ToolCall;
	readonly #liveDetails = new Map<string, NonNullable<TodoLoopAttemptEvent["details"]>>();
	readonly #records: TodoLoopViewRecords;
	#closed = false;

	constructor(ctx: InteractiveModeContext, state: TodoLoopState) {
		this.#ctx = ctx;
		this.#records = getViewRecords(ctx);
		this.#state = signal(state);
		this.#records.widget = {
			key: this.#widgetKey,
			draw: () => todoLoopStatusView(this.#state),
			visible: false,
		};
		syncWidget(ctx, this.#records);
	}

	#ownsSession(): boolean {
		return !this.#closed && ownsSession(this.#ctx, this.#records);
	}

	/** Remove the live status and leave one final snapshot behind the execution cards. */
	finish(): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		const lines = statusLines(this.#state.peek());
		this.dispose();
		appendRecord(this.#ctx, this.#records, { draw: () => wrappedStatusView(lines) });
	}

	/** Only detach our own dock; other commands and native loaders own their rows. */
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#records.widget?.key !== this.#widgetKey) return;
		if (this.#records.widget.visible) this.#ctx.hud.widgets.set(this.#widgetKey, undefined);
		this.#records.widget = undefined;
	}

	onState(state: TodoLoopState): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		this.#state.set(state);
		syncWidget(this.#ctx, this.#records);
	}

	onAttempt(event: TodoLoopAttemptEvent): void {
		if (!this.#ownsSession()) {
			this.dispose();
			return;
		}
		syncWidget(this.#ctx, this.#records);
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
			const ctx = this.#ctx;
			let globalExpanded = ctx.toolOutputExpanded;
			card.setExpanded(this.#lastCard?.state().expanded ?? (!ctx.hideToolActivity && globalExpanded));
			this.#lastCard = card;
			card.setExecutionStarted();
			attempt = {
				card,
				live: true,
				draw: () => {
					effect(() => {
						const expanded = ctx.toolOutputExpanded;
						if (!ctx.hideToolActivity && expanded !== globalExpanded) card.setExpanded(expanded);
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
			};
			appendRecord(this.#ctx, this.#records, attempt);
			this.#attempts.set(event.id, attempt);
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
			attempt.live = false;
			if (block && canPresent(this.#ctx, this.#records)) this.#ctx.shell.transcript.settle(block);
			this.#liveDetails.delete(event.id);
		}
	}
}
