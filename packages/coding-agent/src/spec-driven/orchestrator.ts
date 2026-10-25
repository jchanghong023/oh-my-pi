import * as crypto from "node:crypto";
import { parseSpecPlan, parseSpecRequirements, parseSpecReview } from "./schemas";
import { isDecisionPhase, isExecutionPhase, type SpecRunTiming } from "./stages";
import type {
	SpecCandidate,
	SpecConversationRecipient,
	SpecConversationReply,
	SpecStageRole,
	SpecDrivenOptions,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecExecution,
	SpecFinding,
	SpecPlan,
	SpecPlanDraft,
	SpecRequirements,
	SpecReview,
	SpecReviewInput,
	SpecReviewKind,
	SpecReviewSlot,
	SpecRunContext,
	SpecSolution,
	SpecTask,
	SpecTaskState,
	SpecToolRecord,
} from "./types";

export class StaleRun extends Error {}
/** Invalid caller identity, state or approval; execution failures keep their original error. */
export class SpecAdmissionError extends Error {
	readonly code = "invalid_params";
}
const hash = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const substantive = (finding: SpecFinding): boolean => finding.severity !== "minor";

/** Session-scoped controller. All effects are explicit ports; no process-restart recovery is implied. */
export class SpecDrivenOrchestrator {
	readonly #ports: SpecDrivenPorts;
	readonly #options: SpecDrivenOptions;
	readonly #runId: string;
	readonly #members: readonly string[];
	#state: SpecDrivenStatus = {
		phase: "idle",
		paused: false,
		generation: 0,
		questions: [],
		tasks: [],
		reviews: [],
		pendingClosure: [],
	};
	#abort = new AbortController();
	#driving?: Promise<SpecDrivenStatus>;
	#request = "";
	#answer?: string;
	#reviewIndex = 0;
	#requirementsSlot?: SpecReviewSlot;
	#planSlot?: SpecReviewSlot;
	#overallSlot?: SpecReviewSlot;
	#conditionRecords = new Map<string, SpecToolRecord>();
	#finalRecords: SpecToolRecord[] = [];
	#finalValidationRecords = new Map<string, SpecToolRecord>();
	#gitPrepared = false;
	#initialized = false;
	#taskIdentities = new Map<string, string>();
	#preservedTasks = new Map<string, SpecTaskState>();
	#preservedDependencies = new Map<string, readonly string[]>();
	#preserving: Promise<void> = Promise.resolve();
	#dialoguing = false;
	#repair?: { text: string; taskIds: string[] };
	// Retain admitted work through failed/interrupted scope analysis; only explicit resume retries it.
	#pendingRepair?: string;
	#acceptanceRound = 0;
	#clarificationRound = 0;
	#phaseStartedAt = Date.now();
	#timedPhase: SpecDrivenStatus["phase"] = "idle";
	#timingTotals: SpecRunTiming = { plannedDecisionWaitMs: 0, executionWaitMs: 0 };

	constructor(ports: SpecDrivenPorts, options: SpecDrivenOptions) {
		if (!options.currentModel.trim()) throw new Error("A current model is required");
		if (options.unavailableMembers?.length)
			throw new Error(`Unavailable team.members: ${options.unavailableMembers.join(", ")}`);
		if (options.members?.some(member => !member.trim()) || options.members?.length === 0)
			throw new Error("Invalid explicit team.members");
		this.#ports = ports;
		this.#options = options;
		this.#members = options.members ? [...options.members] : [options.currentModel];
		this.#runId = options.runId ?? crypto.randomUUID();
	}

	status(): SpecDrivenStatus {
		this.#trackTiming();
		const state = structuredClone(this.#state);
		if (state.phase === "awaiting-answers")
			state.clarification = {
				id: hash({
					runId: this.#runId,
					round: this.#clarificationRound,
					specification: state.specification?.version,
					questions: state.questions,
				}),
				questions: [...state.questions],
			};
		return state;
	}

	get runId(): string {
		return this.#runId;
	}

	#trackTiming(now = Date.now()): void {
		if (this.#state.phase === this.#timedPhase) return;
		const elapsed = Math.max(0, now - this.#phaseStartedAt);
		if (isDecisionPhase(this.#timedPhase)) this.#timingTotals.plannedDecisionWaitMs += elapsed;
		else if (isExecutionPhase(this.#timedPhase)) this.#timingTotals.executionWaitMs += elapsed;
		this.#timedPhase = this.#state.phase;
		this.#phaseStartedAt = now;
	}

	/** Observed phase time; the current phase is included up to `now` without double counting. */
	timing(): SpecRunTiming {
		const now = Date.now();
		this.#trackTiming(now);
		const current = Math.max(0, now - this.#phaseStartedAt);
		return {
			plannedDecisionWaitMs:
				this.#timingTotals.plannedDecisionWaitMs + (isDecisionPhase(this.#state.phase) ? current : 0),
			executionWaitMs: this.#timingTotals.executionWaitMs + (isExecutionPhase(this.#state.phase) ? current : 0),
		};
	}

	currentRole(): SpecStageRole | undefined {
		const phase = this.#state.phase;
		if (["idle", "completed", "cancelled"].includes(phase)) return undefined;
		if (phase === "awaiting-answers") return this.#state.specificationApproval ? "solution" : "requirements";
		if (["requirements", "requirements-review", "awaiting-specification"].includes(phase)) return "requirements";
		if (["team", "awaiting-choice"].includes(phase)) return "solution";
		if (["planning", "plan-review", "awaiting-plan"].includes(phase)) return "planner";
		return "executor";
	}

	recipient(): SpecConversationRecipient | undefined {
		const role = this.currentRole();
		return role ? this.#ports.conversation?.recipient(role) : undefined;
	}

	async converse(
		text: string,
		messageId: string,
		recipient: SpecConversationRecipient,
		signal: AbortSignal,
	): Promise<SpecConversationReply> {
		const actual = this.recipient();
		if (
			this.#driving ||
			this.#dialoguing ||
			this.#state.paused ||
			!actual ||
			actual.role !== recipient.role ||
			actual.actorId !== recipient.actorId ||
			actual.sessionId !== recipient.sessionId
		)
			throw new SpecAdmissionError("Current stage actor is unavailable or message ownership is stale");
		const conversation = this.#ports.conversation;
		if (!conversation) throw new Error("Current stage dialogue is unavailable");
		const phase = this.#state.phase;
		const context = { ...this.#context(), signal: AbortSignal.any([this.#abort.signal, signal]) };
		this.#dialoguing = true;
		try {
			this.#guard(context);
			const reply = await this.#checked(
				conversation.respond({ text, role: actual.role, status: this.status(), messageId }, context),
				context,
			);
			if (reply.requirements) {
				if (
					actual.role !== "requirements" ||
					this.#state.specificationApproval ||
					!["awaiting-specification", "awaiting-answers"].includes(phase) ||
					reply.plan
				)
					throw new Error("Use explicit amendment to change approved upstream requirements");
				const draft = parseSpecRequirements(reply.requirements);
				if (
					this.#requirementsSlot?.lastReview?.verdict === "pass" &&
					this.#requirementsSlot.reviewedRevision === this.#requirementsSlot.revision
				)
					this.#revise(this.#requirementsSlot);
				const snapshot = await this.#checked(this.#ports.artifacts.writeRequirements(draft, context), context);
				await this.#checked(this.#ports.artifacts.validateRequirements(context), context);
				if (!snapshot.version) throw new Error("Requirements artifact has no content identity");
				this.#state.specification = { ...draft, version: snapshot.version };
				this.#clarificationRound++;
				this.#state.questions = draft.questions;
				this.#state.phase = draft.questions.length ? "awaiting-answers" : "requirements-review";
				await this.#drive(context);
			} else if (reply.plan) {
				if (actual.role !== "planner" || phase !== "awaiting-plan" || this.#state.planApproval)
					throw new Error("Only an unapproved current plan can be revised by dialogue");
				const draft = parseSpecPlan(reply.plan);
				this.#validatePlan(draft);
				if (this.#planSlot) this.#revise(this.#planSlot);
				const snapshot = await this.#checked(this.#ports.artifacts.writePlan(draft, context), context);
				if (!snapshot.version) throw new Error("Plan artifact has no content identity");
				const binding = {
					artifactVersion: snapshot.version,
					specificationVersion: this.#specification().version,
					candidateVersion: this.#candidate().version,
					solutionVersion: this.#solution().version,
				};
				this.#state.plan = { ...draft, ...binding, version: hash({ ...binding, draft }) };
				this.#state.phase = "plan-review";
				await this.#drive(context);
			} else if (phase === "awaiting-answers" && actual.role === "solution") {
				this.#answer = text;
				this.#state.questions = [];
				this.#state.phase = "team";
				await this.#drive(context);
			}
			this.#guard(context);
			await this.#preserve();
			return reply;
		} finally {
			this.#dialoguing = false;
			this.#notify();
		}
	}

	/** Admission invalidates acceptance synchronously, before any read-only scope analysis or renewed execution. */
	prepareRepair(expectedVersion: string, text: string): () => Promise<SpecDrivenStatus> {
		this.assertRepair(expectedVersion, text);
		this.#state.acceptanceVersion = undefined;
		this.#state.finalApproval = undefined;
		this.#pendingRepair = text;
		this.#notify();
		let available = true;
		return () => {
			if (!available) throw new SpecAdmissionError("Repair admission has already been consumed");
			available = false;
			return this.#runRepair(text);
		};
	}

	async #runRepair(text: string): Promise<SpecDrivenStatus> {
		return this.#launch(async context => {
			await this.#checkInputs(context);
			const scope = this.#ports.conversation?.repairScope;
			if (!scope) throw new Error("Repair scope analysis is unavailable");
			const ids = await this.#checked(scope({ text, status: this.status() }, context), context);
			// Admission already checked outstanding input; #checked retains pause/cancel/generation ownership.
			const tasks = this.#plan().tasks;
			if (!ids.length || ids.some(id => !tasks.some(task => task.id === id)))
				throw new Error("Repair has no valid approved task scope");
			const affected = new Set(ids);
			let expanded = true;
			while (expanded) {
				expanded = false;
				for (const task of tasks)
					if (!affected.has(task.id) && task.dependencies.some(id => affected.has(id))) {
						affected.add(task.id);
						expanded = true;
					}
			}
			if (this.#overallSlot) this.#revise(this.#overallSlot);
			for (const task of this.#state.tasks)
				if (affected.has(task.id) && task.review?.revision === 2)
					throw new Error("Task review is still bounded to two repair rounds");
			for (const task of this.#state.tasks)
				if (affected.has(task.id)) {
					task.status = "pending";
					task.validatedIds = [];
					if (task.review) {
						this.#revise(task.review);
						task.review.reviewedRevision = undefined;
					}
				}
			for (const condition of this.#plan().conditions)
				if (tasks.some(task => affected.has(task.id) && task.conditionIds.includes(condition.id)))
					this.#conditionRecords.delete(condition.id);
			this.#repair = { text, taskIds: [...affected] };
			this.#finalValidationRecords.clear();
			this.#finalRecords = [];
			this.#pendingRepair = undefined;
			this.#state.phase = "executing";
		});
	}

	async repair(expectedVersion: string, text: string): Promise<SpecDrivenStatus> {
		return this.prepareRepair(expectedVersion, text)();
	}

	assertRepair(expectedVersion: string, text: string): void {
		this.#expect("awaiting-acceptance");
		if (!text.trim() || !expectedVersion || expectedVersion !== this.#state.acceptanceVersion)
			throw new SpecAdmissionError("Stale final acceptance or missing repair instructions");
	}

	#notify(): void {
		this.#trackTiming();
		const listener = this.#options.onStatusChange;
		if (!listener) return;
		try {
			listener(this.status());
		} catch {
			// Observation must never interrupt native execution, approvals, or evidence persistence.
		}
	}

	async start(request: string, changeId: string): Promise<SpecDrivenStatus> {
		this.#expect("idle");
		if (!request.trim() || !changeId.trim()) throw new SpecAdmissionError("Request and change ID are required");
		this.#request = request;
		this.#state.changeId = changeId;
		this.#state.phase = "requirements";
		return this.#launch();
	}

	async answer(text: string): Promise<SpecDrivenStatus> {
		if (!text.trim()) throw new SpecAdmissionError("An explicit answer is required");
		this.#expect("awaiting-answers");
		this.#answer = text;
		this.#state.questions = [];
		if (this.#state.specificationApproval) this.#state.phase = "team";
		else this.#state.phase = "requirements";
		return this.#launch();
	}

	async confirmSpecification(expectedVersion: string): Promise<SpecDrivenStatus> {
		this.#expect("awaiting-specification");
		const specification = this.#specification();
		if (expectedVersion !== specification.version) throw new SpecAdmissionError("Stale specification approval");
		return this.#launch(async context => {
			await this.#checkSpecification(context);
			this.#options.assertTransitionAllowed?.();
			this.#state.specificationApproval = expectedVersion;
			this.#state.phase = "team";
		});
	}

	async chooseCandidate(runId: string, candidateId: string, candidateVersion: string): Promise<SpecDrivenStatus> {
		this.#expect("awaiting-choice");
		const team = this.#state.team;
		if (
			!team ||
			team.runId !== runId ||
			team.inputVersion !== this.#specification().version ||
			this.#state.specificationApproval !== team.inputVersion
		)
			throw new SpecAdmissionError("Stale discussion choice");
		if (team.interpretationDifferences.some(item => item.affectsChoice && !item.resolved))
			throw new SpecAdmissionError("Unresolved choice ambiguity");
		const candidate = team.candidates.find(item => item.id === candidateId && item.version === candidateVersion);
		if (!candidate || !this.#eligible(candidate)) throw new SpecAdmissionError("Stale or ineligible candidate");
		return this.#launch(async context => {
			await this.#checkSpecification(context);
			const draft = {
				specificationVersion: this.#specification().version,
				runId,
				candidateId,
				candidateVersion,
				proposal: candidate.proposal,
				conditions: structuredClone(candidate.conditions),
			};
			const snapshot = await this.#checked(this.#ports.artifacts.writeSolution(draft, context), context);
			if (!snapshot.version) throw new Error("Solution artifact has no content identity");
			this.#options.assertTransitionAllowed?.();
			this.#state.solution = {
				...draft,
				artifactVersion: snapshot.version,
				version: hash({ draft, artifactVersion: snapshot.version }),
			};
			this.#state.selection = { runId, candidateId, candidateVersion };
			this.#state.phase = "planning";
		});
	}

	/** Explicitly starts implementation AND authorizes only local, task-owned commits. */
	async confirmPlan(expectedVersion: string, options?: { mode?: "normal" | "goal" }): Promise<SpecDrivenStatus> {
		this.#expect("awaiting-plan");
		const plan = this.#plan();
		if (expectedVersion !== plan.version) throw new SpecAdmissionError("Stale plan approval");
		return this.#launch(async context => {
			await this.#checkInputs(context);
			this.#options.assertTransitionAllowed?.();
			this.#state.planApproval = expectedVersion;
			this.#state.executionMode = options?.mode ?? "normal";
			this.#state.phase = "executing";
		});
	}

	async accept(expectedVersion: string): Promise<SpecDrivenStatus> {
		this.#expect("awaiting-acceptance");
		if (!this.#state.acceptanceVersion || expectedVersion !== this.#state.acceptanceVersion)
			throw new SpecAdmissionError("Stale final acceptance");
		return this.#launch(async context => {
			await this.#checkInputs(context);
			if (await this.#refreshEvidence(context))
				throw new Error("Stale final acceptance: selected input content changed");
			if (this.#state.acceptanceVersion !== expectedVersion) throw new Error("Stale final acceptance");
			this.#options.assertTransitionAllowed?.();
			this.#state.finalApproval = expectedVersion;
			this.#state.phase = "closing";
		});
	}

	async amendRequirements(text: string): Promise<SpecDrivenStatus> {
		if (!text.trim()) throw new SpecAdmissionError("Amendment is required");
		this.#assertMutable();
		await this.#interrupt();
		this.#rememberTasks();
		this.#request += `\n${text}`;
		this.#answer = text;
		this.#invalidateDownstream();
		this.#state.specificationApproval = undefined;
		this.#requirementsSlot = undefined;
		this.#state.phase = "requirements";
		return this.#launch();
	}

	async changeSolution(text: string): Promise<SpecDrivenStatus> {
		if (!text.trim()) throw new SpecAdmissionError("Solution change is required");
		this.#assertMutable();
		if (!this.#state.specificationApproval)
			throw new SpecAdmissionError("Confirm requirements before changing the solution");
		await this.#interrupt();
		this.#rememberTasks();
		this.#invalidateDownstream();
		this.#answer = text;
		this.#state.phase = "team";
		return this.#launch();
	}

	pause(): SpecDrivenStatus {
		if (this.#state.phase === "completed" || this.#state.phase === "cancelled") return this.status();
		this.#state.paused = true;
		this.#state.blockedReason = "Paused by user";
		this.#abort.abort();
		this.#state.generation++;
		if (!this.#driving) this.#preserving = this.#preserving.then(() => this.#preserve());
		this.#notify();
		return this.status();
	}

	async resume(): Promise<SpecDrivenStatus> {
		if (!this.#state.paused) throw new SpecAdmissionError("Workflow is not paused");
		if (this.#state.phase === "cancelled") throw new SpecAdmissionError("Cancelled workflow cannot resume");
		if (this.#driving) await this.#driving;
		await this.#preserving;
		this.#state.paused = false;
		this.#state.blockedReason = undefined;
		this.#abort = new AbortController();
		return this.#pendingRepair === undefined ? this.#launch() : this.#runRepair(this.#pendingRepair);
	}

	cancel(): SpecDrivenStatus {
		this.pause();
		if (this.#state.phase !== "completed") this.#state.phase = "cancelled";
		this.#pendingRepair = undefined;
		if (!this.#driving) this.#preserving = this.#preserving.then(() => this.#preserve());
		this.#notify();
		return this.status();
	}

	#expect(phase: SpecDrivenStatus["phase"]): void {
		this.#options.assertTransitionAllowed?.();
		if (this.#state.paused || this.#state.phase !== phase || this.#driving || this.#dialoguing)
			throw new SpecAdmissionError(`Expected active ${phase}; current ${this.#state.phase}`);
	}
	#assertMutable(): void {
		if (this.#dialoguing) throw new SpecAdmissionError("Current stage dialogue is still processing");
		this.#options.assertTransitionAllowed?.();
		if (["idle", "completed", "cancelled"].includes(this.#state.phase))
			throw new SpecAdmissionError("No mutable active workflow");
	}
	async #interrupt(): Promise<void> {
		this.pause();
		if (this.#driving) await this.#driving;
		await this.#preserving;
		this.#state.paused = false;
		this.#state.blockedReason = undefined;
		this.#abort = new AbortController();
	}
	#rememberTasks(): void {
		for (const task of this.#state.tasks)
			if (task.status === "completed") {
				this.#preservedTasks.set(task.id, structuredClone(task));
				this.#preservedDependencies.set(task.id, [
					...(this.#state.plan?.tasks.find(item => item.id === task.id)?.dependencies ?? []),
				]);
			}
	}
	#invalidateDownstream(): void {
		this.#state.team = undefined;
		this.#state.selection = undefined;
		this.#state.solution = undefined;
		this.#state.planApproval = undefined;
		this.#state.acceptanceVersion = undefined;
		this.#state.finalApproval = undefined;
		this.#pendingRepair = undefined;
		this.#state.questions = [];
		this.#state.pendingClosure = [];
		this.#state.tasks = [];
		this.#state.plan = undefined;
		this.#planSlot = undefined;
		this.#overallSlot = undefined;
		this.#conditionRecords.clear();
		this.#finalRecords = [];
		this.#finalValidationRecords.clear();
		this.#gitPrepared = false;
	}
	#context(): SpecRunContext {
		return { runId: this.#runId, generation: this.#state.generation, signal: this.#abort.signal };
	}
	#guard(context: SpecRunContext): void {
		if (context.signal.aborted || context.generation !== this.#state.generation || this.#state.paused)
			throw new StaleRun();
	}
	async #checked<T>(promise: Promise<T>, context: SpecRunContext): Promise<T> {
		this.#notify();
		const result = await promise;
		this.#guard(context);
		this.#notify();
		return result;
	}
	async #handoff(input: Parameters<SpecDrivenPorts["handoff"]>[0], context: SpecRunContext) {
		await this.#refreshEvidence(context);
		const handoff = await this.#checked(this.#ports.handoff(input, context), context);
		this.#state.handoffs = [
			...(this.#state.handoffs ?? []).filter(item => item.transition !== handoff.transition),
			handoff,
		];
		this.#notify();
		await this.#ports.evidence.flush(this.status(), context);
		return handoff;
	}
	async #preserve(): Promise<void> {
		try {
			await this.#ports.evidence.flush(this.status(), this.#context());
		} catch (error) {
			this.#state.paused = true;
			if (this.#state.phase === "completed") this.#state.phase = "closing";
			this.#state.blockedReason ??= error instanceof Error ? error.message : String(error);
			this.#abort.abort();
		}
		this.#notify();
	}
	async #launch(before?: (context: SpecRunContext) => Promise<void>): Promise<SpecDrivenStatus> {
		if (this.#driving) throw new Error("Workflow dispatch is already active");
		const context = this.#context();
		const drive = async (): Promise<SpecDrivenStatus> => {
			try {
				this.#guard(context);
				await this.#refreshEvidence(context);
				if (before) await before(context);
				await this.#drive(context);
			} catch (error) {
				if (!(error instanceof StaleRun) && context.generation === this.#state.generation) {
					this.#state.paused = true;
					this.#state.blockedReason = error instanceof Error ? error.message : String(error);
					this.#abort.abort();
					this.#state.generation++;
				}
			}
			await this.#preserve();
			return this.status();
		};
		this.#driving = drive();
		try {
			return await this.#driving;
		} finally {
			this.#driving = undefined;
		}
	}

	async #drive(context: SpecRunContext): Promise<void> {
		while (true) {
			this.#guard(context);
			this.#notify();
			switch (this.#state.phase) {
				case "requirements":
					await this.#draftRequirements(context);
					break;
				case "requirements-review":
					await this.#reviewRequirements(context);
					break;
				case "team":
					await this.#discuss(context);
					break;
				case "planning":
					await this.#draftPlan(context);
					break;
				case "plan-review":
					await this.#reviewPlan(context);
					break;
				case "executing":
					await this.#checked(
						this.#handoff(
							{
								transition: "plan-to-execution",
								specification: this.#specification(),
								solution: this.#solution(),
								plan: this.#plan(),
								decision: { planApproval: this.#state.planApproval },
							},
							context,
						),
						context,
					);
					await this.#execute(context);
					break;
				case "validating":
					await this.#validateFinal(context);
					break;
				case "overall-review":
					await this.#reviewOverall(context);
					break;
				case "closing":
					await this.#close(context);
					break;
				default:
					return;
			}
		}
	}
	#specification(): SpecRequirements {
		if (!this.#state.specification) throw new Error("Requirements missing");
		return this.#state.specification;
	}
	#plan(): SpecPlan {
		if (!this.#state.plan) throw new Error("Plan missing");
		return this.#state.plan;
	}
	#candidate(): SpecCandidate {
		const selection = this.#state.selection;
		const candidate = this.#state.team?.candidates.find(
			item => item.id === selection?.candidateId && item.version === selection?.candidateVersion,
		);
		if (!candidate || !this.#eligible(candidate)) throw new Error("Selected candidate is no longer eligible");
		return candidate;
	}
	#eligible(candidate: SpecCandidate): boolean {
		return (
			candidate.adoptable &&
			candidate.reviewSucceeded &&
			candidate.recheckSucceeded &&
			!candidate.unresolvedBlocking.length &&
			!candidate.exclusionReason
		);
	}
	#solution(): SpecSolution {
		if (!this.#state.solution) throw new Error("Selected solution missing");
		return this.#state.solution;
	}
	async #checkSolution(context: SpecRunContext): Promise<void> {
		const solution = this.#solution();
		const current = await this.#checked(this.#ports.artifacts.readSolution(context), context);
		const selection = this.#state.selection;
		if (
			current.version !== solution.artifactVersion ||
			solution.specificationVersion !== this.#state.specificationApproval ||
			solution.runId !== selection?.runId ||
			solution.candidateId !== selection?.candidateId ||
			solution.candidateVersion !== selection?.candidateVersion
		) {
			this.#rememberTasks();
			this.#invalidateDownstream();
			this.#state.phase = "team";
			throw new Error("Selected solution changed; select and approve current inputs before continuing");
		}
	}
	async #checkSpecification(context: SpecRunContext): Promise<void> {
		const current = await this.#checked(this.#ports.artifacts.readRequirements(context), context);
		if (current.version !== this.#specification().version) {
			this.#rememberTasks();
			this.#invalidateDownstream();
			this.#state.specificationApproval = undefined;
			this.#requirementsSlot = undefined;
			this.#state.phase = "requirements";
			throw new Error("Specification changed on disk; amend and review before continuing");
		}
	}
	async #checkInputs(context: SpecRunContext): Promise<void> {
		await this.#checkSpecification(context);
		await this.#checkSolution(context);
		const plan = this.#plan();
		const current = await this.#checked(this.#ports.artifacts.readPlan(context), context);
		if (
			current.version !== plan.artifactVersion ||
			plan.specificationVersion !== this.#state.specificationApproval ||
			plan.candidateVersion !== this.#candidate().version ||
			plan.solutionVersion !== this.#solution().version
		) {
			this.#state.planApproval = undefined;
			this.#state.acceptanceVersion = undefined;
			this.#state.finalApproval = undefined;
			this.#conditionRecords.clear();
			this.#finalValidationRecords.clear();
			this.#finalRecords = [];
			this.#gitPrepared = false;
			this.#rememberTasks();
			this.#planSlot = undefined;
			this.#overallSlot = undefined;
			this.#state.phase = "planning";
			throw new Error("Plan or its approved inputs changed; regenerate and review before continuing");
		}
	}
	async #draftRequirements(context: SpecRunContext): Promise<void> {
		if (!this.#initialized) {
			await this.#checked(this.#ports.artifacts.initialize(this.#state.changeId!, context), context);
			this.#initialized = true;
		}
		const draft = parseSpecRequirements(
			await this.#checked(
				this.#ports.models.requirements(
					{
						request: this.#request,
						answer: this.#answer,
						previous: this.#state.specification,
						review: this.#requirementsSlot?.lastReview,
					},
					context,
				),
				context,
			),
		);
		this.#clarificationRound++;
		const snapshot = await this.#checked(this.#ports.artifacts.writeRequirements(draft, context), context);
		await this.#checked(this.#ports.artifacts.validateRequirements(context), context);
		if (!snapshot.version) throw new Error("Requirements artifact has no content identity");
		this.#state.specification = { ...draft, version: snapshot.version };
		if (draft.questions.length) {
			this.#state.questions = draft.questions;
			this.#state.phase = "awaiting-answers";
		} else this.#state.phase = "requirements-review";
	}
	#slot(kind: SpecReviewKind, author = this.#options.currentModel): SpecReviewSlot {
		const start = this.#reviewIndex++ % this.#members.length;
		const ordered = [...this.#members.slice(start), ...this.#members.slice(0, start)];
		const model = ordered.find(item => item !== author) ?? ordered[0]!;
		const slot: SpecReviewSlot = {
			id: `R${this.#reviewIndex}`,
			kind,
			model,
			sameModelIndependent: model === author,
			revision: 0,
			findings: [],
		};
		this.#state.reviews.push(slot);
		return slot;
	}
	async #refreshEvidence(context: SpecRunContext): Promise<boolean> {
		const invalid = await this.#checked(this.#ports.evidence.revalidate(context), context);
		if (!invalid.taskIds.length && !invalid.overall) return false;
		const affected = new Set(invalid.taskIds);
		const dependencies = new Map(this.#preservedDependencies);
		for (const task of this.#state.plan?.tasks ?? []) dependencies.set(task.id, task.dependencies);
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const [id, required] of dependencies)
				if (!affected.has(id) && required.some(dependency => affected.has(dependency))) {
					affected.add(id);
					expanded = true;
				}
		}
		for (const task of [...this.#state.tasks, ...this.#preservedTasks.values()]) {
			if (!affected.has(task.id)) continue;
			task.status = task.execution ? "implemented" : "pending";
			task.validatedIds = [];
			if (task.review?.lastReview?.verdict === "pass") task.review.reviewedRevision = undefined;
		}
		for (const condition of this.#state.plan?.conditions ?? [])
			if (this.#state.plan?.tasks.some(task => affected.has(task.id) && task.conditionIds.includes(condition.id)))
				this.#conditionRecords.delete(condition.id);
		this.#finalValidationRecords.clear();
		this.#finalRecords = [];
		this.#state.acceptanceVersion = undefined;
		this.#state.finalApproval = undefined;
		if (this.#overallSlot?.lastReview?.verdict === "pass") this.#overallSlot.reviewedRevision = undefined;
		if (["validating", "overall-review", "awaiting-acceptance", "closing"].includes(this.#state.phase))
			this.#state.phase = this.#state.tasks.some(task => task.status !== "completed") ? "executing" : "validating";
		this.#notify();
		return true;
	}
	async #review(
		slot: SpecReviewSlot,
		input: Omit<SpecReviewInput, "slot" | "kind" | "specification" | "previous">,
		context: SpecRunContext,
	): Promise<SpecReview> {
		const invalidated = await this.#refreshEvidence(context);
		if (invalidated && slot.kind !== "requirements" && slot.kind !== "plan")
			throw new Error("Review inputs changed before independent analysis");
		if (slot.reviewedRevision === 2 && slot.lastReview?.verdict !== "pass") {
			throw new Error(`${slot.kind} review still blocked after two repair rounds`);
		}
		const review = parseSpecReview(
			await this.#checked(
				this.#ports.models.review(
					{
						...input,
						kind: slot.kind,
						slot: structuredClone(slot),
						specification: this.#specification(),
						solution: this.#state.solution,
						previous: slot.lastReview,
					},
					context,
				),
				context,
			),
		);
		if (await this.#refreshEvidence(context)) throw new Error("Review inputs changed during independent analysis");
		for (const finding of review.findings) {
			const existing = slot.findings.find(item => item.issue === finding.issue);
			if (existing && existing.id !== finding.id) throw new Error("Review changed a stable finding ID");
			const sameId = slot.findings.find(item => item.id === finding.id);
			if (sameId && sameId.issue !== finding.issue) throw new Error("Review reassigned a stable finding ID");
		}
		for (const old of slot.findings.filter(substantive)) {
			const stillSubstantive = review.findings.some(item => item.id === old.id && substantive(item));
			if (
				!stillSubstantive &&
				!review.resolutions.some(item => item.findingId === old.id && item.resolved && item.evidence.trim())
			) {
				throw new Error(`Missing mandatory recheck for ${old.id}`);
			}
		}
		if (review.resolutions.some(item => !slot.findings.some(old => old.id === item.findingId)))
			throw new Error("Review resolved an unknown finding ID");
		if (review.verdict === "pass" && review.resolutions.some(item => !item.resolved))
			throw new Error("Review passed an unresolved finding");
		slot.findings = review.findings;
		slot.lastReview = review;
		slot.reviewedRevision = slot.revision;
		return review;
	}
	#revise(slot: SpecReviewSlot): void {
		if (slot.revision >= 2) throw new Error(`${slot.kind} review still blocked after two repair rounds`);
		slot.revision++;
	}
	async #reviewRequirements(context: SpecRunContext): Promise<void> {
		const slot = (this.#requirementsSlot ??= this.#slot("requirements"));
		const review = await this.#review(slot, { records: [], commits: [] }, context);
		if (review.verdict === "pass") this.#state.phase = "awaiting-specification";
		else if (review.verdict === "clarify") {
			this.#clarificationRound++;
			this.#state.questions = review.questions;
			this.#state.phase = "awaiting-answers";
		} else {
			this.#revise(slot);
			this.#state.phase = "requirements";
		}
	}
	async #discuss(context: SpecRunContext): Promise<void> {
		await this.#checkSpecification(context);
		if (this.#state.specificationApproval !== this.#specification().version)
			throw new Error("Specification is not approved");
		await this.#checked(
			this.#handoff(
				{
					transition: "requirements-to-solution",
					specification: this.#specification(),
					decision: { specificationApproval: this.#state.specificationApproval },
				},
				context,
			),
			context,
		);
		this.#clarificationRound++;
		const team = await this.#checked(
			this.#ports.team.run({ specification: this.#specification(), answer: this.#answer }, context),
			context,
		);
		if (
			!team ||
			team.status !== "completed" ||
			!team.runId ||
			team.inputVersion !== this.#specification().version ||
			!Array.isArray(team.candidates) ||
			!Array.isArray(team.interpretationDifferences)
		)
			throw new Error("Team failed or returned stale/incomplete structured results");
		if (new Set(team.candidates.map(item => item.id)).size !== team.candidates.length)
			throw new Error("Duplicate candidate IDs");
		for (const candidate of team.candidates) {
			if (
				!candidate.id ||
				!candidate.label ||
				!candidate.version ||
				!candidate.proposal ||
				typeof candidate.adoptable !== "boolean" ||
				typeof candidate.reviewSucceeded !== "boolean" ||
				typeof candidate.recheckSucceeded !== "boolean" ||
				!Array.isArray(candidate.unresolvedBlocking) ||
				!Array.isArray(candidate.conditions) ||
				candidate.conditions.some(condition => !condition.id || !condition.description) ||
				new Set(candidate.conditions.map(condition => condition.id)).size !== candidate.conditions.length
			) {
				throw new Error("Team candidate is missing structured eligibility or condition evidence");
			}
		}
		if (
			team.interpretationDifferences.some(
				item =>
					!item.id ||
					!item.question ||
					typeof item.affectsChoice !== "boolean" ||
					typeof item.resolved !== "boolean",
			)
		) {
			throw new Error("Team returned incomplete interpretation differences");
		}
		this.#state.team = team;
		if (team.interpretationDifferences.some(item => item.affectsChoice && !item.resolved)) {
			this.#state.questions = team.interpretationDifferences
				.filter(item => item.affectsChoice && !item.resolved)
				.map(item => item.question);
			this.#state.phase = "awaiting-answers";
		} else {
			this.#state.phase = "awaiting-choice";
			if (!team.candidates.some(item => this.#eligible(item)))
				throw new Error("Team returned zero adoptable candidates");
		}
	}
	async #draftPlan(context: SpecRunContext): Promise<void> {
		await this.#checkSpecification(context);
		await this.#checkSolution(context);
		await this.#checked(
			this.#handoff(
				{
					transition: "solution-to-plan",
					specification: this.#specification(),
					solution: this.#solution(),
					decision: this.#state.selection,
				},
				context,
			),
			context,
		);
		const draft = parseSpecPlan(
			await this.#checked(
				this.#ports.models.plan(
					{
						specification: this.#specification(),
						candidate: this.#candidate(),
						solution: this.#solution(),
						previous: this.#state.plan,
						review: this.#planSlot?.lastReview,
					},
					context,
				),
				context,
			),
		);
		this.#validatePlan(draft);
		const snapshot = await this.#checked(this.#ports.artifacts.writePlan(draft, context), context);
		if (!snapshot.version) throw new Error("Plan artifact has no content identity");
		const binding = {
			artifactVersion: snapshot.version,
			specificationVersion: this.#specification().version,
			candidateVersion: this.#candidate().version,
			solutionVersion: this.#solution().version,
		};
		this.#state.plan = { ...draft, ...binding, version: hash({ ...binding, draft }) };
		this.#state.phase = "plan-review";
	}
	#validatePlan(plan: SpecPlanDraft): void {
		const requirementIds = new Set(this.#specification().requirements.map(item => item.id));
		const tasks = new Map(plan.tasks.map(item => [item.id, item]));
		const conditions = new Map(plan.conditions.map(item => [item.id, item]));
		for (const candidateCondition of this.#candidate().conditions) {
			const plannedCondition = conditions.get(candidateCondition.id);
			if (
				!plannedCondition ||
				plannedCondition.description !== candidateCondition.description ||
				!plannedCondition.command.trim() ||
				(candidateCondition.command !== undefined && plannedCondition.command !== candidateCondition.command)
			) {
				throw new Error(`Missing executable candidate condition ${candidateCondition.id}`);
			}
			// Without an explicit unaffected proof, every task is gated by every adoption condition.
			if (plan.tasks.some(task => !task.conditionIds.includes(candidateCondition.id)))
				throw new Error(`Task bypasses candidate condition ${candidateCondition.id}`);
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visiting.has(id)) throw new Error("Cyclic task dependencies");
			if (visited.has(id)) return;
			const task = tasks.get(id);
			if (!task) throw new Error(`Unknown dependency ${id}`);
			visiting.add(id);
			for (const dependency of task.dependencies) visit(dependency);
			visiting.delete(id);
			visited.add(id);
		};
		const taskIdentities = new Map<string, string>();
		for (const task of plan.tasks) {
			visit(task.id);
			if (task.requirementIds.some(id => !requirementIds.has(id)))
				throw new Error(`Unknown requirement in ${task.id}`);
			if (task.conditionIds.some(id => !conditions.has(id))) throw new Error(`Unknown condition in ${task.id}`);
			if (
				task.implementationPaths.some(path => !task.ownedPaths.includes(path)) ||
				(task.tdd.mode === "required" && !task.implementationPaths.length)
			) {
				throw new Error(`Task ${task.id} lacks explicit owned implementation paths`);
			}
			if (
				task.tdd.mode === "exception" &&
				task.tdd.alternativeCommands.some(command => !task.validation.some(item => item.command === command))
			)
				throw new Error(`Unscheduled TDD alternative in ${task.id}`);
			const identity = this.#taskIdentities.get(task.id);
			const newIdentity = hash({ title: task.title, requirementIds: [...task.requirementIds].sort() });
			if (identity && identity !== newIdentity) throw new Error(`Stable task ID ${task.id} was reassigned`);
			taskIdentities.set(task.id, newIdentity);
		}
		const covered = new Set(plan.tasks.flatMap(task => task.requirementIds));
		for (const id of requirementIds) if (!covered.has(id)) throw new Error(`Plan omits requirement ${id}`);
		if (!plan.finalValidation.some(item => item.realEntry))
			throw new Error("Plan omits real public-entry validation");
		// Rejected drafts must not reserve identities before all plan guards succeed.
		for (const [id, identity] of taskIdentities) this.#taskIdentities.set(id, identity);
	}
	async #reviewPlan(context: SpecRunContext): Promise<void> {
		const slot = (this.#planSlot ??= this.#slot("plan"));
		const review = await this.#review(slot, { plan: this.#plan(), records: [], commits: [] }, context);
		if (review.verdict === "pass") {
			this.#bindTasks();
			this.#state.phase = "awaiting-plan";
		} else if (review.verdict === "clarify")
			throw new Error(`Plan needs clarification: ${review.questions.join("; ")}`);
		else {
			this.#revise(slot);
			this.#state.phase = "planning";
		}
	}
	#fingerprint(task: SpecTask): string {
		const requirements = task.requirementIds.map(id =>
			this.#specification().requirements.find(item => item.id === id),
		);
		return hash({ task, requirements, workspace: this.#plan().workspace });
	}
	#bindTasks(): void {
		const plan = this.#plan();
		const rebound = new Map<string, SpecTaskState>();
		const bind = (task: SpecTask): SpecTaskState => {
			const existing = rebound.get(task.id);
			if (existing) return existing;
			const fingerprint = this.#fingerprint(task);
			const previous = this.#preservedTasks.get(task.id);
			const dependenciesValid = task.dependencies.every(id => {
				const dependency = plan.tasks.find(item => item.id === id)!;
				return bind(dependency).status === "completed";
			});
			const retained = previous?.fingerprint === fingerprint ? structuredClone(previous) : undefined;
			if (retained && !dependenciesValid) {
				retained.status = retained.execution ? "implemented" : "pending";
				retained.validatedIds = [];
				if (retained.review?.lastReview?.verdict === "pass") retained.review.reviewedRevision = undefined;
			}
			const state: SpecTaskState = retained ?? {
				id: task.id,
				fingerprint,
				status: "pending",
				records: [],
				commits: [],
				specificationVersion: "",
				planVersion: "",
			};
			state.specificationVersion = this.#specification().version;
			state.planVersion = plan.version;
			rebound.set(task.id, state);
			return state;
		};
		this.#state.tasks = plan.tasks.map(bind);
	}
	async #records(ids: readonly string[], context: SpecRunContext): Promise<SpecToolRecord[]> {
		if (!ids.length || new Set(ids).size !== ids.length)
			throw new Error("Missing or duplicate native execution records");
		const records = await this.#checked(this.#ports.evidence.read(ids, context), context);
		if (records.length !== ids.length || new Set(records.map(item => item.id)).size !== ids.length)
			throw new Error("Native evidence ledger is incomplete");
		if (new Set(records.map(record => record.toolCallId)).size !== records.length)
			throw new Error("Duplicate native tool call identities");
		for (const record of records) {
			if (
				!ids.includes(record.id) ||
				record.runId !== context.runId ||
				record.generation > context.generation ||
				!record.binding ||
				record.binding.planVersion !== this.#plan().version ||
				record.binding.specificationVersion !== this.#specification().version ||
				!record.toolCallId ||
				!record.tool ||
				!record.args.command ||
				!record.args.cwd ||
				!record.artifact.path ||
				!record.artifact.version ||
				!Number.isFinite(record.startedAt) ||
				!Number.isFinite(record.finishedAt) ||
				record.finishedAt < record.startedAt ||
				(record.result.exitCode !== null && !Number.isInteger(record.result.exitCode))
			)
				throw new Error("Counterfeit, stale or malformed native execution evidence");
		}
		return records;
	}
	async #command(
		command: string,
		purpose: "condition" | "task" | "final",
		id: string,
		context: SpecRunContext,
	): Promise<SpecToolRecord> {
		const recordId = await this.#checked(this.#ports.validation.run({ command, purpose, id }, context), context);
		const [record] = await this.#records([recordId], context);
		if (
			!record ||
			record.args.command !== command ||
			record.result.status !== "completed" ||
			record.result.isError ||
			record.result.exitCode !== 0 ||
			!record.inputsBefore?.complete ||
			!record.inputsAfter?.complete ||
			record.inputsBefore.version !== record.inputsAfter.version
		)
			throw new Error(`Required ${purpose} validation failed: ${id}`);
		return record;
	}
	async #execute(context: SpecRunContext): Promise<void> {
		await this.#checkInputs(context);
		if (this.#state.planApproval !== this.#plan().version)
			throw new Error("Execution requires explicit current-plan startup approval");
		if (!this.#gitPrepared) {
			await this.#checked(
				this.#ports.git.preflight({ specification: this.#specification(), plan: this.#plan() }, context),
				context,
			);
			this.#gitPrepared = true;
		}
		for (const condition of this.#plan().conditions) {
			if (!this.#conditionRecords.has(condition.id))
				this.#conditionRecords.set(
					condition.id,
					await this.#command(condition.command, "condition", condition.id, context),
				);
		}
		await this.#checked(
			this.#ports.models.execute(
				structuredClone({
					specification: this.#specification(),
					solution: this.#solution(),
					plan: this.#plan(),
					tasks: this.#state.tasks,
					mode: this.#state.executionMode ?? "normal",
					repair: this.#repair,
				}),
				context,
				{
					status: () => structuredClone(this.#state.tasks),
					start: async taskId => {
						this.#guard(context);
						await this.#checkInputs(context);
						await this.#refreshEvidence(context);
						const task = this.#plan().tasks.find(item => item.id === taskId);
						await this.#qualifyDependencies(taskId, context);
						if (task) await this.#conditions(task, context);
						const state = this.#state.tasks.find(item => item.id === taskId);
						if (!task || !state || state.status === "completed")
							throw new Error(`Unknown or ended parent task ${taskId}`);
						if (
							state.planVersion !== this.#plan().version ||
							state.specificationVersion !== this.#specification().version
						)
							throw new Error("Task approval binding is stale");
						if (
							task.dependencies.some(
								id => this.#state.tasks.find(item => item.id === id)?.status !== "completed",
							)
						)
							throw new Error(`Unmet dependency for ${taskId}`);
						if (task.conditionIds.some(id => !this.#conditionRecords.has(id)))
							throw new Error(`Unverified adoption condition for ${taskId}`);
						return structuredClone(task);
					},
					checkpoint: async (taskId, execution) => {
						this.#guard(context);
						const task = this.#plan().tasks.find(item => item.id === taskId);
						if (!task) throw new Error(`Unknown parent task ${taskId}`);
						await this.#checkpoint(task, execution, context);
						await this.#ports.evidence.flush(this.status(), context);
						this.#notify();
						return structuredClone(this.#state.tasks.find(item => item.id === taskId)!);
					},
				},
			),
			context,
		);
		await this.#refreshEvidence(context);
		if (this.#state.tasks.some(task => task.status !== "completed"))
			throw new Error("Execution stage ended before every actual parent task completed");
		this.#state.phase = "validating";
	}
	async #checkpoint(task: SpecTask, execution: SpecExecution, context: SpecRunContext): Promise<void> {
		await this.#checkInputs(context);
		await this.#refreshEvidence(context);
		await this.#qualifyDependencies(task.id, context);
		await this.#conditions(task, context);
		const state = this.#state.tasks.find(item => item.id === task.id)!;
		if (state.status === "completed") throw new Error(`Parent task ${task.id} has already ended`);
		if (
			task.dependencies.some(id => this.#state.tasks.find(item => item.id === id)?.status !== "completed") ||
			task.conditionIds.some(id => !this.#conditionRecords.has(id))
		)
			throw new Error(`Parent task ${task.id} is not ready`);
		if (state.status === "pending" || (state.execution && hash(state.execution) !== hash(execution))) {
			if (execution.requestedTddException)
				throw new Error(`Unapproved TDD exemption: ${execution.requestedTddException}`);
			if (execution.changedPaths.some(file => !task.ownedPaths.includes(file)))
				throw new Error(`Executor changed unowned paths for ${task.id}`);
			const records =
				task.tdd.mode === "exception" && !execution.recordIds.length
					? []
					: await this.#records(execution.recordIds, context);
			this.#checkTdd(task, execution, records);
			if (records.some(record => record.binding?.taskId !== task.id))
				throw new Error("Execution evidence belongs to a different approved parent");
			state.execution = execution;
			state.records = records;
			state.validatedIds = [];
			state.status = "implemented";
			this.#notify();
		}
		if (state.status === "implemented") {
			for (const validation of task.validation) {
				if (state.validatedIds?.includes(validation.id)) continue;
				const record = await this.#command(validation.command, "task", `${task.id}:${validation.id}`, context);
				state.records.push(record);
				(state.validatedIds ??= []).push(validation.id);
			}
			state.status = "verified";
			this.#notify();
		}
		if (state.status === "verified") {
			const execution = state.execution!;
			const executionIdentity = hash({ records: execution.recordIds, content: execution.contentVersion });
			if (execution.changedPaths.length && !state.committedExecutionIds?.includes(executionIdentity)) {
				const commit = await this.#checked(
					this.#ports.git.commit(
						{ task, changedPaths: execution.changedPaths, revision: state.review?.revision ?? 0 },
						context,
					),
					context,
				);
				if (
					!commit.base ||
					!commit.head ||
					commit.base === commit.head ||
					!commit.reviewPackage ||
					commit.taskId !== task.id ||
					commit.paths.some(path => !task.ownedPaths.includes(path)) ||
					execution.changedPaths.some(path => !commit.paths.includes(path))
				)
					throw new Error("Invalid or contaminated task commit range");
				state.commits.push(commit);
				(state.committedExecutionIds ??= []).push(executionIdentity);
			}
			const slot = (state.review ??= this.#slot("task"));
			const review = await this.#review(
				slot,
				{ plan: this.#plan(), task, execution, records: state.records, commits: state.commits },
				context,
			);
			if (review.verdict === "pass") {
				this.#checkSemanticEvidence(task, execution, review);
				if (await this.#refreshEvidence(context)) return;
				state.status = "completed";
				state.repairReview = undefined;
			} else if (review.verdict === "clarify")
				throw new Error(`Task ${task.id} needs clarification: ${review.questions.join("; ")}`);
			else {
				this.#revise(slot);
				state.status = "pending";
				state.repairReview = review;
			}
		}
		this.#notify();
	}
	async #conditions(task: SpecTask, context: SpecRunContext): Promise<void> {
		for (const id of task.conditionIds)
			if (!this.#conditionRecords.has(id)) {
				const condition = this.#plan().conditions.find(item => item.id === id)!;
				this.#conditionRecords.set(id, await this.#command(condition.command, "condition", id, context));
			}
	}
	async #qualifyDependencies(taskId: string, context: SpecRunContext): Promise<void> {
		const task = this.#plan().tasks.find(item => item.id === taskId);
		if (!task) return;
		for (const id of task.dependencies) {
			const dependency = this.#state.tasks.find(item => item.id === id)!;
			if ((dependency.status === "implemented" || dependency.status === "verified") && dependency.execution)
				await this.#checkpoint(
					this.#plan().tasks.find(item => item.id === id)!,
					dependency.execution,
					context,
				);
		}
	}
	#checkTdd(task: SpecTask, execution: SpecExecution, records: SpecToolRecord[]): void {
		if (task.tdd.mode === "exception") return;
		const requiredBehavior = task.tdd.behavior;
		const red = records.find(item => item.id === execution.redRecordId);
		const green = records.find(item => item.id === execution.greenRecordId);
		if (
			!red ||
			!green ||
			red.id === green.id ||
			red.result.exitCode === null ||
			red.result.exitCode <= 0 ||
			red.result.isError ||
			green.result.exitCode !== 0 ||
			green.result.isError ||
			!green.inputsBefore?.complete ||
			!green.inputsAfter?.complete ||
			green.inputsBefore.version !== green.inputsAfter.version ||
			red.result.status !== "completed" ||
			green.result.status !== "completed" ||
			!red.obligation ||
			!green.obligation ||
			red.obligation.validationId !== green.obligation.validationId ||
			red.obligation.stage !== "red" ||
			green.obligation.stage !== "green" ||
			(red.args.command !== red.obligation.approvedCommand && !red.obligation.reason?.trim()) ||
			(green.args.command !== green.obligation.approvedCommand && !green.obligation.reason?.trim()) ||
			red.tool !== "spec_verify" ||
			green.tool !== "spec_verify" ||
			!task.validation.some(
				validation =>
					validation.id === red.obligation?.validationId &&
					validation.command === red.obligation.approvedCommand &&
					validation.behavior === requiredBehavior,
			) ||
			!(red.result.stdout.trim() || red.result.stderr.trim()) ||
			execution.implementationStartedAt === null ||
			!Number.isFinite(execution.implementationStartedAt) ||
			red.finishedAt > execution.implementationStartedAt ||
			execution.implementationStartedAt > green.startedAt ||
			red.finishedAt > green.startedAt
		) {
			throw new Error(`Task ${task.id} lacks actual ordered RED/implementation/GREEN evidence`);
		}
	}
	#checkSemanticEvidence(task: SpecTask, execution: SpecExecution, review: SpecReview): void {
		const state = this.#state.tasks.find(item => item.id === task.id)!;
		for (const record of state.records.filter(
			item => item.obligation && item.args.command !== item.obligation.approvedCommand,
		))
			if (
				!record.obligation?.reason?.trim() ||
				!review.evidenceChecks.some(check => check.recordId === record.id && check.valid && check.reason.trim())
			)
				throw new Error(`Independent review did not establish equivalent verification ${record.id}`);
		if (task.tdd.mode !== "required") return;
		const behavior = task.tdd.behavior;
		for (const recordId of [execution.redRecordId, execution.greenRecordId]) {
			if (
				!review.evidenceChecks.some(
					check =>
						check.recordId === recordId && check.behavior === behavior && check.valid && check.reason.trim(),
				)
			) {
				throw new Error(`Independent review did not establish meaningful TDD evidence for ${task.id}`);
			}
		}
	}
	async #validateFinal(context: SpecRunContext): Promise<void> {
		await this.#checkInputs(context);
		if (await this.#refreshEvidence(context)) return;
		if (this.#state.tasks.some(task => task.status !== "completed"))
			throw new Error("Final validation requires verified and reviewed tasks");
		for (const validation of this.#plan().finalValidation) {
			if (!this.#finalValidationRecords.has(validation.id)) {
				this.#finalValidationRecords.set(
					validation.id,
					await this.#command(validation.command, "final", validation.id, context),
				);
			}
		}
		this.#finalRecords = [...this.#finalValidationRecords.values()];
		this.#state.phase = "overall-review";
	}
	async #reviewOverall(context: SpecRunContext): Promise<void> {
		const slot = (this.#overallSlot ??= this.#slot("overall"));
		const review = await this.#review(
			slot,
			{
				plan: this.#plan(),
				records: [...this.#state.tasks.flatMap(task => task.records), ...this.#finalRecords],
				commits: this.#state.tasks.flatMap(task => task.commits),
			},
			context,
		);
		if (review.verdict === "pass") {
			if (await this.#refreshEvidence(context)) return;
			this.#state.acceptanceVersion = hash({
				round: ++this.#acceptanceRound,
				specification: this.#specification().version,
				plan: this.#plan().version,
				tasks: this.#state.tasks.map(task => ({
					fingerprint: task.fingerprint,
					records: task.records.map(record => record.id),
					commits: task.commits,
				})),
				finalRecords: this.#finalRecords.map(record => record.id),
				runId: this.#runId,
				review,
			});
			this.#state.phase = "awaiting-acceptance";
		} else if (review.verdict === "clarify")
			throw new Error(`Overall review needs clarification: ${review.questions.join("; ")}`);
		else {
			this.#revise(slot);
			const affected = new Set(review.findings.filter(substantive).flatMap(finding => finding.taskIds));
			if (!affected.size || [...affected].some(id => !this.#state.tasks.some(task => task.id === id)))
				throw new Error("Overall repair has no valid task scope");
			let expanded = true;
			while (expanded) {
				expanded = false;
				for (const task of this.#plan().tasks) {
					if (!affected.has(task.id) && task.dependencies.some(id => affected.has(id))) {
						affected.add(task.id);
						expanded = true;
					}
				}
			}
			for (const task of this.#state.tasks) {
				if (affected.has(task.id)) {
					task.status = "pending";
					task.repairReview = review;
				}
			}
			this.#finalValidationRecords.clear();
			this.#finalRecords = [];
			this.#state.phase = "executing";
		}
	}
	async #close(context: SpecRunContext): Promise<void> {
		if (await this.#refreshEvidence(context)) throw new Error("Current target changed before closure");
		for (const task of this.#state.tasks)
			if (task.records.length)
				task.records = await this.#ports.evidence.read(
					task.records.map(record => record.id),
					context,
				);
		await this.#ports.evidence.flush(this.status(), context);
		if (!this.#state.finalApproval || this.#state.finalApproval !== this.#state.acceptanceVersion)
			throw new Error("Close requires current final acceptance");
		await this.#checkInputs(context);
		const plan = this.#plan();
		if (plan.closure.sync || plan.closure.archive) {
			if (!this.#requirementsSlot || this.#requirementsSlot.lastReview?.verdict !== "pass")
				throw new Error("Reviewed specification patches are required for closure");
			await this.#checked(
				this.#ports.artifacts.close(
					{
						specification: this.#specification(),
						plan,
						acceptanceVersion: this.#state.finalApproval,
						requirementsReview: this.#requirementsSlot,
					},
					context,
				),
				context,
			);
			for (const task of this.#state.tasks)
				if (task.records.length)
					task.records = await this.#ports.evidence.read(
						task.records.map(record => record.id),
						context,
					);
		} else
			this.#state.pendingClosure = [
				"Specification synchronization and archive were not authorized; change files remain in place.",
			];
		this.#state.phase = "completed";
	}
}
