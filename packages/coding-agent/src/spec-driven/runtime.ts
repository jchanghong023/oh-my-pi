import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../sdk";
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
import { createSpecExecutionTools, recordSpecCommand, type SpecExecutionTools } from "./execution-tools";
import { SpecGitService } from "./git";
import type { SpecRunMeasurement, SpecRequestMeasurement } from "./metrics";
import { loadSpecDrivenSkill, runOpenSpec } from "./resources";
import { SPEC_PLAN_SCHEMA, SPEC_REQUIREMENTS_SCHEMA, SPEC_REVIEW_SCHEMA } from "./schemas";
import type {
	SpecDrivenOptions,
	SpecDrivenPorts,
	SpecPlan,
	SpecRunContext,
	SpecTeamResult,
	SpecToolRecord,
} from "./types";

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
async function fileIdentity(cwd: string, file: string): Promise<string | null> {
	try {
		return artifactVersion(await fs.readFile(await containedSpecPath(cwd, file), "utf8"));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
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
}): Promise<SpecDrivenRuntime> {
	const { session, settings } = args;
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
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-runtime-"));
	// Evidence is deliberately retained after disposal; reports refer to these actual command outputs.
	const ledger = new Map<string, SpecToolRecord>();
	const labels = new Map<string, { validationId: string; stage: "red" | "green" }>();
	const startedAt = Date.now();
	const requests: SpecRequestMeasurement[] = [];
	let store: SpecArtifactStore | undefined;
	let sourceMap: SpecSourceMap | undefined;
	let gitTaskOpen = false;
	let git: SpecGitService | undefined;
	let approvedPlan: SpecPlan | undefined;
	let activeTask: string | undefined;
	let activeFindings: string[] = [];
	let requestText = "";
	let baseline = "";
	let acceptanceCriteria = "";
	let disposed = false;
	const pending = new Set<Promise<unknown>>();
	const requireStore = (): SpecArtifactStore => {
		if (!store) throw new Error("Specification artifacts are not initialized");
		return store;
	};
	const contextFor = (context: SpecRunContext): SpecRunContext => {
		if (disposed) throw new Error("Specification runtime disposed");
		const signal = AbortSignal.any([context.signal, lifetime.signal]);
		signal.throwIfAborted();
		return { ...context, signal };
	};
	const releaseTask = (): void => {
		if (gitTaskOpen && git && activeTask) git.finishTask(activeTask);
		gitTaskOpen = false;
		activeTask = undefined;
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
				cost: null,
				evidence: `Native child ${id} message_end; persisted transcript`,
			});
		});
	};
	const originals = (): SpecSourceMap | undefined => (sourceMap ? structuredClone(sourceMap) : undefined);
	const runRole = async (
		role: "requirements" | "planner" | "executor" | "reviewer",
		input: unknown,
		schema: unknown,
		context: SpecRunContext,
		model = currentModel,
		execution?: SpecExecutionTools,
	): Promise<unknown> => {
		const ctx = contextFor(context);
		const definition = getBundledAgent(role === "reviewer" ? "reviewer" : `spec-${role}`);
		if (!definition) throw new Error(`Missing bundled specification role: ${role}`);
		const skillNames =
			role === "requirements"
				? ["openspec-explore", "openspec-new-change", "openspec-continue-change"]
				: role === "planner"
					? ["writing-plans"]
					: role === "executor"
						? [
								"subagent-driven-development",
								"test-driven-development",
								"verification-before-completion",
								"systematic-debugging",
								"receiving-code-review",
							]
						: ["requesting-code-review"];
		const skills = await Promise.all(
			skillNames.map(name => loadSpecDrivenSkill(name.startsWith("openspec-") ? "openspec" : "superpowers", name)),
		);
		const payload = JSON.stringify({ specDrivenRole: role, input });
		const task = prompt.render(taskTemplate, { payload, skills: [] });
		const requiredBytes =
			contextBytes +
			Buffer.byteLength(task) +
			(await Promise.all(skills.map(skill => fs.readFile(skill.filePath, "utf8")))).reduce(
				(size, text) => size + Buffer.byteLength(text),
				0,
			);
		const selected = session.modelRegistry.getAvailable().find(item => formatModelStringWithRouting(item) === model);
		// One token can encode one UTF-8 byte; use an explicit conservative bound, never truncate required input.
		if (!selected?.contextWindow || requiredBytes + 12000 > selected.contextWindow)
			throw new Error(
				`Required ${role} originals exceed the selected context; narrow scope explicitly (${requiredBytes} bytes)`,
			);
		const id = `spec-${role}-${crypto.randomUUID()}`;
		const result = await tracked(
			runSubprocess({
				cwd,
				agent: {
					...definition,
					model: [model],
					spawns: [],
					tools: [...TEAM_READ_ONLY_TOOLS, ...(execution ? ["write", "edit", "spec_verify"] : [])],
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
				autoloadSkills: skills,
				specSkillPolicy: { phase: role, allowedSkills: skills.map(skill => skill.name) },
				customTools: execution?.tools,
				localProtocolOptions: {
					getArtifactsDir: () => root,
					getReadIsolationRoots: () => [root],
					getSessionId: () => id,
					allowCrossAgentReads: false,
				},
				onSessionCreated(child) {
					return observeRequests(child, role, model, id);
				},
			}),
		);
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
		artifacts: {
			async initialize(changeId, context) {
				contextFor(context);
				store = new SpecArtifactStore({
					cwd,
					changeId,
					requirementsDir: await requirementsAuthority(cwd),
					checkPaths: ["checks/source-approval.json", "checks/requirements.json"],
				});
				await store.initialize();
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
				return { version: (await requireStore().readRequirements()).version };
			},
			async validateRequirements(context) {
				const result = await requireStore().validateRequirements(contextFor(context).signal);
				if (result.exitCode !== 0)
					throw new Error(`Specification validation failed: ${result.stdout}\n${result.stderr}`);
			},
			async writePlan(draft, context) {
				contextFor(context);
				// 审批必须绑定完整执行元数据，不能让同一正文下的任务、命令或收尾权限悄然变化。
				const content = `${draft.content}\n\n<!-- OMP approved plan metadata\n${JSON.stringify(draft)}\n-->\n`;
				return { version: (await requireStore().writePlan(content)).version };
			},
			async readPlan(context) {
				contextFor(context);
				return { version: (await requireStore().readPlan()).version };
			},
			async close(input, context) {
				const ctx = contextFor(context);
				const artifacts = requireStore();
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
					await artifacts.archive(approval, ctx.signal, markdown, { sync: input.plan.closure.sync });
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
			async execute(input, context) {
				const ctx = contextFor(context);
				if (!git || approvedPlan?.version !== input.plan.version)
					throw new Error("Execution has no current local commit authority");
				if (activeTask) throw new Error("Native task execution must be serialized");
				if (input.task.ownedPaths.length) {
					await git.beginTask(input.task.id, input.task.ownedPaths, {
						executionApproved: true,
						planVersion: input.plan.version,
						expectedPlanVersion: approvedPlan.version,
					});
					gitTaskOpen = true;
				}
				activeTask = input.task.id;
				activeFindings =
					input.review?.findings.filter(finding => finding.severity !== "minor").map(finding => finding.id) ?? [];
				const before = new Map(
					await Promise.all(
						input.task.ownedPaths.map(async file => [file, await fileIdentity(cwd, file)] as const),
					),
				);
				const toolSession: ToolSession = {
					cwd,
					hasUI: false,
					settings,
					enableLsp: false,
					enableMCP: false,
					getSessionSpawns: () => null,
					getSessionFile: () => session.sessionFile ?? null,
					getArtifactsDir: () => root,
				};
				const tools = createSpecExecutionTools({
					session: toolSession,
					task: input.task,
					context: ctx,
					artifactDir: root,
					onRecord(record, validationId, stage) {
						ledger.set(record.id, structuredClone(record));
						labels.set(record.id, { validationId, stage });
					},
				});
				try {
					const output = await runRole(
						"executor",
						{ ...input, originals: originals() },
						{
							type: "object",
							properties: { summary: { type: "string" }, requestedTddException: { type: "string" } },
							required: ["summary", "requestedTddException"],
							additionalProperties: false,
						},
						ctx,
						currentModel,
						tools,
					);
					const changedPaths: string[] = [];
					for (const file of input.task.ownedPaths)
						if (before.get(file) !== (await fileIdentity(cwd, file))) changedPaths.push(file);
					if (!changedPaths.length) releaseTask();
					const behavior = input.task.tdd.mode === "required" ? input.task.tdd.behavior : undefined;
					const red = tools.records.find(
						record =>
							labels.get(record.id)?.stage === "red" &&
							!record.result.isError &&
							record.result.exitCode > 0 &&
							input.task.validation.some(
								validation =>
									validation.id === labels.get(record.id)?.validationId &&
									(!behavior || validation.behavior === behavior),
							) &&
							(tools.implementationStartedAt === null || record.finishedAt <= tools.implementationStartedAt),
					);
					const green = tools.records.findLast(
						record =>
							labels.get(record.id)?.stage === "green" &&
							!record.result.isError &&
							record.result.exitCode === 0 &&
							(!red || labels.get(record.id)?.validationId === labels.get(red.id)?.validationId) &&
							record.startedAt >= (tools.implementationStartedAt ?? red?.finishedAt ?? 0),
					);
					return {
						changedPaths,
						recordIds: tools.records.map(record => record.id),
						redRecordId: red?.id ?? null,
						greenRecordId: green?.id ?? null,
						implementationStartedAt: tools.implementationStartedAt,
						requestedTddException:
							typeof object(output)?.requestedTddException === "string"
								? String(object(output)!.requestedTddException) || null
								: null,
					};
				} catch (error) {
					if (activeTask === input.task.id) releaseTask();
					throw error;
				}
			},
			async review(input, context) {
				return runRole(
					"reviewer",
					{
						...input,
						originals: originals(),
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
				return adaptSpecTeamResult(result);
			},
		},
		git: {
			async preflight(input, context) {
				contextFor(context);
				git ??= new SpecGitService(cwd);
				const state = await git.preflight();
				baseline ||= state.head;
				approvedPlan = structuredClone(input.plan);
			},
			async commit(input, context) {
				const ctx = contextFor(context);
				if (!git || activeTask !== input.task.id) throw new Error("No serialized native task to commit");
				try {
					const result = await git.commitTask(
						input.task.id,
						`spec: ${requireStore().changeId} ${input.task.id}${input.revision ? ` repair ${input.revision}` : ""}`,
						activeFindings,
					);
					if (!result.commit)
						return { base: result.base, head: result.head, taskId: input.task.id, paths: [], reviewPackage: "" };
					const review = await git.reviewPackage(
						input.task.id,
						requireStore().planPath,
						`${requireStore().changeDir}/checks/review-${input.task.id}-${crypto.randomUUID()}.md`,
						ctx.signal,
					);
					return {
						base: result.base,
						head: result.head,
						taskId: input.task.id,
						paths: result.changedPaths,
						reviewPackage: review.content,
					};
				} finally {
					releaseTask();
				}
			},
		},
		evidence: {
			async read(ids, context) {
				const ctx = contextFor(context);
				return ids.map(id => {
					const record = ledger.get(id);
					if (!record || record.runId !== ctx.runId || record.generation !== ctx.generation)
						throw new Error(`Unknown or stale native evidence: ${id}`);
					return structuredClone(record);
				});
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
				const record = await tracked(
					recordSpecCommand({
						cwd,
						command: approved.command,
						toolCallId: `host-${input.purpose}-${input.id}-${crypto.randomUUID()}`,
						artifactDir: root,
						context: ctx,
					}),
				);
				ledger.set(record.id, structuredClone(record));
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
			await Promise.allSettled(pending);
			releaseTask();
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
