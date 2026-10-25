import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { Settings } from "../config/settings";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { AgentSession } from "../session/agent-session";
import { getBundledAgent } from "../task/agents";
import { runSubprocess } from "../task/executor";
import { cfgTaskMaxConcurrency } from "../task/settings";
import { buildRunnerDeps, resolveTeamParticipantsForSession } from "../team/controller";
import { cfgTeamMembers } from "../team/settings";
import { runTeamDiscussion } from "../team/orchestrator";
import { createTeamSubagentRunner, modelMatches, TEAM_READ_ONLY_TOOLS } from "../team/runner";
import type { TeamRunResult } from "../team/types";
import taskTemplate from "../prompts/spec-driven-task.md" with { type: "text" };
import {
	artifactVersion,
	containedSpecPath,
	SpecArtifactStore,
	specPatchVersion,
	type SpecSourceMap,
} from "./artifacts";
import { SpecExecutionHost } from "./execution";
import { aggregateSpecEvidence, SpecEvidenceService } from "./evidence";
import { cfgGoalEnabled, cfgGoalContinuationModes } from "../goals/settings";
import { GoalHost, GOAL_CONTINUATION_MODE } from "../modes/zcode/hosts/goal-host";
import { SpecGitService, type SpecNativePublication, type SpecNativeSource } from "./git";
import { specRequestCost, type SpecRunMeasurement, type SpecRequestMeasurement } from "./metrics";
import { loadSpecDrivenSkill, runOpenSpec } from "./resources";
import { SPEC_PLAN_SCHEMA, SPEC_REQUIREMENTS_SCHEMA, SPEC_REVIEW_SCHEMA } from "./schemas";
import { createSpecActor, type SpecActor } from "./actors";
import { bindSpecSkillPolicy, grantSpecSkillAccess } from "./skill-policy";
import type {
	SpecDrivenOptions,
	SpecConversationReply,
	SpecDrivenPorts,
	SpecPlan,
	SpecExecutionControl,
	SpecReviewArtifact,
	SpecGitEvidence,
	SpecRequirements,
	SpecRunContext,
	SpecTeamResult,
} from "./types";
import type { SpecHandoff, SpecHandoffTransition, SpecStageRole } from "./types";

export interface SpecDrivenRuntime {
	ports: SpecDrivenPorts;
	options: SpecDrivenOptions;
	dispose(): Promise<void>;
	measurement(): SpecRunMeasurement;
}

/** Preserve structured discussion facts; report prose cannot resolve a user's choice. */
export function adaptSpecTeamResult(result: TeamRunResult): SpecTeamResult {
	return {
		runId: result.runId,
		inputVersion: result.inputVersion,
		status: result.status,
		report: result.reportMarkdown ?? result.failureReason ?? "",
		candidates: result.candidates.map(candidate => ({
			...candidate,
			conditions: candidate.conditions.map((description, index) => ({
				id: `${candidate.id}-C${index + 1}`,
				description,
			})),
		})),
		interpretationDifferences: result.interpretationDifferences.map((difference, index) => ({
			id: `${result.runId}-D${index + 1}`,
			question: [
				`请确认需求解释：${difference.ambiguity}`,
				...difference.interpretations.map(
					(interpretation, viewIndex) =>
						`${viewIndex + 1}. ${interpretation.view}\n影响：${interpretation.impact}`,
				),
				"应采用哪种解释？请明确答复。",
			].join("\n"),
			affectsChoice: difference.affectsChoice,
			// Team has no structured resolution field; a remaining difference is not proof of resolution.
			resolved: false,
		})),
	};
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function observedNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Discover an existing authority, without creating an editable mirror or guessing between two directories. */
async function requirementsAuthority(cwd: string): Promise<string | undefined> {
	const found: string[] = [];
	for (const candidate of ["docs-zh-CN/requirements", "docs/requirements", "requirements"]) {
		try {
			if ((await fs.stat(await containedSpecPath(cwd, candidate))).isDirectory()) found.push(candidate);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	if (found.length > 1) throw new Error(`Ambiguous Markdown requirement authorities: ${found.join(", ")}`);
	return found[0];
}

export async function createSpecDrivenRuntime(args: {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	onOutput?: (text: string) => Promise<void>;
	onRequest?: () => void;
}): Promise<SpecDrivenRuntime> {
	const { session, settings } = args;
	const asyncJobs = session.asyncJobManager;
	if (!asyncJobs) throw new Error("Specification workflow requires its owning SDK session's AsyncJobManager");
	const cwd = await fs.realpath(args.cwd);
	if (!session.model) throw new Error("Specification workflow requires a current model");
	const currentModel = formatModelStringWithRouting(session.model);
	const resolution = resolveTeamParticipantsForSession(session, settings);
	if (!resolution.ok) throw new Error(resolution.error);
	const configuredCount = cfgTeamMembers.get(settings).length;
	const members = resolution.participants.slice(0, configuredCount || 1).map(member => member.modelPattern);
	const parentDeps = buildRunnerDeps(session, settings, cwd);
	const loadedContext = session.loadedProjectContext;
	if (!loadedContext)
		throw new Error("Loaded project hard constraints are unavailable for isolated specification roles");
	const contextBytes = Buffer.byteLength(JSON.stringify(loadedContext));
	const lifetime = new AbortController();
	let root = "";
	const services: Array<{ service: SpecEvidenceService; source: boolean }> = [];
	const qualifications = new Map<string, { service: SpecEvidenceService; taskIds?: string[] }>();
	const reviewArtifacts: SpecReviewArtifact[] = [];
	const recordOwners = new Map<string, SpecEvidenceService>();
	const startedAt = Date.now();
	const requests: SpecRequestMeasurement[] = [];
	const gitBaselines: SpecGitEvidence["baselines"] = [];
	const retiredSources: SpecNativeSource[] = [];
	const retiredPublications: SpecNativePublication[] = [];
	let store: SpecArtifactStore | undefined;
	let sourceMap: SpecSourceMap | undefined;
	let git: SpecGitService | undefined;
	let approvedPlan: SpecPlan | undefined;
	let approvedRequirements: SpecRequirements | undefined;
	let executionHost: SpecExecutionHost | undefined;
	let executionInput:
		| { mode: "normal" | "goal"; context: SpecRunContext; workspace: string; planVersion: string }
		| undefined;
	let goalHost: GoalHost | undefined;
	let activeExecution = false;
	let goalContinuationAllowed = false;
	let ownedGoal: { actorId: string; id: string; objective: string } | undefined;
	let goalWake = Promise.withResolvers<void>();
	const wakeGoal = (): void => {
		const previous = goalWake;
		goalWake = Promise.withResolvers<void>();
		previous.resolve();
	};
	let requestText = "";
	let baseline = "";
	let acceptanceCriteria = "";
	let disposed = false;
	const pending = new Set<Promise<unknown>>();
	let archived:
		| {
				root: string;
				path: string;
				acceptanceVersion: string;
				versions: { requirements: string; solution: string; plan: string };
				files: Array<{ path: string; content: string }>;
		  }
		| undefined;
	const checkArchived = async (): Promise<void> => {
		if (!archived) throw new Error("No observed archive outcome");
		for (const file of archived.files)
			if ((await fs.readFile(await containedSpecPath(archived.root, file.path), "utf8")) !== file.content)
				throw new Error(`Archived approved material changed: ${file.path}`);
		for (const file of [
			"verification.md",
			...[...handoffs.values()].map(item => path.posix.relative(requireStore().changeDir, item.path)),
		])
			await fs.readFile(await containedSpecPath(archived.root, file), "utf8");
	};
	const requireStore = (): SpecArtifactStore => {
		if (!store) throw new Error("Specification artifacts are not initialized");
		return store;
	};
	const relocateArchivedEvidence = async (context: SpecRunContext): Promise<void> => {
		if (!archived) return;
		archived.root = await containedSpecPath(cwd, archived.path);
		for (const { service } of services) await service.relocateOutputs(archived.root, context);
	};
	const contextFor = (context: SpecRunContext): SpecRunContext => {
		if (disposed) throw new Error("Specification runtime disposed");
		const signal = AbortSignal.any([context.signal, lifetime.signal]);
		signal.throwIfAborted();
		return { ...context, signal };
	};
	const releaseExecution = (): void => {
		activeExecution = false;
		goalContinuationAllowed = false;
		goalHost?.stopForHostAbort();
		executionHost?.stop();
		const actor = actors.get("executor");
		if (actor) asyncJobs.cancelAll({ ownerId: actor.id });
	};
	const tracked = async <T>(operation: Promise<T>): Promise<T> => {
		pending.add(operation);
		try {
			return await operation;
		} finally {
			pending.delete(operation);
		}
	};
	const observeRequests = (child: AgentSession, node: string, model: string, id: string): (() => void) => {
		let requestStarted = Date.now();
		return child.subscribe(event => {
			if (event.type === "message_start") requestStarted = Date.now();
			if (event.type !== "message_end") return;
			const message = object(event.message);
			if (message?.role !== "assistant") return;
			const usage = object(message.usage);
			requests.push({
				id: `${id}-${requests.length}`,
				node,
				model,
				startedAt: requestStarted,
				endedAt: Date.now(),
				inputTokens: observedNumber(usage?.input),
				outputTokens: observedNumber(usage?.output),
				cacheReadTokens: observedNumber(usage?.cacheRead),
				cacheWriteTokens: observedNumber(usage?.cacheWrite),
				cost: specRequestCost(usage?.cost),
				evidence: `Native child ${id} message_end; persisted transcript`,
			});
			args.onRequest?.();
		});
	};
	const originals = (): SpecSourceMap | undefined => (sourceMap ? structuredClone(sourceMap) : undefined);
	const actors = new Map<SpecStageRole, SpecActor>();
	const handoffs = new Map<SpecHandoffTransition, SpecHandoff>();
	const actorPending = new Map<SpecStageRole, Promise<SpecActor>>();
	const roleSkills = async (role: SpecStageRole | "reviewer") => {
		const names =
			role === "requirements"
				? ["brainstorming", "jch-grill-me"]
				: role === "planner"
					? ["writing-plans"]
					: role === "solution"
						? []
						: role === "reviewer"
							? ["requesting-code-review"]
							: [
									"subagent-driven-development",
									"test-driven-development",
									"systematic-debugging",
									"verification-before-completion",
									"requesting-code-review",
								];
		return Promise.all(
			names.map(name => loadSpecDrivenSkill(name === "jch-grill-me" ? "jch" : "superpowers", name, { role })),
		);
	};
	const getActor = async (role: SpecStageRole): Promise<SpecActor> => {
		const existing = actors.get(role);
		if (existing) return existing;
		const pendingActor = actorPending.get(role);
		if (pendingActor) return pendingActor;
		const operation = (async () => {
			const skills = await roleSkills(role);
			const methods = await Promise.all(skills.map(skill => fs.readFile(skill.filePath, "utf8")));
			const executor = role === "executor";
			if (executor && !executionHost) throw new Error("Executor has no current whole-stage binding");
			const actorSettings = settings.overlay();
			if (executor && executionInput?.mode === "goal") {
				cfgGoalEnabled.override(actorSettings, true);
				cfgGoalContinuationModes.override(actorSettings, [GOAL_CONTINUATION_MODE]);
			}
			const actor = await createSpecActor({
				role,
				methods,
				sessionDirectory: root,
				options: {
					cwd: executor ? executionInput!.workspace : cwd,
					settings: actorSettings,
					model: session.model,
					modelRegistry: session.modelRegistry,
					authStorage: parentDeps.authStorage,
					getApiKey: parentDeps.getApiKey,
					asyncJobManager: asyncJobs,
					parentAgentId: session.getAgentId(),
					eventBus: parentDeps.eventBus,
					subagentEventBus: parentDeps.subagentEventBus,
					contextFiles: loadedContext.contextFiles ? [...loadedContext.contextFiles] : [],
					rules: loadedContext.activeRules ? [...loadedContext.activeRules] : [],
					skills,
					promptTemplates: [],
					spawns: executor ? "*" : "",
					hasUI: false,
					toolNames: executor
						? [
								"read",
								"grep",
								"glob",
								"task",
								"write",
								"edit",
								"spec_verify",
								"spec_task",
								...(executionInput?.mode === "goal" ? ["goal"] : []),
							]
						: [...TEAM_READ_ONLY_TOOLS],
					customTools: executor ? executionHost!.rootTools() : undefined,
					subagentHooks: executor ? executionHost!.hooks() : undefined,
					allowRestrictedCustomTools: executor,
					allowRestrictedGoal: executor && executionInput?.mode === "goal",
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					disableExtensionDiscovery: true,
				},
				onSessionCreated(child) {
					const releasePolicy = bindSpecSkillPolicy(child.sessionManager, {
						phase: role,
						allowedSkills: skills.map(skill => skill.name),
					});
					const grants = skills.map(skill => grantSpecSkillAccess(child.sessionManager, skill));
					const unobserve = observeRequests(child, role, currentModel, child.sessionId);
					let unobserveGoal: (() => void) | undefined;
					if (executor && executionInput?.mode === "goal") {
						goalHost = new GoalHost(child, wakeGoal, () => {
							const current = child.getGoalModeState();
							return (
								activeExecution &&
								goalContinuationAllowed &&
								!executionInput?.context.signal.aborted &&
								ownedGoal !== undefined &&
								ownedGoal.actorId === child.getAgentId() &&
								current?.goal.id === ownedGoal.id &&
								current.goal.objective === ownedGoal.objective
							);
						});
						unobserveGoal = child.subscribe(event => {
							goalHost?.observe(event);
							wakeGoal();
						});
					}
					return () => {
						unobserve();
						unobserveGoal?.();
						for (const release of grants) release();
						releasePolicy();
					};
				},
			});
			if (disposed) {
				await actor.dispose();
				throw new Error("Specification runtime disposed");
			}
			actors.set(role, actor);
			return actor;
		})();
		actorPending.set(role, operation);
		try {
			return await operation;
		} finally {
			actorPending.delete(role);
		}
	};
	const requestActor = async (role: SpecStageRole, input: unknown, schema: unknown, context: SpecRunContext) => {
		const ctx = contextFor(context);
		const handoff =
			role === "requirements"
				? undefined
				: handoffs.get(
						role === "solution"
							? "requirements-to-solution"
							: role === "planner"
								? "solution-to-plan"
								: "plan-to-execution",
					);
		if (role !== "requirements" && !handoff) throw new Error(`Missing approved predecessor handoff for ${role}`);
		const documents = handoff
			? await Promise.all(
					Object.keys(handoff.versions).map(async file => {
						const document = await requireStore().readDocument(file);
						if (document.version !== handoff.versions[file])
							throw new Error("Approved predecessor document changed before successor admission");
						return { path: file, content: document.content };
					}),
				)
			: [];
		ctx.signal.throwIfAborted();
		const actor = await getActor(role);
		const bytes =
			contextBytes +
			Buffer.byteLength(JSON.stringify({ input, handoff, documents })) +
			actor.session.systemPrompt.reduce((size, block) => size + Buffer.byteLength(block), 0);
		if (!actor.session.model?.contextWindow || bytes + 12000 > actor.session.model.contextWindow)
			throw new Error(
				`Required ${role} materials exceed selected context; narrow scope explicitly (${bytes} input bytes + 12000 reserve; context ${actor.session.model?.contextWindow ?? "unknown"})`,
			);
		return tracked(actor.request({ documents, handoff, payload: input }, ctx, schema));
	};
	const runRole = async (
		role: "requirements" | "planner" | "reviewer",
		input: unknown,
		schema: unknown,
		context: SpecRunContext,
		model = currentModel,
	): Promise<unknown> => {
		const ctx = contextFor(context);
		if (role === "requirements" || role === "planner") return requestActor(role, input, schema, ctx);
		const definition = getBundledAgent("reviewer");
		if (!definition) throw new Error(`Missing bundled specification role: ${role}`);
		const skills = await roleSkills(role);
		const methods = await Promise.all(skills.map(skill => fs.readFile(skill.filePath, "utf8")));
		const payload = JSON.stringify({ specDrivenRole: role, input });
		const task = prompt.render(taskTemplate, { payload, skills: [] });
		const requiredBytes =
			contextBytes + Buffer.byteLength(task) + methods.reduce((size, text) => size + Buffer.byteLength(text), 0);
		const selected = session.modelRegistry.getAvailable().find(item => formatModelStringWithRouting(item) === model);
		// One token can encode one UTF-8 byte; use an explicit conservative bound, never truncate required input.
		if (!selected?.contextWindow || requiredBytes + 12000 > selected.contextWindow)
			throw new Error(
				`Required ${role} originals exceed the selected context; narrow scope explicitly (${requiredBytes} bytes)`,
			);
		const id = `spec-${role}-${crypto.randomUUID()}`;
		let observedSessionId: string | null = null;
		const deferredCleanup: Promise<void>[] = [];
		const result = await tracked(
			runSubprocess({
				onCleanupDeferred(completion) {
					deferredCleanup.push(completion);
				},
				cwd,
				agent: {
					...definition,
					model: [model],
					spawns: [],
					tools: [...TEAM_READ_ONLY_TOOLS],
					readSummarize: false,
				},
				task,
				assignment: task,
				id,
				index: 0,
				modelOverride: model,
				parentActiveModelPattern: currentModel,
				outputSchema: schema,
				outputSchemaMode: "strict",
				outputSchemaSource: "caller",
				outputSchemaOverridesAgent: true,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				keepAlive: false,
				disableAutoCompaction: true,
				maxRuntimeMs: 0,
				signal: ctx.signal,
				settings,
				modelRegistry: session.modelRegistry,
				authStorage: parentDeps.authStorage,
				getApiKey: parentDeps.getApiKey,
				sessionFile: session.sessionFile ?? null,
				artifactsDir: root,
				persistArtifacts: true,
				parentAgentId: parentDeps.parentAgentId,
				eventBus: parentDeps.eventBus,
				subagentEventBus: parentDeps.subagentEventBus,
				contextFiles: loadedContext.contextFiles ? [...loadedContext.contextFiles] : [],
				rules: loadedContext.activeRules ? [...loadedContext.activeRules] : [],
				promptTemplates: [],
				skills,
				autoloadSkills: [],
				subagentRequest: {
					session: {
						cwd,
						hasUI: false,
						settings,
						enableMCP: false,
						enableLsp: false,
						enableIrc: false,
						getSessionFile: () => session.sessionFile ?? null,
						getSessionSpawns: () => "",
					},
					invocationKind: "eval",
					assignment: task,
					agent: definition.name,
					outputSchema: schema,
				},
				subagentHooks: {
					async beforeSpawn() {
						ctx.signal.throwIfAborted();
					},
					async configureSession(_request, options) {
						ctx.signal.throwIfAborted();
						const nativePrompt = options.systemPrompt;
						return {
							allowRestrictedCustomTools: false,
							systemPrompt: defaults => {
								const original =
									typeof nativePrompt === "function" ? nativePrompt(defaults) : (nativePrompt ?? defaults);
								return [...(typeof original === "string" ? [original] : original), ...methods];
							},
						};
					},
				},
				localProtocolOptions: {
					getArtifactsDir: () => root,
					getReadIsolationRoots: () => [root],
					getSessionId: () => id,
					allowCrossAgentReads: false,
				},
				onSessionCreated(child) {
					observedSessionId = child.sessionId;
					const releasePolicy = bindSpecSkillPolicy(child.sessionManager, {
						phase: role,
						allowedSkills: skills.map(skill => skill.name),
					});
					const grants = skills.map(skill => grantSpecSkillAccess(child.sessionManager, skill));
					const unobserve = observeRequests(child, role, model, id);
					return () => {
						unobserve();
						for (const release of grants) release();
						releasePolicy();
					};
				},
			}).finally(async () => {
				await Promise.all(deferredCleanup);
			}),
		);
		const name = `review-${result.id}-${crypto.randomUUID()}.json`;
		const original = JSON.stringify({
			runId: ctx.runId,
			generation: ctx.generation,
			actorId: result.id,
			sessionId: observedSessionId,
			assignedModel: model,
			actualModel: result.resolvedModel ?? null,
			actualModelIdentity: result.resolvedModelIdentity ?? null,
			exitCode: result.exitCode,
			error: result.error ?? null,
			aborted: result.aborted ?? false,
			output: result.output,
			structuredOutput: result.structuredOutput ?? null,
		});
		const relative = `checks/${name}`;
		await fs.writeFile(await containedSpecPath(cwd, `${requireStore().changeDir}/${relative}`), original, {
			flag: "wx",
		});
		const slotId = object(object(input)?.slot)?.id;
		if (typeof slotId !== "string") throw new Error("Independent review has no actual assigned seat");
		reviewArtifacts.push({
			slotId,
			actorId: result.id,
			sessionId: observedSessionId,
			model: result.resolvedModel ?? null,
			path: relative,
			version: artifactVersion(original),
		});
		ctx.signal.throwIfAborted();
		if (result.aborted || result.exitCode !== 0 || result.error)
			throw new Error(result.error ?? result.abortReason ?? `Native ${role} failed`);
		if (
			!modelMatches(result.resolvedModel, model) ||
			(result.resolvedModelIdentity !== undefined &&
				result.resolvedModelIdentity !== model &&
				!result.resolvedModelIdentity.startsWith(`${model}@`))
		)
			throw new Error(`Native ${role} ran a model outside its assigned review/author seat`);
		if (result.structuredOutput?.status !== "valid")
			throw new Error(`Native ${role} did not yield validated structured output`);
		return result.structuredOutput.data;
	};
	const ports: SpecDrivenPorts = {
		conversation: {
			recipient(role) {
				const actor = actors.get(role);
				if (!actor || actor.session.isDisposed || disposed) return undefined;
				return { role, actorId: actor.id, sessionId: actor.session.sessionId };
			},
			async respond(input, context) {
				if (!actors.has(input.role)) throw new Error(`No retained ${input.role} conversation actor`);
				// Dialogue inherits current authority; it never renews a stopped execution host.
				if (input.status.phase === "awaiting-acceptance") executionHost?.stop();
				return (await requestActor(
					input.role,
					{
						kind: "conversation",
						...input,
						originals: originals(),
						uniquePlanPath: requireStore().planPath,
					},
					{
						type: "object",
						properties: {
							text: { type: "string", minLength: 1 },
							requirements: SPEC_REQUIREMENTS_SCHEMA,
							plan: SPEC_PLAN_SCHEMA,
						},
						required: ["text"],
						additionalProperties: false,
					},
					context,
				)) as SpecConversationReply;
			},
			async repairScope(input, context) {
				if (!actors.has("executor") || !executionHost) throw new Error("No retained executor for repair analysis");
				executionHost.stop();
				const reply = (await requestActor(
					"executor",
					{ kind: "repair-scope", ...input, originals: originals() },
					{
						type: "object",
						properties: {
							taskIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
						},
						required: ["taskIds"],
						additionalProperties: false,
					},
					context,
				)) as { taskIds: string[] };
				return reply.taskIds;
			},
		},
		async handoff(input, context) {
			const ctx = contextFor(context);
			const artifacts = requireStore();
			const requirements = await artifacts.readRequirements();
			const solution = input.solution ? await artifacts.readSolution() : undefined;
			const plan = input.plan ? await artifacts.readPlan() : undefined;
			if (
				requirements.version !== input.specification.version ||
				(solution && solution.version !== input.solution!.artifactVersion) ||
				(plan && plan.version !== input.plan!.artifactVersion)
			)
				throw new Error("Approved handoff document version changed");
			const snapshots = [
				requirements.proposal,
				...requirements.specs,
				...requirements.checks,
				...(solution ? [solution] : []),
				...(plan ? [plan] : []),
			];
			const documents = snapshots.map(item => ({ path: item.path, content: item.content, version: item.version }));
			const role =
				input.transition === "requirements-to-solution"
					? "requirements"
					: input.transition === "solution-to-plan"
						? "solution"
						: "planner";
			const actor = actors.get(role);
			if (!actor) throw new Error(`Missing live ${role} producer`);
			const file = `${artifacts.changeDir}/handoffs/${input.transition}.md`;
			const target = await containedSpecPath(cwd, file);
			const versions = Object.fromEntries(documents.map(item => [item.path, item.version]));
			const check = async () => {
				ctx.signal.throwIfAborted();
				if (actors.get(role) !== actor || actor.session.isDisposed)
					throw new Error("Handoff producer ownership changed");
				for (const document of documents)
					if ((await artifacts.readDocument(document.path)).version !== document.version)
						throw new Error("Approved handoff document changed during native handoff");
			};
			await check();
			const saved = handoffs.get(input.transition);
			if (
				saved &&
				saved.actorId === actor.id &&
				saved.runId === ctx.runId &&
				JSON.stringify(saved.versions) === JSON.stringify(versions) &&
				(await fs.readFile(target, "utf8").catch(() => null)) === saved.body
			)
				return saved;
			const result = await tracked(
				actor.handoff({ transition: input.transition, documents, decision: input.decision, path: file }, ctx),
			);
			await check();
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, result.body, "utf8");
			await check();
			if ((await fs.readFile(target, "utf8")) !== result.body) throw new Error("Native handoff persistence changed");
			handoffs.set(input.transition, result);
			return result;
		},
		artifacts: {
			async initialize(changeId, context) {
				contextFor(context);
				store = new SpecArtifactStore({
					cwd,
					changeId,
					runId: context.runId,
					requirementsDir: await requirementsAuthority(cwd),
					checkPaths: ["checks/source-approval.json", "checks/requirements.json"],
				});
				await store.initialize();
				root = path.dirname(path.join(cwd, store.statePath));
				await fs.mkdir(root, { recursive: true });
				try {
					sourceMap = await store.prepareSourceMap();
				} catch (error) {
					if (!store.native || !isEnoent(error)) throw error;
				}
			},
			async writeRequirements(draft, context) {
				contextFor(context);
				if (
					!requireStore().native &&
					(!sourceMap || draft.sourceMapVersion !== sourceMap.version || !draft.sourcePatches)
				)
					throw new Error("Markdown authority requires current mapped source patches");
				const checks = [{ path: "checks/requirements.json", content: JSON.stringify(draft) }];
				if (sourceMap)
					checks.push({
						path: "checks/source-approval.json",
						content: JSON.stringify({ sourceMap, sourcePatches: draft.sourcePatches ?? [] }),
					});
				const result = await requireStore().writeRequirements({ ...draft, checks });
				acceptanceCriteria = JSON.stringify(draft.requirements);
				return { version: result.version };
			},
			async readRequirements(context) {
				contextFor(context);
				if (archived) {
					await checkArchived();
					return { version: archived.versions.requirements };
				}
				return { version: (await requireStore().readRequirements()).version };
			},
			async validateRequirements(context) {
				const result = await requireStore().validateRequirements(contextFor(context).signal);
				if (result.exitCode !== 0)
					throw new Error(`Specification validation failed: ${result.stdout}\n${result.stderr}`);
			},
			async writeSolution(draft, context) {
				contextFor(context);
				return { version: (await requireStore().writeSolution(draft)).version };
			},
			async readSolution(context) {
				contextFor(context);
				if (archived) {
					await checkArchived();
					return { version: archived.versions.solution };
				}
				return { version: (await requireStore().readSolution()).version };
			},
			async writePlan(draft, context) {
				contextFor(context);
				return { version: (await requireStore().writePlan(draft)).version };
			},
			async readPlan(context) {
				contextFor(context);
				if (archived) {
					await checkArchived();
					return { version: archived.versions.plan };
				}
				return { version: (await requireStore().readPlan()).version };
			},
			async close(input, context) {
				const ctx = contextFor(context);
				const artifacts = requireStore();
				if (archived) {
					if (
						input.acceptanceVersion !== archived.acceptanceVersion ||
						input.specification.version !== archived.versions.requirements ||
						input.plan.artifactVersion !== archived.versions.plan
					)
						throw new Error("Observed archive belongs to a different approved closure");
					await relocateArchivedEvidence(ctx);
					await checkArchived();
					return;
				}
				if (input.plan.closure.sync) {
					try {
						const currentSources = await artifacts.prepareSourceMap();
						if (sourceMap ? currentSources.version !== sourceMap.version : currentSources.files.length > 0)
							throw new Error("Requirement authority changed after independent approval");
					} catch (error) {
						if (!isEnoent(error) || sourceMap) throw error;
					}
				}
				if (
					(await artifacts.readRequirements()).version !== input.specification.version ||
					input.requirementsReview.lastReview?.verdict !== "pass" ||
					input.requirementsReview.reviewedRevision !== input.requirementsReview.revision
				)
					throw new Error("Current independent requirements review is required for closure");
				const approval = {
					accepted: true,
					authorized: true,
					requirementsVersion: input.specification.version,
				} as const;
				let markdown;
				if (
					sourceMap &&
					input.plan.closure.sync &&
					sourceMap.entries.some(
						entry =>
							!input.requirementsReview.lastReview!.evidenceChecks.some(
								check => check.recordId === entry.id && check.valid && check.reason.trim(),
							),
					)
				)
					throw new Error("Independent per-source semantic preservation evidence is incomplete");
				if (!artifacts.native && sourceMap && input.plan.closure.sync) {
					if (input.specification.sourceMapVersion !== sourceMap.version || !input.specification.sourcePatches)
						throw new Error("Stale source approval");
					const covered = [
						...sourceMap.entries.map(entry => entry.id),
						...input.specification.sourcePatches.flatMap(patch =>
							patch.operation === "add" && !patch.afterSourceId ? [`add:${patch.path}`] : [],
						),
					];
					const review = input.requirementsReview.lastReview;
					if (
						covered.some(
							id =>
								!review.evidenceChecks.some(
									check => check.recordId === id && check.valid && check.reason.trim(),
								),
						)
					)
						throw new Error("Independent per-source semantic preservation evidence is incomplete");
					markdown = {
						patches: input.specification.sourcePatches,
						sourceMap,
						approval: {
							...approval,
							sourceMapVersion: sourceMap.version,
							patchVersion: specPatchVersion(input.specification.sourcePatches),
							reviewer: input.requirementsReview.id,
							reviewEvidence: JSON.stringify(review),
							coveredSourceIds: covered,
						},
					};
				}
				if (input.plan.closure.archive) {
					const requirements = await artifacts.readRequirements();
					const solution = await artifacts.readSolution();
					const plan = await artifacts.readPlan();
					const files = [requirements.proposal, ...requirements.specs, ...requirements.checks].map(item => ({
						path: path.posix.relative(artifacts.changeDir, item.path),
						content: item.content,
					}));
					files.push(
						{ path: "plan.md", content: plan.content },
						{
							path: "checks/orchestration.json",
							content: await fs.readFile(await containedSpecPath(cwd, artifacts.statePath), "utf8"),
						},
					);
					const outcome = await artifacts.archive(approval, ctx.signal, markdown, {
						sync: input.plan.closure.sync,
					});
					archived = {
						path: outcome.archivePath,
						root: path.resolve(cwd, outcome.archivePath),
						acceptanceVersion: input.acceptanceVersion,
						versions: { requirements: requirements.version, solution: solution.version, plan: plan.version },
						files,
					};
					await relocateArchivedEvidence(ctx);
					await checkArchived();
				} else if (input.plan.closure.sync) {
					await artifacts.sync(approval, ctx.signal, markdown);
				}
			},
		},
		models: {
			async requirements(input, context) {
				requestText = input.request;
				if (sourceMap) sourceMap = await requireStore().prepareSourceMap();
				const nativeInstructions = await Promise.all(
					["proposal", "specs"].map(async artifact => {
						const result = await runOpenSpec(
							["instructions", artifact, "--change", requireStore().changeId, "--json"],
							cwd,
							contextFor(context).signal,
						);
						if (result.exitCode !== 0)
							throw new Error(`OpenSpec ${artifact} instructions failed: ${result.stderr}`);
						return { artifact, instructions: result.stdout };
					}),
				);
				return runRole(
					"requirements",
					{ ...input, originals: originals(), nativeInstructions },
					SPEC_REQUIREMENTS_SCHEMA,
					context,
				);
			},
			async plan(input, context) {
				return runRole(
					"planner",
					{ ...input, originals: originals(), uniquePlanPath: requireStore().planPath },
					SPEC_PLAN_SCHEMA,
					context,
				);
			},
			async execute(input, context, control) {
				const ctx = contextFor(context);
				if (!git || approvedPlan?.version !== input.plan.version)
					throw new Error("Execution has no current local commit authority");
				const workspace = await fs.realpath(await containedSpecPath(cwd, input.plan.workspace.executionPath));
				if (executionHost && executionInput?.context.generation !== ctx.generation) {
					releaseExecution();
					const previous = actors.get("executor");
					if (previous) await previous.dispose();
					actors.delete("executor");
					goalHost = undefined;
					ownedGoal = undefined;
				}
				executionInput = { mode: input.mode, context: ctx, workspace, planVersion: input.plan.version };
				const executorSkills = await roleSkills("executor");
				const executionControl: SpecExecutionControl = {
					...control,
					async checkpoint(taskId, execution) {
						const state = await control.checkpoint(taskId, execution);
						if (control.status().every(task => task.status === "completed")) {
							activeExecution = false;
							goalHost?.stopForHostAbort();
							wakeGoal();
						}
						return state;
					},
				};
				if (!executionHost)
					executionHost = new SpecExecutionHost({
						plan: input.plan,
						specificationVersion: input.specification.version,
						workspace,
						changeDir: path.join(cwd, requireStore().changeDir),
						context: ctx,
						checksDirectory: `${requireStore().changeDir}/checks`,
						control: executionControl,
						git,
						planPath: requireStore().planPath,
						skills: executorSkills,
						methods: await Promise.all(executorSkills.map(skill => fs.readFile(skill.filePath, "utf8"))),
						session: {
							cwd: workspace,
							hasUI: false,
							settings,
							enableLsp: false,
							enableMCP: false,
							getSessionSpawns: () => "*",
							getSessionFile: () => actors.get("executor")?.session.sessionFile ?? null,
							getAgentId: () => actors.get("executor")?.id ?? null,
							getArtifactsDir: () => root,
						},
						onEvidence(service, source, taskId) {
							services.push({ service, source });
							if (!source) qualifications.set(`tools:${taskId}`, { service });
						},
						onRecord(record, service) {
							recordOwners.set(record.id, service);
						},
					});
				activeExecution = true;
				// Creating a Goal is also idle; its continuation must not race the stage owner's first prompt.
				goalContinuationAllowed = false;
				const stop = () => releaseExecution();
				ctx.signal.addEventListener("abort", stop, { once: true });
				try {
					const actor = await getActor("executor");
					executionHost.renew(ctx, executionControl);
					if (input.mode === "goal") {
						const objective = `Complete approved specification plan ${input.plan.version}; checkpoint every parent and stop before user acceptance. No broader authorization.`;
						const current = actor.session.getGoalModeState();
						if (!current?.enabled && current?.goal.status === "paused") {
							if (
								ownedGoal?.actorId !== actor.id ||
								ownedGoal.id !== current.goal.id ||
								ownedGoal.objective !== objective ||
								current.goal.objective !== objective
							)
								throw new Error("Paused Goal is not the current executor's approved objective");
							await goalHost!.handle({ op: "resume" });
						} else if (!current?.enabled) {
							const created = await goalHost!.handle({ op: "create", objective });
							if (!created.goal) throw new Error("Scoped Goal creation returned no actual goal");
							ownedGoal = { actorId: actor.id, id: created.goal.id, objective };
						}
					}
					for (;;) {
						const before = JSON.stringify({ tasks: control.status(), sources: executionHost.sourceFacts });
						await requestActor(
							"executor",
							{ ...input, tasks: control.status(), originals: originals() },
							{
								type: "object",
								properties: { summary: { type: "string" } },
								required: ["summary"],
								additionalProperties: false,
							},
							ctx,
						);
						await asyncJobs.waitForOwnerJobs(actor.id);
						if (input.mode === "goal") {
							goalContinuationAllowed = true;
							goalHost!.refresh();
						}
						if (input.mode === "goal") {
							while (control.status().some(task => task.status !== "completed")) {
								const wake = goalWake.promise;
								await actor.session.waitForIdle();
								await goalHost!.settled();
								ctx.signal.throwIfAborted();
								if (control.status().every(task => task.status === "completed")) break;
								if (
									!goalHost!.continuationPending &&
									!actor.session.isStreaming &&
									!actor.session.hasAdmittedSubmission
								)
									throw new Error("Scoped Goal stopped before approved checkpoints completed");
								await untilAborted(ctx.signal, () => wake);
							}
							await actor.session.waitForIdle();
						}
						if (control.status().every(task => task.status === "completed")) break;
						const after = JSON.stringify({ tasks: control.status(), sources: executionHost.sourceFacts });
						if (before === after) throw new Error("Executor made no checkpoint progress on approved obligations");
					}
					if (control.status().some(task => task.status !== "completed"))
						throw new Error("Executor returned without completing all approved parent checkpoints");
				} finally {
					activeExecution = false;
					goalContinuationAllowed = false;
					executionHost.stop();
					goalHost?.stopForHostAbort();
					const actor = actors.get("executor");
					if (actor) {
						asyncJobs.cancelAll({ ownerId: actor.id });
						await asyncJobs.waitForOwnerJobs(actor.id);
					}
					if (goalHost) await goalHost.handle({ op: "pause" });
					ctx.signal.removeEventListener("abort", stop);
				}
			},
			async review(input, context) {
				return runRole(
					"reviewer",
					{
						...input,
						originals: originals(),
						executionEvidence: executionHost
							? { sources: executionHost.sourceFacts, publications: executionHost.publicationFacts }
							: undefined,
						independentContext: input.slot.sameModelIndependent
							? "same-model independent analysis"
							: "independent model analysis",
					},
					SPEC_REVIEW_SCHEMA,
					context,
					input.slot.model,
				);
			},
		},
		team: {
			async run(input, context) {
				const ctx = contextFor(context);
				await requestActor(
					"solution",
					{
						...input,
						originals: originals(),
						organization:
							"Organize existing native OMP Team; candidate identity and eligibility remain native structured facts.",
					},
					{
						type: "object",
						properties: { questions: { type: "array", items: { type: "string" } } },
						required: ["questions"],
						additionalProperties: false,
					},
					ctx,
				);
				const question = JSON.stringify({ ...input, originals: originals() });
				for (const participant of resolution.participants) {
					if (
						!participant.model.contextWindow ||
						Buffer.byteLength(question) + contextBytes + 12000 > participant.model.contextWindow
					)
						throw new Error("Team required originals exceed configured member context; narrow scope explicitly");
				}
				const runner = createTeamSubagentRunner({
					...parentDeps,
					preserveContextFiles: true,
					disableAutoCompaction: true,
					contextFiles: loadedContext.contextFiles ? [...loadedContext.contextFiles] : [],
					skills: [],
					promptTemplates: [],
					rules: loadedContext.activeRules ? [...loadedContext.activeRules] : [],
					onSessionCreated(call, child) {
						return observeRequests(child, `team-${call.role}`, call.modelPattern, `team-${crypto.randomUUID()}`);
					},
				});
				const result = await tracked(
					runTeamDiscussion({
						question,
						inputVersion: input.specification.version,
						cwd,
						participants: resolution.participants,
						sessionModelPattern: currentModel,
						runner,
						signal: ctx.signal,
						maxConcurrency: cfgTaskMaxConcurrency.get(settings),
						onProgress(update) {
							if (!ctx.signal.aborted) void args.onOutput?.(update.text);
						},
					}),
				);
				ctx.signal.throwIfAborted();
				await requireStore().saveTeamResult(result);
				return adaptSpecTeamResult(result);
			},
		},
		git: {
			async preflight(input, context) {
				const ctx = contextFor(context);
				const workspace = await fs.realpath(await containedSpecPath(cwd, input.plan.workspace.executionPath));
				const changed = approvedPlan?.version !== input.plan.version || git?.cwd !== workspace;
				if (changed) {
					releaseExecution();
					const executor = actors.get("executor");
					if (executor) {
						await asyncJobs.waitForOwnerJobs(executor.id);
						await executor.dispose();
					}
					if (executionHost) {
						retiredSources.push(...executionHost.sourceFacts);
						retiredPublications.push(...executionHost.publicationFacts);
						executionHost.dispose();
					}
					executionHost = undefined;
					actors.delete("executor");
					goalHost = undefined;
					ownedGoal = undefined;
					executionInput = undefined;
					const keep = new Set<string>();
					if (approvedPlan && approvedRequirements && git?.cwd === workspace) {
						for (const task of input.plan.tasks) {
							const previous = approvedPlan.tasks.find(item => item.id === task.id);
							const before = previous && {
								task: previous,
								workspace: approvedPlan.workspace,
								requirements: previous.requirementIds.map(id =>
									approvedRequirements!.requirements.find(item => item.id === id),
								),
							};
							const after = {
								task,
								workspace: input.plan.workspace,
								requirements: task.requirementIds.map(id =>
									input.specification.requirements.find(item => item.id === id),
								),
							};
							if (JSON.stringify(before) !== JSON.stringify(after)) continue;
							keep.add(`tools:${task.id}`);
							for (const validation of task.validation) keep.add(`task:${task.id}:${validation.id}`);
						}
						for (const condition of input.plan.conditions) {
							if (
								JSON.stringify(condition) !==
								JSON.stringify(approvedPlan.conditions.find(item => item.id === condition.id))
							)
								continue;
							const key = `condition:${condition.id}`;
							keep.add(key);
							const qualification = qualifications.get(key);
							if (qualification)
								qualification.taskIds = input.plan.tasks
									.filter(task => task.conditionIds.includes(condition.id))
									.map(task => task.id);
						}
					}
					for (const key of qualifications.keys()) if (!keep.has(key)) qualifications.delete(key);
					git = new SpecGitService(workspace, { projectRoot: cwd });
				}
				if (!git) throw new Error("Approved workspace has no actual Git service");
				const state = await git.preflight();
				ctx.signal.throwIfAborted();
				baseline ||= state.head;
				gitBaselines.push({ ...state, planVersion: input.plan.version, workspace, observedAt: Date.now() });
				approvedPlan = structuredClone(input.plan);
				approvedRequirements = structuredClone(input.specification);
			},
			async commit(input, context) {
				const ctx = contextFor(context);
				if (!executionHost) throw new Error("No live stage executor to commit");
				const findings = executionHost.findings(input.task.id);
				return executionHost.commit(
					input.task.id,
					`spec: ${requireStore().changeId} ${input.task.id}${input.revision ? ` repair ${input.revision}` : ""}`,
					findings,
					ctx.signal,
				);
			},
		},
		evidence: {
			async read(ids, context) {
				await relocateArchivedEvidence(context);
				return Promise.all(
					ids.map(async id => {
						const owner = recordOwners.get(id);
						if (!owner) throw new Error(`Unknown runtime-owned native evidence ${id}`);
						return (await owner.read([id], context))[0]!;
					}),
				);
			},
			async revalidate(context) {
				await relocateArchivedEvidence(context);
				const current = [...qualifications.entries()];
				const results = await Promise.all(
					current.map(async ([key, item]) => {
						const result = await item.service.revalidate(context);
						if (result.reasons.length && qualifications.get(key)?.service === item.service)
							qualifications.delete(key);
						return result.reasons.length && item.taskIds
							? { ...result, taskIds: item.taskIds, overall: item.taskIds.length === 0 }
							: result;
					}),
				);
				return {
					taskIds: [...new Set(results.flatMap(item => item.taskIds))],
					reasons: results.flatMap(item => item.reasons),
					overall: results.some(item => item.overall),
				};
			},
			async flush(status, context) {
				await relocateArchivedEvidence(context);
				if (archived)
					for (const task of status.tasks)
						if (task.records.length)
							task.records = await ports.evidence.read(
								task.records.map(record => record.id),
								context,
							);
				let current: SpecGitEvidence["current"] = null;
				if (git) {
					const observedAt = Date.now();
					try {
						const repo = vcs.requireGit(git.cwd);
						const head = (await repo.headSha()) ?? null;
						const observedStatus = await repo.statusPorcelain({ untracked: "all", nulTerminated: true });
						current = {
							workspace: git.cwd,
							head,
							status: observedStatus,
							observedAt,
							...(head ? {} : { error: "Git HEAD is unavailable" }),
						};
					} catch (error) {
						current = {
							workspace: git.cwd,
							head: null,
							status: null,
							observedAt,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}
				status.gitEvidence = { baselines: structuredClone(gitBaselines), current };
				status.reviewArtifacts = structuredClone(reviewArtifacts);
				if (executionHost || retiredSources.length || retiredPublications.length) {
					const sourceView = (source: SpecNativeSource) => ({
						...source,
						evidencePath: path.posix.relative(requireStore().changeDir, source.evidencePath),
					});
					status.executionEvidence = {
						sources: [...retiredSources, ...(executionHost?.sourceFacts ?? [])].map(sourceView),
						publications: [...retiredPublications, ...(executionHost?.publicationFacts ?? [])].map(
							publication => ({
								...publication,
								source: sourceView(publication.source),
							}),
						),
					};
				}
				if (store) await store.saveState(status);
				if (services.length) {
					await tracked(
						aggregateSpecEvidence(
							services.map(item => item.service),
							status,
							context,
						),
					);
				} else if (store) {
					const directory = archived?.root ?? path.join(cwd, store.changeDir);
					const checks = await containedSpecPath(directory, "checks");
					await fs.mkdir(checks, { recursive: true });
					const raw = `status-${crypto.randomUUID()}.json`;
					await fs.writeFile(
						path.join(checks, raw),
						JSON.stringify({ context: { runId: context.runId, generation: context.generation }, status }),
						{ flag: "wx" },
					);
					const temporary = path.join(checks, `report-${crypto.randomUUID()}.tmp`);
					const gitSection = [
						"## Git baseline and current observations",
						"",
						...(status.gitEvidence.baselines.length ? [] : ["Baselines: unknown (no observed baseline).", ""]),
						...(status.gitEvidence.current ? [] : ["Current: unknown (null).", ""]),
						"```json",
						JSON.stringify(status.gitEvidence, null, 2),
						"```",
					].join("\n");
					await fs.writeFile(
						temporary,
						`# Verification\n\nObserved phase: ${status.phase}; paused: ${status.paused}.\n\n[Raw stage observations](checks/${raw})\n\n${gitSection}\n\nNo execution command evidence has been collected. Stage reviews and approvals are observations, not implementation acceptance.\n`,
						{ flag: "wx" },
					);
					await fs.rename(temporary, path.join(directory, "verification.md"));
				}
			},
		},
		validation: {
			async run(input, context) {
				const ctx = contextFor(context);
				const plan = approvedPlan;
				const approved =
					input.purpose === "condition"
						? plan?.conditions.find(item => item.id === input.id)
						: input.purpose === "final"
							? plan?.finalValidation.find(item => item.id === input.id)
							: plan?.tasks
									.flatMap(task =>
										task.validation.map(validation => ({ ...validation, id: `${task.id}:${validation.id}` })),
									)
									.find(item => item.id === input.id);
				if (!approved || approved.command !== input.command)
					throw new Error(`Unapproved ${input.purpose} validation: ${input.id}`);
				if (!plan) throw new Error("Missing approved validation plan");
				const task =
					input.purpose === "task" ? plan.tasks.find(item => input.id.startsWith(`${item.id}:`)) : undefined;
				const inputPaths =
					input.purpose === "condition"
						? [...approved.inputPaths]
						: [...new Set([...approved.inputPaths, ...(task?.ownedPaths ?? [])])];
				if (!inputPaths.length) throw new Error("Validation has no deliberate approved input selectors");
				const workspace = await fs.realpath(await containedSpecPath(cwd, plan.workspace.executionPath));
				const service = new SpecEvidenceService({
					cwd: workspace,
					changeDir: path.join(cwd, requireStore().changeDir),
					owner: {
						actorId: actors.get("executor")?.id ?? `host-${ctx.runId}`,
						taskId: task?.id ?? null,
						workspace,
						specificationVersion: plan.specificationVersion,
						planVersion: plan.version,
					},
					run: ctx,
				});
				services.push({ service, source: false });
				qualifications.set(`${input.purpose}:${input.id}`, {
					service,
					...(input.purpose === "condition"
						? { taskIds: plan.tasks.filter(item => item.conditionIds.includes(input.id)).map(item => item.id) }
						: {}),
				});
				const record = await tracked(
					service.recordCommand(
						{
							command: approved.command,
							toolCallId: `host-${input.purpose}-${input.id}-${crypto.randomUUID()}`,
							inputPaths,
							obligation: { validationId: input.id, approvedCommand: approved.command, reason: null },
						},
						ctx,
					),
				);
				recordOwners.set(record.id, service);
				if (task) qualifications.delete(`tools:${task.id}`);
				return record.id;
			},
		},
	};
	return {
		ports,
		options: { currentModel, members },
		async dispose() {
			if (disposed) return;
			disposed = true;
			lifetime.abort();
			releaseExecution();
			await Promise.allSettled(pending);
			await Promise.allSettled(actorPending.values());
			await Promise.all([...actors.values()].map(actor => actor.dispose()));
			releaseExecution();
			executionHost?.dispose();
		},
		measurement() {
			return structuredClone({
				task: requestText,
				codeBaseline: baseline,
				modelConfiguration: JSON.stringify({ currentModel, members }),
				acceptanceCriteria,
				mode: "workflow",
				startedAt,
				endedAt: Date.now(),
				requests,
				observations: [],
				plannedDecisionWaitMs: null,
				executionWaitMs: null,
				assessmentComplete: false,
			});
		},
	};
}
