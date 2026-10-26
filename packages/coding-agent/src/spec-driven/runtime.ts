import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { AgentSession } from "../session/agent-session";
import { buildRunnerDeps, resolveTeamParticipantsForSession } from "../team/controller";
import { cfgTaskMaxConcurrency } from "../task/settings";
import { runTeamDiscussion } from "../team/orchestrator";
import { createTeamSubagentRunner } from "../team/runner";
import type { TeamRunResult } from "../team/types";
import { containedSpecPath, SpecArtifactStore } from "./artifacts";
import { createSpecActor, type SpecActor } from "./actors";
import { specRequestCost, type SpecRunMeasurement, type SpecRequestMeasurement } from "./metrics";
import { loadSpecDrivenSkill, runOpenSpec } from "./resources";
import { grantSpecSkillAccess } from "./skill-policy";
import type { SpecDrivenOptions, SpecDrivenPorts, SpecRunContext, SpecStageRole } from "./types";

export interface SpecDrivenRuntime {
	ports: SpecDrivenPorts;
	options: SpecDrivenOptions;
	dispose(): Promise<void>;
	measurement(): SpecRunMeasurement;
}

/** Preserve an existing authority without introducing editable requirement mirrors. */
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

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function observedNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function createSpecDrivenRuntime(args: {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	onOutput?: (text: string) => Promise<void>;
	onRequest?: () => void;
}): Promise<SpecDrivenRuntime> {
	const { session, settings } = args;
	if (!session.asyncJobManager)
		throw new Error("Specification workflow requires its owning SDK session's AsyncJobManager");
	if (!session.model) throw new Error("Specification workflow requires a current model");
	const loadedContext = session.loadedProjectContext;
	if (!loadedContext)
		throw new Error("Loaded project hard constraints are unavailable for isolated specification roles");
	const cwd = await fs.realpath(args.cwd);
	const currentModel = formatModelStringWithRouting(session.model);
	const deps = buildRunnerDeps(session, settings, cwd);
	const lifetime = new AbortController();
	const runId = crypto.randomUUID();
	const actors = new Map<SpecStageRole, SpecActor>();
	const actorPending = new Map<SpecStageRole, Promise<SpecActor>>();
	const pending = new Set<Promise<unknown>>();
	const startedAt = Date.now();
	const requests: SpecRequestMeasurement[] = [];
	let requestText = "";
	let store: SpecArtifactStore | undefined;
	let disposed = false;
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
	const tracked = async <T>(operation: Promise<T>): Promise<T> => {
		pending.add(operation);
		try {
			return await operation;
		} finally {
			pending.delete(operation);
		}
	};
	const getActor = async (role: SpecStageRole): Promise<SpecActor> => {
		const existing = actors.get(role);
		if (existing) return existing;
		const creating = actorPending.get(role);
		if (creating) return creating;
		const operation = (async () => {
			const skills = role === "planner" ? [await loadSpecDrivenSkill("superpowers", "writing-plans")] : [];
			const methods = await Promise.all(skills.map(skill => fs.readFile(skill.filePath, "utf8")));
			if (role === "requirements") {
				for (const artifact of ["proposal", "specs"]) {
					const instruction = await runOpenSpec(
						["instructions", artifact, "--change", requireStore().changeId, "--json"],
						cwd,
						lifetime.signal,
					);
					if (instruction.exitCode !== 0)
						throw new Error(
							`OpenSpec ${artifact} instructions failed: ${instruction.stdout}\n${instruction.stderr}`,
						);
					methods.push(instruction.stdout);
				}
			}
			const executor = role === "executor";
			const actor = await createSpecActor({
				role,
				methods,
				sessionDirectory: await containedSpecPath(cwd, `.omp/spec-sessions/${runId}/sessions`),
				options: {
					cwd,
					settings: settings.overlay(),
					model: session.model,
					modelRegistry: session.modelRegistry,
					authStorage: deps.authStorage,
					getApiKey: deps.getApiKey,
					asyncJobManager: session.asyncJobManager,
					parentAgentId: session.getAgentId(),
					eventBus: deps.eventBus,
					subagentEventBus: deps.subagentEventBus,
					contextFiles: loadedContext.contextFiles ? [...loadedContext.contextFiles] : [],
					rules: loadedContext.activeRules ? [...loadedContext.activeRules] : [],
					skills: executor ? [...session.skills] : skills,
					promptTemplates: [],
					spawns: executor ? "*" : "",
					hasUI: false,
					toolNames: executor
						? ["read", "grep", "glob", "write", "edit", "bash", "task"]
						: [
								"read",
								"grep",
								"glob",
								"write",
								"edit",
								...(role === "requirements" || role === "solution" ? ["wiki"] : []),
							],
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					disableExtensionDiscovery: true,
				},
				onSessionCreated(child) {
					const grants = skills.map(skill => grantSpecSkillAccess(child.sessionManager, skill));
					let requestStarted = Date.now();
					const unsubscribe = child.subscribe(event => {
						if (event.type === "message_start") requestStarted = Date.now();
						if (event.type !== "message_end" || event.message.role !== "assistant") return;
						const usage = object(event.message.usage);
						requests.push({
							id: crypto.randomUUID(),
							node: role,
							model: currentModel,
							startedAt: requestStarted,
							endedAt: Date.now(),
							inputTokens: observedNumber(usage?.input),
							outputTokens: observedNumber(usage?.output),
							cacheReadTokens: observedNumber(usage?.cacheRead),
							cacheWriteTokens: observedNumber(usage?.cacheWrite),
							cost: specRequestCost(usage?.cost),
							evidence: `session:${child.sessionId}`,
						});
					});
					return () => {
						unsubscribe();
						for (const release of grants) release();
					};
				},
			});
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
	const ports: SpecDrivenPorts = {
		agents: {
			recipient(role) {
				const actor = actors.get(role);
				return actor ? { role, actorId: actor.id, sessionId: actor.session.sessionId } : undefined;
			},
			async run(input, context) {
				const ctx = contextFor(context);
				return tracked(
					(async () => {
						const actor = await getActor(input.role);
						ctx.signal.throwIfAborted();
						args.onRequest?.();
						requestText ||= input.request;
						let files = input.files;
						if (input.role === "requirements" && !requireStore().native && !files.length)
							files = await requireStore().readAuthorityDocuments();
						let teamResult: TeamRunResult | undefined;
						if (input.role === "solution" && input.useTeam) {
							const members = resolveTeamParticipantsForSession(session, settings);
							if (!members.ok) throw new Error(members.error);
							// All Team descendants belong to the persistent solution producer.
							const runner = createTeamSubagentRunner({
								...buildRunnerDeps(actor.session, settings, cwd),
								parentAgentId: actor.id,
								isCurrentSession: () => !disposed && !ctx.signal.aborted && !actor.session.isDisposed,
							});
							teamResult = await runTeamDiscussion({
								question: JSON.stringify({ ...input, files }, null, 2),
								cwd,
								participants: members.participants,
								sessionModelPattern: currentModel,
								runner,
								signal: ctx.signal,
								maxConcurrency: cfgTaskMaxConcurrency.get(settings),
								onProgress(update) {
									if (!ctx.signal.aborted) void args.onOutput?.(update.text);
								},
							});
							ctx.signal.throwIfAborted();
							if (teamResult.status !== "completed")
								throw new Error(`Team ${teamResult.status}: ${teamResult.failureReason ?? "讨论未成功完成"}`);
							if (!teamResult.candidates.some(candidate => candidate.adoptable))
								throw new Error("Team 未产生可采用候选；不能退回单代理方案");
						}
						const reply = await actor.request({ ...input, files }, ctx, teamResult);
						if (teamResult && !input.readOnly) {
							const solution = await requireStore().readSolution();
							for (const candidate of solution.candidates) {
								const source = teamResult.candidates.find(item => item.id === candidate.id);
								if (!source?.adoptable || !candidate.content.includes(source.proposal))
									throw new Error(`Team 候选 ${candidate.id} 未获采用资格或未保留完整获审方案`);
							}
						}
						ctx.signal.throwIfAborted();
						if (reply.text) await args.onOutput?.(reply.text);
						return reply;
					})(),
				);
			},
		},
		artifacts: {
			async initialize(changeId, context) {
				contextFor(context);
				if (store) throw new Error("Specification artifacts are already initialized");
				store = new SpecArtifactStore({ cwd, changeId, requirementsDir: await requirementsAuthority(cwd) });
				const paths = await store.initialize();
				contextFor(context);
				return paths;
			},
			async readRequirements(context) {
				return requireStore().readRequirements(contextFor(context).signal);
			},
			async readSolution(context) {
				contextFor(context);
				return requireStore().readSolution();
			},
			async readPlan(context) {
				contextFor(context);
				return requireStore().readPlan();
			},
			async readReport(context) {
				contextFor(context);
				return requireStore().readReport();
			},
			async close(input, context) {
				return tracked(requireStore().close(input, contextFor(context).signal));
			},
		},
	};
	return {
		ports,
		options: { currentModel, runId },
		async dispose() {
			if (disposed) return;
			disposed = true;
			lifetime.abort();
			await Promise.allSettled(pending);
			await Promise.allSettled(actorPending.values());
			await Promise.all([...actors.values()].map(actor => actor.dispose()));
		},
		measurement() {
			return structuredClone({
				task: requestText,
				codeBaseline: "",
				modelConfiguration: JSON.stringify({ currentModel }),
				acceptanceCriteria: "",
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
