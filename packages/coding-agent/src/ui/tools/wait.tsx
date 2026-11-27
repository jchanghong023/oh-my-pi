/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Wait: background jobs and running agents as the wait call left them.
 *
 * The call is a frameless `Wait` line. The result heads `waiting on 2 of 5
 * jobs  3 done  1 failed` (or `5 jobs settled`, `2 running agents — no
 * jobs`) over one wrapping row of job tiles (running first, then failed,
 * cancelled, done; longest first) and a row per agent outside job control.
 * A wait cut short by a message says so; a wait with nothing to show says
 * why.
 *
 * Terminal look: `wait` (`src/ui/styles/tools/wait.ts`), from the snapshot
 * on `term.wait`.
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { jobDisplayLabel } from "../../async/job-label";
import { stripBashExitCodeNotice, stripBashWallTimeNotice } from "../../tools/details/bash";
import type { AgentActivitySnapshot, CoordinationDetails, JobSnapshot } from "../../tools/details/wait";
import {
	formatArtifactErrorNotice,
	formatFullOutputReference,
	stripOutputNotice,
	stripRawOutputNotice,
	stripTrailingNotice,
} from "../../tools/output-meta-format";
import { ErrorText } from "./agent-common";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { resultText } from "./default";
import { type JobTile, JobTiles } from "./jobs/widget";
import { registerToolPresenter } from "./registry";

/** Tiles a wait card shows before it counts the rest. */
const TILES_SHOWN = 9;

const STATUS_ORDER: Record<JobSnapshot["status"], number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };

const BASH_TIMEOUT_NOTICE =
	/^(\[(?:timed out(?: after \d+s)?(?:; shell unresponsive, output may be incomplete)?|Command timed out(?: after \d+(?:\.\d+)? seconds(?:; the shell backend did not respond, so any output above may be incomplete)?)?)\])(?:\r?\n|$)/u;

/** What the terminal draws a wait from. */
export type WaitTerm =
	| { readonly kind: "empty"; readonly text: string; readonly meta?: CoordinationDetails["meta"] }
	| { readonly kind: "interrupted" }
	| {
			readonly kind: "jobs";
			readonly jobs: readonly JobSnapshot[];
			readonly agents: readonly AgentActivitySnapshot[];
			readonly meta?: CoordinationDetails["meta"];
			readonly settledBashJobs?: ReadonlyMap<string, string>;
	  };

/** A displayed Bash card already owns this job's output; Wait still draws its own diagnostics. */
export function duplicatesBashOutcome(job: JobSnapshot, settled: ReadonlyMap<string, string> | undefined): boolean {
	return (
		job.type === "bash" &&
		settled?.get(job.id) === job.status &&
		(job.structured === undefined || job.structured.status === "valid")
	);
}

/** A failed job's visible output and diagnostics, without the generated output footers. */
export function waitFailurePreview(
	job: JobSnapshot,
	expanded: boolean,
	settled: ReadonlyMap<string, string> | undefined,
): { lines: string[]; reason?: string; artifact?: string } {
	if (job.status !== "failed") return { lines: [] };
	const error = job.errorText ?? "";
	const raw = stripOutputNotice(
		job.type === "bash" && !error.trim() ? (job.resultText ?? "") : error,
		job.meta ?? (job.artifactError ? { artifactError: job.artifactError } : undefined),
	);
	if (job.type !== "bash") {
		const reason = raw
			.split(/\r?\n/)
			.find(line => line.trim())
			?.trim();
		return { lines: reason ? [plainText(reason)] : [] };
	}
	// The local sink prefixes its reason, while bridge and shaped output can carry it as a footer.
	let trailingReason: string | undefined;
	const rawFooter = stripRawOutputNotice(raw);
	const withoutTimeout =
		job.timedOut === true
			? stripTrailingNotice(rawFooter.text, line => {
					trailingReason = BASH_TIMEOUT_NOTICE.exec(line)?.[1];
					return trailingReason !== undefined;
				})
			: rawFooter.text;
	const wallTimeMs = job.wallTimeNoticeEmitted === true ? job.wallTimeMs : undefined;
	const withoutWall = wallTimeMs === undefined ? withoutTimeout : stripBashWallTimeNotice(withoutTimeout, wallTimeMs);
	const exitCode = job.exitCode;
	const withoutExit =
		exitCode === undefined || exitCode === 0 ? withoutWall : stripBashExitCodeNotice(withoutWall, exitCode, "trailing");
	const outputWithArtifact = stripRawOutputNotice(withoutExit);
	const output = outputWithArtifact.text;
	const timeout = job.timedOut === true ? BASH_TIMEOUT_NOTICE.exec(output) : undefined;
	const reason = timeout?.[1] ?? trailingReason;
	if (!expanded && duplicatesBashOutcome(job, settled)) return { lines: [], reason };
	const outputStart = timeout?.[0].length ?? 0;
	const lines: string[] = [];
	if (expanded) {
		const body = output.slice(outputStart).trimEnd();
		if (body) for (const line of body.split(/\r?\n/)) lines.push(plainText(line));
	} else {
		for (let end = output.length; end > outputStart && lines.length < 2;) {
			const start = output.lastIndexOf("\n", end - 1);
			const line = plainText(output.slice(start + 1, end)).trimEnd();
			if (line.trim()) lines.unshift(line);
			end = start;
		}
	}
	const truncation = job.meta?.truncation;
	const artifactId =
		job.meta?.minimized?.artifactId ??
		rawFooter.artifactId ??
		outputWithArtifact.artifactId ??
		truncation?.artifactId;
	const elidedBytes = artifactId === truncation?.artifactId ? truncation?.artifactElidedBytes : undefined;
	return {
		lines,
		reason,
		artifact: artifactId
			? `${elidedBytes ? "Sample only · " : ""}${formatFullOutputReference(artifactId, elidedBytes)}`
			: undefined,
	};
}

/** Running first, then failed, cancelled, done; longest first within each. */
export function sortJobs(jobs: readonly JobSnapshot[]): JobSnapshot[] {
	return [...jobs].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.durationMs - a.durationMs);
}

/** A job as its tile; `live` while the card's clocks run. */
export function jobTile(job: JobSnapshot, live: boolean): JobTile {
	const label = jobDisplayLabel(job);
	let widget = job.widget;
	// A saved fallback title was clipped from the job intent; an authored title is independent of it.
	if (widget && widget.state !== "live" && job.intent && label !== job.intent) {
		const flat = label.replace(/\s+/g, " ").trim();
		const title =
			flat.length > widget.title.length ? `${flat.slice(0, Math.max(0, widget.title.length - 1))}…` : flat;
		if (title !== widget.title) widget = { ...widget, title };
	}
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		label,
		durationMs: job.durationMs,
		live: live && job.status === "running",
		...(widget ? { widget } : {}),
		...(job.status === "running" && job.completionPercent !== undefined
			? { completionPercent: job.completionPercent }
			: {}),
		...(job.stage ? { stage: job.stage } : {}),
		...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
	};
}

/** `waiting on 2 of 5 jobs`, `5 jobs settled`, `2 running agents — no jobs`. */
export function waitTitle(jobs: readonly JobSnapshot[], agents: readonly unknown[]): string {
	const running = jobs.filter(job => job.status === "running").length;
	const noun = jobs.length === 1 ? "job" : "jobs";
	if (jobs.length === 0) return `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`;
	if (running === 0) return `${jobs.length} ${noun} settled`;
	return running === jobs.length
		? `waiting on ${jobs.length} ${noun}`
		: `waiting on ${running} of ${jobs.length} ${noun}`;
}

function AgentRow(props: { readonly agent: AgentActivitySnapshot; readonly live: boolean }): JSXNode {
	const agent = props.agent;
	const spans: TspSpan[] = [{ s: "muted", t: plainText(agent.id) }];
	if (agent.activity) spans.push({ s: "toolOutput", t: ` ${plainText(agent.activity)}` });
	if (agent.parentId) spans.push({ s: "dim", t: ` ← ${plainText(agent.parentId)}` });
	const age = Math.max(0, Math.round(agent.ageMs));
	return (
		<row key={`agent:${agent.id}`} role="omp.wait.agent" gap="sm">
			<badge text={agent.live ? "agent" : "agent · no turn"} tone={agent.live ? "accent" : "warning"} />
			<text spans={spans} truncate="end" grow={1} />
			{agent.live && props.live ? (
				<elapsed age={age} format="short" />
			) : (
				<elapsed age={age} stopped={age} format="short" />
			)}
		</row>
	);
}

/** Text with escapes and control characters dropped, tabs as spaces. */
function plainText(text: string): string {
	return replaceTabs(sanitizeText(text));
}

function waitHead(...parts: (TspSpan | undefined)[]): TspSpan[] {
	return [{ s: "toolTitle strong", t: "Wait" }, ...parts.filter((part): part is TspSpan => part !== undefined)];
}

function resultView(result: ToolResult<CoordinationDetails>, state: ToolViewState): ToolView {
	const details = result.details;
	const jobs = details?.jobs ?? [];
	const agents = details?.agents ?? [];
	const spinning = state.isPartial;
	const settledBashJobs = state.renderContext?.settledBashJobs as ReadonlyMap<string, string> | undefined;
	if (result.isError) {
		return {
			label: waitHead(),
			tone: "error",
			body: <ErrorText message={resultText(result)} />,
			inline: false,
			term: { look: "wait", spinning, wait: jobsTerm(result, settledBashJobs) },
		};
	}
	if (details?.interrupted) {
		return {
			label: waitHead({ t: " " }, { s: "muted", t: "interrupted by message" }),
			tone: "info",
			term: { look: "wait", spinning, wait: { kind: "interrupted" } satisfies WaitTerm },
		};
	}
	if (jobs.length === 0 && agents.length === 0) {
		return {
			label: waitHead(),
			tone: "warning",
			body: [
				<text spans={[{ s: "dim", t: plainText(resultText(result) || "No jobs to process") }]} />,
				details?.meta?.artifactError && (
					<text spans={[{ s: "warning", t: formatArtifactErrorNotice(details.meta.artifactError) }]} wrap="word" />
				),
			],
			inline: false,
			term: { look: "wait", spinning, wait: jobsTerm(result, settledBashJobs) },
		};
	}
	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;
	const head: TspSpan[] = [{ s: "toolTitle strong", t: waitTitle(jobs, agents) }];
	if (counts.completed > 0) head.push({ s: "success", t: ` ${counts.completed} done` });
	if (counts.failed > 0) head.push({ s: "error", t: ` ${counts.failed} failed` });
	if (counts.cancelled > 0) head.push({ s: "warning", t: ` ${counts.cancelled} cancelled` });
	const sorted = sortJobs(jobs);
	const rest = sorted.length - TILES_SHOWN;
	const tone: TspTone = counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success";
	return {
		label: head,
		tone,
		// The tiles are what a wait shows: clamping the body by lines would cut them.
		preview: "children",
		// While it waits, the host's jobs tray already shows these jobs live: the card starts folded.
		...(state.isPartial ? { folded: true } : {}),
		inline: false,
		body: [
			sorted.length > 0 ? (
				<JobTiles nodeKey="tiles" tiles={sorted.slice(0, TILES_SHOWN).map(job => jobTile(job, state.isPartial))} />
			) : undefined,
			...sorted.slice(0, TILES_SHOWN).flatMap(job => {
				const { lines, reason, artifact } = waitFailurePreview(job, state.expanded, settledBashJobs);
				const body: JSXNode[] = [];
				if (reason)
					body.push(
						<text
							spans={[{ s: "error", t: `${plainText(job.id)} · ${reason}` }]}
							wrap={state.expanded ? "word" : undefined}
							truncate={state.expanded ? undefined : "end"}
						/>,
					);
				if (job.type === "bash" && lines.length > 0)
					body.push(
						<text
							spans={[
								{ s: "muted", t: `${plainText(job.id)} · ${state.expanded ? "Output:" : "Output tail:"}` },
							]}
							truncate="end"
						/>,
					);
				for (const line of lines)
					body.push(
						<text
							spans={[{ s: "error", t: job.type === "bash" ? line : `${plainText(job.id)} · ${line}` }]}
							wrap={state.expanded ? "word" : undefined}
							truncate={state.expanded ? undefined : "end"}
						/>,
					);
				if (artifact) body.push(<text spans={[{ s: "warning", t: artifact }]} wrap="word" />);
				const error = job.meta?.artifactError ?? job.artifactError;
				if (error) body.push(<text spans={[{ s: "warning", t: formatArtifactErrorNotice(error) }]} wrap="word" />);
				return body;
			}),
			rest > 0 ? (
				<text
					role="omp.wait.more"
					spans={[{ s: "dim", t: `+${rest} more ${rest === 1 ? "job" : "jobs"} · /jobs` }]}
				/>
			) : undefined,
			...agents.map(agent => <AgentRow agent={agent} live={state.isPartial} />),
			details?.meta?.artifactError &&
				!jobs.some(job => (job.meta?.artifactError ?? job.artifactError) === details.meta?.artifactError) && (
					<text spans={[{ s: "warning", t: formatArtifactErrorNotice(details.meta.artifactError) }]} wrap="word" />
				),
		],
		term: { look: "wait", spinning, wait: jobsTerm(result, settledBashJobs) },
	};
}

/** The snapshot the terminal draws (also for an error, whose rows still list its jobs). */
function jobsTerm(result: ToolResult<CoordinationDetails>, settledBashJobs?: ReadonlyMap<string, string>): WaitTerm {
	const details = result.details;
	const jobs = details?.jobs ?? [];
	const agents = details?.agents ?? [];
	if (jobs.length === 0 && agents.length === 0)
		return { kind: "empty", text: resultText(result) || "No jobs to process", meta: details?.meta };
	return { kind: "jobs", jobs, agents, meta: details?.meta, settledBashJobs };
}

export const waitPresenter: ToolPresenter<Record<string, unknown>, CoordinationDetails> = {
	inline: true,
	merge: true,
	activity: () => ({ label: "Wait", detail: "Background work or peer message" }),
	call: () => ({ label: waitHead(), term: { look: "wait" } }),
	result: (result, state) => resultView(result, state),
};

registerToolPresenter("wait", waitPresenter);
