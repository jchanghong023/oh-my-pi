import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { loadSessionFile, readSessionHeaderId, type SessionLoadResult } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { buildRunnerDeps, resolveTeamParticipantsForSession } from "../team/controller";
import { followMCPTools } from "../task/executor";
import { cfgTaskMaxConcurrency } from "../task/settings";
import { runTeamDiscussion } from "../team/orchestrator";
import { createTeamSubagentRunner } from "../team/runner";
import type { TeamRunResult } from "../team/types";
import { artifactVersion, containedSpecPath, formalMaterialPaths, SpecArtifactStore } from "./artifacts";
import { createSpecActor, specSolutionBasisFromHistory, type SpecActor, type SpecNativeToolBoundary } from "./actors";
import { assertDevSpecSchema, ensureSpecDrivenResources, loadSpecDrivenSkill, runOpenSpecDirectory } from "./resources";
import { exposeSpecExecutionSkill, grantSpecExecutionSkills, grantSpecSkillAccess } from "./skill-policy";
import type {
	DevRequirementRecord,
	DevSolutionBasis,
	SpecSolution,
	SpecAgentInput,
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
	solutionBasis(): Promise<DevSolutionBasis | null>;
	prepareConversation(input: SpecAgentInput, context: SpecRunContext): Promise<void>;
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
	getRecord?: () => DevRequirementRecord | undefined;
	repairPaths?: () => readonly string[] | undefined;
	createInteractionUI?: CreateAgentSessionOptions["createInteractionUI"];
	uiForSession?: (session: AgentSession) => ExtensionUIContext;
	getSavedRun?: () => SpecSavedRun | undefined;
	observeReport?: () => void | Promise<void>;
	beginRepair?: () => Promise<void>;
	onToolStart?: (event: SpecNativeToolBoundary) => Promise<void>;
	onToolEnd?: (event: SpecNativeToolBoundary & { isError: boolean }) => Promise<void>;
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
	const recoveredActors = new Set<SpecStageRole>();
	const preparing = new Map<SpecStageRole, Promise<SpecActor>>();
	let disposed = false;
	let restoredOriginalRequest = "";
	const businessSessionFile = args.saved?.sessions.business?.sessionFile;
	if (businessSessionFile) {
		try {
			const history = await loadSessionFile(businessSessionFile, undefined, { throwIfMissing: true });
			if (
				!history.invalidHeader &&
				!history.malformedRecords &&
				history.entries.some(entry => entry.type === "custom" && entry.customType === "dev-original-interview") &&
				!history.entries.some(
					entry => entry.type === "custom_message" && entry.customType === "dev-history-recovery",
				)
			) {
				const first = history.entries.find(entry => entry.type === "message" && entry.message.role === "user");
				if (first?.type === "message" && first.message.role === "user") {
					const content = first.message.content;
					restoredOriginalRequest =
						typeof content === "string"
							? content
							: content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n");
				}
			}
		} catch (error) {
			if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
		}
	}
	let pendingTeam:
		| { session: AgentSession; controller: AbortController; settled: PromiseWithResolvers<void> }
		| undefined;
	let store = args.saved?.changeId
		? new SpecArtifactStore({
				cwd,
				changeId: args.saved.changeId,
				requirementsDir: await requirementsAuthority(cwd),
				paths: args.saved.paths,
				archivedChangePath: args.saved.closing?.archivedChangePath ?? args.saved.archivedChangePath,
			})
		: undefined;
	const requireStore = () => {
		if (!store) throw new Error("Dev artifacts are not initialized");
		const saved = args.getSavedRun?.() ?? args.saved;
		const archivedChangePath =
			saved?.closing?.archivedChangePath ??
			saved?.archivedChangePath ??
			args.getRecord?.()?.syncRevisions.findLast(revision => revision.archivedChangePath)?.archivedChangePath;
		if (archivedChangePath && store.archivedChangePath !== archivedChangePath) {
			store = new SpecArtifactStore({
				cwd,
				changeId: store.changeId,
				requirementsDir: store.requirementsDir,
				planPath: store.planPath,
				paths: saved?.paths ?? store.paths,
				archivedChangePath,
			});
		}
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
		const record = args.getRecord?.();
		const materials: Array<{ path: string; content?: string; version?: string; error?: string }> = [];
		if (saved?.paths && saved.changeId) {
			try {
				const paths =
					saved.phase === "business"
						? saved.paths.business
							? [saved.paths.business]
							: []
						: await formalMaterialPaths(
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
			record: record ?? null,
			originalRequestAvailable: false,
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
				role === "business" || role === "requirements"
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
					const history = await loadSessionFile(sessionFile, undefined, { throwIfMissing: true });
					if (
						history.invalidHeader ||
						history.malformedRecords > 0 ||
						history.entries.length === 0 ||
						!(await readSessionHeaderId(sessionFile))
					)
						sessionFile = undefined;
				} catch (error) {
					if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
					sessionFile = undefined;
				}
			}
			const missingHistory = !!(saved || args.saved) && !sessionFile;
			if (missingHistory) recoveredActors.add(role);
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
			// Subscribe before taking the snapshot so changes during actor creation
			// are replayed, without transferring ownership of the parent's manager.
			const capabilities = session.nativeChildCapabilities;
			const inheritedMcpManager =
				executor && capabilities?.enableMCP !== false && !capabilities?.restrictToolNames
					? capabilities?.mcpManager
					: undefined;
			const nativeSessionDirectory =
				session.sessionManager.getSessionDir() || SessionManager.getDefaultSessionDir(cwd, settings.getAgentDir());
			const sessionDirectory = path.join(nativeSessionDirectory, `spec-${encodeURIComponent(runId)}`);
			const sessionManager = await SessionManager.open(
				sessionFile ?? path.join(sessionDirectory, `${role}-${crypto.randomUUID()}.jsonl`),
				sessionDirectory,
				undefined,
				{
					initialCwd: cwd,
					parentSession: session.sessionFile ?? session.sessionId,
					suppressBreadcrumb: true,
				},
			);
			const mcpFollower = inheritedMcpManager
				? followMCPTools(
						inheritedMcpManager,
						{ scope: sessionManager.getSessionId(), seed: capabilities?.mcpToolScope },
						new Set(capabilities?.customTools?.map(tool => tool.name)),
					)
				: undefined;
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
									const result = await runOpenSpecDirectory(
										"instructions-directory",
										{
											changeDir: await containedSpecPath(cwd, await requireStore().resolveChangeDirectory()),
											projectRoot: cwd,
											changeName: requireStore().changeId,
											artifactId: artifact,
											schema: "omp-spec",
										},
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
				sessionDirectory,
				checkApproved: args.checkApproved,
				getStatus: args.getStatus,
				getRecord: args.getRecord,
				repairPaths: args.repairPaths,
				uiForSession: args.uiForSession,
				solutionPath:
					role === "solution"
						? (args.saved?.paths?.solution ?? requireStore().planPath.replace(/\.md$/, "-solutions.json"))
						: undefined,
				observeReport: args.observeReport,
				beginRepair: args.beginRepair,
				onToolStart: args.onToolStart,
				onToolEnd: args.onToolEnd,
				recoverContext: missingHistory ? () => recoveryContext(role, saved?.sessionFile) : undefined,
				reportPath: executor
					? (args.saved?.paths?.report ?? requireStore().planPath.replace(/\.md$/, "-completion.md"))
					: undefined,
				options: {
					cwd,
					sessionManager,
					settings: settings.overlay(),
					model: sessionFile ? undefined : session.model,
					modelRegistry: session.modelRegistry,
					authStorage: deps.authStorage,
					getApiKey: deps.getApiKey,
					asyncJobManager: session.asyncJobManager,
					parentAgentId: session.getAgentId(),
					eventBus: deps.eventBus,
					subagentEventBus: deps.subagentEventBus,
					additionalDirectories: session.sessionManager.getAdditionalDirectories(),
					...(executor
						? {
								...session.nativeChildCapabilities,
								mcpTools:
									capabilities?.enableMCP === false || capabilities?.restrictToolNames
										? undefined
										: (mcpFollower?.proxyTools() ?? capabilities?.mcpTools),
								mcpToolScope: mcpFollower?.scope,
							}
						: {}),
					extensionRoots: () => session.effectiveExtensionRoots,
					preloadedPreparedExtensions: session.preparedExtensions?.filter(prepared =>
						session.extensionRunner?.isExtensionActive(prepared.path),
					),
					preloadedExtensionPaths:
						session.extensionPaths?.filter(extensionPath =>
							session.extensionRunner
								?.getLoadedExtensions()
								.some(
									extension =>
										(extension.path === extensionPath || extension.resolvedPath === extensionPath) &&
										session.extensionRunner?.isExtensionActive(extension.path),
								),
						) ?? [],
					extensionProviderOwnership: "inherited",
					contextFiles: [...(loadedContext.contextFiles ?? [])],
					rules: [...(loadedContext.activeRules ?? [])],
					skills: executor
						? executionSkills
						: [
								...session.skills,
								...skills.filter(skill => !session.skills.some(existing => existing.name === skill.name)),
							],
					promptTemplates: [...session.promptTemplates],
					slashCommands: [...session.slashCommands],
					spawns: executor ? "*" : role === "business" ? "" : "scout",
					createInteractionUI: args.createInteractionUI,
					interactionParentSessionId: session.sessionId,
					interactivePrompts: !!args.createInteractionUI || !!args.uiForSession,
					hasUI: false,
					...(executor
						? {}
						: {
								toolNames: [
									"read",
									"grep",
									"glob",
									"write",
									"edit",
									"task",
									...(role === "requirements"
										? ["knowledge_search", "ask"]
										: role === "solution"
											? ["knowledge_search"]
											: []),
								],
								restrictToolNames: true,
								enableMCP: false,
								enableLsp: false,
								enableIrc: false,
								disableExtensionDiscovery: true,
							}),
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
			}).catch(error => {
				mcpFollower?.dispose();
				throw error;
			});
			mcpFollower?.bind(actor.session);
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
		const business = actors.get("business");
		if (!business) return restoredOriginalRequest;
		const history = business.session.sessionManager.getEntries();
		if (!history.some(entry => entry.type === "custom" && entry.customType === "dev-original-interview")) return "";
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
		return restoredOriginalRequest;
	};
	const basisFor = async (solution: SpecSolution): Promise<DevSolutionBasis> => {
		const actor = actors.get("solution");
		if (actor && !recoveredActors.has("solution")) return actor.solutionBasis(solution);
		const saved = (args.getSavedRun?.() ?? args.saved)?.sessions.solution;
		if (!actor && saved?.sessionFile) {
			let history: SessionLoadResult | undefined;
			let sessionId: string | undefined;
			try {
				history = await loadSessionFile(saved.sessionFile, undefined, { throwIfMissing: true });
				sessionId = await readSessionHeaderId(saved.sessionFile);
			} catch (error) {
				if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
			}
			if (history && !history.invalidHeader && !history.malformedRecords && history.entries.length && sessionId)
				return specSolutionBasisFromHistory(solution, sessionId, history.entries);
		}
		const basis = args.getRecord?.()?.solutionBasis;
		if (
			!basis ||
			basis.solutionVersion !== solution.version ||
			solution.candidates.length !== basis.candidateIds.length ||
			solution.candidates.some(
				candidate => !basis.candidateIds.includes(candidate.id) || !basis.usableCandidateIds.includes(candidate.id),
			)
		)
			throw new Error("当前方案缺少与实际字节版本绑定的真实来源证明；请返回需求阶段并重新进入方案。");
		return structuredClone(basis);
	};
	const prepareConversation = async (input: SpecAgentInput, context: SpecRunContext): Promise<void> => {
		const ctx = contextFor(context);
		const actor = await getActor(input.role);
		let outputPaths = input.outputPaths;
		if (input.role === "requirements") {
			const activeDirectory = `openspec/changes/${requireStore().changeId}`;
			const actualDirectory = await requireStore().resolveChangeDirectory();
			outputPaths = outputPaths.map(file =>
				file.startsWith(`${activeDirectory}/`)
					? `${actualDirectory}/${file.slice(activeDirectory.length + 1)}`
					: file,
			);
		}
		const operation = actor.prepareConversation({ ...input, outputPaths }, ctx);
		active.add(operation);
		try {
			await operation;
			ctx.signal.throwIfAborted();
		} finally {
			active.delete(operation);
		}
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
			async solutionBasis(solution) {
				return basisFor(solution);
			},
			prepareConversation,
			async run(input, context) {
				const ctx = contextFor(context);
				const actor = await getActor(input.role);
				ctx.signal.throwIfAborted();
				const operation = (async () => {
					let files = input.files;
					let outputPaths = input.outputPaths;
					if (input.role === "requirements") {
						const activeDirectory = `openspec/changes/${requireStore().changeId}`;
						const actualDirectory = await requireStore().resolveChangeDirectory();
						outputPaths = outputPaths.map(file =>
							file.startsWith(`${activeDirectory}/`)
								? `${actualDirectory}/${file.slice(activeDirectory.length + 1)}`
								: file,
						);
					}
					if (input.entry && input.role === "requirements" && !requireStore().native) {
						const authority = await requireStore().readAuthorityDocuments();
						const paths = new Set<string>();
						files = [];
						for (const file of [...input.files, ...authority]) {
							const realPath = await containedSpecPath(cwd, file.path);
							if (paths.has(realPath)) continue;
							paths.add(realPath);
							files.push(file);
						}
					}
					let teamResult: TeamRunResult | undefined;
					if (input.entry && input.role === "solution") {
						actor.beginSolutionAttempt(ctx);
						recoveredActors.delete("solution");
					}
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
								extensionProviderOwnership: "inherited",
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
					const result = await actor.request({ ...input, files, outputPaths }, ctx, teamResult);
					if (input.entry) recoveredActors.delete(input.role);
					return result;
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
			async initialize(changeId, context, businessPath) {
				contextFor(context);
				if (store && (businessPath || store.changeId !== changeId))
					throw new Error("Dev artifacts already initialized");
				if (!store) {
					const requirementsDir = await requirementsAuthority(cwd);
					store = new SpecArtifactStore({ cwd, changeId, requirementsDir });
					const paths = await store.initialize(businessPath);
					if (businessPath) store = new SpecArtifactStore({ cwd, changeId, requirementsDir, paths });
					return paths;
				}
				return store.initialize();
			},
			async readBusiness(context) {
				contextFor(context);
				return requireStore().readBusiness();
			},
			async readRequirements(context) {
				return requireStore().readRequirements(contextFor(context).signal);
			},
			async readSolution(context) {
				contextFor(context);
				const solution = await requireStore().readSolution();
				await basisFor(solution);
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
		prepareConversation,
		async solutionBasis() {
			if (!store) return null;
			const solution = await store.readSolution();
			return basisFor(solution);
		},
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
			await Promise.allSettled(preparing.values());
			const stopped = await Promise.allSettled([...actors.values()].map(actor => actor.stop()));
			await Promise.allSettled(active);
			const failure = stopped.find(result => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			lifetime = new AbortController();
		},
		async dispose() {
			if (disposed) return;
			lifetime.abort();
			await Promise.allSettled(preparing.values());
			const stopped = await Promise.allSettled([...actors.values()].map(actor => actor.dispose()));
			await Promise.allSettled(active);
			const failure = stopped.find(result => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			disposed = true;
		},
	};
}
