import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as url from "node:url";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AsyncJobManagerApi } from "../async/job-manager";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { cfgEditMode } from "../edit/settings";
import type { ExtensionFactory, ExtensionUIContext } from "../extensibility/extensions";
import type { Skill } from "../extensibility/skills";
import { cfgGoalEnabled } from "../goals/settings";
import { cfgTaskIsolationEnabled, cfgTaskSpeculativeLaunch, cfgWorktreeOnStart } from "../task/settings";
import { getBundledAgent } from "../task/agents";
import { isSeanceIsolationSkills } from "../task/seance-policy";
import type { NativeSubagentHooks } from "../task/types";
import { cfgToolsSpeculativeExecutionEnabled } from "../tools/settings";
import { artifactVersion, assertSpecWritePath, existingNativeSpec, matchesNativeSpecPattern } from "./artifacts";
import { cloneEmbeddingToolRestrictions, createAgentSession, type CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { isLocalAgentSession } from "../session/agent-session-handle";
import { initializeExtensions } from "../modes/runtime-init";
import { SessionManager } from "../session/session-manager";
import type { FileEntry } from "../session/session-entries";
import { applyToolProxy } from "../extensibility/tool-proxy";
import type { Tool } from "../tools";
import { ToolRestrictions } from "../session/tool-restrictions";
import { AgentRegistry, type AgentRegistryApi } from "../registry/agent-registry";
import actorTemplate from "../prompts/agents/spec-driven.md" with { type: "text" };
import taskTemplate from "../prompts/spec-driven-task.md" with { type: "text" };
import communicationPrompt from "../prompts/spec-driven-communication.md" with { type: "text" };
import type { TeamRunResult } from "../team/types";
import { hasExplicitRepairIntent } from "./orchestrator";
import { grantSpecExecutionSkills } from "./skill-policy";
import type {
	DevRequirementRecord,
	DevSolutionBasis,
	SpecAgentInput,
	SpecCandidate,
	SpecConversationReply,
	SpecDrivenStatus,
	SpecRunContext,
	SpecStageRole,
	SpecSolution,
} from "./types";

export interface SpecNativeToolBoundary {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	sessionId: string;
}

function checkNativeSolutionCandidates(candidates: readonly SpecCandidate[], entries: readonly FileEntry[]) {
	const source = entries.findLast(entry => entry.type === "custom" && entry.customType === "dev-solution-source");
	if (
		!source ||
		source.type !== "custom" ||
		!source.data ||
		typeof source.data !== "object" ||
		!("team" in source.data) ||
		typeof source.data.team !== "boolean" ||
		!("candidates" in source.data) ||
		!Array.isArray(source.data.candidates)
	)
		throw new Error("方案来源无法从真实原生阶段历史确证；请返回需求阶段并重新进入方案。");
	const attempt = entries.findLast(entry => entry.type === "custom" && entry.customType === "dev-solution-attempt");
	if (attempt && entries.indexOf(source) <= entries.indexOf(attempt))
		throw new Error("本次方案阶段尚无成功来源；先前方案不能替代失败或取消的本次 Team 讨论。");
	const originals: unknown[] = source.data.candidates;
	if (source.data.team)
		for (const candidate of candidates) {
			const original = originals.find(
				item => item && typeof item === "object" && "id" in item && item.id === candidate.id,
			);
			if (
				!original ||
				typeof original !== "object" ||
				!("adoptable" in original) ||
				original.adoptable !== true ||
				!("proposal" in original) ||
				typeof original.proposal !== "string" ||
				!original.proposal ||
				!candidate.content.includes(original.proposal)
			)
				throw new Error(`方案 ${candidate.id} 不是本轮 Team 可采用的完整候选。`);
		}
	return { entry: source, team: source.data.team };
}

/** Read native facts without creating a model session during cold record recovery. */
export function specSolutionBasisFromHistory(
	solution: SpecSolution,
	sessionId: string,
	entries: readonly FileEntry[],
): DevSolutionBasis {
	const source = checkNativeSolutionCandidates(solution.candidates, entries);
	const version = entries.findLast(entry => entry.type === "custom" && entry.customType === "dev-solution-version");
	if (
		!version ||
		entries.indexOf(version) <= entries.indexOf(source.entry) ||
		version.type !== "custom" ||
		!version.data ||
		typeof version.data !== "object" ||
		!("version" in version.data) ||
		version.data.version !== solution.version
	)
		throw new Error("方案字节版本尚未由真实原生写入确证；文件变化后须重新建立来源证明。");
	return {
		solutionVersion: solution.version,
		candidateIds: solution.candidates.map(candidate => candidate.id),
		usableCandidateIds: solution.candidates.map(candidate => candidate.id),
		source: source.team ? "team" : "single-agent",
		sourceSessionId: sessionId,
		sourceEntryIds: [source.entry.id, version.id],
	};
}

/** Recheck final native arguments, after extension transforms, at canonical dispatch. */
class SpecActorToolRestrictions extends ToolRestrictions {
	readonly #base: ToolRestrictions;
	readonly #check: (name: string, input: unknown) => Promise<void>;
	readonly #before?: (event: SpecNativeToolBoundary) => Promise<void>;
	readonly #after?: (event: SpecNativeToolBoundary & { isError: boolean }) => Promise<void>;
	readonly #cache = new WeakMap<Tool, Tool>();
	#sessionId = "";
	constructor(
		base: ToolRestrictions,
		check: (name: string, input: unknown) => Promise<void>,
		before?: (event: SpecNativeToolBoundary) => Promise<void>,
		after?: (event: SpecNativeToolBoundary & { isError: boolean }) => Promise<void>,
		options = base.snapshot(),
	) {
		super(options);
		this.#base = base;
		this.#check = check;
		this.#before = before;
		this.#after = after;
	}
	override clone(): SpecActorToolRestrictions {
		return new SpecActorToolRestrictions(this.#base, this.#check, this.#before, this.#after, this.snapshot());
	}
	bindSession(sessionId: string): void {
		this.#sessionId = sessionId;
	}
	override wrap<T extends Tool>(tool: T): T {
		const existing = this.#cache.get(tool);
		if (existing) return existing as T;
		const guarded = super.wrap(this.#base.wrap(tool));
		const execute = guarded.execute;
		const wrapped = {
			execute: async (...args: Parameters<Tool["execute"]>) => {
				await this.#check(tool.name, args[1]);
				const event: SpecNativeToolBoundary = {
					toolCallId: args[0],
					toolName: tool.name,
					input: args[1] as Record<string, unknown>,
					sessionId: this.#sessionId,
				};
				if (!event.sessionId) throw new Error("Native tool owner is not registered");
				await this.#before?.(event);
				let isError = true;
				let failure: unknown;
				try {
					await this.#check(tool.name, args[1]);
					const result = await execute.call(guarded, ...args);
					isError = false;
					return result;
				} catch (error) {
					failure = error;
					throw error;
				} finally {
					try {
						await this.#after?.({ ...event, isError });
					} catch (error) {
						if (isError)
							throw new AggregateError(
								[failure, error],
								"Native execution and owned-write journaling both failed",
							);
						throw error;
					}
				}
			},
			speculation: undefined,
		} as T;
		applyToolProxy(guarded, wrapped);
		this.#cache.set(tool, wrapped);
		this.#cache.set(wrapped, wrapped);
		return wrapped;
	}
}

export interface SpecActor {
	readonly id: string;
	readonly role: SpecStageRole;
	readonly session: AgentSession;
	request(input: SpecAgentInput, context: SpecRunContext, teamResult?: TeamRunResult): Promise<SpecConversationReply>;
	prepareConversation(input: SpecAgentInput, context: SpecRunContext): Promise<void>;
	checkSolutionCandidates(candidates: readonly SpecCandidate[]): void;
	solutionBasis(solution: SpecSolution): DevSolutionBasis;
	beginSolutionAttempt(context: SpecRunContext): void;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

/** Collect every registered descendant of `ownerId` through the actual agent parent chain. */
export function specDescendantAgentIds(registry: AgentRegistryApi, ownerId: string): string[] {
	const children = new Map<string, string[]>();
	for (const ref of registry.list()) {
		if (!ref.parentId) continue;
		const siblings = children.get(ref.parentId) ?? [];
		siblings.push(ref.id);
		children.set(ref.parentId, siblings);
	}
	const seen = new Set<string>([ownerId]);
	const descendants: string[] = [];
	const queue = [ownerId];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const child of children.get(parent) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

/** Wait for all jobs owned by `ownerId`, treating rejected jobs as settled and picking up late registrations. */
async function waitOwnedSettled(manager: AsyncJobManagerApi, ownerId: string): Promise<void> {
	const awaited = new Set<string>();
	for (;;) {
		const pending = manager.getUnsettledJobs().filter(job => job.ownerId === ownerId && !awaited.has(job.id));
		if (pending.length === 0) return;
		for (const job of pending) awaited.add(job.id);
		await Promise.all(pending.map(job => job.promise.catch(() => {})));
	}
}

/**
 * Cancel the actor and every descendant agent's jobs, then wait for actual settlement.
 * A task child owns its own background jobs, so the actor's exact-owner barrier alone
 * cannot stop an idle grandchild; this walks the registered parent chain instead.
 */
export async function cancelSpecDescendantJobs(
	manager: AsyncJobManagerApi,
	ownerId: string,
	registry: AgentRegistryApi = AgentRegistry.global(),
): Promise<boolean> {
	const targets = new Set<string>([ownerId]);
	for (let pass = 0; pass < 3; pass++) {
		for (const id of specDescendantAgentIds(registry, ownerId)) targets.add(id);
		// Native registration retains lineage even after a parent job or ref disappears.
		const jobs = manager.getUnsettledJobs();
		let discovered = true;
		while (discovered) {
			discovered = false;
			for (const [child, parent] of manager.getAgentParentLinks()) {
				if (!targets.has(parent) || targets.has(child)) continue;
				targets.add(child);
				discovered = true;
			}
		}
		for (const job of jobs) if (job.ownerId && targets.has(job.ownerId)) manager.cancel(job.id);
		await Promise.all(
			[...targets]
				.filter(id => id !== ownerId)
				.map(async id => {
					const child = registry.get(id)?.session;
					if (!child || (isLocalAgentSession(child) && child.isDisposed)) return;
					await child.abort({ clearQueuedInputs: true });
				}),
		);
		for (const id of targets) await waitOwnedSettled(manager, id);
		const remaining = manager.getUnsettledJobs();
		if (
			!specDescendantAgentIds(registry, ownerId).some(id => !targets.has(id)) &&
			!remaining.some(job => job.ownerId && targets.has(job.ownerId))
		)
			return true;
	}
	return false;
}

/** Caller owns the live producer, its independent transcript and its final disposal. */
export async function createSpecActor(args: {
	role: SpecStageRole;
	options: CreateAgentSessionOptions;
	sessionDirectory: string;
	methods?: readonly string[];
	entryMethods?: () => Promise<readonly string[]>;
	sessionFile?: string;
	checkApproved?: () => Promise<unknown>;
	getStatus?: () => SpecDrivenStatus | undefined;
	getRecord?: () => DevRequirementRecord | undefined;
	repairPaths?: () => readonly string[] | undefined;
	uiForSession?: (session: AgentSession) => ExtensionUIContext;
	observeReport?: () => void | Promise<void>;
	beginRepair?: () => Promise<void>;
	onToolStart?: (event: SpecNativeToolBoundary) => Promise<void>;
	onToolEnd?: (event: SpecNativeToolBoundary & { isError: boolean }) => Promise<void>;
	reportPath?: string;
	solutionPath?: string;
	recoverContext?: () => Promise<string>;
	executionSkills?: readonly Skill[];
	onSessionCreated?: (session: AgentSession) => (() => void) | void;
}): Promise<SpecActor> {
	const id = `spec-${args.role}-${crypto.randomUUID()}`;
	const registry = args.options.agentRegistry ?? AgentRegistry.global();
	const fixed = prompt.render(actorTemplate, { name: `spec-${args.role}` });
	const settings = (
		await (args.options.settings ??
			args.options.settingsManager ??
			Settings.loadIsolated({ cwd: args.options.cwd, agentDir: args.options.agentDir }))
	).overlay();
	cfgEditMode.override(settings, "replace");
	cfgTaskIsolationEnabled.override(settings, false);
	cfgWorktreeOnStart.override(settings, "off");
	if (args.role !== "executor") {
		cfgTaskSpeculativeLaunch.override(settings, false);
		cfgToolsSpeculativeExecutionEnabled.override(settings, false);
	}
	if (args.role === "executor") cfgGoalEnabled.override(settings, true);
	let stageOutputPaths: readonly string[] | undefined;
	let reportTurn: unknown;
	const readonlyTools = new Set([
		"read",
		"find",
		"grep",
		"glob",
		"web_search",
		"knowledge_search",
		"openwiki_search",
		"openwiki_read",
		"ask",
		"wait",
		"yield",
	]);
	const record = () => args.getRecord?.() ?? args.getStatus?.()?.record;
	const boundary = (deliveredRepair?: boolean): "full" | "report" | "repair" | "read" => {
		const facts = record();
		const status = args.getStatus?.();
		const repairing = deliveredRepair ?? repairAuthorized();
		const currentReportTurn = deliveredRepair === undefined && !!reportTurn && lastUser() === reportTurn;
		if (status?.pendingGitOperationId || status?.observedPr?.state === "merged") return "read";
		if (facts) {
			const activeRole =
				facts.stage === "planning"
					? "planner"
					: ["executing", "st", "pr", "testing"].includes(facts.stage)
						? "executor"
						: facts.stage;
			if (activeRole !== args.role) return "read";
		}
		if (
			restrictions.snapshot().denylist?.includes("spec-readonly-input") ||
			(facts && facts.lifecycle !== "active") ||
			facts?.pr?.state === "merged" ||
			facts?.stage === "testing"
		)
			return "read";
		if (
			status?.closing &&
			(status.closing.sideEffects || status.closing.archiveCleanup || status.closing.retirementCleanup)
		)
			return repairing && (args.repairPaths?.() ?? status.repairPaths)?.length ? "repair" : "read";
		if (facts?.stage === "st" || facts?.stage === "pr") {
			if (repairing && !currentReportTurn) return "full";
			return facts.stage === "st" ? "report" : "read";
		}
		if ((status?.awaitingAcceptance || reportTurn) && (!repairing || currentReportTurn)) return "read";
		return "full";
	};
	const exactWrite = async (input: unknown, paths: readonly string[]): Promise<string | undefined> => {
		const requested = input && typeof input === "object" && "path" in input ? input.path : undefined;
		if (
			typeof requested !== "string" ||
			requested.includes("://") ||
			/[\0:#?\[\]]/.test(requested.replace(/^[A-Za-z]:/, ""))
		)
			return "必须使用精确的普通文件路径。";
		const relative = path
			.relative(args.options.cwd!, path.resolve(args.options.cwd!, requested))
			.replaceAll("\\", "/");
		if (
			!paths.some(
				file =>
					path.relative(args.options.cwd!, path.resolve(args.options.cwd!, file)).replaceAll("\\", "/") ===
					relative,
			)
		)
			return `当前阶段未授权写入：${requested}`;
		await assertSpecWritePath(args.options.cwd!, relative);
		return undefined;
	};
	const stageWrite = async (input: Record<string, unknown>): Promise<void> => {
		const requested = input.path;
		if (
			typeof requested !== "string" ||
			requested.includes("://") ||
			/[\0:#?\[\]]/.test(requested.replace(/^[A-Za-z]:/, ""))
		)
			throw new Error("阶段产物必须使用精确文件路径。");
		const cwd = args.options.cwd!;
		const relative = path.relative(cwd, path.resolve(cwd, requested)).replaceAll("\\", "/");
		const paths = args.getStatus?.()?.paths;
		const outputs =
			stageOutputPaths ??
			(paths
				? args.role === "business"
					? paths.business
						? [paths.business]
						: []
					: args.role === "requirements"
						? paths.requirements
						: [args.role === "solution" ? paths.solution : paths.plan]
				: []);
		let allowed = outputs.includes(relative);
		if (!allowed && args.role === "requirements")
			for (const output of outputs) {
				if (!matchesNativeSpecPattern(output, relative)) continue;
				const capability = relative.slice(output.indexOf("*"));
				if (
					/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)+spec\.md$/.test(capability) ||
					(await existingNativeSpec(cwd, relative)) ||
					(await existingNativeSpec(cwd, `openspec/specs/${capability}`))
				) {
					allowed = true;
					break;
				}
			}
		if (!allowed) throw new Error(`未授权的阶段文件写入：${requested}`);
		await assertSpecWritePath(cwd, relative);
	};
	const assertAgentFileTarget = async (input: Record<string, unknown>): Promise<void> => {
		if (typeof input.path !== "string") throw new Error("文件写入必须指定精确路径。");
		const fileUrl = input.path.toLowerCase().startsWith("file://");
		if (input.path.includes("://") && !fileUrl) return;
		const cwd = args.options.cwd!;
		const target = path.resolve(cwd, fileUrl ? url.fileURLToPath(input.path) : input.path);
		let ancestor = target;
		const missing: string[] = [];
		for (;;) {
			try {
				ancestor = await fs.realpath(ancestor);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				missing.unshift(path.basename(ancestor));
				const parent = path.dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		const canonicalRoot = await fs.realpath(cwd);
		const canonical = path.join(ancestor, ...missing);
		const normalize = (file: string) => {
			const relative = path.relative(canonicalRoot, file).replaceAll("\\", "/");
			return process.platform === "win32" ? relative.toLowerCase() : relative;
		};
		const reserved = (relative: string) =>
			["docs/dev-requirements", ".omp/dev-workbench"].some(
				directory => relative === directory || relative.startsWith(`${directory}/`),
			);
		const ownBusiness = args.role === "business" && !record() && args.getStatus?.()?.paths?.business;
		const localBusiness = ownBusiness && normalize(target) === normalize(path.resolve(cwd, ownBusiness));
		if ((reserved(normalize(target)) || reserved(normalize(canonical))) && !localBusiness)
			throw new Error("需求决定、批准及宿主控制记录只能由工作台 owner 保存，Agent 不得直接写入。");
		try {
			if ((await fs.stat(target)).nlink > 1)
				throw new Error("无法证明硬链接写入不影响宿主控制记录；请使用无别名的普通文件。");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	const solutionWrites = new Set<string>();
	let generatedSolutionVersion: string | undefined;
	const checkCandidates = (candidates: readonly SpecCandidate[]) =>
		checkNativeSolutionCandidates(candidates, session.sessionManager.getBranch());
	const reportFile = args.reportPath ? path.resolve(args.options.cwd!, args.reportPath) : undefined;
	const reportVersion = async (): Promise<string | undefined> => {
		if (!reportFile) return undefined;
		try {
			const stat = await fs.stat(reportFile, { bigint: true });
			return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};
	let observedReport = await reportVersion();
	const reportBeforeTool = new Map<string, string | undefined>();
	let reportObservation = Promise.resolve();
	const observeChangedReport = (before: string | undefined) => {
		reportObservation = reportObservation.then(async () => {
			const current = await reportVersion();
			if (current === before || current === observedReport) return;
			observedReport = current;
			if (current === undefined) return;
			reportTurn = lastUser();
			await args.observeReport?.();
			if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
		});
		return reportObservation;
	};
	let needsRecovery = !!args.recoverContext;
	const lastUser = () => session?.messages.findLast(message => message.role === "user");
	const repairAuthorized = () => {
		const user = lastUser();
		if (!user || user.role !== "user") return false;
		const text =
			typeof user.content === "string"
				? user.content
				: user.content
						.filter(item => item.type === "text")
						.map(item => item.text)
						.join("\n");
		return hasExplicitRepairIntent(text);
	};
	const validateScoutTask = (input: unknown): string | undefined => {
		if (!input || typeof input !== "object") return undefined;
		const call = input as Record<string, unknown>;
		const items = Array.isArray(call.tasks) ? [call, ...call.tasks] : [call];
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			const fields = item as Record<string, unknown>;
			if (typeof fields.agent === "string" && fields.agent.trim() && fields.agent.trim() !== "scout")
				return "执行确认前只能派发 scout 调查子代理。";
			if ("tools" in fields || fields.isolated === true || fields.worktree)
				return "scout 不允许注入工具或创建 worktree。";
		}
		return undefined;
	};
	const checkScoutAdmission = async () => {
		const manager = session.asyncJobManager;
		if (manager) {
			const owners = new Set([id, ...specDescendantAgentIds(registry, id)]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const [child, parent] of manager.getAgentParentLinks()) {
					if (!owners.has(parent) || owners.has(child)) continue;
					owners.add(child);
					changed = true;
				}
			}
			if (
				manager.getUnsettledJobs().some(job => job.status === "cancelled" && job.ownerId && owners.has(job.ownerId))
			)
				throw new Error("已取消的原生工作尚未结清，不得派发新的协作。");
		}
		const approval = await args.checkApproved?.();
		if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
			throw new Error("正式批准版本已变化，不得继续协作。");
		if (boundary() !== "full") throw new Error("当前交付边界不允许继续派发协作。");
	};
	const inheritedRestrictions =
		args.options.toolRestrictions?.clone() ??
		cloneEmbeddingToolRestrictions(args.options.modelRegistry) ??
		new ToolRestrictions();
	const restrictions: SpecActorToolRestrictions = new SpecActorToolRestrictions(
		inheritedRestrictions,
		async (name, value) => {
			if (readonlyTools.has(name)) return;
			const mode = boundary();
			const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			if (name === "write" || name === "edit") await assertAgentFileTarget(input);
			if (mode === "read") throw new Error("当前阶段只读；未证明写隔离的测试或工具不可执行。");
			const approved = await args.checkApproved?.();
			if (approved && typeof approved === "object" && "matches" in approved && !approved.matches)
				throw new Error("正式批准版本已变化，须返回相应阶段重新确认。");
			if (mode === "repair" || mode === "report") {
				if (name !== "write" && name !== "edit")
					throw new Error("限定修复只允许精确文件写入；命令执行没有写隔离证明。");
				const reason = await exactWrite(
					input,
					mode === "report"
						? args.reportPath
							? [args.reportPath]
							: []
						: (args.repairPaths?.() ?? args.getStatus?.()?.repairPaths ?? []),
				);
				if (reason) throw new Error(reason);
			} else if (args.role !== "executor" && ["write", "edit"].includes(name)) await stageWrite(input);
			else if (args.role !== "executor" && name !== "task") throw new Error("当前阶段不开放此执行工具。");
		},
		args.onToolStart,
		args.onToolEnd,
	);
	const business = args.role === "business";
	const scout = args.role === "executor" || business ? undefined : getBundledAgent("scout");
	if (args.role !== "executor" && !business && !scout) throw new Error("Bundled scout agent is unavailable");
	const scoutHooks: NativeSubagentHooks = {
		async beforeSpawn(request) {
			await checkScoutAdmission();
			if (
				request.invocationKind !== "task" ||
				(request.agent?.trim() || "scout") !== "scout" ||
				request.isolation?.requested ||
				request.customTools?.length
			)
				throw new Error("执行确认前只能派发无额外工具和 worktree 的 scout。");
		},
		async configureSession() {
			const childRestrictions = restrictions.clone();
			return {
				toolNames: ["read", "find", "grep", "glob", "web_search", "yield"],
				toolRestrictions: childRestrictions,
				extensionProviderOwnership: "inherited",
				restrictToolNames: true,
				allowRestrictedCustomTools: false,
				customTools: [],
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				subagentHooks: undefined,
				onSessionCreated(child) {
					childRestrictions.bindSession(child.sessionId);
				},
			};
		},
	};
	const executorHooks: NativeSubagentHooks = {
		async beforeSpawn(request) {
			await checkScoutAdmission();
			if (request.isolation?.requested) throw new Error("Dev 协作不得创建 worktree。");
		},
		async configureSession(_request, options) {
			const childRestrictions = restrictions.clone();
			return {
				toolRestrictions: childRestrictions,
				extensionProviderOwnership: "inherited",
				preloadedPreparedExtensions: [
					...(options.preloadedPreparedExtensions ?? []).filter(
						extension => extension.path !== "<spec-stage-write-guard>",
					),
					{
						path: "<spec-stage-write-guard>",
						resolvedPath: "<spec-stage-write-guard>",
						factory: writeGuard,
						error: null,
					},
				],
				...(options.restrictToolNames || options.toolNames ? { restrictToolNames: true } : {}),
				...(!options.restrictToolNames && !options.toolNames && args.options.customTools?.length
					? {
							customTools: [
								...args.options.customTools.filter(
									tool => !options.customTools?.some(existing => existing.name === tool.name),
								),
								...(options.customTools ?? []),
							],
						}
					: {}),
				// Seance isolation strips the inherited catalog. Restore only the
				// execution resources explicitly granted to this Dev chain.
				skills: isSeanceIsolationSkills(options.skills)
					? [...(args.executionSkills ?? [])]
					: (options.skills ?? args.options.skills),
				subagentHooks: executorHooks,
				onSessionCreated(child) {
					childRestrictions.bindSession(child.sessionId);
					child.addDisposer(grantSpecExecutionSkills(child.sessionManager, args.executionSkills ?? []));
				},
			};
		},
	};
	const writeGuard: ExtensionFactory = pi => {
		pi.on("before_agent_start", async () => {
			if (record() && record()?.lifecycle !== "active") {
				session.agent.abort("当前需求不接受新的自主执行轮次。");
				session.clearQueue();
				if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
				return;
			}
			if (!needsRecovery || !args.recoverContext) return;
			const content = await args.recoverContext();
			needsRecovery = false;
			return { message: { customType: "dev-history-recovery", display: false, content } };
		});
		pi.on("tool_call", async (event, ctx) => {
			const builtin = pi.getAllTools().find(tool => tool.name === event.toolName)?.sourceInfo.source === "builtin";
			if (!builtin && (boundary() !== "full" || args.role !== "executor"))
				return { block: true, reason: "本阶段无法证明自定义、扩展或 MCP 工具满足文件写隔离。" };
			const mode = boundary();
			if (mode !== "full") {
				if (readonlyTools.has(event.toolName)) return undefined;
				if ((mode === "report" || mode === "repair") && ["write", "edit"].includes(event.toolName)) {
					try {
						const approved = await args.checkApproved?.();
						if (approved && typeof approved === "object" && "matches" in approved && !approved.matches)
							return { block: true, reason: "正式批准版本已变化，须返回相应阶段重新确认。" };
						const paths =
							mode === "report"
								? args.reportPath
									? [args.reportPath]
									: []
								: (args.repairPaths?.() ?? args.getStatus?.()?.repairPaths ?? []);
						const reason = await exactWrite(event.input, paths);
						if (reason) return { block: true, reason };
						reportBeforeTool.set(event.toolCallId, await reportVersion());
						return undefined;
					} catch (error) {
						return { block: true, reason: error instanceof Error ? error.message : String(error) };
					}
				}
				return {
					block: true,
					reason:
						"当前阶段只开放受限读取或精确文档修复；无法证明写隔离的命令、自定义工具、MCP、eval 和协作执行均被阻止。",
				};
			}
			if (business) {
				if (ctx.sessionManager.getSessionId() !== session.sessionId)
					return { block: true, reason: "业务阶段不得派发子代理。" };
				if (["read", "knowledge_search", "openwiki_search", "openwiki_read", "ask"].includes(event.toolName))
					return undefined;
				if (event.toolName !== "write" && event.toolName !== "edit")
					return { block: true, reason: "业务阶段只允许读取资料和写入指定业务文档。" };
			}
			if (args.role !== "executor" && ctx.sessionManager.getSessionId() !== session.sessionId) {
				if (["read", "find", "grep", "glob", "web_search", "yield"].includes(event.toolName)) return undefined;
				return { block: true, reason: "scout 只允许使用只读调查工具。" };
			}
			// Native questions do not write files or grant approval for subsequent tools.
			if (["read", "grep", "glob", "knowledge_search", "ask"].includes(event.toolName)) return undefined;
			try {
				const approval = await args.checkApproved?.();
				if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
					return { block: true, reason: "正式批准版本已变化，请返回对应阶段重新确认。" };
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			if (reportTurn && lastUser() === reportTurn)
				return { block: true, reason: "当前阶段只允许读取；请在新一轮明确请求修复。" };
			if (event.toolName === "task" && event.input.worktree)
				return { block: true, reason: "Dev 协作不得创建 worktree。" };
			if (event.toolName === "bash" && /\bgit\s+worktree\s+add\b/i.test(String(event.input.command ?? "")))
				return { block: true, reason: "Dev 不得创建 worktree。" };
			if (event.toolName === "task" && args.role !== "executor") {
				const error = validateScoutTask(event.input);
				if (error) return { block: true, reason: error };
				return undefined;
			}
			if (args.role === "executor") {
				reportBeforeTool.set(event.toolCallId, await reportVersion());
				return undefined;
			}
			if (event.toolName !== "write" && event.toolName !== "edit")
				return { block: true, reason: "执行确认前只能写本阶段的指定产物。" };
			try {
				await stageWrite(event.input);
				if (args.role === "solution") solutionWrites.add(event.toolCallId);
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			return undefined;
		});
		pi.on("tool_result", async event => {
			if (solutionWrites.delete(event.toolCallId) && !event.isError && args.solutionPath) {
				const bytes = await fs.readFile(path.resolve(args.options.cwd!, args.solutionPath));
				generatedSolutionVersion = artifactVersion(bytes);
			}
			if (reportBeforeTool.has(event.toolCallId)) {
				const before = reportBeforeTool.get(event.toolCallId);
				reportBeforeTool.delete(event.toolCallId);
				await observeChangedReport(before);
			}
		});
		pi.on("before_agent_start", async (event, ctx) => {
			let valid = true;
			try {
				const approval = await args.checkApproved?.();
				valid = !(approval && typeof approval === "object" && "matches" in approval && !approval.matches);
			} catch {
				valid = false;
			}
			const status = args.getStatus?.();
			const explicitRepair = hasExplicitRepairIntent(event.prompt);
			if (
				ctx.sessionManager.getSessionId() === session.sessionId &&
				valid &&
				(status?.awaitingAcceptance || ["executing", "st", "pr"].includes(record()?.stage ?? "")) &&
				boundary(explicitRepair) === "full" &&
				explicitRepair
			) {
				await args.beginRepair?.();
				reportTurn = undefined;
			}
			// Keep read-only explanations available after invalidation; tool_call is authoritative for writes.
			if (
				(!valid || boundary() !== "full" || (reportTurn && lastUser() === reportTurn)) &&
				session.getGoalModeState()?.enabled
			)
				await session.goalRuntime.pauseGoal();
			const facts = args.getStatus?.();
			if (facts && (facts.blockedReason || facts.closing || facts.awaitingAcceptance || boundary() !== "full")) {
				return {
					message: {
						customType: "dev-lifecycle-facts",
						display: false,
						content: JSON.stringify({
							error: facts.blockedReason,
							closing: facts.closing,
							awaitingAcceptance: facts.awaitingAcceptance === true,
							writeBoundary: boundary(),
							stage: record()?.stage,
							lifecycle: record()?.lifecycle,
							merged: facts.observedPr?.state === "merged" || record()?.pr?.state === "merged",
							observedPr: facts.observedPr ?? null,
							approvedVersionsMatch: valid,
							explicitRepair,
						}),
					},
				};
			}
		});
		pi.on("before_subagent_spawn", async event => {
			if (business) return { block: true, reason: "业务阶段不得派发子代理。" };
			if (args.role !== "executor" && (event.invocationKind !== "task" || event.agent !== "scout"))
				return { block: true, reason: "执行确认前只能派发 scout 调查子代理。" };
			try {
				const approval = await args.checkApproved?.();
				if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
					return { block: true, reason: "正式批准版本已变化，不得继续协作。" };
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			if (boundary() !== "full") return { block: true, reason: "当前交付边界不允许继续派发协作。" };
		});
	};
	const created = await createAgentSession({
		...args.options,
		extensionProviderOwnership: "inherited",
		interactionParentSessionId: undefined,
		settings,
		editMode: "replace",
		toolRestrictions: restrictions,
		...(business
			? {
					toolNames: ["read", "knowledge_search", "openwiki_search", "openwiki_read", "ask", "write", "edit"],
					restrictToolNames: true,
					disableExtensionDiscovery: true,
					allowRestrictedCustomTools: false,
					customTools: [],
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					spawns: "",
					subagentHooks: undefined,
				}
			: {}),
		...(scout
			? {
					restrictToolNames: true,
					disableExtensionDiscovery: true,
					allowRestrictedCustomTools: false,
					customTools: [],
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					spawns: "scout",
					getAgentDefinitions: () => [
						{ ...scout, tools: ["read", "find", "grep", "glob", "web_search"], spawns: [], blocking: true },
					],
					subagentHooks: scoutHooks,
				}
			: {}),
		...(args.role === "executor"
			? {
					allowRestrictedGoal: true,
					subagentHooks: executorHooks,
					...(args.options.toolNames ? { toolNames: [...new Set([...args.options.toolNames, "goal"])] } : {}),
				}
			: {}),
		agentId: id,
		parentTaskPrefix: id,
		expectedAgentRef: null,
		initialAgentStatus: "idle",
		bindProcessState: false,
		agentRegistry: registry,
		sessionManager:
			args.options.sessionManager ??
			(args.sessionFile
				? await SessionManager.open(args.sessionFile, args.sessionDirectory)
				: SessionManager.create(args.options.cwd!, args.sessionDirectory)),
		requireYieldTool: false,
		// Bind the safety factory even when the native parent supplied prepared extensions.
		preloadedPreparedExtensions: [
			...(args.options.preloadedPreparedExtensions ?? []).filter(
				extension => extension.path !== "<spec-stage-write-guard>",
			),
			...(args.options.extensions ?? []).map((factory, index) => ({
				path: `<spec-inline:${index}>`,
				resolvedPath: `<spec-inline:${index}>`,
				factory,
				error: null,
			})),
			{
				path: "<spec-stage-write-guard>",
				resolvedPath: "<spec-stage-write-guard>",
				factory: writeGuard,
				error: null,
			},
		],
		systemPrompt: defaults => [...defaults, ...(args.methods ?? []), fixed, communicationPrompt],
	});
	const session = created.session;
	restrictions.bindSession(session.sessionId);
	session.addDisposer(
		session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				generatedSolutionVersion = undefined;
				return;
			}
			if (event.message.stopReason === "stop" && generatedSolutionVersion && args.role === "solution") {
				session.sessionManager.appendCustomEntry("dev-solution-version", { version: generatedSolutionVersion });
				generatedSolutionVersion = undefined;
			}
		}),
	);
	if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
	const ref = registry.get(id);
	const unsubscribeRunState = registry.syncSessionStatus(id, session);
	session.addDisposer(() => {
		unsubscribeRunState();
		registry.unregister(id, ref ?? session);
	});
	let disposed = false;
	let runId: string | undefined;
	let release: (() => void) | void;
	let scopedInteraction: { ui: ExtensionUIContext; cancel(): void; dispose(): void } | undefined;
	try {
		release = args.onSessionCreated?.(session);
		if (release) session.addDisposer(release);
		let ui = args.uiForSession?.(session) ?? created.interactionUI;
		if (!ui && args.options.createInteractionUI) {
			scopedInteraction = args.options.createInteractionUI({
				agentId: id,
				agentName: id,
				sessionId: session.sessionId,
				parentSessionId: session.sessionId,
			});
			ui = scopedInteraction.ui;
			const interaction = scopedInteraction;
			session.addDisposer(() => interaction.dispose());
		}
		if (ui) created.setToolUIContext(ui, true, args.options.createInteractionUI);
		await initializeExtensions(session, {
			uiContext: ui,
			reportSendError: (_action, error) => {
				session.agent.abort(error.message);
			},
			reportRuntimeError: error => {
				session.agent.abort(error.error);
			},
		});
	} catch (error) {
		await session.dispose();
		registry.unregister(id, ref ?? session);
		throw error;
	}
	const owned = (context: SpecRunContext): void => {
		context.signal.throwIfAborted();
		if (disposed || session.isDisposed || registry.get(id) !== ref || ref?.session !== session)
			throw new Error("Specification producer ownership changed");
		if (runId && runId !== context.runId) throw new Error("Specification producer belongs to another run");
		runId = context.runId;
	};
	const perform = async <T>(context: SpecRunContext, operation: () => Promise<T>): Promise<T> => {
		owned(context);
		let abortCompletion: Promise<void> | undefined;
		let cancellationCompletion: Promise<boolean> | undefined;
		const abort = () => {
			scopedInteraction?.cancel();
			// Keep the cancellation barrier until the native prompt, tools and descendants settle.
			if (session.asyncJobManager) {
				cancellationCompletion ??= cancelSpecDescendantJobs(session.asyncJobManager, id, registry);
				void cancellationCompletion.catch(() => {});
			}
			abortCompletion ??= (async () => {
				if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
				session.clearQueue();
				await session.abort();
			})();
			void abortCompletion.catch(() => {});
		};
		context.signal.addEventListener("abort", abort, { once: true });
		type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
		let outcome: Outcome;
		try {
			const value = await operation();
			owned(context);
			outcome = { ok: true, value };
		} catch (error) {
			outcome = { ok: false, error };
		}
		let barrierError: unknown;
		try {
			if (context.signal.aborted) abort();
			let settled = cancellationCompletion ? await cancellationCompletion : true;
			await abortCompletion;
			if (context.signal.aborted && session.asyncJobManager) {
				const afterAbort = await cancelSpecDescendantJobs(session.asyncJobManager, id, registry);
				settled = settled && afterAbort;
			}
			if (!settled) throw new Error("Descendant cancellation was not confirmed");
		} catch (error) {
			barrierError = error;
		} finally {
			context.signal.removeEventListener("abort", abort);
		}
		if (barrierError) throw barrierError;
		context.signal.throwIfAborted();
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	};
	let hydrated = session.sessionManager
		.getBranch()
		.some(entry => entry.type === "custom_message" && entry.customType === "dev-stage-context");
	const prepareConversation = async (
		input: SpecAgentInput,
		context: SpecRunContext,
		teamResult?: TeamRunResult,
		establishSource = false,
	): Promise<void> => {
		owned(context);
		if (!establishSource && hydrated) return;
		const entryMethods = (await args.entryMethods?.()) ?? [];
		owned(context);
		if (needsRecovery && args.recoverContext) {
			await session.sendCustomMessage(
				{ customType: "dev-history-recovery", display: false, content: await args.recoverContext() },
				{ triggerTurn: false },
			);
		}
		needsRecovery = false;
		if (establishSource) reportTurn = undefined;
		if (establishSource && input.role === "business" && input.request)
			session.sessionManager.appendCustomEntry("dev-original-interview", { available: true });
		if (input.role === "solution" && establishSource) {
			if (input.useTeam && teamResult?.status !== "completed") throw new Error("Team 来源未成功完成。");
			session.sessionManager.appendCustomEntry("dev-solution-source", {
				team: input.useTeam === true,
				candidates: teamResult?.candidates ?? [],
			});
		}
		if (input.outputPaths.length) stageOutputPaths = input.outputPaths;
		const { images: _images, imageLinks: _imageLinks, ...handoff } = input;
		await session.sendCustomMessage(
			{
				customType: "dev-stage-context",
				display: false,
				content: [
					...entryMethods,
					prompt.render(taskTemplate, {
						payload: JSON.stringify(
							{
								...handoff,
								stage: record()?.stage,
								lifecycle: record()?.lifecycle,
								merged: args.getStatus?.()?.observedPr?.state === "merged" || record()?.pr?.state === "merged",
								observedPr: args.getStatus?.()?.observedPr ?? null,
								originalRequestAvailable: input.request.length > 0,
							},
							null,
							2,
						),
						teamResult: teamResult ? JSON.stringify(teamResult, null, 2) : undefined,
					}),
				].join("\n\n"),
			},
			{ triggerTurn: false },
		);
		hydrated = true;
	};
	let hydration: Promise<void> | undefined;
	const hydrateConversation = (input: SpecAgentInput, context: SpecRunContext): Promise<void> => {
		owned(context);
		if (hydrated) return Promise.resolve();
		if (hydration) return hydration;
		const operation = prepareConversation(input, context).finally(() => {
			if (hydration === operation) hydration = undefined;
		});
		hydration = operation;
		return operation;
	};
	return {
		id,
		role: args.role,
		session,
		beginSolutionAttempt(context) {
			owned(context);
			if (args.role !== "solution") throw new Error("Only the solution actor owns solution attempts");
			generatedSolutionVersion = undefined;
			solutionWrites.clear();
			session.sessionManager.appendCustomEntry("dev-solution-attempt", { generation: context.generation });
		},
		prepareConversation: hydrateConversation,
		checkSolutionCandidates: checkCandidates,
		solutionBasis: solution =>
			specSolutionBasisFromHistory(solution, session.sessionId, session.sessionManager.getBranch()),
		async request(input, context, teamResult) {
			owned(context);
			if (input.entry) await prepareConversation(input, context, teamResult, true);
			owned(context);
			const task = input.entry ? input.userReply || input.request : (input.feedback ?? "");
			// Queue restrictions travel with the native input, never mutate the running turn.
			const toolDenylist = input.readOnly
				? [
						"spec-readonly-input",
						...session
							.getAllToolInfos()
							.filter(tool => !readonlyTools.has(tool.name))
							.map(tool => tool.name),
					]
				: [];
			if (input.outputPaths.length) stageOutputPaths = input.outputPaths;
			const queued = session.isStreaming;
			if (queued) {
				await session.prompt(task, {
					images: input.images,
					streamingBehavior: "followUp",
					toolDenylist,
					expandPromptTemplates: false,
					runCommands: false,
					throwOnDrop: true,
				});
				return { text: "" };
			}
			generatedSolutionVersion = undefined;
			return perform(context, async () => {
				let message: AssistantMessage | undefined;
				const unsubscribe = session.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "assistant") message = event.message;
				});
				try {
					await session.prompt(task, {
						images: input.images,
						streamingBehavior: "followUp",
						toolDenylist,
						expandPromptTemplates: false,
						runCommands: false,
						throwOnDrop: true,
					});
				} finally {
					unsubscribe();
				}
				if (!message || message.stopReason === "error" || message.stopReason === "aborted")
					throw new Error(
						`Native ${args.role} produced no successful assistant result${message?.errorMessage ? `: ${message.errorMessage}` : ""}`,
					);
				return {
					text: message.content
						.filter(item => item.type === "text")
						.map(item => item.text)
						.join("\n"),
				};
			});
		},
		async stop() {
			scopedInteraction?.cancel();
			if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
			session.clearQueue();
			await session.abort();
			if (session.asyncJobManager && !(await cancelSpecDescendantJobs(session.asyncJobManager, id, registry)))
				throw new Error("Descendant cancellation was not confirmed");
		},
		async dispose() {
			if (disposed) return;
			scopedInteraction?.cancel();
			if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
			session.clearQueue();
			await session.abort();
			if (session.asyncJobManager && !(await cancelSpecDescendantJobs(session.asyncJobManager, id, registry)))
				throw new Error("Descendant cancellation was not confirmed");
			await session.dispose();
			disposed = true;
			registry.unregister(id, ref ?? session);
		},
	};
}
