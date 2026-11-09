import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { cfgGoalEnabled } from "../goals/settings";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import {
	artifactVersion,
	containedSpecPath,
	importDevBusiness,
	readDevMaterial,
	resolveDevMaterials,
	SpecArtifactStore,
} from "./artifacts";
import { DevCancellationService } from "./cancel";
import { devRepositoryIdentity, DevForgeService } from "./forge";
import { DevGitService, type DevGitServiceOptions } from "./git";
import { syncDevRequirement } from "./native-sync";
import { hasExplicitRepairIntent, hasPendingDevSync, SpecAdmissionError, SpecDrivenOrchestrator } from "./orchestrator";
import {
	allocateDevRequirementId,
	devRequirementPath,
	loadDevRequirements,
	readDevRequirement,
	resolveDevOperationCommit,
} from "./records";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "./runtime";
import { roleForDevStage } from "./stages";
import type {
	DevAction,
	DevActionIntent,
	DevActionPreview,
	DevActionResult,
	DevCancelPlan,
	DevDecision,
	DevGitAction,
	DevGitTarget,
	DevMaterialRef,
	DevPerson,
	DevPrFact,
	DevRequirementRecord,
	DevRequirementSnapshot,
	DevRuntimeState,
	DevSessionTarget,
	DevStage,
	DevStoredRequirement,
	DevSyncRevision,
	SpecArtifactPaths,
	SpecCloseProgress,
	SpecConversationRecipient,
	SpecDocument,
	SpecFileVersion,
	SpecSavedRun,
} from "./types";
import { DevWorkspace } from "./workspace";

export type SpecRuntimeFactory = typeof createSpecDrivenRuntime;
export interface SpecControllerDependencies {
	createGit?: (options: DevGitServiceOptions) => DevGitService;
}
export interface SpecDrivenHost {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	createInteractionUI?: CreateAgentSessionOptions["createInteractionUI"];
	uiForSession?: (session: AgentSession) => ExtensionUIContext;
}
interface OwnedRuntime {
	core: SpecDrivenOrchestrator;
	native: SpecDrivenRuntime;
	stored: DevStoredRequirement;
	execution: DevRuntimeState["execution"];
	history: DevRuntimeState["history"];
	blockedReason?: string;
	stopping?: Promise<void>;
	pendingSync?: SpecCloseProgress;
	pendingGit?: string;
	observedPr?: DevPrFact;
}
interface PreparedAction {
	preview: DevActionPreview;
	cancel: DevCancelPlan | null;
	actor?: DevPerson;
	decision?: DevDecision;
	consumed: boolean;
	result?: DevActionResult;
	pending?: Promise<DevActionResult>;
	captureId?: string;
}
interface LocalBusiness {
	id: string;
	path: string;
	runtime: SpecDrivenRuntime;
	generation: number;
}
const canonicalOwners = new Map<string, SpecDrivenController>();
const defaultPerson = (): DevPerson => ({ name: process.env.USERNAME ?? process.env.USER ?? "local", source: "local" });
function generationValue(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid native generation");
	return value;
}
function nativeWorkBusy(session: AgentSession): boolean {
	return (
		session.isBusyForSnapshot ||
		session.hasAdmittedSubmission ||
		session.queuedMessageCount > 0 ||
		session.hasPostPromptWork ||
		session.hasPendingAsyncWork() ||
		session.hasUnsettledAsyncJobTree()
	);
}
function actionIntent(action: DevActionIntent): DevActionIntent {
	switch (action.kind) {
		case "next":
			return { kind: "next", ...(action.candidateId === undefined ? {} : { candidateId: action.candidateId }) };
		case "back":
			return { kind: "back" };
		case "sync-archive":
			return { kind: "sync-archive" };
		case "mark":
			return { kind: "mark", mark: action.mark };
		case "cancel":
			return { kind: "cancel" };
		case "commit":
			return { kind: "commit" };
		case "set-test-state":
			return { kind: "set-test-state", state: action.state };
		case "link-fix":
			return { kind: "link-fix", fixRequirementId: action.fixRequirementId };
		default:
			throw new SpecAdmissionError("未知业务动作");
	}
}
export function nativeBusy(session: AgentSession): boolean {
	return nativeWorkBusy(session) || session.getGoalModeState()?.enabled === true;
}
function sameVersions(left: readonly SpecFileVersion[], right: readonly SpecFileVersion[]): boolean {
	return (
		left.length === right.length && left.every(a => right.some(b => a.path === b.path && a.version === b.version))
	);
}
function teamValue(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("useTeam" in value) || typeof value.useTeam !== "boolean")
		throw new Error("Invalid saved Team configuration");
	return value.useTeam;
}
function sessionRefs(value: unknown): SpecSavedRun["sessions"] {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid native session references");
	const refs: SpecSavedRun["sessions"] = {};
	for (const role of ["business", "requirements", "solution", "planner", "executor"] as const) {
		if (!(role in value)) continue;
		const ref: unknown = Reflect.get(value, role);
		if (
			!ref ||
			typeof ref !== "object" ||
			!("role" in ref) ||
			ref.role !== role ||
			!("actorId" in ref) ||
			typeof ref.actorId !== "string" ||
			!("sessionId" in ref) ||
			typeof ref.sessionId !== "string" ||
			("sessionFile" in ref && ref.sessionFile !== undefined && typeof ref.sessionFile !== "string")
		)
			throw new Error("Invalid native session reference");
		refs[role] = {
			role,
			actorId: ref.actorId,
			sessionId: ref.sessionId,
			sessionFile: "sessionFile" in ref && typeof ref.sessionFile === "string" ? ref.sessionFile : undefined,
		};
	}
	return refs;
}
/** One canonical native owner. Reading never acquires the lease or creates actors. */
export class SpecDrivenController {
	readonly #host: SpecDrivenHost;
	readonly #factory: SpecRuntimeFactory;
	readonly #runtimes = new Map<string, OwnedRuntime>();
	readonly #listeners = new Set<(snapshot: DevRequirementSnapshot) => void>();
	readonly #sessionListeners = new Set<(session: AgentSession, requirementId: string | null) => void>();
	readonly #sessions = new Map<AgentSession, { requirementId: string | null; unsubscribe: () => void }>();
	readonly #prepared = new Map<string, PreparedAction>();
	readonly #createGit: (options: DevGitServiceOptions) => DevGitService;
	#identity: Promise<{ root: string; branch: string | null }>;
	#workspace: DevWorkspace | undefined;
	#git: DevGitService | undefined;
	#forge: DevForgeService | undefined;
	#cancel: DevCancellationService | undefined;
	#useTeam = false;
	#teamLoaded = false;
	#control = false;
	#controlSettled: PromiseWithResolvers<void> | undefined;
	#closing = false;
	#disposing: Promise<void> | undefined;
	#disposed = false;
	#local: LocalBusiness | undefined;
	constructor(
		host: SpecDrivenHost,
		factory: SpecRuntimeFactory = createSpecDrivenRuntime,
		dependencies: SpecControllerDependencies = {},
	) {
		this.#host = host;
		this.#factory = factory;
		this.#identity = DevWorkspace.resolve(host.cwd);
		this.#createGit = dependencies.createGit ?? (options => new DevGitService(options));
	}
	rootSession(): AgentSession {
		return this.#host.session;
	}
	observe(listener: (snapshot: DevRequirementSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	subscribeSessions(listener: (session: AgentSession, requirementId: string | null) => void): () => void {
		this.#sessionListeners.add(listener);
		for (const [session, owner] of this.#sessions) listener(session, owner.requirementId);
		return () => this.#sessionListeners.delete(listener);
	}
	#register(session: AgentSession, requirementId: string | null): void {
		if (this.#sessions.has(session)) return;
		const unsubscribe = session.subscribe(event => {
			if (!requirementId) return;
			const owned = this.#runtimes.get(requirementId);
			if (owned) {
				if (event.type === "agent_start") {
					owned.execution = "running";
					owned.blockedReason = undefined;
				}
				if (event.type === "agent_end" && owned.execution === "running") owned.execution = "idle";
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					(event.message.stopReason === "error" || event.message.stopReason === "aborted")
				) {
					owned.execution = event.message.stopReason === "aborted" ? "interrupted" : "failed";
					owned.blockedReason = event.message.errorMessage;
				}
			}
			void this.#emit(requirementId);
			if (event.type === "agent_end") {
				// Native admission/post-prompt cleanup can outlive agent_end; publish settled facts.
				void Promise.allSettled([session.waitForAdmittedSubmissions(), session.waitForIdle()]).then(() => {
					if (this.#sessions.has(session) && !this.#disposed) return this.#emit(requirementId);
				});
			}
		});
		this.#sessions.set(session, { requirementId, unsubscribe });
		for (const listener of this.#sessionListeners) listener(session, requirementId);
	}
	nativeSession(requirementId?: string): AgentSession | undefined {
		if (requirementId) {
			const owned = this.#runtimes.get(requirementId);
			const recipient = owned?.core.recipient();
			return recipient ? owned?.native.nativeSession(recipient.role) : undefined;
		}
		return this.#local?.runtime.nativeSession("business");
	}
	nativeSessions(): Array<{ session: AgentSession; requirementId: string | null; generation: number }> {
		return [...this.#sessions].map(([session, owner]) => ({
			session,
			requirementId: owner.requirementId,
			generation: owner.requirementId
				? (this.#runtimes.get(owner.requirementId)?.core.status().generation ?? 0)
				: (this.#local?.generation ?? 0),
		}));
	}
	resolveSession(target: DevSessionTarget): AgentSession {
		if (this.#closing || this.#disposed) throw new SpecAdmissionError("Dev 宿主正在退出或已关闭");
		if (this.#control) throw new SpecAdmissionError("业务控制或 Git 操作尚未结清；原生输入不会排队越过此边界");
		const session =
			target.requirementId === null
				? this.#local?.runtime.nativeSession("business")
				: this.nativeSession(target.requirementId);
		const generation =
			target.requirementId === null
				? this.#local?.generation
				: this.#runtimes.get(target.requirementId)?.core.status().generation;
		if (!session || session.sessionId !== target.sessionId || generation !== target.generation)
			throw new SpecAdmissionError("原生会话不属于此需求或运行代际已改变");
		if (
			target.requirementId !== null &&
			this.#runtimes.get(target.requirementId)?.stored.record.lifecycle !== "active"
		)
			throw new SpecAdmissionError("需求只读，不能恢复执行");
		return session;
	}
	async submitNativeInput(
		target: DevSessionTarget,
		submit: (session: AgentSession, onAdmitted: () => void) => Promise<unknown>,
	): Promise<boolean> {
		// Resolve and acquire control without an await: the target cannot cross a Dev transition.
		const session = this.resolveSession(target);
		return this.#exclusive(async () => {
			const admitted = Promise.withResolvers<boolean>();
			try {
				void submit(session, () => admitted.resolve(true)).then(
					() => admitted.resolve(false),
					error => admitted.reject(error),
				);
			} catch (error) {
				admitted.reject(error);
			}
			// Native queue/dispatch admission, not the eventual model turn, releases control.
			return admitted.promise;
		});
	}
	canStartGoal(target: DevSessionTarget): boolean {
		if (target.requirementId === null || this.#control) return false;
		const owned = this.#runtimes.get(target.requirementId);
		if (!owned) return false;
		const record = owned.stored.record;
		if (
			record.stage !== "executing" ||
			record.lifecycle !== "active" ||
			record.pr?.state === "merged" ||
			owned.observedPr?.state === "merged" ||
			record.marks["pr-merged"] ||
			owned.pendingGit ||
			owned.pendingSync ||
			hasPendingDevSync(record) ||
			owned.core.isTransitioning()
		)
			return false;
		try {
			const session = this.resolveSession(target);
			return (
				cfgGoalEnabled.get(session.settings) &&
				!session.getPlanModeState()?.enabled &&
				session.getAllToolNames().includes("goal")
			);
		} catch {
			return false;
		}
	}
	async assertGoalAllowed(target: DevSessionTarget): Promise<void> {
		if (!this.canStartGoal(target) || target.requirementId === null)
			throw new SpecAdmissionError("当前原生会话或业务阶段不允许启动 Goal");
		const check = await this.#runtimes.get(target.requirementId)!.core.checkApproved();
		if (!check.matches)
			throw new SpecAdmissionError(
				`上游批准版本失效：${check.changed.map(file => `${file.path}: ${file.reason}`).join("；")}`,
			);
		if (!this.canStartGoal(target)) throw new SpecAdmissionError("Goal 准入期间需求或原生会话发生变化");
	}
	async #owner(): Promise<DevWorkspace> {
		if (this.#disposed) throw new Error("Dev host is closed");
		if (this.#workspace) {
			await this.#workspace.assertCurrentBranch();
			return this.#workspace;
		}
		const { root } = await this.#identity;
		const owner = canonicalOwners.get(root);
		if (owner && owner !== this) throw new SpecAdmissionError("同一 canonical 工作区已有原生宿主");
		const workspace = await DevWorkspace.acquire(root);
		this.#workspace = workspace;
		canonicalOwners.set(root, this);
		return workspace;
	}
	async #save(record: DevRequirementRecord, expected: string | null): Promise<DevStoredRequirement> {
		const workspace = await this.#owner();
		const owned = this.#runtimes.get(record.requirementId);
		if (owned) {
			const persisted = (await workspace.readLocal(`generation-${record.requirementId}`, generationValue)) ?? 0;
			const changed =
				owned.stored.record.stage !== record.stage || owned.stored.record.lifecycle !== record.lifecycle;
			const required = owned.core.status().generation + (changed ? 1 : 0);
			if (required > persisted) await workspace.saveLocal(`generation-${record.requirementId}`, required);
		}
		const stored = await workspace.saveRequirement(record, expected);
		if (owned) {
			owned.stored = stored;
			owned.core.replaceRecord(stored.record);
		}
		return stored;
	}
	async #remember(prepared: PreparedAction): Promise<void> {
		const { pending: _pending, ...durable } = prepared;
		await (await this.#owner()).saveLocal(`action-${prepared.preview.action.binding.operationId}`, durable);
	}
	async #preparedAction(operationId: string): Promise<PreparedAction | undefined> {
		const existing = this.#prepared.get(operationId);
		if (existing) return existing;
		if (!/^[a-zA-Z0-9-]+$/.test(operationId)) throw new SpecAdmissionError("非法操作身份");
		const { root } = await this.#identity;
		let value: unknown;
		try {
			value = JSON.parse(
				await fs.readFile(await containedSpecPath(root, `.omp/dev-workbench/action-${operationId}.json`), "utf8"),
			);
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
		if (
			!value ||
			typeof value !== "object" ||
			!("preview" in value) ||
			!("cancel" in value) ||
			!("consumed" in value) ||
			typeof value.consumed !== "boolean"
		)
			throw new Error("损坏的本地操作恢复资料");
		const preview = value.preview;
		if (
			!preview ||
			typeof preview !== "object" ||
			!("action" in preview) ||
			!("confirmationToken" in preview) ||
			typeof preview.confirmationToken !== "string"
		)
			throw new Error("损坏的本地操作确认");
		const action = preview.action;
		if (
			!action ||
			typeof action !== "object" ||
			!("binding" in action) ||
			!action.binding ||
			typeof action.binding !== "object" ||
			!("operationId" in action.binding) ||
			action.binding.operationId !== operationId
		)
			throw new Error("本地操作身份不匹配");
		const prepared = value as PreparedAction;
		this.#prepared.set(operationId, prepared);
		return prepared;
	}
	async #pendingSyncAction(record: DevRequirementRecord): Promise<string | undefined> {
		if (record.lifecycle !== "active" || record.stage !== "pr") return undefined;
		for (let index = record.decisions.length - 1; index >= 0; index--) {
			const prepared = await this.#preparedAction(record.decisions[index].operationId);
			if (prepared?.consumed && prepared.preview.action.kind === "sync-archive" && !prepared.result)
				return prepared.preview.action.binding.operationId;
		}
		return undefined;
	}
	async #services(): Promise<{ git: DevGitService; forge: DevForgeService; cancel: DevCancellationService }> {
		const workspace = await this.#owner();
		if (!this.#git || !this.#forge || !this.#cancel) {
			const repo = vcs.git(workspace.root);
			if (!repo) throw new SpecAdmissionError("需要真实 Git 仓库");
			const records = {
				read: (id: string) => readDevRequirement(workspace.root, id),
				save: (record: DevRequirementRecord, expected: string | null) => this.#save(record, expected),
				list: () => loadDevRequirements(workspace.root),
				resolveOperationCommit: (id: string, operation: string) =>
					resolveDevOperationCommit(workspace.root, id, operation),
			};
			this.#forge = new DevForgeService({ cwd: workspace.root });
			this.#git = this.#createGit({
				cwd: workspace.root,
				repo,
				records,
				snapshot: id => this.getRequirement(id),
				applyDecision: async (record, decision, operation) => {
					if (operation === "cancel")
						return {
							...record,
							lifecycle: "cancelled",
							materials: [],
							decisions: [],
							marks: {},
							solutionBasis: null,
							report: { development: null, st: null },
							syncRevisions: [],
						};
					const prepared = this.#prepared.get(decision.operationId);
					if (!prepared) throw new SpecAdmissionError("缺少宿主签发的操作范围");
					const intent = prepared.preview.action;
					const owned = await this.#runtime(record.requirementId);
					if (intent.kind === "mark" && (intent.mark === "pr-submitted" || intent.mark === "pr-merged")) {
						const target = prepared.preview.git?.target;
						if (!target) throw new SpecAdmissionError("缺少明确 PR 目标");
						if (record.pr)
							record = {
								...record,
								pr: await this.#forge!.observeDevPr(record.pr.pr, new AbortController().signal),
							};
						else if (intent.mark === "pr-submitted")
							record = {
								...record,
								pr: await this.#forge!.createDevPr(
									{
										requirementId: record.requirementId,
										target,
										title: record.requirementId,
										body: decision.userReply,
									},
									new AbortController().signal,
								),
							};
						else throw new SpecAdmissionError("没有可核实的对应 PR");
						if (
							!record.pr ||
							record.pr.pr.sourceRef.replace(/^refs\/heads\//, "") !==
								target.sourceRef.replace(/^refs\/heads\//, "") ||
							record.pr.pr.baseRef.replace(/^refs\/heads\//, "") !==
								target.baseRef.replace(/^refs\/heads\//, "") ||
							devRepositoryIdentity(record.pr.pr.repository) !== devRepositoryIdentity(target.baseRepository)
						)
							throw new SpecAdmissionError("PR source/base 不属于本次确认目标");
						owned.observedPr = record.pr;
						if (intent.mark === "pr-submitted" && record.pr?.state === "closed")
							throw new SpecAdmissionError("对应 PR 已关闭且未合入");
					}
					if (intent.kind === "link-fix") await readDevRequirement(workspace.root, intent.fixRequirementId);
					return owned.core.decide(record, intent, decision);
				},
			});
			this.#cancel = new DevCancellationService({
				cwd: workspace.root,
				repo,
				git: this.#git,
				records,
				stop: id => this.stop(id),
				snapshot: id => this.getRequirement(id),
			});
		}
		return { git: this.#git, forge: this.#forge, cancel: this.#cancel };
	}
	async #paths(record: DevRequirementRecord): Promise<SpecArtifactPaths> {
		const { root } = await this.#identity;
		const materials = await resolveDevMaterials(root, record);
		const solution = materials.find(ref => ref.kind === "solution")?.path;
		const plan = materials.find(ref => ref.kind === "plan")?.path;
		const report = materials.find(ref => ref.kind === "report")?.path;
		const planPath =
			plan ?? solution?.replace(/-solutions\.json$/, ".md") ?? report?.replace(/-completion\.md$/, ".md");
		const paths = await new SpecArtifactStore({ cwd: root, changeId: record.changeId, planPath }).initialize(
			`docs/business-requirements/${record.changeId}.md`,
		);
		return {
			...paths,
			solution: solution ?? paths.solution,
			plan: plan ?? paths.plan,
			report: report ?? paths.report,
		};
	}
	async #runtime(id: string): Promise<OwnedRuntime> {
		const workspace = await this.#owner();
		const stored = await readDevRequirement(workspace.root, id);
		await this.getTeamConfiguration();
		const pendingGit = (await (await this.#services()).git.getPendingCommitOperation(id)) ?? undefined;
		const pendingSync = await this.#pendingSyncAction(stored.record);
		const current = this.#runtimes.get(id);
		if (current) {
			current.stored = stored;
			current.pendingGit = pendingGit;
			if (pendingSync && !current.pendingSync) current.pendingSync = {};
			if (
				current.observedPr &&
				(!stored.record.pr ||
					stored.record.pr.pr.number !== current.observedPr.pr.number ||
					stored.record.pr.pr.repository !== current.observedPr.pr.repository)
			)
				current.observedPr = undefined;
			current.core.replaceRecord(stored.record);
			const active = current.core.status().generation;
			const persisted = (await workspace.readLocal(`generation-${id}`, generationValue)) ?? 0;
			if (active > persisted) await workspace.saveLocal(`generation-${id}`, active);
			return current;
		}
		const refs = (await workspace.readLocal(`sessions-${id}`, sessionRefs)) ?? {};
		const generation = (await workspace.readLocal(`generation-${id}`, generationValue)) ?? 0;
		await workspace.saveLocal(`generation-${id}`, generation + 1);
		const paths = await this.#paths(stored.record);
		const saved: SpecSavedRun = {
			runId: id,
			changeId: stored.record.changeId,
			phase: stored.record.stage,
			entryPhase: "business",
			paths,
			sessions: refs,
			approvals: {},
			archivedChangePath: stored.record.syncRevisions.at(-1)?.archivedChangePath ?? undefined,
		};
		const native = await this.#factory({
			session: this.#host.session,
			settings: this.#host.settings,
			cwd: workspace.root,
			saved,
			getRecord: () => owned?.core.record() ?? stored.record,
			getStatus: () => owned?.core.status(),
			getSavedRun: () => owned?.core.save() ?? saved,
			checkApproved: () => owned!.core.checkApproved(),
			beginRepair: () => owned!.core.beginRepair(),
			observeReport: () => owned!.core.observeReport(),
			repairPaths: () =>
				owned?.core
					.record()
					.syncRevisions.at(-1)
					?.progress.sideEffects?.expectedVersions?.map(file => file.path),
			createInteractionUI: this.#host.createInteractionUI,
			uiForSession: this.#host.uiForSession,
			onToolStart: async event => {
				if (event.toolName === "write" || event.toolName === "edit")
					await (await this.#services()).git.beginNativeTool(id, event);
			},
			onToolEnd: async event => {
				if (event.toolName === "write" || event.toolName === "edit")
					await (await this.#services()).git.endNativeTool(id, event);
			},
			onSessionCreated: (_role, session) => this.#register(session, id),
		});
		const initialize = native.ports.artifacts.initialize;
		native.ports.artifacts.initialize = async (changeId, context, businessPath) => {
			if (businessPath) return initialize(changeId, context, businessPath);
			const { git } = await this.#services();
			const capture = await git.beginOwnedPaths(id, crypto.randomUUID(), [
				`openspec/changes/${changeId}/.openspec.yaml`,
			]);
			try {
				return await initialize(changeId, context);
			} finally {
				await git.endOwnedPaths(id, capture);
			}
		};
		const core = new SpecDrivenOrchestrator(native.ports, {
			record: stored.record,
			paths,
			generation: generation + 1,
			getUseTeam: () => this.#useTeam,
			getSessions: () => refs,
			persist: async record => {
				record.materials = await resolveDevMaterials(workspace.root, record);
				await this.#save(record, owned!.stored.recordVersion);
			},
			persistSessions: refs => workspace.saveLocal(`sessions-${id}`, refs),
			getSolutionBasis: () => owned?.stored.record.solutionBasis ?? null,
			getPendingSync: () => owned?.pendingSync,
			getPendingGit: () => owned?.pendingGit,
			getObservedPr: () => owned?.observedPr,
			startModel: work => this.#start(owned!, work),
			onStatusChange: () => {
				void this.#emit(id);
			},
		});
		const owned: OwnedRuntime = {
			core,
			native,
			stored,
			execution: "idle",
			history:
				refs[roleForDevStage(stored.record.stage)] || stored.record.stage !== "business"
					? "unavailable"
					: "not-created",
			pendingGit,
			...(pendingSync ? { pendingSync: {} } : {}),
		};
		this.#runtimes.set(id, owned);
		return owned;
	}
	async #snapshot(stored: DevStoredRequirement): Promise<DevRequirementSnapshot> {
		const owned = this.#runtimes.get(stored.record.requirementId);
		let runtime: DevRuntimeState | null = null;
		if (owned) {
			const sessions = [...this.#sessions]
				.filter(([, o]) => o.requirementId === stored.record.requirementId)
				.map(([s]) => s);
			const busy = sessions.some(nativeBusy);
			runtime = {
				requirementId: stored.record.requirementId,
				generation: owned.core.status().generation,
				execution: owned.stopping ? "stopping" : busy ? "running" : owned.execution,
				recipient: owned.core.recipient() ?? null,
				history: owned.core.recipient() ? "available" : owned.history,
				blockedReason: owned.blockedReason ?? owned.core.status().blockedReason,
			};
		} else if (stored.record.lifecycle === "active" && stored.record.stage !== "business") {
			runtime = {
				requirementId: stored.record.requirementId,
				generation: 0,
				execution: "interrupted",
				recipient: null,
				history: "unavailable",
			};
		}
		const writable = stored.record.lifecycle === "active";
		const busy = runtime?.execution === "running" || runtime?.execution === "stopping";
		const pendingSync = await this.#pendingSyncAction(stored.record);
		const reason =
			this.#closing || this.#disposed
				? "Dev 宿主正在退出或已关闭"
				: !writable
					? "需求只读"
					: busy
						? "原生操作尚未结清"
						: owned?.pendingGit
							? `Git 提交或 index 尚未结清：${owned.pendingGit}`
							: hasPendingDevSync(stored.record) || owned?.pendingSync || pendingSync
								? "同步部分副作用或持久化尚未结清"
								: undefined;
		const stage = stored.record.stage;
		return {
			...stored,
			runtime,
			actions: [
				{ id: "next", allowed: ["business", "requirements", "solution", "planning", "executing"].includes(stage) },
				{
					id: "commit",
					allowed:
						stage === "testing" ||
						(stored.record.pr?.state !== "merged" && owned?.observedPr?.state !== "merged"),
				},
				{
					id: "back",
					allowed:
						stage !== "business" &&
						!stored.record.marks["pr-merged"] &&
						stored.record.pr?.state !== "merged" &&
						owned?.observedPr?.state !== "merged",
				},
				{
					id: "sync-archive",
					allowed: stage === "pr" && stored.record.pr?.state !== "merged" && owned?.observedPr?.state !== "merged",
				},
				{ id: "st-complete", allowed: stage === "st" },
				{ id: "pr-submitted", allowed: stage === "pr" },
				{ id: "pr-merged", allowed: stage === "pr" && !!stored.record.marks["pr-submitted"] },
				{ id: "tested", allowed: stage === "testing" },
				{ id: "set-test-state", allowed: stage === "testing" },
				{ id: "link-fix", allowed: stage === "testing" },
				{
					id: "cancel",
					allowed:
						!stored.record.marks["pr-merged"] &&
						stored.record.pr?.state !== "merged" &&
						owned?.observedPr?.state !== "merged",
				},
			].map(({ id, allowed }) => ({
				id,
				available: allowed && !reason,
				blockedReason: reason ?? (!allowed ? "当前阶段不允许此操作" : undefined),
			})),
		};
	}
	async #emit(id: string): Promise<void> {
		try {
			const snapshot = await this.getRequirement(id);
			for (const listener of this.#listeners) {
				try {
					listener(snapshot);
				} catch {
					/* Observers cannot own work. */
				}
			}
		} catch {
			/* A failed read is reported by the requesting read/action, not an event promise. */
		}
	}
	async listRequirements(): Promise<DevRequirementSnapshot[]> {
		const { root } = await this.#identity;
		return Promise.all((await loadDevRequirements(root)).map(stored => this.#snapshot(stored)));
	}
	async getRequirement(id: string): Promise<DevRequirementSnapshot> {
		const { root } = await this.#identity;
		return this.#snapshot(await readDevRequirement(root, id));
	}
	async #exclusive<T>(work: () => Promise<T>): Promise<T> {
		if (this.#closing || this.#disposed) throw new SpecAdmissionError("Dev 宿主正在退出或已关闭");
		if (this.#control) throw new SpecAdmissionError("控制操作冲突；不会排队批准");
		const settled = Promise.withResolvers<void>();
		this.#control = true;
		this.#controlSettled = settled;
		try {
			return await work();
		} finally {
			this.#control = false;
			if (this.#controlSettled === settled) this.#controlSettled = undefined;
			settled.resolve();
		}
	}
	async #continueAction(prepared: PreparedAction, work: () => Promise<DevActionResult>): Promise<DevActionResult> {
		if (prepared.pending) return prepared.pending;
		const pending = this.#exclusive(work);
		prepared.pending = pending;
		try {
			return await pending;
		} finally {
			if (prepared.pending === pending) prepared.pending = undefined;
		}
	}
	#assertSettled(id: string, allowGoal = false): void {
		const owned = this.#runtimes.get(id);
		if (
			owned?.stopping ||
			owned?.execution === "running" ||
			owned?.core.isTransitioning() ||
			[...this.#sessions].some(
				([session, owner]) =>
					owner.requirementId === id && (allowGoal ? nativeWorkBusy(session) : nativeBusy(session)),
			)
		)
			throw new SpecAdmissionError("原生输入、工具、Team、Goal 或后代工作尚未结清");
	}
	async createRequirement(input: {
		source: "conversation" | "import";
		request?: string;
		relatedRequirementIds?: string[];
	}): Promise<DevRequirementSnapshot> {
		return this.#exclusive(async () => {
			if (input.source !== "conversation" && input.source !== "import") throw new SpecAdmissionError("未知需求入口");
			if (input.source === "conversation" && !input.request?.trim())
				throw new SpecAdmissionError("业务访谈请求不能为空");
			const workspace = await this.#owner();
			await workspace.assertDevelopmentAvailable();
			await this.getTeamConfiguration();
			const { git } = await this.#services();
			const head = await git.repo.head();
			if (!head.commit || !head.refName?.startsWith("refs/heads/"))
				throw new SpecAdmissionError("开发需求必须使用已有提交的当前分支");
			const related = [...new Set(input.relatedRequirementIds ?? [])];
			for (const id of related) await readDevRequirement(workspace.root, id);
			const id = await allocateDevRequirementId(workspace.root);
			const record: DevRequirementRecord = {
				schemaVersion: 1,
				requirementId: id,
				changeId: id,
				branch: workspace.branch!,
				stage: "business",
				lifecycle: "active",
				materials: [],
				decisions: [],
				marks: {},
				solutionBasis: null,
				report: { development: null, st: null },
				syncRevisions: [],
				gitOperations: [],
				pr: null,
				testing: "not-started",
				relatedRequirementIds: related,
			};
			await this.#save(record, null);
			await git.initializeRequirementGit(id);
			if (input.source === "conversation") {
				const owned = await this.#runtime(id);
				this.#start(owned, () => owned.core.startConversation(input.request!, true));
			}
			await this.#emit(id);
			return this.getRequirement(id);
		});
	}
	#start(owned: OwnedRuntime, work: () => Promise<void>): void {
		owned.execution = "running";
		void work()
			.then(
				() => {
					if (!owned.stopping && owned.execution !== "interrupted") owned.execution = "idle";
				},
				error => {
					if (!owned.stopping && owned.execution !== "interrupted") {
						owned.execution = "failed";
						owned.blockedReason = error instanceof Error ? error.message : String(error);
					}
				},
			)
			.finally(() => this.#emit(owned.stored.record.requirementId));
	}
	async importBusiness(
		id: string,
		source: { kind: "upload"; name: string; bytes: Uint8Array } | { kind: "host-path"; path: string },
		replaceVersion?: string,
	): Promise<SpecDocument> {
		return this.#exclusive(async () => {
			const workspace = await this.#owner();
			const stored = await readDevRequirement(workspace.root, id);
			if (stored.record.stage !== "business" || stored.record.lifecycle !== "active")
				throw new SpecAdmissionError("仅业务阶段可导入文档");
			this.#assertSettled(id);
			await workspace.assertDevelopmentAvailable(id);
			const { git } = await this.#services();
			const capture = await git.beginOwnedPaths(id, crypto.randomUUID(), [
				`docs/business-requirements/${stored.record.changeId}.md`,
			]);
			let document: SpecDocument;
			try {
				document = await importDevBusiness(workspace.root, stored.record, source, replaceVersion);
			} finally {
				await git.endOwnedPaths(id, capture);
			}
			await this.#save(
				{ ...stored.record, materials: await resolveDevMaterials(workspace.root, stored.record) },
				stored.recordVersion,
			);
			await this.#emit(id);
			return document;
		});
	}
	async readMaterial(id: string, materialId: string): Promise<SpecDocument> {
		const { root } = await this.#identity;
		const stored = await readDevRequirement(root, id);
		if (stored.record.lifecycle === "cancelling")
			throw new SpecAdmissionError("需求材料正在撤销，暂不提供当前材料；请查看取消操作的实际进度。");
		if (stored.record.lifecycle === "cancelled") throw new SpecAdmissionError("需求已撤销，不再提供当前需求材料。");
		return readDevMaterial(root, stored.record, materialId);
	}
	async listMaterials(requirementId: string): Promise<DevMaterialRef[]> {
		const { root } = await this.#identity;
		const { record } = await readDevRequirement(root, requirementId);
		if (record.lifecycle === "cancelling" || record.lifecycle === "cancelled") return [];
		return resolveDevMaterials(root, record);
	}
	async discoverDevGitTargets(id: string): Promise<DevGitTarget[]> {
		const { root } = await this.#identity;
		return new DevGitService({
			cwd: root,
			snapshot: requirementId => this.getRequirement(requirementId),
		}).discoverDevGitTargets(id);
	}
	async prepareDevAction(input: {
		requirementId: string;
		expectedRecordVersion: string;
		expectedStage: DevStage;
		intent: DevActionIntent;
		gitTarget: DevGitTarget | null;
	}): Promise<DevActionPreview> {
		return this.#exclusive(async () => {
			const workspace = await this.#owner();
			const stored = await readDevRequirement(workspace.root, input.requirementId);
			const requested = actionIntent(input.intent);
			if (stored.recordVersion !== input.expectedRecordVersion || stored.record.stage !== input.expectedStage)
				throw new SpecAdmissionError("需求版本或阶段已改变");
			for (const operationId of [
				...new Set([
					...stored.record.gitOperations.map(op => op.operationId),
					...stored.record.decisions.map(decision => decision.operationId),
				]),
			].reverse()) {
				const previous = await this.#preparedAction(operationId);
				if (
					!previous?.consumed ||
					JSON.stringify(actionIntent(previous.preview.action)) !== JSON.stringify(requested)
				)
					continue;
				if (
					previous.cancel &&
					(stored.record.lifecycle === "cancelling" || stored.record.lifecycle === "cancelled")
				)
					return structuredClone(previous.preview);
				if (previous.preview.action.kind === "sync-archive" && !previous.result)
					return structuredClone(previous.preview);
				if (previous.preview.git) {
					const result = await this.readDevAction(operationId);
					if (
						result.persistence.save === "succeeded" &&
						(result.persistence.commit.status !== "succeeded" ||
							!result.persistence.commit.indexReconciled ||
							result.persistence.push.status !== "succeeded")
					)
						return structuredClone(previous.preview);
				}
			}
			if (stored.record.lifecycle !== "active")
				throw new SpecAdmissionError("需求只读；仅能续办原已确认 operation 尚未完成的推送");
			this.#assertSettled(input.requirementId, input.intent.kind === "cancel");
			if (stored.record.stage !== "testing") await workspace.assertDevelopmentAvailable(stored.record.requirementId);
			const owned = await this.#runtime(input.requirementId);
			const checked = await owned.core.inspect(requested);
			const intent: DevActionIntent =
				requested.kind === "next" ? { kind: "next", candidateId: checked.candidateId } : requested;
			const binding = {
				requirementId: input.requirementId,
				expectedRecordVersion: stored.recordVersion,
				expectedStage: stored.record.stage,
				files: checked.files,
				operationId: crypto.randomUUID(),
				expectedGeneration: owned.core.status().generation,
			};
			const requiresGit = ["mark", "commit", "cancel", "set-test-state", "link-fix"].includes(intent.kind);
			if (requiresGit && !input.gitTarget) throw new SpecAdmissionError("必须选择实际发现的 Git 提交推送目标");
			if (!requiresGit && input.gitTarget) throw new SpecAdmissionError("此动作不包含 Git 授权");
			let git: DevActionPreview["git"] = null;
			let cancel: DevCancelPlan | null = null;
			if (requiresGit) {
				const services = await this.#services();
				const discovered = await services.git.discoverDevGitTargets(input.requirementId);
				if (!discovered.some(target => JSON.stringify(target) === JSON.stringify(input.gitTarget)))
					throw new SpecAdmissionError("Git 目标不是当前真实发现的候选");
				if (intent.kind === "cancel") {
					cancel = await services.cancel.planDevCancellation(
						stored.record,
						binding,
						input.gitTarget!,
						new AbortController().signal,
					);
					git = cancel.preview;
				} else {
					const operation: Exclude<DevGitAction, "cancel"> =
						intent.kind === "commit"
							? "commit"
							: intent.kind === "mark"
								? intent.mark
								: intent.kind === "set-test-state"
									? "set-test-state"
									: "link-fix";
					const recordOnly =
						stored.record.stage === "testing" ||
						stored.record.pr?.state === "merged" ||
						owned.observedPr?.state === "merged" ||
						(intent.kind === "mark" && intent.mark === "pr-merged");
					const paths = recordOnly
						? [devRequirementPath(stored.record.requirementId)]
						: [
								...new Set([
									devRequirementPath(stored.record.requirementId),
									...checked.files.map(file => file.path),
									...(await resolveDevMaterials(workspace.root, stored.record)).map(file => file.path),
									...(await services.git.getOwnedChanges(stored.record.requirementId)).flatMap(
										change => change.paths ?? [change.path],
									),
								]),
							].sort();
					const files: SpecFileVersion[] = [];
					if (!recordOnly)
						for (const file of paths) {
							try {
								files.push({
									path: file,
									version: artifactVersion(await fs.readFile(await containedSpecPath(workspace.root, file))),
								});
							} catch (error) {
								if (!isEnoent(error)) throw error;
							}
						}
					git = await services.git.previewDevGitOperation(
						stored.record,
						{ binding, operation, target: input.gitTarget!, files, paths },
						new AbortController().signal,
					);
				}
			}
			const preview: DevActionPreview = {
				action: { ...intent, binding, previewId: git?.previewId ?? null },
				confirmationToken: crypto.randomBytes(32).toString("base64url"),
				git,
				cancelPlan: cancel,
			};
			const prepared: PreparedAction = { preview: structuredClone(preview), cancel, consumed: false };
			await this.#remember(prepared);
			this.#prepared.set(binding.operationId, prepared);
			return preview;
		});
	}
	async confirmDevAction(
		input: { operationId: string; confirmationToken: string; userReply: string },
		actor: DevPerson = defaultPerson(),
	): Promise<DevActionResult> {
		const prepared = await this.#preparedAction(input.operationId);
		if (!prepared || input.confirmationToken !== prepared.preview.confirmationToken)
			throw new SpecAdmissionError("未知操作或确认 token 不匹配");
		if (!input.userReply.trim()) throw new SpecAdmissionError("必须保留人员本次明确确认原文");
		if (prepared.pending) return prepared.pending;
		if (prepared.consumed) {
			if (!prepared.preview.git) {
				const snapshot = await this.getRequirement(prepared.preview.action.binding.requirementId);
				if (
					prepared.preview.action.kind !== "sync-archive" ||
					!prepared.decision ||
					snapshot.record.lifecycle !== "active" ||
					snapshot.record.stage !== prepared.preview.action.binding.expectedStage ||
					(prepared.result &&
						!hasPendingDevSync(snapshot.record) &&
						!this.#runtimes.get(snapshot.record.requirementId)?.pendingSync)
				)
					return this.readDevAction(input.operationId);
				if (
					snapshot.recordVersion !== prepared.preview.action.binding.expectedRecordVersion &&
					!snapshot.record.decisions.some(decision => decision.operationId === input.operationId) &&
					!snapshot.record.syncRevisions.some(revision => revision.operationId === input.operationId)
				)
					throw new SpecAdmissionError("未开始的同步确认已过期");
				return this.#continueAction(prepared, async () => {
					const owned = await this.#runtime(snapshot.record.requirementId);
					try {
						await this.#sync(owned, prepared.decision!);
						prepared.result = {
							snapshot: await this.getRequirement(snapshot.record.requirementId),
							persistence: {
								save: "succeeded",
								commit: { status: "not-started", sha: null, indexReconciled: false },
								push: { status: "not-started", target: null },
							},
						};
					} catch (error) {
						prepared.result = {
							snapshot: await this.getRequirement(snapshot.record.requirementId),
							persistence: {
								save: "succeeded",
								commit: { status: "not-started", sha: null, indexReconciled: false },
								push: { status: "not-started", target: null },
								error: error instanceof Error ? error.message : String(error),
							},
						};
					}
					await this.#remember(prepared);
					return prepared.result;
				});
			}
			// A cancellation push receipt does not publish its tombstone or settle its journal.
			// Its own service is the authority for both boundaries, including a lost final response.
			if (
				!prepared.cancel &&
				prepared.result?.persistence.save === "succeeded" &&
				prepared.result.persistence.commit.status === "succeeded" &&
				prepared.result.persistence.commit.indexReconciled &&
				prepared.result.persistence.push.status === "succeeded"
			)
				return this.readDevAction(input.operationId);
			const snapshot = await this.getRequirement(prepared.preview.action.binding.requirementId);
			if (
				(snapshot.record.lifecycle === "cancelled" && !prepared.cancel) ||
				(snapshot.record.lifecycle === "completed" &&
					snapshot.record.marks.tested?.operationId !== input.operationId) ||
				(snapshot.record.lifecycle === "cancelling" && !prepared.cancel)
			)
				return this.readDevAction(input.operationId);
			return this.#continueAction(prepared, async () => {
				const { git, cancel } = await this.#services();
				const decision = prepared.decision;
				const result =
					prepared.cancel && decision
						? await cancel.executeDevCancellation(prepared.cancel, decision, new AbortController().signal)
						: await git.resumeDevGitOperation(
								prepared.preview.action.binding.requirementId,
								input.operationId,
								new AbortController().signal,
							);
				const owned = this.#runtimes.get(result.snapshot.record.requirementId);
				if (owned) {
					owned.pendingGit =
						(await git.getPendingCommitOperation(result.snapshot.record.requirementId)) ?? undefined;
					owned.blockedReason = result.persistence.error;
				}
				prepared.result = result;
				await this.#remember(prepared);
				return result;
			});
		}
		prepared.actor = {
			name: actor.name,
			source: actor.source,
			...(actor.peerId === undefined ? {} : { peerId: actor.peerId }),
		};
		return this.dispatch({ ...prepared.preview.action, userReply: input.userReply }, prepared.actor);
	}
	async dispatch(action: DevAction, actor: DevPerson): Promise<DevActionResult> {
		const prepared = this.#prepared.get(action.binding.operationId);
		if (
			!prepared ||
			!prepared.actor ||
			JSON.stringify(prepared.actor) !== JSON.stringify(actor) ||
			JSON.stringify({ ...action, userReply: undefined }) !==
				JSON.stringify({ ...prepared.preview.action, userReply: undefined })
		)
			throw new SpecAdmissionError("动作未经宿主同范围确认");
		const person = prepared.actor;
		if (prepared.pending) return prepared.pending;
		if (prepared.consumed) return this.readDevAction(action.binding.operationId);
		const pending = this.#exclusive(async () => {
			const { root } = await this.#identity;
			const current = await readDevRequirement(root, action.binding.requirementId);
			if (
				current.recordVersion !== action.binding.expectedRecordVersion ||
				current.record.stage !== action.binding.expectedStage
			)
				throw new SpecAdmissionError("确认已过期；不会排队到下一阶段");
			this.#assertSettled(current.record.requirementId, action.kind === "cancel");
			const owned = await this.#runtime(current.record.requirementId);
			if (owned.core.status().generation !== action.binding.expectedGeneration)
				throw new SpecAdmissionError("原生运行代际已经改变");
			const checked = await owned.core.inspect(action);
			if (!sameVersions(checked.files, action.binding.files))
				throw new SpecAdmissionError("确认后实际材料字节已改变");
			const decision: DevDecision = {
				operationId: action.binding.operationId,
				stage: current.record.stage,
				actor: structuredClone(person),
				at: new Date().toISOString(),
				userReply: action.userReply,
				files: checked.files,
				...(checked.candidateId === undefined ? {} : { candidateId: checked.candidateId }),
			};
			prepared.decision = structuredClone(decision);
			prepared.consumed = true;
			try {
				await this.#remember(prepared);
			} catch (error) {
				prepared.consumed = false;
				prepared.decision = undefined;
				throw error;
			}
			let result: DevActionResult;
			if (action.kind === "cancel") {
				if (!prepared.cancel) throw new SpecAdmissionError("缺少取消预览");
				result = await (
					await this.#services()
				).cancel.executeDevCancellation(prepared.cancel, decision, new AbortController().signal);
			} else if (prepared.preview.git)
				result = await (
					await this.#services()
				).git.executeDevGitOperation(prepared.preview.git, decision, new AbortController().signal);
			else {
				try {
					if (action.kind === "sync-archive") await this.#sync(owned, decision);
					else await owned.core.execute(action, decision);
					result = {
						snapshot: await this.getRequirement(current.record.requirementId),
						persistence: {
							save: "succeeded",
							commit: { status: "not-started", sha: null, indexReconciled: false },
							push: { status: "not-started", target: null },
						},
					};
				} catch (error) {
					const snapshot = await this.getRequirement(current.record.requirementId);
					owned.blockedReason = error instanceof Error ? error.message : String(error);
					result = {
						snapshot,
						persistence: {
							save: snapshot.recordVersion !== current.recordVersion ? "succeeded" : "failed",
							commit: { status: "not-started", sha: null, indexReconciled: false },
							push: { status: "not-started", target: null },
							error: owned.blockedReason,
						},
					};
				}
			}
			const latest = await readDevRequirement(root, current.record.requirementId);
			owned.stored = latest;
			owned.core.replaceRecord(latest.record);
			if (prepared.preview.git) {
				owned.pendingGit =
					(await (await this.#services()).git.getPendingCommitOperation(current.record.requirementId)) ??
					undefined;
				owned.blockedReason = result.persistence.error;
			}
			prepared.result = result;
			await this.#remember(prepared);
			await this.#emit(current.record.requirementId);
			return result;
		});
		prepared.pending = pending;
		try {
			return await pending;
		} finally {
			prepared.pending = undefined;
		}
	}
	async #sync(owned: OwnedRuntime, decision: DevDecision): Promise<void> {
		const workspace = await this.#owner();
		const record = owned.core.record();
		if (!record.decisions.some(entry => entry.operationId === decision.operationId)) {
			record.decisions.push(decision);
			await this.#save(record, owned.stored.recordVersion);
		}
		const previous = record.syncRevisions.at(-1) ?? null;
		const { git } = await this.#services();
		const prepared = this.#prepared.get(decision.operationId);
		let revision: DevSyncRevision;
		let progressPersisted = false;
		try {
			revision = await syncDevRequirement(
				{
					cwd: workspace.root,
					changeId: record.changeId,
					changeDirectory: previous?.archivedChangePath ?? `openspec/changes/${record.changeId}`,
					acceptedVersions: decision.files,
					previous,
					operationId: decision.operationId,
					onBeforeWrite: async paths => {
						const captureId = await git.beginOwnedPaths(record.requirementId, decision.operationId, paths);
						if (prepared) {
							prepared.captureId = captureId;
							await this.#remember(prepared);
						}
						return captureId;
					},
					onAfterWrite: async captureId => {
						await git.endOwnedPaths(record.requirementId, captureId);
						if (prepared) {
							prepared.captureId = undefined;
							await this.#remember(prepared);
						}
					},
					onProgress: async progress => {
						progressPersisted = false;
						owned.pendingSync = structuredClone(progress);
						const next = owned.core.record();
						const partial: DevSyncRevision = {
							operationId: decision.operationId,
							files: decision.files,
							mainSpecs: progress.targetVersions ?? [],
							archivedChangePath: progress.archivedChangePath ?? previous?.archivedChangePath ?? null,
							progress,
						};
						const index = next.syncRevisions.findIndex(r => r.operationId === decision.operationId);
						if (index >= 0) next.syncRevisions[index] = partial;
						else next.syncRevisions.push(partial);
						await this.#save(next, owned.stored.recordVersion);
						progressPersisted = true;
						await this.#emit(record.requirementId);
					},
				},
				new AbortController().signal,
			);
		} catch (error) {
			const observed = owned.stored.record.syncRevisions.find(
				revision => revision.operationId === decision.operationId,
			);
			if (
				progressPersisted &&
				observed &&
				!observed.progress.synced &&
				!observed.progress.sideEffects &&
				!observed.progress.retirementCleanup &&
				!observed.progress.archiveCleanup &&
				observed.progress.ownership?.state !== "pending"
			)
				owned.pendingSync = undefined;
			throw error;
		}
		const next = owned.core.record();
		const index = next.syncRevisions.findIndex(r => r.operationId === decision.operationId);
		if (index >= 0) next.syncRevisions[index] = revision;
		else next.syncRevisions.push(revision);
		await this.#save(
			{ ...next, materials: await resolveDevMaterials(workspace.root, next) },
			owned.stored.recordVersion,
		);
		owned.pendingSync = undefined;
	}
	async stopLocalBusiness(): Promise<void> {
		if (!this.#local) return;
		this.#local.generation++;
		await this.#local.runtime.stop();
	}
	async readDevAction(operationId: string): Promise<DevActionResult> {
		const prepared = await this.#preparedAction(operationId);
		if (prepared?.consumed && !prepared.preview.git && !prepared.result) {
			const snapshot = await this.getRequirement(prepared.preview.action.binding.requirementId);
			const saved =
				snapshot.record.decisions.some(decision => decision.operationId === operationId) ||
				snapshot.record.syncRevisions.some(revision => revision.operationId === operationId);
			return {
				snapshot,
				persistence: {
					save: saved ? "succeeded" : "unknown",
					commit: { status: "not-started", sha: null, indexReconciled: false },
					push: { status: "not-started", target: null },
				},
			};
		}
		if (
			prepared?.result &&
			(!prepared.preview.git || (prepared.cancel && prepared.result.persistence.commit.status === "not-started"))
		)
			return {
				...prepared.result,
				snapshot: await this.getRequirement(prepared.preview.action.binding.requirementId),
			};
		const { root } = await this.#identity;
		const git = new DevGitService({ cwd: root, snapshot: id => this.getRequirement(id) });
		if (prepared?.consumed && prepared.preview.git) {
			try {
				const result = await git.readDevGitOperation(
					prepared.preview.action.binding.requirementId,
					operationId,
					new AbortController().signal,
				);
				if (!prepared.pending) prepared.result = result;
				return result;
			} catch (error) {
				if (!isEnoent(error)) throw error;
				const snapshot = await this.getRequirement(prepared.preview.action.binding.requirementId);
				const sha = await resolveDevOperationCommit(root, snapshot.record.requirementId, operationId);
				const saved =
					snapshot.record.gitOperations.some(operation => operation.operationId === operationId) ||
					snapshot.record.decisions.some(decision => decision.operationId === operationId);
				return {
					snapshot,
					persistence: {
						save: saved ? "succeeded" : "unknown",
						commit: { status: sha ? "succeeded" : "unknown", sha, indexReconciled: false },
						push: { status: "unknown", target: prepared.preview.git.target },
						error: "操作正在建立回执或原本地回执不可用；只观察事实，不重放",
					},
				};
			}
		}
		const records = await this.listRequirements();
		const match = records.find(s => s.record.gitOperations.some(op => op.operationId === operationId));
		if (match) return git.readDevGitOperation(match.record.requirementId, operationId, new AbortController().signal);
		throw new SpecAdmissionError("操作尚未确认或不存在");
	}
	async getTeamConfiguration(): Promise<{ useTeam: boolean }> {
		if (!this.#teamLoaded) {
			const { root } = await this.#identity;
			try {
				this.#useTeam = teamValue(
					JSON.parse(
						await fs.readFile(await containedSpecPath(root, ".omp/dev-workbench/team-config.json"), "utf8"),
					),
				);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			this.#teamLoaded = true;
		}
		return { useTeam: this.#useTeam };
	}
	async saveTeamConfiguration(input: {
		requirementId: string | null;
		expectedRecordVersion: string | null;
		useTeam: boolean;
	}): Promise<{ useTeam: boolean }> {
		return this.#exclusive(async () => {
			if (typeof input.useTeam !== "boolean") throw new SpecAdmissionError("Team 开关须为 boolean");
			if (input.requirementId) {
				const snapshot = await this.getRequirement(input.requirementId);
				if (snapshot.recordVersion !== input.expectedRecordVersion)
					throw new SpecAdmissionError("配置需求版本过期");
				if (!["business", "requirements"].includes(snapshot.record.stage) || snapshot.record.lifecycle !== "active")
					throw new SpecAdmissionError("仅进入方案前可修改 Team 开关");
				this.#assertSettled(input.requirementId);
			} else if (input.expectedRecordVersion !== null) throw new SpecAdmissionError("本地配置没有需求版本");
			await (await this.#owner()).saveLocal("team-config", { useTeam: input.useTeam });
			this.#useTeam = input.useTeam;
			this.#teamLoaded = true;
			return { useTeam: this.#useTeam };
		});
	}
	async startLocalBusiness(
		request: string,
	): Promise<{ document: SpecDocument | null; recipient: SpecConversationRecipient }> {
		return this.#exclusive(async () => {
			if (!request.trim()) throw new SpecAdmissionError("业务写作请求不能为空");
			if (this.#local) {
				const session = this.#local.runtime.nativeSession("business");
				if (session && nativeBusy(session)) throw new SpecAdmissionError("本地业务会话仍忙碌");
				await this.#local.runtime.dispose();
				this.#local = undefined;
				for (const [owned, ref] of this.#sessions)
					if (ref.requirementId === null && owned.isDisposed) {
						ref.unsubscribe();
						this.#sessions.delete(owned);
					}
			}
			const workspace = await this.#owner();
			const id = `business-${crypto.randomUUID()}`;
			const file = `.omp/dev-workbench/business/${id}.md`;
			const store = new SpecArtifactStore({ cwd: workspace.root, changeId: id });
			const paths = await store.initialize(file);
			const saved: SpecSavedRun = {
				runId: id,
				phase: "business",
				entryPhase: "business",
				changeId: id,
				paths,
				sessions: {},
				approvals: {},
			};
			const runtime = await this.#factory({
				session: this.#host.session,
				settings: this.#host.settings,
				cwd: workspace.root,
				saved,
				getSavedRun: () => saved,
				getStatus: () => ({
					phase: "business",
					generation: this.#local?.id === id ? this.#local.generation : 0,
					changeId: id,
					paths,
					useTeam: false,
				}),
				createInteractionUI: this.#host.createInteractionUI,
				uiForSession: this.#host.uiForSession,
				onSessionCreated: (_role, session) => this.#register(session, null),
			});
			const context = { runId: id, generation: 0, signal: new AbortController().signal };
			let recipient: SpecConversationRecipient;
			try {
				await runtime.ports.agents.prepare("business", context);
				const prepared = runtime.ports.agents.recipient("business");
				if (!prepared) throw new Error("业务会话未建立");
				recipient = prepared;
				await workspace.saveLocal("local-business", { id, path: file, sessions: runtime.sessionRefs() });
			} catch (error) {
				try {
					await runtime.dispose();
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "本地业务会话初始化及原生结清失败");
				}
				for (const [owned, ref] of this.#sessions)
					if (ref.requirementId === null && owned.isDisposed) {
						ref.unsubscribe();
						this.#sessions.delete(owned);
					}
				throw error;
			}
			this.#local = { id, path: file, runtime, generation: 0 };
			void runtime.ports.agents
				.run({ role: "business", entry: true, request, files: [], outputPaths: [file] }, context)
				.catch(() => {
					/* Native session publishes its actual model failure. */
				});
			return { document: await this.readLocalBusiness(), recipient };
		});
	}
	async readLocalBusiness(): Promise<SpecDocument | null> {
		const { root } = await this.#identity;
		let file = this.#local?.path;
		if (!file) {
			let reference: unknown;
			try {
				reference = JSON.parse(
					await fs.readFile(await containedSpecPath(root, ".omp/dev-workbench/local-business.json"), "utf8"),
				);
			} catch (error) {
				if (isEnoent(error)) return null;
				throw error;
			}
			if (
				!reference ||
				typeof reference !== "object" ||
				!("path" in reference) ||
				typeof reference.path !== "string" ||
				!/^\.omp\/dev-workbench\/business\/business-[a-f0-9-]+\.md$/.test(reference.path)
			)
				throw new Error("Invalid registered local business document");
			file = reference.path;
		}
		try {
			const bytes = await fs.readFile(await containedSpecPath(root, file));
			return { path: file, content: bytes.toString("utf8"), version: artifactVersion(bytes) };
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}
	async prepareSession(requirementId: string): Promise<DevSessionTarget> {
		return this.#exclusive(async () => {
			const workspace = await this.#owner();
			const stored = await readDevRequirement(workspace.root, requirementId);
			if (stored.record.stage !== "testing") await workspace.assertDevelopmentAvailable(requirementId);
			this.#assertSettled(requirementId);
			const owned = await this.#runtime(requirementId);
			const recipient = await owned.core.prepareSession();
			return { requirementId, sessionId: recipient.sessionId, generation: owned.core.status().generation };
		});
	}
	async converse(
		requirementId: string,
		text: string,
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<void> {
		const owned = await this.#exclusive(async () => {
			const workspace = await this.#owner();
			const stored = await readDevRequirement(workspace.root, requirementId);
			if (stored.record.lifecycle !== "active") throw new SpecAdmissionError("需求只读");
			if (stored.record.stage !== "testing") await workspace.assertDevelopmentAvailable(requirementId);
			const runtime = await this.#runtime(requirementId);
			runtime.execution = "running";
			return runtime;
		});
		if (this.#closing || this.#disposed) throw new SpecAdmissionError("Dev 宿主正在退出或已关闭");
		try {
			await owned.core.converse(text, images, imageLinks, hasExplicitRepairIntent(text) ? "repair" : undefined);
		} catch (error) {
			owned.execution = "failed";
			owned.blockedReason = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			if (owned.execution === "running") owned.execution = "idle";
			await this.#emit(requirementId);
		}
	}
	hasPendingTeam(session: AgentSession): boolean {
		return [...this.#runtimes.values()].some(owned => owned.native.hasPendingTeam(session));
	}
	async interrupt(session: AgentSession): Promise<boolean> {
		for (const owned of this.#runtimes.values())
			if (owned.native.hasPendingTeam(session)) return owned.native.interruptTeam(session);
		return false;
	}
	async stop(id: string): Promise<void> {
		const owned = this.#runtimes.get(id);
		if (!owned) return;
		if (owned.stopping) return owned.stopping;
		const stopping = (async () => {
			await owned.core.stop();
			try {
				await (await this.#owner()).saveLocal(`generation-${id}`, owned.core.status().generation);
			} finally {
				await owned.native.stop();
				owned.execution = "interrupted";
			}
		})();
		owned.stopping = stopping;
		try {
			await stopping;
		} finally {
			owned.stopping = undefined;
			await this.#emit(id);
		}
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		if (this.#disposing) return this.#disposing;
		this.#closing = true;
		const controlSettled = this.#controlSettled?.promise;
		const disposing = (async () => {
			// Preserve the lease through already-confirmed scoped commit/index/sync settlement.
			await controlSettled;
			const errors: unknown[] = [];
			for (const [id, owned] of this.#runtimes) {
				let settled = true;
				try {
					await this.stop(id);
				} catch (error) {
					settled = false;
					errors.push(error);
				}
				try {
					await owned.native.dispose();
				} catch (error) {
					settled = false;
					errors.push(error);
				}
				if (settled) this.#runtimes.delete(id);
			}
			if (this.#local) {
				let settled = true;
				try {
					await this.#local.runtime.stop();
				} catch (error) {
					settled = false;
					errors.push(error);
				}
				try {
					await this.#local.runtime.dispose();
				} catch (error) {
					settled = false;
					errors.push(error);
				}
				if (settled) this.#local = undefined;
			}
			if (errors.length > 0) throw new AggregateError(errors, "Dev 原生运行结清失败；工作区租约保留");
			for (const { unsubscribe } of this.#sessions.values()) unsubscribe();
			this.#sessions.clear();
			const { root } = await this.#identity;
			this.#workspace?.release();
			if (canonicalOwners.get(root) === this) canonicalOwners.delete(root);
			this.#workspace = undefined;
			this.#disposed = true;
		})();
		this.#disposing = disposing;
		try {
			await disposing;
		} finally {
			if (this.#disposing === disposing) this.#disposing = undefined;
		}
	}
}
