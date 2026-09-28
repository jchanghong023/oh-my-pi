/**
 * Fork-extension background jobs surface (requirement 5.2, rpc-ui-protocol.md).
 *
 * Wraps `AsyncJobManager` + `snapshotJobs`/`executeCancel` (`async/job-control.ts`):
 * `get_jobs` projects the owner-filtered job list into wire rows (running plus
 * optionally the recent settled window), `cancel_job` reuses the stock cancel
 * path. Output artifact paths stay on the `tool_execution_update` channel;
 * this surface never duplicates them.
 */
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../../tools";
import { executeCancel, snapshotJobs } from "../../async/job-control";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

export interface RpcForkJobRow {
	jobId: string;
	type: "bash" | "task" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	startedAt: number;
	durationMs: number;
	exitCode?: number;
	resultText?: string;
	errorText?: string;
}

const DEFAULT_RECENT_LIMIT = 10;

export class RpcForkJobController {
	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
	) {
		host.registerCommand("get_jobs", command => this.#getJobs(command));
		host.registerCommand("cancel_job", command => this.#cancelJob(command));
	}

	/**
	 * Narrow ToolSession view covering exactly the members the job-control
	 * helpers read (`asyncJobManager`, `getAgentId`); `agentRegistry` stays
	 * unset so registration-side cleanup degrades the same way it does for
	 * sessions without a registry.
	 */
	#toolSessionView(): ToolSession {
		return {
			asyncJobManager: this.session.asyncJobManager,
			getAgentId: () => this.session.getAgentId(),
		} as unknown as ToolSession;
	}

	async #getJobs(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { includeRecent, recentLimit } = command as { includeRecent?: unknown; recentLimit?: unknown };
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return this.host.context.success(command.id, "get_jobs", { running: [], recent: [] });
		}
		const jobs = manager.getAllJobs({ ownerId: this.session.getAgentId() ?? undefined });
		const startedAtById = new Map(jobs.map(job => [job.id, job.startTime] as const));
		const snapshots = snapshotJobs(this.#toolSessionView(), jobs, { includeResults: true });
		const toRow = (snapshot: (typeof snapshots)[number]): RpcForkJobRow => ({
			jobId: snapshot.id,
			type: snapshot.type,
			status: snapshot.status,
			label: snapshot.label,
			startedAt: startedAtById.get(snapshot.id) ?? Date.now() - snapshot.durationMs,
			durationMs: snapshot.durationMs,
			...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
			...(snapshot.resultText !== undefined ? { resultText: snapshot.resultText } : {}),
			...(snapshot.errorText !== undefined ? { errorText: snapshot.errorText } : {}),
		});
		const capRecent =
			includeRecent === false
				? 0
				: Math.min(Math.max(typeof recentLimit === "number" ? recentLimit : DEFAULT_RECENT_LIMIT, 0), 100);
		const running = snapshots.filter(snapshot => snapshot.status === "running").map(toRow);
		const recent = snapshots
			.filter(snapshot => snapshot.status !== "running")
			.sort((a, b) => (startedAtById.get(b.id) ?? 0) - (startedAtById.get(a.id) ?? 0))
			.slice(0, capRecent)
			.map(toRow);
		return this.host.context.success(command.id, "get_jobs", { running, recent });
	}

	async #cancelJob(command: RpcForkCommandBase): Promise<RpcResponse> {
		const jobId = (command as { jobId?: unknown }).jobId;
		if (typeof jobId !== "string" || !jobId) {
			return this.host.context.error(command.id, "cancel_job", "jobId is required");
		}
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return this.host.context.error(command.id, "cancel_job", `Unknown job: ${jobId}`, "unknown_job");
		}
		const job = manager.getJob(jobId);
		if (!job || job.ownerId !== (this.session.getAgentId() ?? undefined)) {
			return this.host.context.error(command.id, "cancel_job", `Unknown job: ${jobId}`, "unknown_job");
		}
		const result = await executeCancel(this.#toolSessionView(), manager, this.session.getAgentId() ?? undefined, [
			jobId,
		]);
		const detail = (result.details as CoordinationDetails | undefined)?.cancelled?.find(
			outcome => outcome.id === jobId,
		);
		return this.host.context.success(command.id, "cancel_job", {
			jobId,
			status: detail?.status ?? "cancelled",
		});
	}
}
