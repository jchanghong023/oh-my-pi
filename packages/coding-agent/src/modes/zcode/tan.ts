import * as path from "node:path";
import { z } from "zod";
import type { AsyncJob } from "../../async/job-manager";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import { TanCommandController } from "../controllers/tan-command-controller";
import type { InteractiveModeContext } from "../types";
import { LegacyProtocol as L } from "./schema";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "./sessions";

const baseParams = z
	.object({
		workspace: L.zcodeWorkflowsListParamsSchema.shape.workspace,
		sessionId: z.string().min(1),
	})
	.strict();
export const ompTanListParamsSchema = baseParams;
export const ompTanStartParamsSchema = baseParams.extend({ work: z.string().trim().min(1) }).strict();
export const ompTanStopParamsSchema = baseParams.extend({ jobId: z.string().min(1) }).strict();

export interface OmpTanJob {
	jobId: string;
	agentId?: string;
	childSessionId?: string;
	sessionId: string;
	work: string;
	label: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled" | "unavailable";
	output?: string;
	error?: string;
	unavailable: string[];
}

type TanHost = Pick<
	InteractiveModeContext,
	"session" | "sessionManager" | "settings" | "mcpManager" | "showError" | "showStatus" | "rebuildChatFromMessages"
>;

/** The native controller owns execution; this adapter owns only launch handoff and display facts. */
export class OmpTanBridge {
	readonly #work = new WeakMap<ZCodeSessionRecord, Map<string, string>>();
	constructor(readonly sessions: ZCodeSessionManager) {}

	async start(record: ZCodeSessionRecord, work: string, refresh: () => void): Promise<OmpTanJob> {
		const trimmed = work.trim();
		if (!trimmed) throw new Error("Usage: /tan <work>");
		return this.sessions.runNativeLaunch(record, async () => {
			const manager = record.session.asyncJobManager;
			const ownerId = record.session.getAgentId() ?? MAIN_AGENT_ID;
			const before = new Set(manager?.getAllJobs({ ownerId }).map(job => job.id));
			const notices: Promise<boolean>[] = [];
			const host: TanHost = {
				session: record.session,
				sessionManager: record.session.sessionManager,
				settings: record.settings,
				mcpManager: record.creationResult.mcpManager,
				showError: message => {
					throw new Error(message);
				},
				showStatus: message => {
					notices.push(
						record.session.sendCustomMessage(
							{ customType: "zcode-command-output", content: message, display: true },
							{ triggerTurn: false, deliverAs: "nextTurn" },
						),
					);
				},
				rebuildChatFromMessages: refresh,
			};
			// 原 controller 只读上述窄接口；未知访问必须失败，不能伪造 TUI 或授权能力。
			const context = new Proxy(host, {
				get(target, property, receiver) {
					if (!Reflect.has(target, property))
						throw new Error(`Unsupported Tan host property: ${String(property)}`);
					return Reflect.get(target, property, receiver);
				},
			}) as InteractiveModeContext;
			await new TanCommandController(context).start(trimmed);
			await Promise.all(notices);
			const created = manager?.getAllJobs({ ownerId }).filter(job => !before.has(job.id) && this.#isTan(job));
			if (created?.length !== 1) throw new Error("Native Tan did not register exactly one background job");
			const job = created[0]!;
			let works = this.#work.get(record);
			if (!works) this.#work.set(record, (works = new Map()));
			works.set(job.id, trimmed);
			refresh();
			// 注册交接不代表 SDK 已完成 child journal 初始化；启动响应只用实际 live registry 身份。
			// 后续 list 通过既有冷读身份投影补齐 parked/history，不提前读取正在创建的 JSONL。
			const childSessionId = job.agentId
				? record.registry.get(job.agentId)?.session?.sessionManager.getSessionId()
				: undefined;
			const children = job.agentId && childSessionId ? { [job.agentId]: childSessionId } : {};
			return this.#nativeOutcome(this.#project(record.id, job, trimmed, children));
		});
	}

	#isTan(job: AsyncJob): boolean {
		return job.type === "task" && job.label.startsWith("/tan ") && job.agentId?.startsWith("Tan-") === true;
	}

	#project(sessionId: string, job: AsyncJob, work: string, children: Record<string, string>): OmpTanJob {
		return {
			jobId: job.id,
			sessionId,
			agentId: job.agentId,
			childSessionId: job.agentId ? children[job.agentId] : undefined,
			work,
			label: job.label,
			status: job.queued && job.status === "running" ? "pending" : job.status,
			output: job.resultText,
			error: job.errorText,
			unavailable: [],
		};
	}

	async list(sessionId: string): Promise<OmpTanJob[]> {
		const record = this.sessions.get(sessionId);
		const { entries } = await this.sessions.read(sessionId);
		const children = await this.sessions.childIdentities(sessionId);
		const rows = new Map<string, OmpTanJob>();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) continue;
			const details: unknown = entry.details;
			if (!details || typeof details !== "object" || !("jobId" in details) || !("work" in details)) continue;
			if (typeof details.jobId !== "string" || typeof details.work !== "string") continue;
			const agentId =
				"sessionFile" in details && typeof details.sessionFile === "string"
					? path.basename(details.sessionFile, ".jsonl")
					: undefined;
			rows.set(details.jobId, {
				jobId: details.jobId,
				sessionId,
				agentId,
				childSessionId: agentId ? children[agentId] : undefined,
				work: details.work,
				label: `/tan ${details.work.trim().replace(/\s+/g, " ")}`,
				status: "unavailable",
				unavailable: ["Native job status is no longer retained; dispatch history is not completion evidence."],
			});
		}
		if (record) {
			const ownerId = record.session.getAgentId() ?? MAIN_AGENT_ID;
			for (const job of record.session.asyncJobManager?.getAllJobs({ ownerId }) ?? []) {
				if (!this.#isTan(job)) continue;
				const work = this.#work.get(record)?.get(job.id) ?? rows.get(job.id)?.work;
				const projected = this.#project(sessionId, job, work ?? "", children);
				if (work === undefined) projected.unavailable.push("The native dispatch work is not yet journaled.");
				rows.set(job.id, projected);
			}
		}
		return Promise.all([...rows.values()].map(row => this.#nativeOutcome(row)));
	}

	async #nativeOutcome(row: OmpTanJob): Promise<OmpTanJob> {
		if (!row.childSessionId || (row.status !== "completed" && row.status !== "unavailable")) return row;
		const child = await this.sessions.read(row.childSessionId);
		const terminal = child.messages.findLast(message => message.role === "assistant");
		// 原生 prompt 可在模型错误后正常 resolve；job completed 只说明函数返回，不能覆盖真实终态错误。
		if (terminal?.role === "assistant" && terminal.stopReason === "error") {
			row.status = "failed";
			row.error = terminal.errorMessage ?? "Native Tan model response failed";
			row.output = undefined;
		}
		return row;
	}

	async stop(record: ZCodeSessionRecord, jobId: string): Promise<{ accepted: boolean; job: OmpTanJob }> {
		return record.run(async () => {
			const job = (await this.list(record.id)).find(candidate => candidate.jobId === jobId);
			if (!job) throw new Error("Tan job does not belong to this session");
			const ownerId = record.session.getAgentId() ?? MAIN_AGENT_ID;
			const manager = record.session.asyncJobManager;
			const live = manager?.getAllJobs({ ownerId }).find(candidate => candidate.id === jobId);
			// 恢复后的 manager 会复用 bg_N；历史派发不能证明同 ID 的当前任务仍属于 Tan。
			const accepted =
				live && this.#isTan(live) ? (manager?.cancel(jobId, { ownerId: live.ownerId }) ?? false) : false;
			return { accepted, job: (await this.list(record.id)).find(candidate => candidate.jobId === jobId) ?? job };
		});
	}
}
