import * as crypto from "node:crypto";
import { isDecisionPhase, isExecutionPhase, type SpecRunTiming } from "./stages";
import type {
	SpecAgentInput,
	SpecConversationRecipient,
	SpecConversationReply,
	SpecDocument,
	SpecDrivenOptions,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecRunContext,
	SpecStageRole,
} from "./types";

export class StaleRun extends Error {}
export class SpecAdmissionError extends Error {
	readonly code = "invalid_params";
}
const ACTIVE = {
	requirements: "requirements",
	solution: "solution",
	planner: "planning",
	executor: "executing",
} as const;
const WAITING = {
	requirements: "awaiting-specification",
	solution: "awaiting-choice",
	planner: "awaiting-plan",
	executor: "awaiting-acceptance",
} as const;

/** Session-scoped file workflow. Agent text is presentation, never a transition protocol. */
export class SpecDrivenOrchestrator {
	readonly runId: string;
	readonly #ports: SpecDrivenPorts;
	readonly #options: SpecDrivenOptions;
	#state: SpecDrivenStatus = { phase: "idle", paused: false, generation: 0 };
	#abort = new AbortController();
	#mutation?: Promise<SpecDrivenStatus>;
	#request = "";
	#confirmations: Partial<Record<SpecStageRole, string>> = {};
	#timedPhase: SpecDrivenStatus["phase"] = "idle";
	#phaseStartedAt = Date.now();
	#totals: SpecRunTiming = { plannedDecisionWaitMs: 0, executionWaitMs: 0 };

	constructor(ports: SpecDrivenPorts, options: SpecDrivenOptions) {
		if (!options.currentModel.trim()) throw new Error("A current model is required");
		this.#ports = ports;
		this.#options = options;
		this.runId = options.runId ?? crypto.randomUUID();
	}
	status(): SpecDrivenStatus {
		this.#trackTiming();
		return structuredClone(this.#state);
	}
	#trackTiming(now = Date.now()): void {
		if (this.#timedPhase === this.#state.phase) return;
		const elapsed = Math.max(0, now - this.#phaseStartedAt);
		if (isDecisionPhase(this.#timedPhase)) this.#totals.plannedDecisionWaitMs += elapsed;
		else if (isExecutionPhase(this.#timedPhase)) this.#totals.executionWaitMs += elapsed;
		this.#timedPhase = this.#state.phase;
		this.#phaseStartedAt = now;
	}
	timing(): SpecRunTiming {
		const now = Date.now();
		this.#trackTiming(now);
		const elapsed = Math.max(0, now - this.#phaseStartedAt);
		return {
			plannedDecisionWaitMs: this.#totals.plannedDecisionWaitMs + (isDecisionPhase(this.#timedPhase) ? elapsed : 0),
			executionWaitMs: this.#totals.executionWaitMs + (isExecutionPhase(this.#timedPhase) ? elapsed : 0),
		};
	}
	currentRole(): SpecStageRole | undefined {
		const phase = this.#state.phase;
		if (["requirements", "awaiting-specification"].includes(phase)) return "requirements";
		if (["solution", "awaiting-choice"].includes(phase)) return "solution";
		if (["planning", "awaiting-plan"].includes(phase)) return "planner";
		if (["executing", "awaiting-acceptance"].includes(phase)) return "executor";
		return undefined;
	}
	recipient(): SpecConversationRecipient | undefined {
		const role = this.currentRole();
		return role ? this.#ports.agents.recipient(role) : undefined;
	}
	#guard(context: SpecRunContext): void {
		if (
			context.signal.aborted ||
			context.generation !== this.#state.generation ||
			this.#state.paused ||
			this.#state.phase === "cancelled"
		)
			throw new StaleRun("当前操作已暂停或取消");
	}
	async #checked<T>(promise: Promise<T>, context: SpecRunContext): Promise<T> {
		const result = await promise;
		this.#guard(context);
		return result;
	}
	#notify(): void {
		this.#options.onStatusChange?.(this.status());
	}
	#mutate(
		work: (context: SpecRunContext) => Promise<void>,
		signal?: AbortSignal,
		transition = true,
	): Promise<SpecDrivenStatus> {
		if (this.#mutation) return Promise.reject(new SpecAdmissionError("当前操作尚未结清"));
		if (this.#state.paused || this.#state.phase === "cancelled")
			return Promise.reject(new SpecAdmissionError("请先恢复当前流程"));
		if (transition) this.#options.assertTransitionAllowed?.();
		const context: SpecRunContext = {
			runId: this.runId,
			generation: this.#state.generation,
			signal: signal ? AbortSignal.any([this.#abort.signal, signal]) : this.#abort.signal,
		};
		const promise = (async () => {
			this.#guard(context);
			try {
				await work(context);
				this.#guard(context);
				this.#notify();
				return this.status();
			} catch (error) {
				this.#guard(context);
				if (!(error instanceof SpecAdmissionError))
					this.#state.blockedReason = error instanceof Error ? error.message : String(error);
				this.#notify();
				throw error;
			}
		})();
		this.#mutation = promise;
		void promise
			.finally(() => {
				if (this.#mutation === promise) this.#mutation = undefined;
			})
			.catch(() => {});
		return promise;
	}
	#requirePhase(...phases: SpecDrivenStatus["phase"][]): void {
		if (!phases.includes(this.#state.phase))
			throw new SpecAdmissionError(`当前阶段 ${this.#state.phase} 不支持此操作`);
	}
	#upstream(role: SpecStageRole): SpecDocument[] {
		const files = [...(this.#state.specification?.files ?? [])];
		if (role === "requirements") return files;
		if ((role === "planner" || role === "executor") && this.#state.solution) files.push(this.#state.solution);
		if (role === "executor" && this.#state.plan) files.push(this.#state.plan);
		return files;
	}
	async #runStage(role: SpecStageRole, context: SpecRunContext, feedback?: string, readOnly = false): Promise<void> {
		const paths = this.#state.paths;
		if (!paths) throw new Error("尚未初始化文件路径");
		if (!readOnly) this.#state.phase = ACTIVE[role];
		this.#state.blockedReason = undefined;
		this.#notify();
		const input: SpecAgentInput = {
			role,
			request: this.#request,
			files: readOnly && this.#state.report ? [...this.#upstream(role), this.#state.report] : this.#upstream(role),
			outputPaths:
				role === "requirements"
					? paths.requirements
					: [role === "solution" ? paths.solution : role === "planner" ? paths.plan : paths.report],
			userReply: this.#confirmations[role],
			candidateId: role === "planner" || role === "executor" ? this.#state.selection?.candidateId : undefined,
			feedback,
			readOnly,
		};
		const reply = await this.#checked(this.#ports.agents.run(input, context), context);
		this.#state.lastReply = reply.text;
		if (!readOnly) await this.#readStage(role, context);
	}
	async #readStage(role: SpecStageRole, context: SpecRunContext): Promise<void> {
		try {
			if (role === "requirements")
				this.#state.specification = await this.#checked(this.#ports.artifacts.readRequirements(context), context);
			else if (role === "solution")
				this.#state.solution = await this.#checked(this.#ports.artifacts.readSolution(context), context);
			else if (role === "planner")
				this.#state.plan = await this.#checked(this.#ports.artifacts.readPlan(context), context);
			else this.#state.report = await this.#checked(this.#ports.artifacts.readReport(context), context);
			this.#state.phase = WAITING[role];
			this.#state.blockedReason = undefined;
		} catch (error) {
			this.#guard(context);
			this.#state.phase = ACTIVE[role];
			this.#state.blockedReason = error instanceof Error ? error.message : String(error);
		}
	}
	#clearAfter(role: SpecStageRole): void {
		const order: SpecStageRole[] = ["requirements", "solution", "planner", "executor"];
		const index = order.indexOf(role);
		for (const downstream of order.slice(index + 1)) delete this.#confirmations[downstream];
		if (index <= 0) this.#state.solution = undefined;
		if (index <= 1) this.#state.selection = undefined;
		if (index <= 1) this.#state.plan = undefined;
		this.#state.report = undefined;
	}
	/** Reject changed approved bytes, exposing the new file for an explicit new decision. */
	async #checkUpstream(role: SpecStageRole, context: SpecRunContext): Promise<void> {
		const checks: SpecStageRole[] =
			role === "solution"
				? ["requirements"]
				: role === "planner"
					? ["requirements", "solution"]
					: ["requirements", "solution", "planner"];
		for (const upstream of checks) {
			const previous =
				upstream === "requirements"
					? this.#state.specification
					: upstream === "solution"
						? this.#state.solution
						: this.#state.plan;
			const originalPhase = this.#state.phase;
			await this.#readStage(upstream, context);
			this.#guard(context);
			const current =
				upstream === "requirements"
					? this.#state.specification
					: upstream === "solution"
						? this.#state.solution
						: this.#state.plan;
			if (this.#state.blockedReason || !previous || current?.version !== previous.version) {
				this.#clearAfter(upstream);
				this.#state.blockedReason ??= "上游文件已变化，请重新确认后继续";
				throw new SpecAdmissionError(this.#state.blockedReason);
			}
			this.#state.phase = originalPhase;
		}
	}
	start(request: string, changeId: string): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			this.#requirePhase("idle");
			if (!request.trim() || !changeId.trim()) throw new SpecAdmissionError("需求和变更标识不能为空");
			this.#request = request;
			this.#state.changeId = changeId;
			this.#state.phase = "requirements";
			this.#state.paths = await this.#checked(this.#ports.artifacts.initialize(changeId, context), context);
			await this.#runStage("requirements", context);
		});
	}
	answer(text: string): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			const role = this.currentRole();
			if (!role || !text.trim()) throw new SpecAdmissionError("当前没有可回复的阶段，或回复为空");
			if (role !== "requirements") await this.#checkUpstream(role, context);
			await this.#runStage(role, context, text, this.#state.phase === "awaiting-acceptance");
		});
	}
	async converse(input: {
		text: string;
		messageId: string;
		recipient: SpecConversationRecipient;
		signal: AbortSignal;
	}): Promise<SpecConversationReply> {
		const actual = this.recipient();
		if (
			!actual ||
			actual.role !== input.recipient.role ||
			actual.actorId !== input.recipient.actorId ||
			actual.sessionId !== input.recipient.sessionId
		)
			throw new SpecAdmissionError("当前会话归属已变化");
		const result = await this.#mutate(
			async context => {
				if (actual.role !== "requirements") await this.#checkUpstream(actual.role, context);
				await this.#runStage(actual.role, context, input.text, this.#state.phase === "awaiting-acceptance");
			},
			input.signal,
			false,
		);
		return { text: result.lastReply ?? "" };
	}
	confirmSpecification(userReply = "确认需求"): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			this.#requirePhase("awaiting-specification");
			await this.#checkUpstream("solution", context);
			this.#confirmations.solution = userReply;
			await this.#runStage("solution", context);
		});
	}
	chooseCandidate(candidateId: string, userReply: string): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			this.#requirePhase("awaiting-choice");
			await this.#checkUpstream("planner", context);
			if (!this.#state.solution?.candidates.some(item => item.id === candidateId))
				throw new SpecAdmissionError("方案标识不存在");
			this.#state.selection = { candidateId, userReply };
			this.#confirmations.planner = userReply;
			await this.#runStage("planner", context);
		});
	}
	confirmPlan(userReply = "确认计划"): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			this.#requirePhase("awaiting-plan");
			await this.#checkUpstream("executor", context);
			this.#confirmations.executor = userReply;
			await this.#runStage("executor", context);
		});
	}
	revisePlan(text: string): Promise<SpecDrivenStatus> {
		return this.#revise("planner", text);
	}
	repair(text: string): Promise<SpecDrivenStatus> {
		return this.#revise("executor", text);
	}
	amendRequirements(text: string): Promise<SpecDrivenStatus> {
		return this.#revise("requirements", text);
	}
	changeSolution(text: string): Promise<SpecDrivenStatus> {
		return this.#revise("solution", text);
	}
	#revise(role: SpecStageRole, text: string): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			if (!this.currentRole() || !text.trim()) throw new SpecAdmissionError("当前不能修订，或修订内容为空");
			if (role === "executor") this.#requirePhase("awaiting-acceptance", "executing");
			if (role === "planner" && !this.#state.selection) throw new SpecAdmissionError("请先选择方案");
			if (role === "solution" && this.#confirmations.solution === undefined)
				throw new SpecAdmissionError("请先确认需求");
			if (role !== "requirements") await this.#checkUpstream(role, context);
			this.#clearAfter(role);
			await this.#runStage(role, context, text);
		});
	}
	accept(_userReply = "验收通过"): Promise<SpecDrivenStatus> {
		return this.#mutate(async context => {
			this.#requirePhase("awaiting-acceptance");
			await this.#checkUpstream("executor", context);
			const previous = this.#state.report;
			await this.#readStage("executor", context);
			if (this.#state.blockedReason || !previous || previous.version !== this.#state.report?.version)
				throw new SpecAdmissionError(this.#state.blockedReason ?? "完成报告已变化，请重新验收");
			this.#state.phase = "closing";
			this.#notify();
			await this.#close(context);
		});
	}
	async #close(context: SpecRunContext): Promise<void> {
		if (!this.#state.specification || !this.#state.report) throw new SpecAdmissionError("缺少需求或完成报告");
		const result = await this.#checked(
			this.#ports.artifacts.close({ specification: this.#state.specification, report: this.#state.report }, context),
			context,
		);
		this.#state.archivedChangePath = result.archivedChangePath;
		this.#state.phase = "completed";
	}
	async #interrupt(cancel: boolean): Promise<SpecDrivenStatus> {
		if (this.#state.phase === "completed" || this.#state.phase === "cancelled") return this.status();
		this.#state.generation++;
		this.#state.paused = !cancel;
		if (cancel) this.#state.phase = "cancelled";
		this.#abort.abort();
		this.#notify();
		// Aborting is not settlement: native mutations must finish before a caller can resume.
		const pending = this.#mutation;
		if (pending) await pending.catch(() => {});
		return this.status();
	}
	pause(): Promise<SpecDrivenStatus> {
		return this.#interrupt(false);
	}
	cancel(): Promise<SpecDrivenStatus> {
		return this.#interrupt(true);
	}
	resume(): Promise<SpecDrivenStatus> {
		if (this.#mutation) return Promise.reject(new SpecAdmissionError("当前操作尚未结清"));
		if (this.#state.phase === "cancelled") return Promise.reject(new SpecAdmissionError("流程已取消"));
		this.#state.paused = false;
		this.#abort = new AbortController();
		return this.#mutate(async context => {
			if (this.#state.phase === "closing") {
				await this.#close(context);
				return;
			}
			const role = this.currentRole();
			if (role && this.#state.phase === ACTIVE[role]) {
				if (!this.#state.paths && this.#state.changeId)
					this.#state.paths = await this.#checked(
						this.#ports.artifacts.initialize(this.#state.changeId, context),
						context,
					);
				if (role !== "requirements") await this.#checkUpstream(role, context);
				await this.#runStage(role, context);
			}
		});
	}
}
