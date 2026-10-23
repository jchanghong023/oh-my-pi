import * as crypto from "node:crypto";
import { parseSpecPlan, parseSpecRequirements, parseSpecReview } from "./schemas";
import type {
	SpecCandidate,
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
	SpecTask,
	SpecTaskState,
	SpecToolRecord,
} from "./types";

class StaleRun extends Error {}
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
		return structuredClone(this.#state);
	}

	async start(request: string, changeId: string): Promise<SpecDrivenStatus> {
		this.#expect("idle");
		if (!request.trim() || !changeId.trim()) throw new Error("Request and change ID are required");
		this.#request = request;
		this.#state.changeId = changeId;
		this.#state.phase = "requirements";
		return this.#launch();
	}

	async answer(text: string): Promise<SpecDrivenStatus> {
		if (!text.trim()) throw new Error("An explicit answer is required");
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
		if (expectedVersion !== specification.version) throw new Error("Stale specification approval");
		return this.#launch(async context => {
			await this.#checkSpecification(context);
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
			throw new Error("Stale discussion choice");
		if (team.interpretationDifferences.some(item => item.affectsChoice && !item.resolved))
			throw new Error("Unresolved choice ambiguity");
		const candidate = team.candidates.find(item => item.id === candidateId && item.version === candidateVersion);
		if (!candidate || !this.#eligible(candidate)) throw new Error("Stale or ineligible candidate");
		return this.#launch(async context => {
			await this.#checkSpecification(context);
			this.#state.selection = { runId, candidateId, candidateVersion };
			this.#state.phase = "planning";
		});
	}

	/** Explicitly starts implementation AND authorizes only local, task-owned commits. */
	async confirmPlan(expectedVersion: string): Promise<SpecDrivenStatus> {
		this.#expect("awaiting-plan");
		const plan = this.#plan();
		if (expectedVersion !== plan.version) throw new Error("Stale plan approval");
		return this.#launch(async context => {
			await this.#checkInputs(context);
			this.#state.planApproval = expectedVersion;
			this.#state.phase = "executing";
		});
	}

	async accept(expectedVersion: string): Promise<SpecDrivenStatus> {
		this.#expect("awaiting-acceptance");
		if (!this.#state.acceptanceVersion || expectedVersion !== this.#state.acceptanceVersion)
			throw new Error("Stale final acceptance");
		return this.#launch(async context => {
			await this.#checkInputs(context);
			this.#state.finalApproval = expectedVersion;
			this.#state.phase = "closing";
		});
	}

	async amendRequirements(text: string): Promise<SpecDrivenStatus> {
		if (!text.trim()) throw new Error("Amendment is required");
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
		if (!text.trim()) throw new Error("Solution change is required");
		this.#assertMutable();
		if (!this.#state.specificationApproval) throw new Error("Confirm requirements before changing the solution");
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
		return this.status();
	}

	async resume(): Promise<SpecDrivenStatus> {
		if (!this.#state.paused) throw new Error("Workflow is not paused");
		if (this.#state.phase === "cancelled") throw new Error("Cancelled workflow cannot resume");
		if (this.#driving) await this.#driving;
		this.#state.paused = false;
		this.#state.blockedReason = undefined;
		this.#abort = new AbortController();
		return this.#launch();
	}

	cancel(): SpecDrivenStatus {
		this.pause();
		if (this.#state.phase !== "completed") this.#state.phase = "cancelled";
		return this.status();
	}

	#expect(phase: SpecDrivenStatus["phase"]): void {
		if (this.#state.paused || this.#state.phase !== phase || this.#driving)
			throw new Error(`Expected active ${phase}; current ${this.#state.phase}`);
	}
	#assertMutable(): void {
		if (["idle", "completed", "cancelled"].includes(this.#state.phase)) throw new Error("No mutable active workflow");
	}
	async #interrupt(): Promise<void> {
		this.pause();
		if (this.#driving) await this.#driving;
		this.#state.paused = false;
		this.#state.blockedReason = undefined;
		this.#abort = new AbortController();
	}
	#rememberTasks(): void {
		for (const task of this.#state.tasks)
			if (task.status === "completed") this.#preservedTasks.set(task.id, structuredClone(task));
	}
	#invalidateDownstream(): void {
		this.#state.team = undefined;
		this.#state.selection = undefined;
		this.#state.planApproval = undefined;
		this.#state.acceptanceVersion = undefined;
		this.#state.finalApproval = undefined;
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
		const result = await promise;
		this.#guard(context);
		return result;
	}
	async #launch(before?: (context: SpecRunContext) => Promise<void>): Promise<SpecDrivenStatus> {
		if (this.#driving) throw new Error("Workflow dispatch is already active");
		const context = this.#context();
		const drive = async (): Promise<SpecDrivenStatus> => {
			try {
				this.#guard(context);
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
		const plan = this.#plan();
		const current = await this.#checked(this.#ports.artifacts.readPlan(context), context);
		if (
			current.version !== plan.artifactVersion ||
			plan.specificationVersion !== this.#state.specificationApproval ||
			plan.candidateVersion !== this.#candidate().version
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
	async #review(
		slot: SpecReviewSlot,
		input: Omit<SpecReviewInput, "slot" | "kind" | "specification" | "previous">,
		context: SpecRunContext,
	): Promise<SpecReview> {
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
						previous: slot.lastReview,
					},
					context,
				),
				context,
			),
		);
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
		const draft = parseSpecPlan(
			await this.#checked(
				this.#ports.models.plan(
					{
						specification: this.#specification(),
						candidate: this.#candidate(),
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
				!plannedCondition.command.trim()
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
			this.#taskIdentities.set(task.id, newIdentity);
		}
		if (!plan.finalValidation.some(item => item.realEntry))
			throw new Error("Plan omits real public-entry validation");
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
		return hash({ task, requirements });
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
			const retained =
				previous?.fingerprint === fingerprint && dependenciesValid ? structuredClone(previous) : undefined;
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
				record.generation !== context.generation ||
				!record.toolCallId ||
				!record.tool ||
				!record.args.command ||
				!record.args.cwd ||
				!record.artifact.path ||
				!record.artifact.version ||
				!Number.isFinite(record.startedAt) ||
				!Number.isFinite(record.finishedAt) ||
				record.finishedAt < record.startedAt ||
				!Number.isInteger(record.result.exitCode)
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
		if (!record || record.args.command !== command || record.result.isError || record.result.exitCode !== 0)
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
		const next = this.#plan().tasks.find(
			task =>
				this.#state.tasks.find(state => state.id === task.id)?.status !== "completed" &&
				task.dependencies.every(id => this.#state.tasks.find(state => state.id === id)?.status === "completed"),
		);
		if (!next) {
			if (this.#state.tasks.some(task => task.status !== "completed"))
				throw new Error("No task can run: unmet dependency");
			this.#state.phase = "validating";
			return;
		}
		// Serial publication intentionally avoids shared index/range and interface-state conflicts.
		await this.#executeTask(next, context);
	}
	async #executeTask(task: SpecTask, context: SpecRunContext): Promise<void> {
		const state = this.#state.tasks.find(item => item.id === task.id)!;
		if (task.conditionIds.some(id => !this.#conditionRecords.has(id)))
			throw new Error(`Unverified adoption condition for ${task.id}`);
		if (state.status === "pending") {
			const execution = await this.#checked(
				this.#ports.models.execute(
					{
						specification: this.#specification(),
						plan: this.#plan(),
						task,
						review: state.repairReview ?? state.review?.lastReview,
						revision: state.review?.revision ?? 0,
					},
					context,
				),
				context,
			);
			if (execution.requestedTddException)
				throw new Error(`Unapproved TDD exemption: ${execution.requestedTddException}`);
			if (execution.changedPaths.some(path => !task.ownedPaths.includes(path)))
				throw new Error(`Executor changed unowned paths for ${task.id}`);
			const records =
				task.tdd.mode === "exception" && !execution.recordIds.length
					? []
					: await this.#records(execution.recordIds, context);
			this.#checkTdd(task, execution, records);
			state.execution = execution;
			state.records = records;
			state.validatedIds = [];
			state.status = "implemented";
		}
		if (state.status === "implemented") {
			for (const validation of task.validation) {
				if (state.validatedIds?.includes(validation.id)) continue;
				const record = await this.#command(validation.command, "task", `${task.id}:${validation.id}`, context);
				state.records.push(record);
				(state.validatedIds ??= []).push(validation.id);
			}
			state.status = "verified";
		}
		if (state.status === "verified") {
			const execution = state.execution!;
			const executionIdentity = hash(execution.recordIds);
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
				state.status = "completed";
				state.repairReview = undefined;
			} else if (review.verdict === "clarify")
				throw new Error(`Task ${task.id} needs clarification: ${review.questions.join("; ")}`);
			else {
				this.#revise(slot);
				state.status = "pending";
			}
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
			red.result.exitCode === 0 ||
			red.result.isError ||
			green.result.exitCode !== 0 ||
			green.result.isError ||
			red.args.command !== green.args.command ||
			red.tool !== "spec_verify" ||
			green.tool !== "spec_verify" ||
			!task.validation.some(
				validation => validation.command === red.args.command && validation.behavior === requiredBehavior,
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
			this.#state.acceptanceVersion = hash({
				specification: this.#specification().version,
				plan: this.#plan().version,
				tasks: this.#state.tasks.map(task => ({
					fingerprint: task.fingerprint,
					records: task.records.map(record => record.id),
					commits: task.commits,
				})),
				finalRecords: this.#finalRecords.map(record => record.id),
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
		} else
			this.#state.pendingClosure = [
				"Specification synchronization and archive were not authorized; change files remain in place.",
			];
		this.#state.phase = "completed";
	}
}
