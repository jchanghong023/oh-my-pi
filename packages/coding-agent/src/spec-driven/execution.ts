import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { ToolSession } from "../sdk";
import type { StructuredSubagentRequest } from "../task/structured-subagent";
import type { NativeSubagentHooks } from "../task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { CreateAgentSessionOptions } from "../sdk";
import { bindSpecSkillPolicy, grantSpecSkillAccess } from "./skill-policy";
import { artifactVersion } from "./artifacts";
import { SpecEvidenceService } from "./evidence";
import { createSpecExecutionTools, type SpecExecutionTools } from "./execution-tools";
import type { SpecGitService, SpecNativePublication, SpecNativeSource } from "./git";
import type { SpecExecution, SpecExecutionControl, SpecPlan, SpecRunContext, SpecTask, SpecToolRecord } from "./types";

const taskSchema = type({
	action: "'start' | 'integrate' | 'checkpoint' | 'status'",
	"taskId?": "string",
	"sourceIds?": "string[]",
});

interface Binding {
	id: string;
	task: SpecTask;
	parentId?: string;
	workspace: string;
	context: SpecRunContext;
	tools: SpecExecutionTools;
	evidence: SpecEvidenceService;
	before: Map<string, string | null>;
	live: boolean;
	sealed: boolean;
	activeTools: number;
	checkpoint?: { executionVersion: string; completed: boolean };
}

interface ExecutionHostOptions {
	plan: SpecPlan;
	specificationVersion: string;
	workspace: string;
	changeDir: string;
	checksDirectory: string;
	planPath: string;
	methods: string[];
	skills: NonNullable<CreateAgentSessionOptions["skills"]>;
	context: SpecRunContext;
	control: SpecExecutionControl;
	git: SpecGitService;
	session: ToolSession;
	onEvidence(service: SpecEvidenceService, source: boolean, taskId: string): void;
	onRecord(record: SpecToolRecord, service: SpecEvidenceService): void;
}

/** Execution authority stays in host closures, never in task prompts or tool arguments. */
export class SpecExecutionHost {
	readonly #input: ExecutionHostOptions;
	readonly #bindings = new Map<string, Binding>();
	readonly #requests = new WeakMap<
		StructuredSubagentRequest,
		{ task: SpecTask; binding?: Binding; parentId?: string }
	>();
	readonly #sources = new Map<string, SpecNativeSource>();
	readonly #publications: SpecNativePublication[] = [];
	readonly #admissions = new Map<string, SpecTask>();
	readonly #nestedOwners = new Set<string>();
	readonly #sourceExecutions = new Map<string, { execution: SpecExecution; records: SpecToolRecord[] }>();
	readonly #checkpoints = new Set<string>();
	#inline?: Binding;
	#stopped = false;

	constructor(input: ExecutionHostOptions) {
		this.#input = input;
	}
	renew(context: SpecRunContext, control: SpecExecutionControl): void {
		this.#input.context = context;
		this.#nestedOwners.clear();
		this.#input.control = control;
		this.#stopped = false;
		this.#admissions.clear();
		const binding = this.#inline;
		if (binding) {
			binding.context = context;
			const evidence = new SpecEvidenceService({
				cwd: binding.workspace,
				changeDir: this.#input.changeDir,
				owner: {
					actorId: this.#input.session.getAgentId?.() ?? binding.id,
					taskId: binding.task.id,
					workspace: binding.workspace,
					specificationVersion: this.#input.specificationVersion,
					planVersion: this.#input.plan.version,
				},
				run: context,
			});
			const previous = binding.tools;
			binding.evidence = evidence;
			binding.tools = createSpecExecutionTools({
				session: this.#input.session,
				task: binding.task,
				context,
				artifactDir: path.join(this.#input.changeDir, "checks"),
				evidence,
				onRecord: record => this.#input.onRecord(record, evidence),
			});
			binding.tools.records.push(...previous.records);
			binding.tools.implementationStartedAt = previous.implementationStartedAt;
			this.#input.onEvidence(evidence, false, binding.task.id);
		}
	}

	findings(taskId: string): string[] {
		const state = this.#input.control.status().find(item => item.id === taskId);
		return (
			(state?.repairReview ?? state?.review?.lastReview)?.findings
				.filter(finding => finding.severity !== "minor")
				.map(finding => finding.id) ?? []
		);
	}

	#current(): void {
		this.#input.context.signal.throwIfAborted();
		if (this.#stopped) throw new Error("Execution stage ownership has ended");
	}

	async #identity(workspace: string, file: string): Promise<string | null> {
		try {
			return artifactVersion(await fs.readFile(path.join(workspace, file), "utf8"));
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
	}

	#independent(task: SpecTask): void {
		for (const other of this.#admissions.values())
			if (
				other.id === task.id ||
				other.solutionBinding === task.solutionBinding ||
				other.ownedPaths.some(file => task.ownedPaths.includes(file))
			)
				throw new Error(`Concurrent task ${task.id} conflicts with admitted parent/interface ${other.id}`);
		for (const binding of this.#bindings.values()) {
			if (!binding.live) continue;
			if (
				binding.task.id === task.id ||
				binding.task.solutionBinding === task.solutionBinding ||
				task.dependencies.includes(binding.task.id) ||
				binding.task.dependencies.includes(task.id) ||
				task.ownedPaths.some(file => binding.task.ownedPaths.includes(file))
			)
				throw new Error(`Concurrent task ${task.id} conflicts with live parent/interface ${binding.task.id}`);
		}
	}
	#hasDescendant(binding: Binding): boolean {
		if (this.#nestedOwners.has(binding.id)) return true;
		for (const other of this.#bindings.values()) {
			if (!other.live) continue;
			for (let parent = other.parentId; parent; parent = this.#bindings.get(parent)?.parentId)
				if (parent === binding.id) return true;
		}
		return false;
	}

	async #bind(task: SpecTask, workspace: string, session: ToolSession, native: boolean): Promise<Binding> {
		this.#current();
		const id = native ? `${task.id}-${crypto.randomUUID()}` : task.id;
		const previous = this.#bindings.get(task.id);
		const priorTaskId =
			workspace === this.#input.workspace &&
			previous?.workspace === workspace &&
			!previous.live &&
			previous.checkpoint?.completed &&
			previous.task.ownedPaths.length === task.ownedPaths.length &&
			previous.task.ownedPaths.every(file => task.ownedPaths.includes(file))
				? previous.id
				: undefined;
		await this.#input.git.beginTask(
			id,
			task.ownedPaths,
			{
				executionApproved: true,
				planVersion: this.#input.plan.version,
				expectedPlanVersion: this.#input.plan.version,
				priorTaskId,
			},
			workspace,
		);
		try {
			const evidence = new SpecEvidenceService({
				cwd: workspace,
				changeDir: this.#input.changeDir,
				owner: {
					actorId: session.getAgentId?.() ?? id,
					taskId: task.id,
					workspace,
					specificationVersion: this.#input.specificationVersion,
					planVersion: this.#input.plan.version,
				},
				run: this.#input.context,
			});
			this.#input.onEvidence(evidence, native, task.id);
			const binding: Binding = {
				id,
				task,
				workspace,
				context: this.#input.context,
				evidence,
				before: new Map(
					await Promise.all(
						task.ownedPaths.map(async file => [file, await this.#identity(workspace, file)] as const),
					),
				),
				live: true,
				sealed: false,
				activeTools: 0,
				tools: createSpecExecutionTools({
					session,
					task,
					context: this.#input.context,
					artifactDir: path.join(this.#input.changeDir, "checks"),
					evidence,
					onRecord: record => this.#input.onRecord(record, evidence),
				}),
			};
			this.#bindings.set(id, binding);
			return binding;
		} catch (error) {
			this.#input.git.finishTask(id);
			throw error;
		}
	}

	async #execution(binding: Binding): Promise<SpecExecution> {
		const changedPaths: string[] = [];
		const identities: Array<[string, string | null]> = [];
		for (const file of binding.task.ownedPaths) {
			const current = await this.#identity(binding.workspace, file);
			identities.push([file, current]);
			if (binding.before.get(file) !== current) changedPaths.push(file);
		}
		const records = binding.tools.records;
		const red = records.find(
			record =>
				record.obligation?.stage === "red" &&
				record.result.status === "completed" &&
				!record.result.isError &&
				record.result.exitCode !== null &&
				record.result.exitCode > 0 &&
				(binding.tools.implementationStartedAt === null ||
					record.finishedAt <= binding.tools.implementationStartedAt),
		);
		const green = records.findLast(
			record =>
				record.obligation?.stage === "green" &&
				record.result.status === "completed" &&
				!record.result.isError &&
				record.result.exitCode === 0 &&
				(!red || record.obligation.validationId === red.obligation?.validationId),
		);
		return {
			changedPaths,
			recordIds: records.map(record => record.id),
			redRecordId: red?.id ?? null,
			greenRecordId: green?.id ?? null,
			implementationStartedAt: binding.tools.implementationStartedAt,
			requestedTddException: null,
			contentVersion: artifactVersion(JSON.stringify(identities)),
		};
	}

	#release(binding: Binding): void {
		binding.live = false;
		this.#input.git.finishTask(binding.id);
		if (this.#inline === binding) this.#inline = undefined;
	}

	get sourceFacts(): SpecNativeSource[] {
		return structuredClone([...this.#sources.values()]);
	}

	get publicationFacts(): SpecNativePublication[] {
		return structuredClone(this.#publications);
	}
	#spawnFailed(request: StructuredSubagentRequest): void {
		const admitted = this.#requests.get(request);
		if (!admitted) return;
		this.#requests.delete(request);
		if (admitted.parentId) this.#nestedOwners.delete(admitted.parentId);
		else this.#admissions.delete(admitted.task.id);
		if (admitted.binding?.live) this.#release(admitted.binding);
	}

	/** The native scheduler owns concurrency; these callbacks only admit and bind its actual sessions. */
	hooks(parent?: Binding): NativeSubagentHooks {
		return {
			beforeSpawn: async request => {
				this.#current();
				if (parent && (!parent.live || parent.sealed)) throw new Error("Native parent binding has ended");
				if (parent && this.#hasDescendant(parent))
					throw new Error("An approved parent already has a live nested writer");
				const label = request.identity?.label ?? "";
				let task: SpecTask | undefined;
				for (const candidate of this.#input.plan.tasks)
					if (label.startsWith(candidate.id) && (!task || candidate.id.length > task.id.length)) task = candidate;
				if (!task || (parent && parent.task.id !== task.id))
					throw new Error("Native task name must identify its exact approved parent");
				if (this.#input.plan.workspace.isolation !== "native" || request.isolation?.requested !== true)
					throw new Error("Native descendants require approved actual isolation");
				if (this.#inline) throw new Error("Finish the inline parent before dispatching native writers");
				if (!parent) this.#independent(task);
				if (!parent) this.#admissions.set(task.id, task);
				if (parent) this.#nestedOwners.add(parent.id);
				try {
					await this.#input.control.start(task.id);
					this.#requests.set(request, { task, parentId: parent?.id });
				} catch (error) {
					if (!parent) this.#admissions.delete(task.id);
					if (parent) this.#nestedOwners.delete(parent.id);
					throw error;
				}
				return { applyChanges: false, keepAlive: false, preserveCwd: true };
			},
			onSpawnFailed: async request => this.#spawnFailed(request),
			configureSession: async (request, options) => {
				this.#current();
				const admitted = this.#requests.get(request);
				if (!admitted || !options.cwd) throw new Error("Native session has no live task admission");
				await this.#input.control.start(admitted.task.id);
				const workspace = await fs.realpath(options.cwd);
				if (workspace === this.#input.workspace)
					throw new Error("Native writer did not receive an isolated workspace");
				const childSession: ToolSession = {
					cwd: workspace,
					hasUI: false,
					settings: options.settings ?? this.#input.session.settings,
					enableMCP: false,
					enableLsp: false,
					getAgentId: () => options.agentId ?? null,
					getSessionFile: () => options.sessionManager?.getSessionFile() ?? null,
					getSessionSpawns: () => "",
					getArtifactsDir: () => path.join(this.#input.changeDir, "checks"),
				};
				const binding = await this.#bind(admitted.task, workspace, childSession, true);
				binding.parentId = admitted.parentId;
				admitted.binding = binding;
				// Native implementers inherit task methods, not the parent's stage/review orchestration.
				const implementationMethods = this.#input.skills.flatMap((skill, index) =>
					["test-driven-development", "systematic-debugging", "verification-before-completion"].includes(
						skill.name,
					)
						? [{ skill, method: this.#input.methods[index]! }]
						: [],
				);
				return {
					toolNames: ["read", "grep", "glob", "task", "write", "edit", "spec_verify", "spec_task"],
					restrictToolNames: true,
					allowRestrictedCustomTools: true,
					customTools: [
						...binding.tools.tools.map(tool => ({
							...tool,
							execute: async (...args: Parameters<CustomTool["execute"]>) => {
								this.#current();
								if (!binding.live || binding.sealed) throw new Error("Native task write binding has ended");
								if (this.#hasDescendant(binding))
									throw new Error("Native parent writes wait for its actual nested writer");
								if (this.#checkpoints.has(binding.id))
									throw new Error("Native task checkpoint is already in progress");
								binding.activeTools++;
								try {
									return await tool.execute(...args);
								} finally {
									binding.activeTools--;
								}
							},
						})),
						this.#taskTool(binding),
					],
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					subagentHooks: this.hooks(binding),
					skills: implementationMethods.map(({ skill }) => skill),
					systemPrompt: defaults => {
						const native = options.systemPrompt;
						const blocks = typeof native === "function" ? native(defaults) : (native ?? defaults);
						return [
							...(typeof blocks === "string" ? [blocks] : blocks),
							...implementationMethods.map(({ method }) => method),
						];
					},
					onSessionCreated: child => {
						const release = bindSpecSkillPolicy(child.sessionManager, {
							phase: "executor",
							allowedSkills: implementationMethods.map(({ skill }) => skill.name),
						});
						const grants = implementationMethods.map(({ skill }) =>
							grantSpecSkillAccess(child.sessionManager, skill),
						);
						return () => {
							for (const grant of grants) grant();
							release();
						};
					},
				};
			},
			beforeCapture: request => this.freeze(request),
			afterResult: (request, result) => this.settled(request, result),
		};
	}

	/** Called by an awaited native producer seam while the genuine source still exists. */
	async freeze(request: StructuredSubagentRequest): Promise<void> {
		const binding = this.#requests.get(request)?.binding;
		if (!binding) throw new Error("Native source capture has no actual binding");
		await binding.evidence.read(
			binding.tools.records.map(record => record.id),
			binding.context,
		);
		this.#sourceExecutions.set(binding.id, {
			execution: await this.#execution(binding),
			records: [...binding.tools.records],
		});
		const invalid = await binding.evidence.revalidate(binding.context);
		await this.#input.git.freezeTaskSource(binding.id, this.#input.checksDirectory);
		if (invalid.reasons.length)
			throw new Error(`Native source verification inputs changed before capture: ${invalid.reasons.join("; ")}`);
	}

	/** Called only with the observed final native outcome, never model-returned source facts. */
	async settled(request: StructuredSubagentRequest, outcome: SingleResult): Promise<void> {
		const binding = this.#requests.get(request)?.binding;
		if (!binding) throw new Error("Native result has no actual binding");
		try {
			const source = await this.#input.git.registerNativeSource(
				binding.id,
				outcome,
				this.#input.checksDirectory,
				binding.task.id,
			);
			this.#sources.set(source.sourceId, source);
		} finally {
			this.#requests.delete(request);
			if (binding.parentId) this.#nestedOwners.delete(binding.parentId);
			else this.#admissions.delete(binding.task.id);
			this.#release(binding);
		}
	}

	#taskTool(bound?: Binding): CustomTool<typeof taskSchema> {
		return {
			name: "spec_task",
			label: "Approved task lifecycle",
			description:
				"Inspect approved task states and native sources, start one approved parent, integrate registered source IDs, or checkpoint observed work. Completion requires host validation and independent review.",
			parameters: taskSchema,
			strict: true,
			execute: async (_id, params) => {
				this.#current();
				if (bound && !bound.live) throw new Error("Task binding has ended");
				const checkpointKey = bound?.id ?? params.taskId ?? "";
				const current = bound ?? this.#inline;
				if (params.action !== "status" && this.#checkpoints.has(checkpointKey))
					throw new Error("Task checkpoint is already in progress");
				if (params.action === "checkpoint") {
					if (this.#checkpoints.has(checkpointKey) || current?.activeTools)
						throw new Error("Wait for actual task tools/checkpoint to finish before checkpointing");
					this.#checkpoints.add(checkpointKey);
				}
				try {
					let value: unknown;
					if (params.action === "status")
						value = { tasks: this.#input.control.status(), sources: this.sourceFacts };
					else {
						if (!params.taskId || (bound && params.taskId !== bound.task.id))
							throw new Error("An exact approved parent task ID is required");
						if (bound && (bound.sealed || this.#hasDescendant(bound)))
							throw new Error("Native parent is sealed or has a live nested writer");
						if (params.action === "start") {
							if (bound) value = { task: structuredClone(bound.task) };
							else if (this.#inline?.task.id === params.taskId)
								value = { task: structuredClone(this.#inline.task) };
							else {
								if (this.#inline) throw new Error("Only one inline parent may own writes");
								const task = await this.#input.control.start(params.taskId);
								this.#independent(task);
								this.#inline = await this.#bind(task, this.#input.workspace, this.#input.session, false);
								value = { task };
							}
						} else if (params.action === "integrate") {
							if (bound) throw new Error("Only the stage actor integrates registered sources");
							if (!params.sourceIds?.length) throw new Error("Native source IDs are required");
							const task = await this.#input.control.start(params.taskId);
							if (this.#inline && this.#inline.task.id !== task.id)
								throw new Error("Another inline parent owns the target");
							if (!this.#inline)
								this.#inline = await this.#bind(task, this.#input.workspace, this.#input.session, false);
							const publications = await this.#input.git.integrateTask(params.taskId, params.sourceIds);
							this.#publications.push(...publications);
							if (publications.some(item => !item.complete))
								throw new Error(
									"Native integration is incomplete; preserved publication evidence requires repair",
								);
							for (const sourceId of params.sourceIds) {
								const source = this.#sources.get(sourceId);
								if (!source) throw new Error("Unregistered native source");
								const sourceBinding = [...this.#bindings.values()].find(
									item => item.workspace === source.sourceWorkspace && item.task.id === task.id,
								);
								const observed = sourceBinding ? this.#sourceExecutions.get(sourceBinding.id) : undefined;
								if (!observed) throw new Error("Missing frozen source execution observations");
								this.#inline.tools.records.push(...observed.records);
								const started = observed.execution.implementationStartedAt;
								if (
									started !== null &&
									(this.#inline.tools.implementationStartedAt === null ||
										started < this.#inline.tools.implementationStartedAt)
								)
									this.#inline.tools.implementationStartedAt = started;
							}
							value = { publications, sources: this.sourceFacts };
						} else {
							const binding = bound ?? this.#inline;
							if (!binding || binding.task.id !== params.taskId) {
								if (bound) throw new Error("Checkpoint requires a live actual workspace binding");
								const previous = this.#input.control.status().find(item => item.id === params.taskId);
								if (!previous?.execution || !["implemented", "verified"].includes(previous.status))
									throw new Error("Checkpoint requires actual retained implementation evidence");
								const task = await this.#input.control.checkpoint(params.taskId, previous.execution);
								const retained = this.#bindings.get(params.taskId);
								if (
									retained?.workspace === this.#input.workspace &&
									retained.checkpoint?.executionVersion === artifactVersion(JSON.stringify(previous.execution))
								) {
									if (task.status === "completed") this.#input.git.finishVerifiedTask(retained.id);
									retained.checkpoint.completed = task.status === "completed";
								}
								value = { task };
							} else if (bound) {
								const commit = await this.#input.git.commitTask(binding.id, `spec: ${binding.task.id} source`);
								if (commit.base !== commit.head)
									await this.#input.git.reviewPackage(
										binding.id,
										this.#input.planPath,
										`.git/spec-review/${binding.id}.diff`,
										binding.context.signal,
									);
								binding.sealed = true;
								value = { task: { id: binding.task.id, status: "source-recorded" }, commit };
							} else {
								const execution = await this.#execution(binding);
								const task = await this.#input.control.checkpoint(params.taskId, execution);
								if (task.status === "completed") this.#input.git.finishVerifiedTask(binding.id);
								// Only the unique controller's actual completed target checkpoint permits dirty repair.
								binding.checkpoint = {
									executionVersion: artifactVersion(JSON.stringify(execution)),
									completed: task.status === "completed",
								};
								this.#release(binding);
								value = { task };
							}
						}
					}
					return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
				} finally {
					if (params.action === "checkpoint") this.#checkpoints.delete(checkpointKey);
				}
			},
		};
	}

	rootTools(): CustomTool[] {
		// Schemas remain the existing native scoped adapters; execution resolves the current inline binding per call.
		const template = createSpecExecutionTools({
			session: this.#input.session,
			task: this.#input.plan.tasks[0]!,
			context: this.#input.context,
			artifactDir: path.join(this.#input.changeDir, "checks"),
			onRecord() {},
		});
		return [
			this.#taskTool(),
			...template.tools.map(tool => ({
				...tool,
				execute: async (...args: Parameters<CustomTool["execute"]>) => {
					this.#current();
					const binding = this.#inline;
					if (!binding?.live) throw new Error("Start an approved inline parent before writing or verifying");
					if (this.#checkpoints.has(binding.id)) throw new Error("Task checkpoint is already in progress");
					binding.activeTools++;
					const actual = binding.tools.tools.find(candidate => candidate.name === tool.name)!;
					try {
						return await actual.execute(...args);
					} finally {
						binding.activeTools--;
					}
				},
			})),
		];
	}

	async commit(taskId: string, message: string, findings: string[], signal: AbortSignal) {
		const binding = this.#inline;
		if (!binding || binding.task.id !== taskId) throw new Error("Task commit has no live target binding");
		const result = await this.#input.git.commitTask(binding.id, message, findings);
		if (result.base === result.head)
			return { base: result.base, head: result.head, taskId, paths: [], reviewPackage: "" };
		const review = await this.#input.git.reviewPackage(
			binding.id,
			this.#input.planPath,
			`.git/spec-review/${binding.id}-${crypto.randomUUID()}.diff`,
			signal,
		);
		return {
			base: result.base,
			head: result.head,
			taskId,
			paths: (await this.#execution(binding)).changedPaths,
			reviewPackage: review.content,
		};
	}

	stop(): void {
		this.#stopped = true;
	}

	dispose(): void {
		this.#stopped = true;
		for (const binding of this.#bindings.values()) if (binding.live) this.#release(binding);
	}
}
