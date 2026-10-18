/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Component } from "../tui";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import type { JobSnapshot } from "../tools/wait";
import type { StructuredSubagentOutput } from "../tools/task";
import { chatTranscriptDisplayPreferences as displayPreferences } from "./display-preferences";
import { col } from "../native/describe";
import type { NativeNode } from "../native/node";
import type { DaemonSnapshot } from "../tools/daemon";
import { type CustomMessage, type FileMentionMessage, resolveAbortLabel, shouldRenderAbortReason } from "./messages";
import { createIrcMessageCard } from "../tools/wait";
import { formatArtifactErrorNotice, type OutputMeta } from "../tools/output-meta";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../render/render-utils";
import { canonicalizeMessage } from "./thinking-display";
import { ToolActivityContainer } from "../chrome/tool-activity";
import {
	type CompactBackgroundCounts,
	type CompactBackgroundJob,
	type TranscriptBlock,
} from "../chrome/transcript-container";
import { TranscriptStatusBlock, type TranscriptStatusRow } from "../chrome/transcript-status";
import { theme } from "../theme";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/** Background completion rows retain their originals while compact mode projects a segment-local count. */
class AsyncResultBlock extends ToolActivityContainer {
	readonly #compactRows: readonly TranscriptStatusRow[];
	readonly #jobs: readonly (CompactBackgroundJob | undefined)[];
	readonly #compactOverride: boolean | undefined;
	#counts: readonly CompactBackgroundCounts[];
	#compactBlock: TranscriptStatusBlock;
	#visible = true;

	constructor(
		original: TranscriptStatusBlock,
		rows: readonly TranscriptStatusRow[],
		jobs: readonly (CompactBackgroundJob | undefined)[],
		compactOverride?: boolean,
	) {
		super(original);
		this.#compactRows = rows;
		this.#jobs = jobs;
		this.#compactOverride = compactOverride;
		this.#counts = [];
		this.#compactBlock = new TranscriptStatusBlock([]);
		const counts = jobs.map(() => ({ completed: 0, failed: 0 }));
		const identities = new Set<string>();
		let anchor = -1;
		for (let index = 0; index < jobs.length; index++) {
			const job = jobs[index];
			if (job === undefined) {
				anchor = -1;
				identities.clear();
			} else {
				if (anchor < 0) anchor = index;
				if (!identities.has(job.id)) {
					identities.add(job.id);
					if (job.failed) counts[anchor]!.failed++;
					else counts[anchor]!.completed++;
				}
			}
		}
		this.setCompactBackgroundCounts(counts);
	}

	isCompactToolActivity(): boolean {
		return this.#compactOverride ?? displayPreferences.compactToolActivity;
	}

	/** Undefined slots are independent visible boundaries, not ordinary terminal notifications. */
	getCompactBackgroundJobs(): readonly (CompactBackgroundJob | undefined)[] {
		return this.#jobs;
	}

	setCompactBackgroundCounts(counts: readonly CompactBackgroundCounts[]): boolean {
		if (
			counts.every(
				(count, index) =>
					count.completed === this.#counts[index]?.completed && count.failed === this.#counts[index]?.failed,
			)
		) {
			return false;
		}
		this.#counts = counts;
		const rows: TranscriptStatusRow[] = [];
		for (let index = 0; index < this.#compactRows.length; index++) {
			const count = counts[index]!;
			if (this.#jobs[index] === undefined) {
				rows.push(this.#compactRows[index]!);
			} else if (count.completed > 0 || count.failed > 0) {
				rows.push({
					parts: [
						count.completed > 0
							? { text: `${theme.status.done} 后台任务已完成 ${count.completed} 项`, color: "success" }
							: undefined,
						count.failed > 0
							? {
									text: `${count.completed > 0 ? "· " : "… 后台任务"}失败 ${count.failed} 项`,
									color: "dim",
								}
							: undefined,
					],
				});
			}
		}
		this.#compactBlock = new TranscriptStatusBlock(rows);
		this.invalidate();
		return true;
	}

	override setToolActivityVisible(visible: boolean): void {
		this.#visible = visible;
		super.setToolActivityVisible(visible);
	}

	override render(width: number): readonly string[] {
		if (!this.isCompactToolActivity()) return super.render(width);
		return this.#visible ? this.#compactBlock.render(width) : [];
	}

	override describe(): NativeNode {
		if (!this.isCompactToolActivity()) return super.describe();
		return col(
			[this.#compactBlock],
			this.#visible ? { role: "omp.activity" } : { role: "omp.activity", hidden: true },
		);
	}
}

/**
 * Project actual async delivery identities/states, without changing the persisted
 * message or the original clean/detailed presentation.
 */
export function buildAsyncResultBlock(
	message: CustomOrHookMessage,
	compactToolActivity?: boolean,
): ToolActivityContainer {
	type JobDetails = {
		jobId?: string;
		type?: JobSnapshot["type"];
		status?: JobSnapshot["status"];
		label?: string;
		durationMs?: number;
		meta?: OutputMeta;
		schema?: StructuredSubagentOutput;
	};
	const details = (message as CustomMessage<JobDetails & { jobs?: JobDetails[] }>).details;
	const jobs = details?.jobs && details.jobs.length > 0 ? details.jobs : [details ?? {}];
	const rows: TranscriptStatusRow[] = [];
	const compactRows: TranscriptStatusRow[] = [];
	const jobSlots: (CompactBackgroundJob | undefined)[] = [];
	const addWarning = (row: TranscriptStatusRow, original = true) => {
		if (original) rows.push(row);
		compactRows.push(row);
		jobSlots.push(undefined);
	};
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const typeLabel = job.type ? `[${job.type}]` : "[job]";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		const original: TranscriptStatusRow = {
			parts: [
				{ text: `${theme.status.done} Background job completed`, color: "success" },
				{ text: typeLabel, color: "dim" },
				{ text: jobId, color: "accent" },
				duration ? { text: `(${duration})`, color: "dim" } : undefined,
			],
		};
		rows.push(original);
		const identified =
			typeof job.jobId === "string" &&
			job.jobId.trim().length > 0 &&
			(job.type === "task" || job.type === "bash" || job.type === "eval");
		const completed = identified && job.status === "completed";
		const status = completed
			? { text: `${theme.status.done} Background job completed`, color: "success" as const }
			: job.status === "failed"
				? { text: `${theme.status.error} Background job failed`, color: "error" as const }
				: job.status === "cancelled"
					? { text: `${theme.status.warning} Background job cancelled`, color: "warning" as const }
					: { text: "Background job status unknown", color: "warning" as const };
		compactRows.push({ parts: [status, ...original.parts.slice(1)] });
		jobSlots.push(
			identified &&
				(job.type === "task" || job.type === "bash") &&
				(job.status === "completed" || job.status === "failed")
				? { id: jobId, failed: job.status === "failed" }
				: undefined,
		);
		if (job.meta?.artifactError) {
			addWarning({ parts: [{ text: formatArtifactErrorNotice(job.meta.artifactError), color: "warning" }] });
		}
		if (job.schema && (job.schema.status !== "valid" || job.schema.error)) {
			addWarning(
				{
					parts: [
						{
							text: `${jobId}: Structured output ${job.schema.status}${job.schema.error ? `: ${job.schema.error}` : ""}`,
							color: "warning",
						},
					],
				},
				false,
			);
		}
	}
	if (details?.jobs && details.jobs.length > 0 && details.meta?.artifactError) {
		addWarning({ parts: [{ text: formatArtifactErrorNotice(details.meta.artifactError), color: "warning" }] });
	}
	return new AsyncResultBlock(new TranscriptStatusBlock(rows), compactRows, jobSlots, compactToolActivity);
}

/**
 * Render a `launch-completion` custom message (terminal supervised-process
 * exits from the launch broker) as a transcript block of one compact
 * "Supervised process ..." row per daemon, matching background-job rows.
 */
export function buildLaunchCompletionBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (message as CustomMessage<{ daemons?: DaemonSnapshot[] }>).details;
	const rows: TranscriptStatusRow[] = [];
	const daemons = details?.daemons ?? [];
	if (daemons.length === 0 && typeof message.content === "string") {
		rows.push({ parts: [{ text: `${theme.status.done} ${message.content}`, color: "dim" }] });
	}
	for (const daemon of daemons) {
		const failed = daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0);
		const duration =
			daemon.exitedAt !== undefined && daemon.startedAt !== undefined
				? formatDuration(daemon.exitedAt - daemon.startedAt)
				: undefined;
		rows.push({
			parts: [
				failed
					? { text: `${theme.status.error} Supervised process failed`, color: "error" }
					: { text: `${theme.status.done} Supervised process completed`, color: "success" },
				{ text: daemon.name, color: "accent" },
				daemon.exitCode !== undefined ? { text: `(exit ${daemon.exitCode})`, color: "dim" } : undefined,
				duration ? { text: `(${duration})`, color: "dim" } : undefined,
			],
		});
	}
	return new ToolActivityContainer(new TranscriptStatusBlock(rows));
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const details = (
		message as CustomMessage<{
			from?: string;
			to?: string;
			message?: string;
			body?: string;
			replyTo?: string;
			pool?: string;
			mode?: string;
		}>
	).details;
	const kind =
		message.customType === "irc:incoming"
			? ("incoming" as const)
			: message.customType === "irc:autoreply"
				? ("autoreply" as const)
				: message.customType === "irc:workpool"
					? ("workpool" as const)
					: ("relay" as const);
	return createIrcMessageCard(
		{
			kind,
			from: details?.from,
			to: details?.to,
			body: kind === "incoming" ? details?.message : details?.body,
			replyTo: details?.replyTo,
			timestamp: message.timestamp,
			pool: details?.pool,
			mode: details?.mode,
		},
		getExpanded,
		theme,
	);
}

/**
 * Render a `fileMention` message's files as a transcript block of "Read <path>"
 * rows. `indent` sets the left pad: the live chat renders within an outer gutter
 * (0), the transcript viewer renders body rows without one so rows own their pad
 * (1).
 */
export function buildFileMentionBlock(files: FileMentionMessage["files"], indent: number): TranscriptBlock {
	const rows: TranscriptStatusRow[] = [];
	for (const file of files) {
		let suffix: string;
		if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
			suffix = file.skippedReason === "binary" ? `(skipped: binary, ${size})` : `(skipped: ${size})`;
		} else {
			suffix = file.image
				? "(image)"
				: file.lineCount === undefined
					? "(unknown lines)"
					: `(${file.lineCount} lines)`;
		}
		rows.push({
			parts: [
				{ text: theme.tree.last, color: "dim", rowsOnly: true },
				{ text: "Read", color: "muted" },
				{ text: file.path, color: "accent" },
				{ text: suffix, color: "dim" },
			],
			indent,
		});
	}
	return new TranscriptStatusBlock(rows);
}

/**
 * Whether an assistant turn has visible text, thinking, or image content — i.e.
 * content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			content.type === "image" ||
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

/**
 * Split mixed assistant turns into visible text before tool execution and
 * visible text segments that must render immediately after the preceding tool.
 * Cursor can return intro text, tool calls, progress text, and the final answer
 * in one assistant message; keeping every text block in the leading assistant
 * block buries post-tool text above tool results in the transcript.
 */
export function splitAssistantMessageToolTimeline(message: AssistantAgentMessage): {
	beforeTools: AssistantAgentMessage;
	afterToolCalls: ReadonlyMap<string, AssistantAgentMessage>;
	hasToolCalls: boolean;
	lastToolCallId?: string;
} {
	const beforeTools: AssistantAgentMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantAgentMessage>();
	let pendingAfterTool: AssistantAgentMessage["content"] = [];
	let lastToolCallId: string | undefined;
	let sawToolCall = false;

	const displaySegment = (content: AssistantAgentMessage["content"]): AssistantAgentMessage => ({
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		retryRecovery: undefined,
	});

	const flushPendingAfterTool = () => {
		if (!lastToolCallId || pendingAfterTool.length === 0) return;
		afterToolCalls.set(lastToolCallId, displaySegment(pendingAfterTool));
		pendingAfterTool = [];
	};

	for (const content of message.content) {
		if (content.type === "toolCall") {
			flushPendingAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			continue;
		}
		if (sawToolCall) {
			pendingAfterTool.push(content);
		} else {
			beforeTools.push(content);
		}
	}
	flushPendingAfterTool();

	if (!sawToolCall) {
		return { beforeTools: message, afterToolCalls, hasToolCalls: false };
	}

	return { beforeTools: displaySegment(beforeTools), afterToolCalls, hasToolCalls: true, lastToolCallId };
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export type AssistantErrorPresentation =
	| { kind: "none" }
	| { kind: "full"; text: string; isError: true }
	| { kind: "compact-recovered"; text: string; isError: false };

function sanitizeRecoveredRetryNote(note: string): string {
	const normalized = replaceTabs(note).replace(/\s+/g, " ").trim();
	return truncateToWidth(normalized || "retried", TRUNCATE_LENGTHS.CONTENT);
}

/**
 * Resolve the turn-ending assistant error presentation, if any.
 * Silent and user-interrupt aborts yield no label. Recovered retry attempts
 * render a compact note; attempts superseded by an exhausted budget are hidden
 * while the final terminal error keeps its full presentation.
 */
export function resolveAssistantErrorPresentation(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.retryRecovery?.status === "recovered") {
		return {
			kind: "compact-recovered",
			text: sanitizeRecoveredRetryNote(message.retryRecovery.note),
			isError: false,
		};
	}
	if (message.stopReason === "aborted") {
		if (!shouldRenderAbortReason(message)) return { kind: "none" };
		return { kind: "full", text: resolveAbortLabel(message, retryAttempt), isError: true };
	}
	if (message.stopReason === "error") {
		return { kind: "full", text: message.errorMessage || "Error", isError: true };
	}
	if (message.errorMessage && shouldRenderAbortReason(message)) {
		return { kind: "full", text: message.errorMessage, isError: true };
	}
	return { kind: "none" };
}

/**
 * Whether an assistant turn's `usage` reflects work the operator was billed
 * for. Empty automated turns from providers that emit `usage: 0` collapse to
 * `false`, but any input, output, cache, or premium request keeps the row so
 * cost transparency survives — the live path and the resume/rebuild path
 * agree turn-by-turn.
 */
export function assistantUsageIsBilled(usage: AssistantAgentMessage["usage"]): boolean {
	if (usage.input > 0 || usage.output > 0) return true;
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) return true;
	if ((usage.premiumRequests ?? 0) > 0) return true;
	return false;
}
