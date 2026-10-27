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
import { artifactVersion, containedSpecPath, formalMaterialPaths, SpecArtifactStore } from "./artifacts";
import { createSpecActor, type SpecActor } from "./actors";
import { assertDevSpecSchema, ensureSpecDrivenResources, loadSpecDrivenSkill, runOpenSpec } from "./resources";
import { exposeSpecExecutionSkill, grantSpecExecutionSkills, grantSpecSkillAccess } from "./skill-policy";
import type {
	SpecConversationRecipient,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecRunContext,
	SpecSavedRun,
	SpecStageRole,
} from "./types";

export interface SpecDrivenRuntime {
	ports: SpecDrivenPorts;
	options: { runId: string };
	nativeSession(role: SpecStageRole): AgentSession | undefined;
	sessionRefs(): SpecSavedRun["sessions"];
	originalRequest(): string;
	hasPendingTeam(session: AgentSession): boolean;
	interruptTeam(session: AgentSession): Promise<boolean>;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}
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
	saved?: SpecSavedRun;
	checkApproved?: () => Promise<unknown>;
	getStatus?: () => SpecDrivenStatus | undefined;
	getSavedRun?: () => SpecSavedRun | undefined;
	observeReport?: () => void | Promise<void>;
	beginRepair?: () => Promise<void>;
	onSessionCreated?: (role: SpecStageRole, session: AgentSession) => void;
}): Promise<SpecDrivenRuntime> {
	const { session, settings } = args;
	if (!session.asyncJobManager) throw new Error("Dev requires the owning SDK AsyncJobManager");
	const loadedContext = session.loadedProjectContext;
	if (!loadedContext) throw new Error("Loaded project hard constraints are unavailable for Dev roles");
	const cwd = await fs.realpath(args.cwd);
	const deps = buildRunnerDeps(session, settings, cwd);
	let lifetime = new AbortController();
	const active = new Set<Promise<unknown>>();
	const runId = args.saved?.runId ?? crypto.randomUUID();
	const actors = new Map<SpecStageRole, SpecActor>();
	const preparing = new Map<SpecStageRole, Promise<SpecActor>>();
	let disposed = false;
	let pendingTeam:
		| { session: AgentSession; controller: AbortController; settled: PromiseWithResolvers<void> }
		| undefined;
	let store = args.saved?.changeId
		? new SpecArtifactStore({
				cwd,
				changeId: args.saved.changeId,
				requirementsDir: await requirementsAuthority(cwd),
				paths: args.saved.paths,
			})
		: undefined;
	const requireStore = () => {
		if (!store) throw new Error("Dev artifacts are not initialized");
		return store;
	};
	const contextFor = (context: SpecRunContext): SpecRunContext => {
		if (disposed) throw new Error("Dev runtime disposed");
		const signal = AbortSignal.any([context.signal, lifetime.signal]);
		signal.throwIfAborted();
		return { ...context, signal };
	};
	const recoveryContext = async (role: SpecStageRole, sessionFile?: string): Promise<string> => {
		const saved = args.getSavedRun?.() ?? args.saved;
		const materials: Array<{ path: string; content?: string; version?: string; error?: string }> = [];
		if (saved?.paths && saved.changeId) {
			try {
				const paths = await formalMaterialPaths(
					cwd,
					saved.paths,
					saved.changeId,
					saved.closing?.archivedChangePath ?? saved.archivedChangePath,
				);
				for (const file of paths) {
					try {
						const bytes = await fs.readFile(await containedSpecPath(cwd, file));
						materials.push({ path: file, content: bytes.toString("utf8"), version: artifactVersion(bytes) });
					} catch (error) {
						materials.push({ path: file, error: error instanceof Error ? error.message : String(error) });
					}
				}
			} catch (error) {
				materials.push({ path: "formal materials", error: error instanceof Error ? error.message : String(error) });
			}
		}
		return JSON.stringify({
			notice:
				"原生聊天历史不可用；不记得缺失的对话。以下仅为当前真实正式文件和已保存的原始批准，不是新的阶段进入或批准。缺失产物不阻止本阶段澄清，结构门禁仍仅在 next。",
			role,
			unavailableSessionFile: sessionFile ?? null,
			phase: saved?.phase,
			paths: saved?.paths,
			approvals: saved?.approvals ?? {},
			materials,
		});
	};
	const getActor = async (role: SpecStageRole, saved = args.saved?.sessions[role]): Promise<SpecActor> => {
		const existing = actors.get(role);
		if (existing) return existing;
		const pending = preparing.get(role);
		if (pending) return pending;
		const operation = (async () => {
			const skills =
				role === "requirements"
					? [await loadSpecDrivenSkill("jch", "jch-grill-me")]
					: role === "planner"
						? [await loadSpecDrivenSkill("superpowers", "writing-plans")]
						: role === "executor"
							? [
									await loadSpecDrivenSkill("superpowers", "using-superpowers"),
									await loadSpecDrivenSkill("superpowers", "subagent-driven-development"),
								]
							: [];
			const methods = await Promise.all(
				skills.map(async skill => {
					const content = await fs.readFile(skill.filePath, "utf8");
					if (role !== "planner") return content;
					const handoff = content.indexOf("\n## Execution Handoff");
					if (handoff < 0) throw new Error("writing-plans execution handoff section is missing");
					return content.slice(0, handoff);
				}),
			);
			let sessionFile = saved?.sessionFile;
			if (sessionFile) {
				try {
					await fs.stat(sessionFile);
				} catch (error) {
					if (!isEnoent(error)) throw error;
					sessionFile = undefined;
				}
			}
			const missingHistory = !!(saved || args.saved) && !sessionFile;
			const executor = role === "executor";
			const executionResources = executor
				? await Promise.all(
						(await ensureSpecDrivenResources()).manifest.skills
							.filter(entry => entry.source === "superpowers")
							.map(entry => loadSpecDrivenSkill("superpowers", entry.name)),
					)
				: [];
			const executionSkills = [...session.skills];
			const executionPaths = executor
				? await Promise.all(
						executionSkills.map(skill =>
							skill.source === "bundled-superpowers" ||
							(skill._source?.provider === "spec-driven" && skill._source.pluginName === "superpowers")
								? fs.realpath(skill.filePath)
								: undefined,
						),
					)
				: [];
			const executionGrants = executionResources.map(resource => {
				const existing = executionPaths.indexOf(resource.filePath);
				if (existing >= 0) {
					const visible = exposeSpecExecutionSkill(executionSkills[existing]);
					executionSkills[existing] = visible;
					return visible;
				}
				let name = resource.name;
				if (executionSkills.some(skill => skill.name === name)) {
					name = `superpowers/${name}`;
					const base = name;
					let suffix = 2;
					while (executionSkills.some(skill => skill.name === name)) name = `${base}~${suffix++}`;
				}
				const visible = exposeSpecExecutionSkill({ ...resource, name });
				executionSkills.push(visible);
				return visible;
			});
			const actor = await createSpecActor({
				role,
				methods,
				sessionFile,
				entryMethods:
					role === "requirements"
						? async () => {
								await assertDevSpecSchema(cwd, lifetime.signal);
								const instructions: string[] = [];
								for (const artifact of ["proposal", "specs"]) {
									const result = await runOpenSpec(
										[
											"instructions",
											artifact,
											"--change",
											requireStore().changeId,
											"--schema",
											"omp-spec",
											"--json",
										],
										cwd,
										lifetime.signal,
									);
									if (result.exitCode !== 0)
										throw new Error(
											`OpenSpec ${artifact} instructions failed: ${result.stdout}\n${result.stderr}`,
										);
									instructions.push(result.stdout);
								}
								return instructions;
							}
						: undefined,
				sessionDirectory: await containedSpecPath(cwd, `.omp/dev/sessions/${runId}`),
				checkApproved: args.checkApproved,
				getStatus: args.getStatus,
				observeReport: args.observeReport,
				beginRepair: args.beginRepair,
				recoverContext: missingHistory ? () => recoveryContext(role, saved?.sessionFile) : undefined,
				reportPath: args.saved?.paths?.report ?? requireStore().planPath.replace(/\.md$/, "-completion.md"),
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
					contextFiles: [...(loadedContext.contextFiles ?? [])],
					rules: [...(loadedContext.activeRules ?? [])],
					skills: executor ? executionSkills : skills,
					promptTemplates: [],
					spawns: executor ? "*" : "scout",
					hasUI: false,
					toolNames: executor
						? ["read", "grep", "glob", "write", "edit", "bash", "task"]
						: [
								"read",
								"grep",
								"glob",
								"write",
								"edit",
								"task",
								...(role === "requirements" || role === "solution" ? ["wiki"] : []),
							],
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					disableExtensionDiscovery: true,
				},
				executionSkills: executor ? executionGrants : undefined,
				onSessionCreated(child) {
					const grants = executor
						? [grantSpecExecutionSkills(child.sessionManager, executionGrants)]
						: skills.map(skill => grantSpecSkillAccess(child.sessionManager, skill));
					try {
						args.onSessionCreated?.(role, child);
					} catch (error) {
						for (const release of grants) release();
						throw error;
					}
					return () => {
						for (const release of grants) release();
					};
				},
			});
			actors.set(role, actor);
			return actor;
		})();
		preparing.set(role, operation);
		try {
			return await operation;
		} finally {
			preparing.delete(role);
		}
	};
	const recipient = (role: SpecStageRole): SpecConversationRecipient | undefined => {
		const actor = actors.get(role);
		return actor
			? { role, actorId: actor.id, sessionId: actor.session.sessionId, sessionFile: actor.session.sessionFile }
			: undefined;
	};
	const originalRequest = () => {
		const history = actors.get("requirements")?.session.sessionManager.getEntries() ?? [];
		// A recovery continuation is not the lost original request, including after reopening.
		if (history.some(entry => entry.type === "custom_message" && entry.customType === "dev-history-recovery"))
			return "";
		for (const entry of history) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(item => item.type === "text")
							.map(item => item.text)
							.join("\n");
			return text;
		}
		return "";
	};
	const ports: SpecDrivenPorts = {
		agents: {
			async prepare(role, context, saved) {
				contextFor(context);
				await getActor(role, saved);
				contextFor(context);
			},
			recipient,
			originalRequest,
			async run(input, context) {
				const ctx = contextFor(context);
				const actor = await getActor(input.role);
				ctx.signal.throwIfAborted();
				const operation = (async () => {
					let files = input.files;
					if (input.entry && input.role === "requirements" && !requireStore().native && !files.length)
						files = await requireStore().readAuthorityDocuments();
					let teamResult: TeamRunResult | undefined;
					if (input.entry && input.role === "solution" && input.useTeam) {
						const approved = await args.checkApproved?.();
						if (approved && typeof approved === "object" && "matches" in approved && !approved.matches)
							throw new Error("正式批准版本已变化");
						const members = resolveTeamParticipantsForSession(actor.session, actor.session.settings);
						if (!members.ok) throw new Error(members.error);
						if (!actor.session.model) throw new Error("Team requires a current model");
						const team = {
							session: actor.session,
							controller: new AbortController(),
							settled: Promise.withResolvers<void>(),
						};
						const teamSignal = AbortSignal.any([ctx.signal, team.controller.signal]);
						pendingTeam = team;
						try {
							const runner = createTeamSubagentRunner({
								...buildRunnerDeps(actor.session, actor.session.settings, cwd),
								parentAgentId: actor.id,
								isCurrentSession: () => !disposed && !teamSignal.aborted && !actor.session.isDisposed,
							});
							teamResult = await runTeamDiscussion({
								question: JSON.stringify({ ...input, files }, null, 2),
								cwd,
								participants: members.participants,
								sessionModelPattern: formatModelStringWithRouting(actor.session.model),
								runner: async (call, signal) => {
									const approval = await args.checkApproved?.();
									if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
										throw new Error("正式批准版本已变化");
									return runner(call, signal);
								},
								signal: teamSignal,
								maxConcurrency: cfgTaskMaxConcurrency.get(actor.session.settings),
							});
							teamSignal.throwIfAborted();
						} finally {
							if (pendingTeam === team) pendingTeam = undefined;
							team.settled.resolve();
						}
						ctx.signal.throwIfAborted();
						if (teamResult.status !== "completed")
							throw new Error(`Team ${teamResult.status}: ${teamResult.failureReason ?? "讨论未成功完成"}`);
						if (!teamResult.candidates.some(candidate => candidate.adoptable))
							throw new Error("Team 未产生可采用候选");
					}
					return actor.request({ ...input, files }, ctx, teamResult);
				})();
				active.add(operation);
				try {
					return await operation;
				} finally {
					active.delete(operation);
				}
			},
		},
		artifacts: {
			async initialize(changeId, context) {
				contextFor(context);
				if (store) throw new Error("Dev artifacts already initialized");
				store = new SpecArtifactStore({ cwd, changeId, requirementsDir: await requirementsAuthority(cwd) });
				return store.initialize();
			},
			async readRequirements(context) {
				return requireStore().readRequirements(contextFor(context).signal);
			},
			async readSolution(context) {
				contextFor(context);
				const solution = await requireStore().readSolution();
				const actor = await getActor("solution");
				actor.checkSolutionCandidates(solution.candidates);
				return solution;
			},
			async readPlan(context) {
				contextFor(context);
				return requireStore().readPlan();
			},
			async readReport(context) {
				contextFor(context);
				return requireStore().readReport();
			},
			async checkVersions(files, archivedChangePath) {
				return requireStore().checkVersions(files, archivedChangePath);
			},
			async close(input, context) {
				return requireStore().close(input, contextFor(context).signal);
			},
		},
	};
	return {
		ports,
		options: { runId },
		nativeSession: role => actors.get(role)?.session,
		sessionRefs() {
			return Object.fromEntries([...actors.keys()].map(role => [role, recipient(role)]));
		},
		originalRequest,
		hasPendingTeam: owner => pendingTeam?.session === owner,
		async interruptTeam(owner) {
			const team = pendingTeam;
			if (!team || team.session !== owner) return false;
			team.controller.abort(new Error("Team discussion interrupted"));
			await team.settled.promise;
			return true;
		},
		async stop() {
			lifetime.abort();
			await Promise.all(preparing.values());
			await Promise.all([...actors.values()].map(actor => actor.stop()));
			await Promise.allSettled(active);
			lifetime = new AbortController();
		},
		async dispose() {
			if (disposed) return;
			lifetime.abort();
			await Promise.all(preparing.values());
			await Promise.all([...actors.values()].map(actor => actor.dispose()));
			await Promise.allSettled(active);
			disposed = true;
		},
	};
}
