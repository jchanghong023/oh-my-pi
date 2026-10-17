/**
 * `/team` command controller.
 *
 * Bridges the slash command to the orchestrator through the session's async
 * job manager (the /tan precedent): the job signal is the command's
 * cancellation signal and propagates into every subagent; stage progress rides
 * the existing job/status surfaces (no new TUI panels — child detail stays in
 * the Agent Hub); the final report lands as one markdown message in the
 * transcript via `appendCustomMessage`, never as a model-facing delivery.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobError, type AsyncJobRunResult } from "../async";
import { filterAvailableModelsByEnabledPatterns, formatModelStringWithRouting } from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import { isJchToolsAgentModel } from "../config/jchtools-provider";
import type { Settings } from "../config/settings";
import { cfgTaskMaxConcurrency } from "../task/settings";
import { cfgTeamMembers } from "./settings";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { runTeamDiscussion } from "./orchestrator";
import { assembleTeamFailure } from "./report";
import { createTeamSubagentRunner, type TeamRunnerDeps } from "./runner";
import { resolveTeamParticipants } from "./members";
import type { TeamParticipant, TeamProgressUpdate } from "./types";

/** Custom message type persisted with the final `/team` report. */
export const TEAM_RESULT_MESSAGE_TYPE = "team-result";
/** Distinct type for the dispatch breadcrumb so renders/logs can tell them apart. */
export const TEAM_DISPATCH_MESSAGE_TYPE = "team-dispatch";

export interface TeamControllerHooks {
	output?: (text: string) => Promise<void> | void;
	showStatus?: (text: string) => void;
	showError?: (text: string) => void;
	rebuildChat?: () => void | Promise<void>;
}

export interface StartTeamDiscussionArgs {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	hooks: TeamControllerHooks;
}

export interface StartTeamDiscussionResult {
	started: boolean;
	jobId?: string;
	/** User-facing feedback for the dispatch outcome. */
	message: string;
}

const QUESTION_PREVIEW_LENGTH = 80;

const DELIVERY_IDLE_POLL_MS = 250;

/**
 * Wait until the final report can land in the persisted transcript, or until
 * the owning job is cancelled. An explicit timeout reports failure; it must
 * never turn a finished report into a volatile next-turn queue entry.
 */
export async function waitForSessionIdle(
	session: Pick<AgentSession, "isStreaming">,
	signal: AbortSignal,
	options?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
	const deadline = Date.now() + (options?.timeoutMs ?? Number.POSITIVE_INFINITY);
	const pollMs = options?.pollMs ?? DELIVERY_IDLE_POLL_MS;
	while (session.isStreaming && !signal.aborted && Date.now() < deadline) {
		await Bun.sleep(pollMs);
	}
	return !signal.aborted && !session.isStreaming;
}

export async function deliverTeamReport(
	session: Pick<AgentSession, "isStreaming" | "appendCustomMessage">,
	signal: AbortSignal,
	content: string,
	details: { jobId: string; question: string },
	rebuildChat?: () => void | Promise<void>,
	waitOptions?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
	return logger.withLogContext({ job_id: details.jobId }, async () => {
		const started = performance.now();
		let stage = "wait_idle";
		const finish = (result: "completed" | "failed" | "cancelled", category?: string): boolean => {
			const fields = {
				component: "team.controller",
				event: `team_delivery_${result}`,
				stage,
				result,
				elapsed_ms: performance.now() - started,
				...(category ? { failure_category: category } : {}),
			};
			if (result === "failed") logger.error("Team report delivery failed", fields);
			else logger.info("Team report delivery finished", fields);
			return result === "completed";
		};
		logger.info("Team report delivery started", {
			component: "team.controller",
			event: "team_delivery_started",
			stage,
			result: "started",
			streaming: session.isStreaming,
			timeout_ms: waitOptions?.timeoutMs,
		});
		try {
			if (signal.aborted) return finish("cancelled");
			if (!(await waitForSessionIdle(session, signal, waitOptions))) {
				return finish(signal.aborted ? "cancelled" : "failed", signal.aborted ? undefined : "idle_timeout");
			}
			logger.info("Team report delivery idle wait completed", {
				component: "team.controller",
				event: "team_delivery_wait_completed",
				stage,
				result: "completed",
				elapsed_ms: performance.now() - started,
			});
			if (signal.aborted) return finish("cancelled");
			stage = "append";
			const appendStarted = performance.now();
			logger.info("Team report append started", {
				component: "team.controller",
				event: "team_delivery_append_started",
				stage,
				result: "started",
			});
			await session.appendCustomMessage(
				{
					customType: TEAM_RESULT_MESSAGE_TYPE,
					content,
					display: true,
					attribution: "agent",
					details,
				},
				{ signal },
			);
			logger.info("Team report append completed", {
				component: "team.controller",
				event: "team_delivery_append_completed",
				stage,
				result: "completed",
				persisted: true,
				elapsed_ms: performance.now() - appendStarted,
			});
			if (signal.aborted) return finish("cancelled");
			stage = "post_persist";
			try {
				await rebuildChat?.();
			} catch (error) {
				// A post-persist callback failure must not undo durable delivery.
				logger.warn("Team report post-persist callback failed", {
					component: "team.controller",
					event: "team_delivery_post_persist_failed",
					stage,
					result: "failed",
					persisted: true,
					...logger.diagnosticError(error),
				});
			}
			return finish("completed");
		} catch (error) {
			if (signal.aborted) return finish("cancelled");
			logger.error("Team report delivery threw", {
				component: "team.controller",
				event: "team_delivery_failed",
				stage,
				result: "failed",
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	});
}

function previewQuestion(question: string): string {
	const singleLine = question.trim().replace(/\s+/g, " ");
	if (singleLine.length <= QUESTION_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, QUESTION_PREVIEW_LENGTH - 1)}…`;
}

/** Resolve independent slots from settings and the effective available models. */
export function resolveTeamParticipantsForSession(session: AgentSession, settings: Settings) {
	const sessionModel = session.model;
	const configuredMembers = cfgTeamMembers.get(settings);
	const availableModels = filterAvailableModelsByEnabledPatterns(
		session.modelRegistry.getAvailable(),
		cfgEnabledModels.get(settings),
		settings,
	);
	const members = resolveTeamParticipants({
		configuredMembers,
		sessionModel,
		availableModels,
	});
	if (members.ok) {
		const remoteModel = isJchToolsAgentModel(sessionModel)
			? sessionModel
			: members.participants.find(participant => isJchToolsAgentModel(participant.model))?.model;
		if (remoteModel) {
			return {
				ok: false as const,
				error: `/team 不支持远端 Agent 模型 ${remoteModel.provider}/${remoteModel.id}：后端执行权限无法由前端只读工具集限制，且不支持必需的结构化 yield。请切换会话模型或修正 team.members 后重试。`,
			};
		}
	}
	return members;
}

/** Wire the runner deps from the live session. Exported for tests. */
export function buildRunnerDeps(session: AgentSession, settings: Settings, cwd: string): TeamRunnerDeps {
	const modelRegistry = session.modelRegistry;
	return {
		cwd,
		// Session-granted roots (CLI --dir, ACP/add-dir, settings-seeded) must
		// reach the read-only subagents too; dropping them would deny files the
		// main agent can read.
		additionalDirectories: session.sessionManager.getAdditionalDirectories(),
		settings,
		modelRegistry,
		authStorage: modelRegistry.authStorage,
		sessionFile: session.sessionFile ?? null,
		artifactsDir: session.sessionManager.getArtifactsDir(),
		parentAgentId: MAIN_AGENT_ID,
		skills: session.skills,
		promptTemplates: session.promptTemplates ? [...session.promptTemplates] : undefined,
	};
}

export async function startTeamDiscussion(
	question: string,
	args: StartTeamDiscussionArgs,
): Promise<StartTeamDiscussionResult> {
	const teamRunId = `team-${crypto.randomUUID()}`;
	return logger.withLogContext(
		{
			team_run_id: teamRunId,
			operation_id: logger.getLogContext().operation_id ?? teamRunId,
			...(args.session.sessionId ? { session_id: args.session.sessionId } : {}),
		},
		() => startTeamDiscussionImpl(question, args),
	);
}

async function startTeamDiscussionImpl(
	question: string,
	args: StartTeamDiscussionArgs,
): Promise<StartTeamDiscussionResult> {
	const { session, settings, hooks } = args;
	// Best-effort transcript output: synchronous throws and rejected promises
	// must not turn a UI failure into a failed dispatch or discussion.
	const emitOutput = async (text: string): Promise<void> => {
		try {
			await hooks.output?.(text);
		} catch (error) {
			logger.warn("Team output hook failed", {
				component: "team.controller",
				event: "team_output_failed",
				stage: "ui",
				result: "failed",
				...logger.diagnosticError(error),
			});
		}
	};
	const report = (text: string): void => {
		hooks.showError?.(text);
		void emitOutput(text);
	};

	const sessionModel = session.model;
	logger.info("Team dispatch started", {
		component: "team.controller",
		event: "team_dispatch_started",
		stage: "resolve",
		result: "started",
	});
	if (!sessionModel) {
		logger.warn("Team dispatch rejected", {
			component: "team.controller",
			event: "team_dispatch_rejected",
			stage: "resolve",
			result: "rejected",
			rejection_category: "session_model_missing",
		});
		const message = "/team 需要一个当前会话模型（主代理），但当前会话未选择模型。";
		report(message);
		return { started: false, message };
	}

	const members = resolveTeamParticipantsForSession(session, settings);
	let participants: TeamParticipant[];
	if (members.ok) {
		participants = members.participants;
	} else {
		logger.warn("Team dispatch rejected", {
			component: "team.controller",
			event: "team_dispatch_rejected",
			stage: "resolve",
			result: "rejected",
			rejection_category: "participants_unavailable",
		});
		report(members.error);
		return { started: false, message: members.error };
	}

	const manager = session.asyncJobManager;
	if (!manager) {
		logger.warn("Team dispatch rejected", {
			component: "team.controller",
			event: "team_dispatch_rejected",
			stage: "register",
			result: "rejected",
			rejection_category: "job_manager_missing",
		});
		const message = "后台任务不可用：/team 依赖会话的 async job 能力来承载多阶段讨论。";
		report(message);
		return { started: false, message };
	}

	const cwd = args.cwd;
	const sessionModelPattern = formatModelStringWithRouting(sessionModel);
	const label = `/team ${previewQuestion(question)}`;

	let jobId: string;
	try {
		jobId = manager.register(
			"task",
			label,
			async ({ jobId: owningJobId, signal, reportProgress }) =>
				logger.withLogContext({ job_id: owningJobId }, async () => {
					const started = performance.now();
					let stage = "discussion";
					let discussionStatus: string | undefined;
					let deliveryCompleted = false;
					let jobResult: AsyncJobRunResult | undefined;
					logger.info("Team job started", {
						component: "team.controller",
						event: "team_job_started",
						stage,
						result: "started",
						participant_count: participants.length,
					});
					const finishJob = (result: "completed" | "failed" | "cancelled"): void => {
						const fields = {
							component: "team.controller",
							event: `team_job_${result}`,
							stage,
							result,
							discussion_status: discussionStatus,
							delivery_completed: deliveryCompleted,
							elapsed_ms: performance.now() - started,
						};
						if (result === "failed") logger.error("Team job failed", fields);
						else logger.info("Team job finished", fields);
					};
					try {
						const runner = createTeamSubagentRunner(buildRunnerDeps(session, settings, cwd));
						const onProgress = (update: TeamProgressUpdate): void => {
							void reportProgress(update.text, { stage: update.stage, participants: update.participants });
							hooks.showStatus?.(update.text);
							void emitOutput(update.text);
						};
						const onReportPersisted = (): void | Promise<void> => {
							const ackStarted = performance.now();
							logger.info("Team report acknowledgement started", {
								component: "team.controller",
								event: "team_delivery_ack_started",
								stage: "ack",
								result: "started",
							});
							try {
								const acknowledgedCount = manager.acknowledgeDeliveries([jobId]);
								logger.info("Team report acknowledged", {
									component: "team.controller",
									event: "team_delivery_ack_completed",
									stage: "ack",
									result: "completed",
									acknowledged_count: acknowledgedCount,
									elapsed_ms: performance.now() - ackStarted,
								});
							} catch (error) {
								logger.warn("Team report acknowledgement failed", {
									component: "team.controller",
									event: "team_delivery_ack_failed",
									stage: "ack",
									result: "failed",
									elapsed_ms: performance.now() - ackStarted,
									...logger.diagnosticError(error),
								});
								throw error;
							}
							return hooks.rebuildChat?.();
						};
						const result = await runTeamDiscussion({
							question,
							cwd,
							participants,
							sessionModelPattern,
							runner,
							signal,
							maxConcurrency: cfgTaskMaxConcurrency.get(settings),
							onProgress,
						});
						jobResult = {
							// proc:// reads this complete text with line selectors, not just
							// renderer-only structured details or a soon-deleted child file.
							text: JSON.stringify(result, null, 2),
							structured: {
								// The aggregate is audit data, not another schema-validated yield.
								source: "none",
								mode: "permissive",
								status: "unavailable",
								data: result,
							},
						};
						discussionStatus = result.status;
						stage = "delivery";
						if (result.status === "completed") {
							const delivered = await deliverTeamReport(
								session,
								signal,
								result.reportMarkdown!,
								{ jobId, question },
								onReportPersisted,
							);
							deliveryCompleted = delivered;
							finishJob(delivered ? "completed" : signal.aborted ? "cancelled" : "failed");
							jobResult.text = `${delivered ? "team discussion complete" : "team discussion cancelled"}\n${jobResult.text}`;
							return jobResult;
						}
						if (result.status === "cancelled") {
							finishJob("cancelled");
							jobResult.text = `team discussion cancelled\n${jobResult.text}`;
							return jobResult;
						}
						const delivered = await deliverTeamReport(
							session,
							signal,
							assembleTeamFailure(question, result.failureReason ?? "未知原因"),
							{ jobId, question },
							onReportPersisted,
						);
						deliveryCompleted = delivered;
						if (!delivered) finishJob(signal.aborted ? "cancelled" : "failed");
						if (!delivered) {
							jobResult.text = `team discussion cancelled\n${jobResult.text}`;
							return jobResult;
						}
						throw new AsyncJobError(
							`${result.failureReason ?? "team discussion failed"}\n${jobResult.text}`,
							jobResult.structured,
						);
					} catch (error) {
						logger[signal.aborted ? "info" : "error"]("Team job threw", {
							component: "team.controller",
							event: signal.aborted ? "team_job_cancelled" : "team_job_failed",
							stage,
							result: signal.aborted ? "cancelled" : "failed",
							discussion_status: discussionStatus,
							delivery_completed: deliveryCompleted,
							elapsed_ms: performance.now() - started,
							...logger.diagnosticError(error),
						});
						if (!signal.aborted && !deliveryCompleted) {
							const reason = error instanceof Error ? error.message : String(error);
							const message = `/team 任务 ${owningJobId} 失败，结果仍可经 proc://${owningJobId} 恢复：${reason}`;
							await emitOutput(message);
							try {
								hooks.showError?.(message);
							} catch (uiError) {
								logger.warn("Team error hook failed", {
									component: "team.controller",
									event: "team_error_hook_failed",
									...logger.diagnosticError(uiError),
								});
							}
						}
						if (jobResult && !(error instanceof AsyncJobError)) {
							throw new AsyncJobError(
								`${error instanceof Error ? error.message : String(error)}\n${jobResult.text}`,
								jobResult.structured,
							);
						}
						throw error;
					}
				}),
			{ ownerId: MAIN_AGENT_ID, suppressDelivery: true },
		);
	} catch (error) {
		logger.warn("Team job registration failed", {
			component: "team.controller",
			event: "team_dispatch_failed",
			stage: "register",
			result: "failed",
			...logger.diagnosticError(error),
		});
		// register() throws synchronously at the running-job cap; surface it as
		// an actionable /team message instead of the raw internal error.
		const reason = error instanceof Error ? error.message : String(error);
		const message = [
			"无法启动 /team：后台任务注册失败。",
			reason,
			"请等待现有后台任务完成，或经 Agent Hub / hub cancel 取消后重试。",
		].join("\n");
		report(message);
		return { started: false, message };
	}
	logger.info("Team job registered", {
		component: "team.controller",
		event: "team_dispatch_completed",
		stage: "register",
		result: "completed",
		job_id: jobId,
		participant_count: participants.length,
	});
	const distinctModelCount = new Set(participants.map(participant => participant.modelPattern)).size;
	const dispatchNotice = [
		`/team 多代理讨论已启动（任务 ${jobId}，${participants.length} 个独立代理，${distinctModelCount} 个不同模型）。`,
		"阶段进度见状态提示，子代理明细可在 Agent Hub 查看；取消经后台任务取消入口（hub cancel）执行。",
		`原始问题：${previewQuestion(question)}`,
		`[team-dispatch ${jobId}]`,
	].join("\n");
	const followupStarted = performance.now();
	let noticeStage: "notice_dispatch" | "chat_rebuild" | "status_update" = "notice_dispatch";
	let stageStarted = followupStarted;
	let noticeDispatchCompleted = false;
	const logFollowupStage = (result: "started" | "completed"): void => {
		logger.info(`Team dispatch follow-up stage ${result}`, {
			component: "team.controller",
			event: `team_dispatch_followup_${result}`,
			stage: noticeStage,
			result,
			job_id: jobId,
			job_registered: true,
			notice_dispatch_completed: noticeDispatchCompleted,
			...(result === "completed" ? { elapsed_ms: performance.now() - stageStarted } : {}),
		});
	};
	logFollowupStage("started");
	try {
		await session.sendCustomMessage(
			{
				customType: TEAM_DISPATCH_MESSAGE_TYPE,
				content: dispatchNotice,
				display: true,
				attribution: "agent",
				details: { jobId, question, dispatch: true },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		// Resolving this call does not certify persistence; its boolean only
		// indicates whether it started a turn, not whether dispatch succeeded.
		noticeDispatchCompleted = true;
		logFollowupStage("completed");
		noticeStage = "chat_rebuild";
		stageStarted = performance.now();
		logFollowupStage("started");
		await hooks.rebuildChat?.();
		logFollowupStage("completed");
		noticeStage = "status_update";
		stageStarted = performance.now();
		logFollowupStage("started");
		hooks.showStatus?.(`Dispatched /team discussion ${jobId}`);
		logFollowupStage("completed");
	} catch (error) {
		logger.warn(
			noticeStage === "notice_dispatch" ? "Team dispatch notice failed" : "Team dispatch UI update failed",
			{
				component: "team.controller",
				event: "team_dispatch_followup_failed",
				stage: noticeStage,
				result: "failed",
				job_id: jobId,
				job_registered: true,
				notice_dispatch_completed: noticeDispatchCompleted,
				elapsed_ms: performance.now() - stageStarted,
				followup_elapsed_ms: performance.now() - followupStarted,
				...logger.diagnosticError(error),
			},
		);
		// The job is already registered and owns its own lifecycle from here; a
		// failed dispatch breadcrumb must not reject the command — the caller
		// would lose the submitted question and surface an unhandled rejection.
		const reason = error instanceof Error ? error.message : String(error);
		report(`/team 已启动（任务 ${jobId}），但写入派发通知失败：${reason}`);
	}

	return { started: true, jobId, message: dispatchNotice };
}
