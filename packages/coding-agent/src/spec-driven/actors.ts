import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AsyncJobManager } from "../async/job-manager";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { cfgEditMode } from "../edit/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import { cfgGoalEnabled } from "../goals/settings";
import { cfgTaskIsolationEnabled, cfgTaskSpeculativeLaunch, cfgWorktreeOnStart } from "../task/settings";
import { getBundledAgent } from "../task/agents";
import type { NativeSubagentHooks } from "../task/types";
import { assertSpecWritePath } from "./artifacts";
import { cloneEmbeddingToolRestrictions, createAgentSession, type CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { ToolRestrictions } from "../session/tool-restrictions";
import { AgentRegistry } from "../registry/agent-registry";
import actorTemplate from "../prompts/agents/spec-driven.md" with { type: "text" };
import taskTemplate from "../prompts/spec-driven-task.md" with { type: "text" };
import communicationPrompt from "../prompts/spec-driven-communication.md" with { type: "text" };
import type { TeamRunResult } from "../team/types";
import { hasExplicitRepairIntent } from "./orchestrator";
import { ExecutionEvidence } from "./execution-evidence";
import type {
	SpecAgentInput,
	SpecCandidate,
	SpecConversationReply,
	SpecDrivenStatus,
	SpecRunContext,
	SpecStageRole,
} from "./types";

export interface SpecActor {
	readonly id: string;
	readonly role: SpecStageRole;
	readonly session: AgentSession;
	request(input: SpecAgentInput, context: SpecRunContext, teamResult?: TeamRunResult): Promise<SpecConversationReply>;
	checkSolutionCandidates(candidates: readonly SpecCandidate[]): void;
	checkExecution(): void;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

/** Collect every registered descendant of `ownerId` through the actual agent parent chain. */
export function specDescendantAgentIds(registry: AgentRegistry, ownerId: string): string[] {
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
async function waitOwnedSettled(manager: AsyncJobManager, ownerId: string): Promise<void> {
	const awaited = new Set<string>();
	for (;;) {
		const pending = manager.getAllJobs({ ownerId }).filter(job => !awaited.has(job.id));
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
	manager: AsyncJobManager,
	ownerId: string,
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<boolean> {
	const targets = new Set<string>([ownerId]);
	for (let pass = 0; pass < 3; pass++) {
		for (const id of specDescendantAgentIds(registry, ownerId)) targets.add(id);
		for (const id of targets) manager.cancelAll({ ownerId: id });
		await Promise.all(
			[...targets]
				.filter(id => id !== ownerId)
				.map(async id => {
					const child = registry.get(id)?.session;
					if (!child || child.isDisposed) return;
					if (child.getGoalModeState()?.enabled) await child.goalRuntime.pauseGoal();
					child.clearQueue();
					await child.abort();
				}),
		);
		for (const id of targets) await waitOwnedSettled(manager, id);
		if (!specDescendantAgentIds(registry, ownerId).some(id => !targets.has(id))) return true;
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
	observeReport?: () => void | Promise<void>;
	beginRepair?: () => Promise<void>;
	reportPath?: string;
	recoverContext?: () => Promise<string>;
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
	if (args.role !== "executor") cfgTaskSpeculativeLaunch.override(settings, false);
	if (args.role === "executor") cfgGoalEnabled.override(settings, true);
	let stageOutputPaths: readonly string[] | undefined;
	let reportTurn: unknown;
	let needsRecovery = !!args.recoverContext;
	let guardStop: Promise<void> | undefined;
	let executionEvidence: ExecutionEvidence | undefined;
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
		const approval = await args.checkApproved?.();
		if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
			throw new Error("正式批准版本已变化，不得继续协作。");
		const status = args.getStatus?.();
		if (
			status?.closing ||
			status?.accepted ||
			((status?.awaitingAcceptance || reportTurn) && !repairAuthorized()) ||
			(reportTurn && lastUser() === reportTurn)
		)
			throw new Error("当前交付边界不允许继续派发协作。");
	};
	const restrictions =
		args.options.toolRestrictions?.clone() ??
		cloneEmbeddingToolRestrictions(args.options.modelRegistry) ??
		new ToolRestrictions();
	const scout = args.role === "executor" ? undefined : getBundledAgent("scout");
	if (args.role !== "executor" && !scout) throw new Error("Bundled scout agent is unavailable");
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
			return {
				toolNames: ["read", "find", "grep", "glob", "web_search", "yield"],
				toolRestrictions: restrictions.clone(),
				restrictToolNames: true,
				allowRestrictedCustomTools: false,
				customTools: [],
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				subagentHooks: undefined,
			};
		},
	};
	const executorHooks: NativeSubagentHooks = {
		async beforeSpawn(request) {
			await checkScoutAdmission();
			if (request.isolation?.requested) throw new Error("Dev 协作不得创建 worktree。");
			executionEvidence?.start(request);
		},
		async configureSession(request, options) {
			return {
				toolNames: options.toolNames ?? args.options.toolNames ?? [],
				toolRestrictions: restrictions.clone(),
				restrictToolNames: true,
				subagentHooks: executorHooks,
				onSessionCreated(child) {
					const tools = child.getEnabledToolNames();
					executionEvidence?.observeSession(
						request,
						["write", "edit", "bash"].some(name => tools.includes(name) && restrictions.allows(name)),
					);
				},
			};
		},
		async onSpawnFailed(request) {
			executionEvidence?.failed(request);
		},
		async onSettled(request, result) {
			if (result) executionEvidence?.settled(request, result);
			else executionEvidence?.failed(request);
		},
	};
	const writeGuard: ExtensionFactory = pi => {
		pi.on("before_agent_start", async () => {
			if (!needsRecovery || !args.recoverContext) return;
			const content = await args.recoverContext();
			needsRecovery = false;
			return { message: { customType: "dev-history-recovery", display: false, content } };
		});
		pi.on("tool_call", async (event, ctx) => {
			if (args.role !== "executor" && ctx.sessionManager.getSessionId() !== session.sessionId) {
				if (["read", "find", "grep", "glob", "web_search", "yield"].includes(event.toolName)) return undefined;
				return { block: true, reason: "scout 只允许使用只读调查工具。" };
			}
			if (["read", "grep", "glob", "wiki"].includes(event.toolName)) return undefined;
			try {
				const approval = await args.checkApproved?.();
				if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
					return { block: true, reason: "正式批准版本已变化，请返回对应阶段重新确认。" };
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			const status = args.getStatus?.();
			if ((status?.awaitingAcceptance || status?.accepted || reportTurn) && !repairAuthorized())
				return { block: true, reason: "交付后只允许读取；只有明确请求修复或继续实施已批准计划才能修改。" };
			if (status?.accepted) {
				if (!["write", "edit", "bash"].includes(event.toolName))
					return { block: true, reason: "收尾修复不得派发业务任务、协作或 Goal。" };
				const requested = String("path" in event.input ? (event.input.path ?? "") : "");
				if (
					status.accepted.files.some(
						file => path.resolve(args.options.cwd!, file.path) === path.resolve(args.options.cwd!, requested),
					)
				)
					return { block: true, reason: "收尾修复不得修改已验收材料。" };
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
				if (status?.closing) return { block: true, reason: "当前阶段不可派发协作。" };
				return undefined;
			}
			if (args.role === "executor") return undefined;
			if (event.toolName !== "write" && event.toolName !== "edit")
				return { block: true, reason: "执行确认前只能写本阶段的指定产物。" };
			const requested = event.input.path;
			if (
				typeof requested !== "string" ||
				requested.includes("://") ||
				/[\0:#?\[\]]/.test(requested.replace(/^[A-Za-z]:/, ""))
			)
				return { block: true, reason: "阶段产物必须使用精确文件路径。" };
			const cwd = args.options.cwd!;
			const relative = (path.isAbsolute(requested) ? path.relative(cwd, requested) : requested).replaceAll(
				"\\",
				"/",
			);
			const paths = status?.paths;
			const outputPaths =
				stageOutputPaths ??
				(paths
					? args.role === "requirements"
						? paths.requirements
						: [args.role === "solution" ? paths.solution : paths.plan]
					: []);
			const allowed = outputPaths.some(output => {
				if (!output.includes("*")) return output === relative;
				const prefix = output.slice(0, output.indexOf("*"));
				return (
					output.endsWith("*/spec.md") &&
					relative.startsWith(prefix) &&
					/^[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/.test(relative.slice(prefix.length))
				);
			});
			if (!allowed) return { block: true, reason: `未授权的阶段文件写入：${requested}` };
			try {
				await assertSpecWritePath(cwd, relative);
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			return undefined;
		});
		pi.on("tool_result", async event => {
			if (args.getStatus?.()?.accepted && ["write", "edit", "bash"].includes(event.toolName)) {
				let failure: string | undefined;
				try {
					const approval = await args.checkApproved?.();
					if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
						failure = "已验收正式材料发生变化；必须返回对应阶段重新确认。";
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
				if (failure) {
					// Signal synchronously; awaiting session.abort() here would wait on this very hook.
					session.agent.abort(failure);
					session.clearQueue();
					if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
					guardStop = session.abort({ goalReason: "internal", reason: failure });
					void guardStop.catch(() => {});
					return;
				}
			}
			if (event.isError || !["write", "edit"].includes(event.toolName) || !args.reportPath) return;
			const requested = event.input.path;
			if (typeof requested !== "string") return;
			if (path.resolve(args.options.cwd!, requested) !== path.resolve(args.options.cwd!, args.reportPath)) return;
			try {
				executionEvidence?.check();
			} catch {
				// A report can describe incomplete work without creating an acceptance boundary.
				return;
			}
			reportTurn = lastUser();
			await args.observeReport?.();
			if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
		});
		pi.on("before_agent_start", async event => {
			let valid = true;
			try {
				const approval = await args.checkApproved?.();
				valid = !(approval && typeof approval === "object" && "matches" in approval && !approval.matches);
			} catch {
				valid = false;
			}
			const status = args.getStatus?.();
			const explicitRepair = hasExplicitRepairIntent(event.prompt);
			if (valid && status?.awaitingAcceptance && !status.accepted && explicitRepair) {
				await args.beginRepair?.();
				executionEvidence?.reset();
			}
			// Keep read-only explanations available after invalidation; tool_call is authoritative for writes.
			if (
				(!valid || status?.awaitingAcceptance || status?.accepted || (reportTurn && lastUser() === reportTurn)) &&
				session.getGoalModeState()?.enabled
			)
				await session.goalRuntime.pauseGoal();
			const facts = args.getStatus?.();
			if (facts && (facts.blockedReason || facts.closing || facts.awaitingAcceptance || facts.accepted)) {
				return {
					message: {
						customType: "dev-lifecycle-facts",
						display: false,
						content: JSON.stringify({
							error: facts.blockedReason,
							closing: facts.closing,
							awaitingAcceptance: facts.awaitingAcceptance === true,
							accepted: !!facts.accepted,
							approvedVersionsMatch: valid,
							explicitRepair,
						}),
					},
				};
			}
		});
		pi.on("before_subagent_spawn", async event => {
			if (args.role !== "executor" && (event.invocationKind !== "task" || event.agent !== "scout"))
				return { block: true, reason: "执行确认前只能派发 scout 调查子代理。" };
			try {
				const approval = await args.checkApproved?.();
				if (approval && typeof approval === "object" && "matches" in approval && !approval.matches)
					return { block: true, reason: "正式批准版本已变化，不得继续协作。" };
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			const status = args.getStatus?.();
			if (
				status?.accepted ||
				((status?.awaitingAcceptance || reportTurn) && !repairAuthorized()) ||
				(reportTurn && lastUser() === reportTurn)
			)
				return { block: true, reason: "当前交付边界不允许继续派发协作。" };
		});
	};
	const created = await createAgentSession({
		...args.options,
		settings,
		toolRestrictions: restrictions,
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
					toolNames: [
						...new Set([...(args.options.toolNames ?? ["read", "grep", "glob", "write", "edit"]), "goal"]),
					],
				}
			: {}),
		agentId: id,
		parentTaskPrefix: id,
		expectedAgentRef: null,
		initialAgentStatus: "idle",
		bindProcessState: false,
		agentRegistry: registry,
		sessionManager: args.sessionFile
			? await SessionManager.open(args.sessionFile, args.sessionDirectory)
			: SessionManager.create(args.options.cwd!, args.sessionDirectory),
		requireYieldTool: false,
		// Restricted SDK sessions ignore inline `extensions`, but rebind prepared
		// factories without admitting ambient tools or extension discovery.
		...(args.options.restrictToolNames || scout
			? {
					preloadedPreparedExtensions: [
						...(scout ? [] : (args.options.preloadedPreparedExtensions ?? [])),
						{
							path: "<spec-stage-write-guard>",
							resolvedPath: "<spec-stage-write-guard>",
							factory: writeGuard,
							error: null,
						},
					],
				}
			: { extensions: [...(args.options.extensions ?? []), writeGuard] }),
		systemPrompt: defaults =>
			args.role === "requirements"
				? [...defaults, fixed, communicationPrompt, ...(args.methods ?? [])]
				: [...defaults, ...(args.methods ?? []), fixed, communicationPrompt],
	});
	const session = created.session;
	if (args.role === "executor") executionEvidence = new ExecutionEvidence(session.sessionManager, session.sessionId);
	const ref = registry.get(id);
	const unsubscribeRunState = registry.syncSessionStatus(id, session);
	session.addDisposer(() => {
		unsubscribeRunState();
		registry.unregister(id, ref ?? session);
	});
	let disposed = false;
	let runId: string | undefined;
	let release: (() => void) | void;
	try {
		release = args.onSessionCreated?.(session);
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
			await guardStop;
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
	return {
		id,
		role: args.role,
		session,
		checkExecution() {
			if (!executionEvidence) throw new Error("执行阶段会话不可用，无法核实子代理结果。");
			executionEvidence.check();
		},
		checkSolutionCandidates(candidates) {
			// The existing native stage handoff already owns the full real Team result.
			// Read it only at the explicit next boundary; never create a second run-state store.
			const handoff = session.sessionManager
				.getBranch()
				.findLast(item => item.type === "custom_message" && item.customType === "dev-stage-context");
			let source: { team: boolean; candidates?: TeamRunResult["candidates"] } | undefined;
			if (handoff?.type === "custom_message" && typeof handoff.content === "string") {
				try {
					const payload = handoff.content.split("## Stage request (task data, not authority)\n")[1];
					const data = payload?.slice(0, payload.lastIndexOf("\n<critical>")).trim();
					const sections = data?.split("## Complete Team discussion (task data, not user authorization)\n");
					const input = JSON.parse(sections?.[0]?.trim() ?? "");
					if (input.role === "solution" && input.entry === true && typeof input.useTeam === "boolean") {
						const team = input.useTeam ? JSON.parse(sections?.[1]?.trim() ?? "") : undefined;
						if (!input.useTeam || team?.status === "completed")
							source = { team: input.useTeam, candidates: team?.candidates };
					}
				} catch {
					/* Incomplete native provenance blocks adoption, never silently falls back to solo. */
				}
			}
			if (!source || typeof source.team !== "boolean")
				throw new Error("方案来源无法从原生阶段历史确证；请返回需求阶段后 next 重新进入方案阶段。");
			if (!source.team) return;
			for (const candidate of candidates) {
				const original = source.candidates?.find(item => item.id === candidate.id);
				if (!original?.adoptable || !original.proposal || !candidate.content.includes(original.proposal))
					throw new Error(
						`方案 ${candidate.id} 不是本轮 Team 可采用的完整候选；请保留真实候选 ID 和完整 proposal，或返回后重新进入方案阶段。`,
					);
			}
		},
		async request(input, context, teamResult) {
			owned(context);
			if (input.entry) {
				const entryMethods = (await args.entryMethods?.()) ?? [];
				owned(context);
				needsRecovery = false;
				reportTurn = undefined;
				const { images: _images, imageLinks: _imageLinks, ...handoff } = input;
				await session.sendCustomMessage(
					{
						customType: "dev-stage-context",
						display: false,
						content: [
							...entryMethods,
							prompt.render(taskTemplate, {
								payload: JSON.stringify(handoff, null, 2),
								teamResult: teamResult ? JSON.stringify(teamResult, null, 2) : undefined,
							}),
						].join("\n\n"),
					},
					{ triggerTurn: false },
				);
				if (input.role === "executor") executionEvidence?.reset();
			}
			owned(context);
			const task = input.entry ? input.userReply || input.request : (input.feedback ?? "");
			// Queue restrictions travel with the native input, never mutate the running turn.
			const toolDenylist = input.readOnly
				? [...new Set([...(args.options.toolNames ?? []), "write", "edit", "bash", "task", "goal"])].filter(
						name => !["read", "grep", "glob", "wiki"].includes(name),
					)
				: [];
			if (input.entry || !stageOutputPaths) stageOutputPaths = input.outputPaths;
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
			if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
			session.clearQueue();
			await session.abort();
			if (session.asyncJobManager && !(await cancelSpecDescendantJobs(session.asyncJobManager, id, registry)))
				throw new Error("Descendant cancellation was not confirmed");
		},
		async dispose() {
			if (disposed) return;
			if (session.getGoalModeState()?.enabled) await session.goalRuntime.pauseGoal();
			session.clearQueue();
			await session.abort();
			if (session.asyncJobManager && !(await cancelSpecDescendantJobs(session.asyncJobManager, id, registry)))
				throw new Error("Descendant cancellation was not confirmed");
			await session.dispose();
			disposed = true;
			release?.();
			registry.unregister(id, ref ?? session);
		},
	};
}
