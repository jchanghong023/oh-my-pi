import { type OutputMeta, stripOutputNotice, stripRawOutputNotice, stripTrailingNotice } from "../output-meta-format";
import type { RenderResultOptions } from "./renderer";
import { type ShellTrace } from "@oh-my-pi/pi-wire";
import type { SpotlightDetails } from "./spotlight";
import { type ToolCommandRenderDispatch } from "./tool-commands";
import { readShellWord } from "@oh-my-pi/pi-utils/shell";

/**
 * LLM-facing footer appended when a tool call becomes a background job. It states the job's kill
 * deadline (`timeoutSec`, `undefined` when disabled) so the model knows the job will die at it before
 * it waits on the result. The deadline counts the job's whole run time, not time left from now: an
 * auto-backgrounded call has already spent its foreground wait.
 */
export function formatBackgroundNotice(jobId: string, timeoutSec: number | undefined): string {
	const deadline =
		timeoutSec === undefined
			? " (no deadline)"
			: ` (killed once it has run ${timeoutSec}s in total; \`timeout: 0\` disables the deadline)`;
	return `Backgrounded as job ${jobId}${deadline}; its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no \`sleep\`, \`ps\`, \`pgrep\`, \`top\`, \`pidwait\`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.`;
}

/** Shell execution metadata used by transcript rendering. */
export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	/** False when no wall-time footer was emitted; absent on older results. */
	wallTimeNoticeEmitted?: boolean;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/** True when the command was killed by its timeout deadline (not a failure). */
	timedOut?: boolean;
	/** True when the run was cancelled before completion. */
	cancelled?: boolean;
	/** Text the command wrote to `out://`, oldest first; transcripts draw each as a reply after the call. */
	replies?: string[];
	/**
	 * The embedded shell's live trace of the command (omp-shell `RunTrace`): every frame carries the
	 * latest snapshot and the final result the last one. Absent on the PTY and user-shell paths.
	 */
	trace?: ShellTrace;
	/**
	 * Working directory the command ran in when the call set one, explicitly or by the
	 * executor hoisting a leading `cd <dir>`; absent when it ran in the session cwd.
	 * Pairs with {@link trace}: the traced script is the command after hoisting.
	 */
	cwd?: string;
	/** `;` when the hoisted leading cd was `cd <dir>;`, so the card redraws it as written; absent means `&&`. */
	cdSeparator?: ";";
	/** Tool command invocations of this run, in invocation order. */
	toolCommands?: ToolCommandRenderDispatch[];
	/** What the session's Spotlight shaping did to the output. */
	spotlight?: SpotlightDetails;
	/** Live ACP update only; completed results refer to released terminals. */
	terminalId?: string;
	service?: {
		name: string;
		state: string;
		ready: boolean;
		timedOut: boolean;
		pid?: number;
	};
	/** Background job behind the call; `cancelled`: killed (`proc://<id>/kill`) before it finished. */
	async?: {
		state: "running" | "completed" | "failed" | "cancelled";
		jobId: string;
		type: "bash";
	};
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

/** Minimum duration for a model-facing wall-time notice; shorter runs keep timing only in details. */
export const WALL_TIME_NOTICE_MIN_MS = 1000;

/** Formats the model-facing command duration notice. */
export function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

/** Formats the model-facing command exit status notice. */
export function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

type BashNoticeDetails = Pick<BashToolDetails, "meta" | "exitCode" | "wallTimeMs" | "wallTimeNoticeEmitted"> & {
	async?: Pick<NonNullable<BashToolDetails["async"]>, "state" | "jobId">;
};

/** Strip the model-facing notices from shell output without changing the stored result. */
export function stripBashNotices(
	raw: string,
	details: BashNoticeDetails | undefined,
): { text: string; artifactId?: string } {
	const job = details?.async;
	let text = raw;
	if (job?.state === "running") {
		const prefix = `Backgrounded as job ${job.jobId}`;
		text = stripTrailingNotice(text, line => {
			return line.startsWith(prefix) && (line[prefix.length] === ";" || line[prefix.length] === " ");
		});
	}
	text = stripOutputNotice(text, details?.meta);
	if (details?.exitCode !== undefined) text = stripTrailingNotice(text, formatExitCodeNotice(details.exitCode));
	if (details?.wallTimeMs !== undefined && details.wallTimeNoticeEmitted !== false) {
		text = stripTrailingNotice(text, formatWallTimeNotice(details.wallTimeMs));
	}
	return stripRawOutputNotice(text);
}

const COMPOUND_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "\n", "\r"]);

/** Whether a command is one simple tool invocation, with no shell composition or substitution. */
export function isSoleToolInvocation(command: string | undefined, dispatch: ToolCommandRenderDispatch): boolean {
	if (dispatch.mode !== "execute") return false;
	const line = command?.trim();
	if (!line) return false;
	const first = readShellWord(line);
	if (first === "unterminated" || first?.value !== dispatch.tool) return false;
	let quote: "'" | '"' | undefined;
	let wordStart = true;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			if (++i === line.length) return false;
			if (line[i] !== "\n") wordStart = false;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "$" || ch === "`") return false;
			continue;
		}
		if (ch === "#" && wordStart) {
			// A comment's backslash cannot continue it past the physical newline.
			return !line.includes("\n", i);
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (COMPOUND_CHARS.has(ch)) return false;
		wordStart = ch === " " || ch === "\t";
	}
	return quote === undefined;
}

const NO_TOOL_COMMANDS: readonly never[] = [];

/** Whether one nested tool card accounts for the entire shell call's output. */
export function shellToolCommands<T extends ToolCommandRenderDispatch>(
	details: { toolCommands?: readonly T[] } | undefined,
	command: string | undefined,
): { dispatches: readonly T[]; sole: boolean } {
	const dispatches = details?.toolCommands ?? NO_TOOL_COMMANDS;
	return { dispatches, sole: dispatches.length === 1 && isSoleToolInvocation(command, dispatches[0]!) };
}

/** Shell arguments used to build a command preview. */
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, unknown>;
	timeout?: number;
	cwd?: string;
	/** How the `cd <dir>` prefix joins the command: `;` as written by the model, else `&&`. */
	cdSeparator?: ";";
	__partialJson?: string;
	[key: string]: unknown;
}

/** Caller-supplied shell labels and argument projections. */
export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, unknown> | undefined;
	showHeader?: boolean;
}
