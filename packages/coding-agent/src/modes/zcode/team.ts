import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../../async/job-manager";
import type { AgentRef } from "../../registry/agent-registry";
import type { SessionEntry } from "../../session/session-entries";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task/types";
import type { ZCodeSessionRecord } from "./sessions";
import { projectCustomMessageEntityIds } from "./projection";

const OBSERVATION = "zcode_team_observation_v1";
type ObjectValue = Record<string, unknown>;
export interface OmpTeamNode {
	id: string;
	label: string;
	role: string;
	stage?: string;
	proposalLabel?: string;
	round?: number;
	model?: string;
	status: string;
	sessionFile?: string;
	outputPath?: string;
	output?: unknown;
	error?: string;
	tools: unknown[];
	messages: unknown[];
}
export interface OmpTeamEdge {
	source: string;
	target: string;
	kind: "reviews" | "revises" | "rechecks";
	evidence: string;
}
export interface OmpTeamRun {
	jobId: string;
	sessionId: string;
	dispatchEntityId?: string;
	label: string;
	status: "running" | "completed" | "failed" | "cancelled" | "unavailable";
	stage?: string;
	participants: unknown[];
	nodes: OmpTeamNode[];
	edges: OmpTeamEdge[];
	timeline: Array<{ sequence: number; timestamp: number; kind: string; nodeId?: string; data: unknown }>;
	result?: unknown;
	report?: unknown;
	error?: string;
	source: "native-live" | "native-journal";
	unavailable: string[];
}
export interface OmpTeamBridgeSessions {
	get(id: string): ZCodeSessionRecord | undefined;
	read(id: string): Promise<{ entries: SessionEntry[] }>;
}
interface Observation {
	record: ZCodeSessionRecord;
	runs: Map<string, OmpTeamRun>;
	unsubscribe: Array<() => void>;
	settling: Set<string>;
	dirty: Set<string>;
	samples: Map<
		string,
		{
			status: AsyncJob["status"];
			error: string | undefined;
			details: AsyncJob["latestDetails"];
			structured: AsyncJob["structured"];
			dispatchEntityId: string | undefined;
		}
	>;
	progress: Map<string, { status: string; currentTool: unknown; model: string | undefined }>;
}
function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : undefined;
}
function fresh(sessionId: string, jobId: string, label: string): OmpTeamRun {
	return {
		sessionId,
		jobId,
		label,
		status: "unavailable",
		participants: [],
		nodes: [],
		edges: [],
		timeline: [],
		source: "native-journal",
		unavailable: ["Native causal inputs for alignment/synthesis are not exposed as graph edges."],
	};
}
function callIdentity(id: string): Partial<OmpTeamNode> | undefined {
	// 原生 runner 以调用 label 分配 artifact ID；只解析原生固定调用名，不按模型合并独立槽位。
	const match = /(?:^|\.)team-(proposal|review|revision|recheck)-([A-Z]+)(?:-([12]))?(?:$|[._-])/.exec(id);
	if (match) {
		const kind = match[1];
		return {
			label: `team-${kind}-${match[2]}${match[3] ? `-${match[3]}` : ""}`,
			role:
				kind === "proposal"
					? "proposer"
					: kind === "review"
						? "reviewer"
						: kind === "revision"
							? "reviser"
							: "recheck",
			stage: kind === "proposal" ? "investigation" : kind === "review" ? "review" : "revision",
			proposalLabel: match[2],
			...(match[3] ? { round: Number(match[3]) } : {}),
		};
	}
	if (/(?:^|\.)team-(alignment|synthesis)(?:$|[._-])/.test(id)) {
		const synthesis = id.includes("team-synthesis");
		return {
			label: synthesis ? "team-synthesis" : "team-alignment",
			role: synthesis ? "synthesizer" : "aligner",
			stage: synthesis ? "synthesis" : "alignment",
		};
	}
	return undefined;
}
function updateEdges(run: OmpTeamRun): void {
	run.edges = [];
	for (const node of run.nodes) {
		if (!node.proposalLabel) continue;
		const target =
			node.role === "recheck"
				? run.nodes.find(
						candidate =>
							candidate.role === "reviser" &&
							candidate.proposalLabel === node.proposalLabel &&
							candidate.round === node.round,
					)
				: run.nodes.find(
						candidate => candidate.role === "proposer" && candidate.proposalLabel === node.proposalLabel,
					);
		const kind =
			node.role === "reviewer"
				? "reviews"
				: node.role === "reviser"
					? "revises"
					: node.role === "recheck"
						? "rechecks"
						: undefined;
		if (kind && target)
			run.edges.push({ source: node.id, target: target.id, kind, evidence: `native-call-label:${node.label}` });
	}
}
/** Rebuild observations without constructing an AgentSession or acquiring its writer lease. */
export function readOmpTeamJournal(sessionId: string, entries: readonly SessionEntry[]): Map<string, OmpTeamRun> {
	const runs = new Map<string, OmpTeamRun>();
	const dispatchEntities = projectCustomMessageEntityIds(sessionId, entries);
	const dispatches = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === OBSERVATION) {
			const data = object(entry.data);
			const run = object(data?.run);
			if (
				data?.version !== 1 ||
				!run ||
				run.sessionId !== sessionId ||
				typeof run.jobId !== "string" ||
				!Array.isArray(run.nodes) ||
				!Array.isArray(run.timeline) ||
				!Array.isArray(run.edges)
			)
				continue;
			runs.set(run.jobId, { ...run, source: "native-journal" } as unknown as OmpTeamRun);
		} else if (
			entry.type === "custom_message" &&
			(entry.customType === "team-dispatch" || entry.customType === "team-result")
		) {
			const details = object(entry.details);
			if (typeof details?.jobId !== "string") continue;
			const dispatchEntityId = entry.customType === "team-dispatch" ? dispatchEntities.get(entry.id) : undefined;
			if (dispatchEntityId) dispatches.set(details.jobId, dispatchEntityId);
			const run =
				runs.get(details.jobId) ??
				fresh(sessionId, details.jobId, typeof details.question === "string" ? details.question : "/team");
			if (entry.customType === "team-result") run.report = entry.content;
			if (
				!run.nodes.length &&
				!run.unavailable.includes("Native child observations were not recorded for this run.")
			)
				run.unavailable.push("Native child observations were not recorded for this run.");
			runs.set(run.jobId, run);
		}
	}
	for (const run of runs.values()) {
		// 旧 observation 快照可能晚于 dispatch 写入；锚点只取真实公开行，不能被快照覆盖。
		run.dispatchEntityId = dispatches.get(run.jobId);
		// 进程消失不等于成功或取消；历史 running 观察只能表示最后已知状态。
		if (run.status === "running") {
			run.status = "unavailable";
			run.unavailable.push("No live native owner; last recorded state was running.");
		}
	}
	return runs;
}

export class OmpTeamBridge {
	readonly #sessions: OmpTeamBridgeSessions;
	readonly #observations = new Map<string, Observation>();
	constructor(options: { sessions: OmpTeamBridgeSessions }) {
		this.#sessions = options.sessions;
	}

	observeSession(record: ZCodeSessionRecord): void {
		if (this.#observations.get(record.id)?.record === record) return;
		this.detach(record.id);
		const observation: Observation = {
			record,
			runs: readOmpTeamJournal(record.id, record.session.sessionManager.getBranchView()),
			unsubscribe: [],
			settling: new Set(),
			dirty: new Set(),
			samples: new Map(),
			progress: new Map(),
		};
		this.#observations.set(record.id, observation);
		const bus = record.session.subagentEventBus ?? record.session.eventBus;
		for (const channel of [
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			TASK_SUBAGENT_EVENT_CHANNEL,
		]) {
			if (bus) observation.unsubscribe.push(bus.on(channel, raw => this.#frame(observation, channel, raw)));
		}
		observation.unsubscribe.push(
			record.registry.onChange(event => {
				for (const run of observation.runs.values()) {
					const node = run.nodes.find(item => item.id === event.ref.id);
					if (!node) continue;
					if (this.#metadata(node, event.ref)) this.#persist(observation, run);
				}
			}),
		);
		observation.unsubscribe.push(
			record.session.subscribe(event => {
				// token delta 不改变 job 所有者状态；结算另由 promise 收口，避免重复扫描完整结果。
				if (event.type !== "message_update") this.#sample(observation);
			}),
		);
		this.#sample(observation);
	}

	#jobs(observation: Observation): AsyncJob[] {
		const manager = observation.record.session.asyncJobManager;
		return manager
			? manager
					.getAllJobs()
					.filter(
						job =>
							job.label.startsWith("/team ") &&
							job.ownerId === (observation.record.session.getAgentId() ?? "Main"),
					)
			: [];
	}
	#sample(observation: Observation): void {
		const entries = observation.record.session.sessionManager.getBranchView();
		const entities = projectCustomMessageEntityIds(observation.record.id, entries);
		const dispatches = new Map<string, string>();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== "team-dispatch") continue;
			const jobId = object(entry.details)?.jobId;
			const entityId = entities.get(entry.id);
			if (typeof jobId === "string" && entityId) dispatches.set(jobId, entityId);
		}
		for (const job of this.#jobs(observation)) {
			let run = observation.runs.get(job.id);
			if (!run) {
				run = fresh(observation.record.id, job.id, job.label);
				observation.runs.set(job.id, run);
			}
			const previous = observation.samples.get(job.id);
			const dispatchEntityId = dispatches.get(job.id);
			if (
				previous?.status === job.status &&
				previous.error === job.errorText &&
				previous.details === job.latestDetails &&
				previous.structured === job.structured &&
				previous.dispatchEntityId === dispatchEntityId
			)
				continue;
			observation.samples.set(job.id, {
				status: job.status,
				error: job.errorText,
				details: job.latestDetails,
				structured: job.structured,
				dispatchEntityId,
			});
			const before = {
				status: run.status,
				stage: run.stage,
				participants: run.participants,
				result: run.result,
				error: run.error,
				dispatchEntityId: run.dispatchEntityId,
			};
			run.dispatchEntityId = dispatchEntityId;
			run.source = "native-live";
			run.status = job.status;
			const details = job.latestDetails;
			if (typeof details?.stage === "string") run.stage = details.stage;
			if (
				Array.isArray(details?.participants) &&
				details.participants !== run.participants &&
				JSON.stringify(details.participants) !== JSON.stringify(run.participants)
			)
				run.participants = details.participants;
			if (job.structured !== previous?.structured && job.structured && Object.hasOwn(job.structured, "data")) {
				run.result = job.structured.data;
				const result = object(run.result);
				if (Array.isArray(result?.subagentResults))
					for (const raw of result.subagentResults) {
						const call = object(raw);
						const node = run.nodes.find(item => item.label === call?.label);
						const outcome = object(call?.outcome);
						if (node && outcome) {
							node.output = outcome.data;
							if (typeof outcome.error === "string") node.error = outcome.error;
							if (typeof call?.modelPattern === "string" && !node.model) node.model = call.modelPattern;
						}
						if (
							!node &&
							!run.unavailable.includes(
								"Some native child calls predate the observation bridge; their registry IDs/transcripts are unavailable.",
							)
						)
							run.unavailable.push(
								"Some native child calls predate the observation bridge; their registry IDs/transcripts are unavailable.",
							);
					}
			}
			const result = object(run.result);
			if (
				job.status !== "cancelled" &&
				(result?.status === "completed" || result?.status === "failed" || result?.status === "cancelled")
			)
				run.status = result.status;
			if (typeof result?.failureReason === "string") run.error = result.failureReason;
			if (typeof result?.reportMarkdown === "string") run.report = result.reportMarkdown;
			if (job.errorText && !run.error) run.error = job.errorText;
			// details 可发布等效的新对象；只有投影事实改变才新增 job 时间线和完整快照。
			if (
				before.status !== run.status ||
				before.stage !== run.stage ||
				before.participants !== run.participants ||
				before.result !== run.result ||
				before.error !== run.error ||
				before.dispatchEntityId !== run.dispatchEntityId
			) {
				this.#timeline(run, "job", { status: run.status, stage: run.stage, participants: run.participants });
				this.#persist(observation, run);
			}
			if (!observation.settling.has(job.id)) {
				observation.settling.add(job.id);
				void job.promise
					.then(() => {
						if (this.#observations.get(observation.record.id) === observation) this.#sample(observation);
					})
					.catch(error => logger.warn("Team observation completion failed", { error: String(error) }));
			}
		}
	}
	#metadata(node: OmpTeamNode, ref: AgentRef): boolean {
		const { model, sessionFile, outputPath } = node;
		node.model =
			ref.history?.resolvedModel ??
			(ref.session?.model ? `${ref.session.model.provider}/${ref.session.model.id}` : node.model);
		node.sessionFile = ref.sessionFile ?? node.sessionFile;
		node.outputPath = ref.history?.outputPath ?? node.outputPath;
		return model !== node.model || sessionFile !== node.sessionFile || outputPath !== node.outputPath;
	}
	#frame(observation: Observation, channel: string, raw: unknown): void {
		const frame = object(raw);
		const progress = object(frame?.progress);
		const id = typeof frame?.id === "string" ? frame.id : typeof progress?.id === "string" ? progress.id : undefined;
		if (!id || !callIdentity(id)) return;
		this.#sample(observation);
		const known = [...observation.runs.values()].find(run => run.nodes.some(node => node.id === id));
		// 同时运行多个 Team 时必须用原生日志上下文关联 job，禁止按最新任务或相同模型猜测。
		const jobId = logger.getLogContext().job_id;
		const run = known ?? (typeof jobId === "string" ? observation.runs.get(jobId) : undefined);
		if (!run) return;
		let node = run.nodes.find(item => item.id === id);
		if (!node) {
			node = {
				id,
				label: id,
				role: "unavailable",
				status: "unavailable",
				tools: [],
				messages: [],
				...callIdentity(id),
			};
			run.nodes.push(node);
			updateEdges(run);
		}
		const ref = observation.record.registry.get(id);
		let changed = ref ? this.#metadata(node, ref) : false;
		if (typeof frame?.sessionFile === "string" && node.sessionFile !== frame.sessionFile) {
			node.sessionFile = frame.sessionFile;
			changed = true;
		}
		if (channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) {
			const status =
				frame?.status === "started" ? "running" : frame?.status === "aborted" ? "cancelled" : String(frame?.status);
			if (status === node.status && !changed) return;
			node.status = status;
			this.#timeline(run, "lifecycle", { status: node.status, sessionFile: node.sessionFile }, id);
		} else if (channel === TASK_SUBAGENT_PROGRESS_CHANNEL) {
			if (typeof progress?.status === "string")
				node.status = progress.status === "aborted" ? "cancelled" : progress.status;
			const resolvedModel = progress?.resolvedModelIdentity ?? progress?.resolvedModel;
			if (typeof resolvedModel === "string") node.model = resolvedModel;
			const previous = observation.progress.get(id);
			const currentTool = progress?.currentTool;
			if (
				!changed &&
				previous?.status === node.status &&
				previous.currentTool === currentTool &&
				previous.model === node.model
			)
				return;
			observation.progress.set(id, { status: node.status, currentTool, model: node.model });
			this.#timeline(run, "progress", { status: node.status, currentTool, model: node.model }, id);
			// 原生 progress 包含高频时长/文本更新；仅记录可见变化，合并到下一持久状态边界。
			observation.dirty.add(run.jobId);
			if (["completed", "failed", "cancelled"].includes(node.status)) this.#persist(observation, run);
			return;
		} else {
			const event = object(frame?.event);
			if (event?.type === "tool_execution_end") {
				const tool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				};
				node.tools.push(tool);
				this.#timeline(run, "tool", tool, id);
			} else if (event?.type === "message_end") {
				const message = object(event.message);
				if (message?.role === "assistant" && Array.isArray(message.content)) {
					const text = message.content.filter(item => object(item)?.type === "text");
					if (text.length) node.messages.push({ role: "assistant", content: text });
					if (typeof message.errorMessage === "string") node.error = message.errorMessage;
				} else if (message?.role === "toolResult") node.messages.push(message);
			} else return;
		}
		updateEdges(run);
		this.#persist(observation, run);
	}
	#timeline(run: OmpTeamRun, kind: string, data: unknown, nodeId?: string): void {
		run.timeline.push({
			sequence: run.timeline.length + 1,
			timestamp: Date.now(),
			kind,
			...(nodeId ? { nodeId } : {}),
			data,
		});
	}
	#persist(observation: Observation, run: OmpTeamRun): void {
		if (this.#observations.get(observation.record.id) !== observation) return;
		observation.dirty.add(run.jobId);
		try {
			observation.record.session.sessionManager.appendCustomEntry(OBSERVATION, {
				version: 1,
				run: JSON.parse(JSON.stringify(run)),
			});
			observation.dirty.delete(run.jobId);
		} catch (error) {
			logger.warn("Team observation journal write failed", { error: String(error) });
		}
	}
	async handle(
		raw: unknown,
	): Promise<{ runs: OmpTeamRun[] } | { run: OmpTeamRun } | { accepted: boolean; run: OmpTeamRun }> {
		const request = object(raw);
		if (
			!request ||
			!["list", "read", "stop"].includes(String(request.action)) ||
			typeof request.sessionId !== "string" ||
			!request.sessionId.trim()
		)
			throw new Error("Invalid omp/team request");
		const action = request.action;
		const allowed = action === "list" ? ["action", "sessionId"] : ["action", "sessionId", "jobId"];
		if (
			Object.keys(request).some(key => !allowed.includes(key)) ||
			(action !== "list" && (typeof request.jobId !== "string" || !request.jobId.trim()))
		)
			throw new Error("Invalid omp/team request fields");
		const live = this.#sessions.get(request.sessionId);
		if (live) this.observeSession(live);
		const observation = this.#observations.get(request.sessionId);
		if (observation) this.#sample(observation);
		if (observation)
			for (const run of observation.runs.values())
				if (observation.dirty.has(run.jobId)) this.#persist(observation, run);
		const runs =
			observation?.runs ??
			readOmpTeamJournal(request.sessionId, (await this.#sessions.read(request.sessionId)).entries);
		if (action === "list") return { runs: [...runs.values()] };
		const run = runs.get(request.jobId as string);
		if (!run) throw new Error("Native Team run not found");
		if (action === "read") return { run };
		const job = observation && this.#jobs(observation).find(item => item.id === run.jobId);
		const accepted = Boolean(
			job &&
			job.status === "running" &&
			observation?.record.session.asyncJobManager?.cancel(job.id, { ownerId: job.ownerId }),
		);
		if (observation) this.#sample(observation);
		return { accepted, run };
	}
	detach(sessionId: string): void {
		const observation = this.#observations.get(sessionId);
		if (!observation) return;
		this.#sample(observation);
		for (const run of observation.runs.values())
			if (observation.dirty.has(run.jobId)) this.#persist(observation, run);
		this.#observations.delete(sessionId);
		for (const unsubscribe of observation.unsubscribe) unsubscribe();
	}
	dispose(): void {
		for (const id of this.#observations.keys()) this.detach(id);
	}
}
