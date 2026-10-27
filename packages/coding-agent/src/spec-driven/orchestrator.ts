import * as crypto from "node:crypto";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	SpecAgentInput,
	SpecApproval,
	SpecConversationRecipient,
	SpecDocument,
	SpecDrivenOptions,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecFileVersion,
	SpecRunContext,
	SpecSavedRun,
	SpecStageRole,
	SpecVersionCheck,
} from "./types";

export class StaleRun extends Error {}
export class SpecAdmissionError extends Error {
	readonly code = "invalid_params";
}
const ROLES: SpecStageRole[] = ["requirements", "solution", "planner", "executor"];
const PHASE = {
	requirements: "requirements",
	solution: "solution",
	planner: "planning",
	executor: "executing",
} as const;
const version = ({ path, version }: SpecFileVersion): SpecFileVersion => ({ path, version });

/** Explicit imperative only: discussion/assent is not repair authorization or stage approval. */
export function hasExplicitRepairIntent(text: string): boolean {
	return /^\s*(?:repair\b|(?:请(?:你)?(?:帮我)?\s*|帮我\s*)修复|(?:请(?:你)?\s*)?(?:修复(?:[:：\s]|$|这个|这份|这些|该|当前|报告|归档|收尾|已批准|批准范围内)|继续实施已批准))/iu.test(
		text,
	);
}

/** Explicit decisions advance files; ordinary conversation remains entirely native. */
export class SpecDrivenOrchestrator {
	readonly runId: string;
	readonly #ports: SpecDrivenPorts;
	readonly #options: SpecDrivenOptions;
	#state: SpecDrivenStatus;
	#approvals: Partial<Record<SpecStageRole, SpecApproval>> = {};
	#sessions: SpecSavedRun["sessions"] = {};
	#reportNeedsUpdate?: boolean;
	#request = "";
	#abort = new AbortController();
	#transition = false;

	constructor(ports: SpecDrivenPorts, options: SpecDrivenOptions) {
		this.#ports = ports;
		this.#options = options;
		this.runId = options.runId ?? crypto.randomUUID();
		this.#state = { phase: "idle", generation: 0, useTeam: options.getUseTeam() };
	}
	status(): SpecDrivenStatus {
		return structuredClone({ ...this.#state, useTeam: this.#options.getUseTeam() });
	}
	isTransitioning(): boolean {
		return this.#transition;
	}
	currentRole(): SpecStageRole | undefined {
		return ROLES.find(role => PHASE[role] === this.#state.phase);
	}
	recipient(): SpecConversationRecipient | undefined {
		const role = this.currentRole();
		return role ? this.#ports.agents.recipient(role) : undefined;
	}
	#context(): SpecRunContext {
		return { runId: this.runId, generation: this.#state.generation, signal: this.#abort.signal };
	}
	#guard(context: SpecRunContext): void {
		if (context.signal.aborted || context.generation !== this.#state.generation) throw new StaleRun("当前操作已停止");
	}
	#notify(): void {
		this.#options.onStatusChange?.(this.status());
	}
	save(): SpecSavedRun {
		return structuredClone({
			runId: this.runId,
			phase: this.#state.phase,
			changeId: this.#state.changeId,
			paths: this.#state.paths,
			approvals: this.#approvals,
			sessions: this.#sessions,
			awaitingAcceptance: this.#state.awaitingAcceptance,
			reportNeedsUpdate: this.#reportNeedsUpdate,
			closing: this.#state.closing,
			archivedChangePath: this.#state.archivedChangePath,
		});
	}
	async #persist(): Promise<void> {
		await this.#options.persist(this.save());
	}
	async #control(work: (context: SpecRunContext) => Promise<void>): Promise<SpecDrivenStatus> {
		if (this.#transition) throw new SpecAdmissionError("当前控制操作尚未结清");
		this.#options.assertTransitionAllowed?.();
		this.#transition = true;
		const context = this.#context();
		try {
			await work(context);
			this.#guard(context);
			this.#notify();
			return this.status();
		} catch (error) {
			if (!context.signal.aborted) {
				this.#state.blockedReason = error instanceof Error ? error.message : String(error);
				this.#notify();
			}
			throw error;
		} finally {
			this.#transition = false;
		}
	}
	async #commit(state: SpecDrivenStatus, approvals = this.#approvals): Promise<void> {
		const oldState = this.#state;
		const oldApprovals = this.#approvals;
		this.#state = { ...state, blockedReason: undefined };
		this.#approvals = approvals;
		try {
			await this.#persist();
		} catch (error) {
			this.#state = oldState;
			this.#approvals = oldApprovals;
			throw error;
		}
		this.#notify();
	}
	async #prepare(role: SpecStageRole, context: SpecRunContext): Promise<void> {
		await this.#ports.agents.prepare(role, context, this.#sessions[role]);
		this.#guard(context);
		const recipient = this.#ports.agents.recipient(role);
		if (!recipient) throw new Error(`无法建立 ${role} 原生会话`);
		this.#sessions[role] = recipient;
	}
	#input(role: SpecStageRole, entry: boolean, files: SpecDocument[] = []): SpecAgentInput {
		const paths = this.#state.paths;
		if (!paths) throw new Error("尚未初始化产物路径");
		return {
			role,
			entry,
			request: entry ? this.#request || this.#ports.agents.originalRequest() : "",
			files,
			outputPaths:
				role === "requirements"
					? paths.requirements
					: [role === "solution" ? paths.solution : role === "planner" ? paths.plan : paths.report],
			userReply: entry ? this.#approvals[ROLES[ROLES.indexOf(role) - 1]]?.userReply : undefined,
			decisions: entry
				? Object.fromEntries(Object.entries(this.#approvals).map(([role, approval]) => [role, approval.userReply]))
				: undefined,
			candidateId: entry ? this.#state.selection?.candidateId : undefined,
			useTeam: entry && role === "solution" ? this.#options.getUseTeam() : false,
		};
	}
	async #run(
		role: SpecStageRole,
		context: SpecRunContext,
		files: SpecDocument[],
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<void> {
		// Preparation is settled; native admission now owns busy conversation and queues.
		this.#transition = false;
		await this.#ports.agents.run({ ...this.#input(role, true, files), images, imageLinks }, context);
		this.#guard(context);
	}
	async start(
		request: string,
		changeId: string,
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<SpecDrivenStatus> {
		return this.#control(async context => {
			if (this.#state.phase !== "idle" || (this.#state.changeId && !this.#state.archivedChangePath))
				throw new SpecAdmissionError("已有流程，请先退出或丢弃");
			if (!request.trim() || !changeId.trim()) throw new SpecAdmissionError("需求与变更 ID 不能为空");
			const paths = await this.#ports.artifacts.initialize(changeId, context);
			await this.#prepare("requirements", context);
			await this.#commit(
				{
					phase: "requirements",
					generation: this.#state.generation,
					useTeam: this.#options.getUseTeam(),
					changeId,
					paths,
				},
				{},
			);
			this.#request = request;
			await this.#run("requirements", context, [], images, imageLinks);
		});
	}
	async checkApproved(): Promise<SpecVersionCheck> {
		const files = Object.values(this.#approvals).flatMap(approval => approval.files);
		return this.#ports.artifacts.checkVersions(
			files,
			this.#state.closing?.archivedChangePath ?? this.#state.archivedChangePath,
		);
	}
	async #requireApproved(): Promise<void> {
		const check = await this.checkApproved();
		if (!check.matches)
			throw new SpecAdmissionError(
				`已批准材料发生变化，须返回对应阶段重新确认：${check.changed.map(file => `${file.path}: ${file.reason}`).join("；")}`,
			);
	}
	#requireApprovedDocuments(role: SpecStageRole, files: readonly SpecDocument[]): void {
		const approval = this.#approvals[role];
		if (!approval) return;
		if (
			approval.files.length !== files.length ||
			approval.files.some(
				approved => !files.some(file => file.path === approved.path && file.version === approved.version),
			)
		)
			throw new SpecAdmissionError("已批准材料在读取时发生变化，须返回对应阶段重新确认");
	}
	async next(
		candidateId?: string,
		rawDecision = candidateId ? `/dev next ${candidateId}` : "/dev next",
	): Promise<SpecDrivenStatus> {
		return this.#control(async context => {
			const role = this.currentRole();
			if (!role) throw new SpecAdmissionError("请先 /dev new <需求内容>");
			if (candidateId !== undefined && role !== "solution") throw new SpecAdmissionError("仅方案阶段接受方案 ID");
			await this.#requireApproved();
			if (role === "executor") {
				await this.#close(context, rawDecision);
				return;
			}
			const specification = await this.#ports.artifacts.readRequirements(context);
			this.#requireApprovedDocuments("requirements", specification.files);
			const files = [...specification.files];
			let state = { ...this.#state, specification };
			let approval: SpecApproval = { files: files.map(version), userReply: rawDecision };
			if (role === "solution" || role === "planner") {
				const solution = await this.#ports.artifacts.readSolution(context);
				this.#requireApprovedDocuments("solution", [solution]);
				files.push(solution);
				state = { ...state, solution };
				if (role === "solution") {
					const selected =
						candidateId ?? (solution.candidates.length === 1 ? solution.candidates[0].id : undefined);
					if (!selected || !solution.candidates.some(candidate => candidate.id === selected))
						throw new SpecAdmissionError("请选择有效方案 ID；可在材料详情查看完整候选");
					state.selection = { candidateId: selected, userReply: rawDecision };
					approval = { files: [version(solution)], userReply: rawDecision, candidateId: selected };
				}
			}
			if (role === "planner") {
				const plan = await this.#ports.artifacts.readPlan(context);
				files.push(plan);
				state.plan = plan;
				approval = { files: [version(plan)], userReply: rawDecision };
			}
			const target = ROLES[ROLES.indexOf(role) + 1];
			await this.#prepare(target, context);
			this.#guard(context);
			await this.#commit(
				{ ...state, phase: PHASE[target], report: undefined, awaitingAcceptance: false },
				{ ...this.#approvals, [role]: approval },
			);
			await this.#run(target, context, files);
		});
	}
	async #close(context: SpecRunContext, rawDecision: string): Promise<void> {
		if (!this.#approvals.executor) {
			if (this.#reportNeedsUpdate)
				throw new SpecAdmissionError("业务修复后须由执行 Agent 更新完成报告，再次等待验收");
			const specification = await this.#ports.artifacts.readRequirements(context);
			const solution = await this.#ports.artifacts.readSolution(context);
			this.#requireApprovedDocuments("requirements", specification.files);
			this.#requireApprovedDocuments("solution", [solution]);
			const plan = await this.#ports.artifacts.readPlan(context);
			this.#requireApprovedDocuments("planner", [plan]);
			const report = await this.#ports.artifacts.readReport(context);
			this.#guard(context);
			const accepted = {
				files: [...specification.files, solution, plan, report].map(version),
				userReply: rawDecision,
			};
			await this.#commit(
				{ ...this.#state, specification, solution, plan, report, accepted, awaitingAcceptance: true, closing: {} },
				{ ...this.#approvals, executor: accepted },
			);
		}
		const result = await this.#ports.artifacts.close(
			{
				acceptedVersions: this.#approvals.executor!.files,
				progress: this.#state.closing,
				onProgress: async progress => {
					// Actual external effects cannot be rolled back when persistence itself fails.
					this.#state.closing = { ...progress };
					await this.#persist();
					this.#notify();
				},
			},
			context,
		);
		this.#guard(context);
		await this.#commit({
			...this.#state,
			phase: "idle",
			archivedChangePath: result.archivedChangePath,
			closing: { ...this.#state.closing, archivedChangePath: result.archivedChangePath },
		});
	}
	async back(): Promise<SpecDrivenStatus> {
		return this.#control(async context => {
			const role = this.currentRole();
			if (!role || role === "requirements") throw new SpecAdmissionError("当前阶段不能回退");
			if (this.#state.closing?.synced || this.#state.closing?.archivedChangePath)
				throw new SpecAdmissionError("收尾已产生实际结果，不能回退");
			const target = ROLES[ROLES.indexOf(role) - 1];
			const approvals = { ...this.#approvals };
			for (const removed of ROLES.slice(ROLES.indexOf(target))) delete approvals[removed];
			await this.#prepare(target, context);
			const invalidated = this.#reportNeedsUpdate;
			this.#reportNeedsUpdate = undefined;
			try {
				await this.#commit(
					{
						...this.#state,
						phase: PHASE[target],
						selection: target === "requirements" || target === "solution" ? undefined : this.#state.selection,
						accepted: undefined,
						closing: undefined,
						report: undefined,
						awaitingAcceptance: false,
					},
					approvals,
				);
			} catch (error) {
				this.#reportNeedsUpdate = invalidated;
				throw error;
			}
		});
	}
	async converse(
		text: string,
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
		intent?: "repair",
	): Promise<SpecDrivenStatus> {
		if (this.#transition) throw new SpecAdmissionError("当前控制操作尚未结清");
		const role = this.currentRole();
		if (!role) throw new SpecAdmissionError("请先 /dev new <需求内容>");
		const approved = await this.checkApproved();
		if (!approved.matches && intent === "repair")
			throw new SpecAdmissionError("已批准材料发生变化，须返回对应阶段重新确认后才能修复");
		const context = this.#context();
		const blockedReason = this.#state.blockedReason;
		const closing = !!this.#approvals.executor;
		await this.#ports.agents.run(
			{
				...this.#input(role, false),
				feedback: text,
				images,
				imageLinks,
				readOnly:
					!approved.matches ||
					(role === "executor" && (closing || this.#state.awaitingAcceptance) && intent !== "repair"),
			},
			context,
		);
		this.#guard(context);
		if (approved.matches && blockedReason && this.#state.blockedReason === blockedReason) {
			const current = await this.checkApproved();
			this.#guard(context);
			if (current.matches && this.#state.blockedReason === blockedReason) {
				this.#state.blockedReason = undefined;
				this.#notify();
			}
		}
		return this.status();
	}
	/** Native before_agent_start only: queued repair text has now reached its actual turn. */
	async beginRepair(): Promise<void> {
		if (this.#state.phase !== "executing") throw new SpecAdmissionError("仅执行阶段支持范围内修复");
		await this.#requireApproved();
		if (this.#approvals.executor) return;
		const invalidated = this.#reportNeedsUpdate;
		this.#reportNeedsUpdate = true;
		try {
			await this.#commit({ ...this.#state, awaitingAcceptance: false, report: undefined });
		} catch (error) {
			this.#reportNeedsUpdate = invalidated;
			throw error;
		}
	}
	/** Called only after a successful native write/edit of this run's report, never after a reply. */
	async observeReport(): Promise<void> {
		if (this.#state.phase !== "executing" || this.#approvals.executor) return;
		this.#reportNeedsUpdate = undefined;
		this.#state.awaitingAcceptance = true;
		await this.#persist();
		this.#notify();
	}
	async restore(saved: SpecSavedRun): Promise<SpecDrivenStatus> {
		return this.#control(async context => {
			if (saved.runId !== this.runId) throw new SpecAdmissionError("恢复流程 ID 不匹配");
			if (this.#state.phase !== "idle" || this.#state.changeId) throw new SpecAdmissionError("已有流程不能覆盖恢复");
			this.#sessions = structuredClone(saved.sessions);
			this.#approvals = structuredClone(saved.approvals);
			this.#reportNeedsUpdate = saved.reportNeedsUpdate;
			this.#state = {
				phase: saved.phase,
				generation: 0,
				changeId: saved.changeId,
				paths: saved.paths,
				selection: saved.approvals.solution?.candidateId
					? { candidateId: saved.approvals.solution.candidateId, userReply: saved.approvals.solution.userReply }
					: undefined,
				accepted: saved.approvals.executor,
				awaitingAcceptance: saved.awaitingAcceptance,
				closing: saved.closing,
				archivedChangePath: saved.archivedChangePath,
				useTeam: this.#options.getUseTeam(),
			};
			// The durable run remains the owner even if native history restoration fails.
			for (const role of ROLES) {
				if (!saved.sessions[role]) continue;
				await this.#prepare(role, context);
			}
			this.#guard(context);
			await this.#persist();
			const check = await this.checkApproved();
			if (!check.matches)
				this.#state.blockedReason = check.changed.map(file => `${file.path}: ${file.reason}`).join("；");
		});
	}
	async stop(): Promise<void> {
		this.#abort.abort();
		this.#state.generation++;
		this.#notify();
	}
}
