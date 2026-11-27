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
import { cfgOffline } from "../config/auxiliary-model-policy";
import { filterAvailableModelsByEnabledPatterns, formatModelStringWithRouting } from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { Semaphore } from "../task/parallel";
import { cfgTaskMaxConcurrency } from "../task/settings";
import { cfgTeamMembers } from "./settings";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { resolveNativeChildSessionHooks } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { runTeamDiscussion } from "./orchestrator";
import { assembleTeamFailure } from "./report";
import { createTeamSubagentRunner, type TeamRunnerDeps } from "./runner";
import { resolveTeamParticipants, type TeamMembersResult } from "./members";
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
	signal?: AbortSignal;
	/** Echo the persisted report when the host does not present it from the transcript. */
	echoReport?: boolean;
	hooks: TeamControllerHooks;
}

export interface StartTeamDiscussionResult {
	started: boolean;
	jobId?: string;
	/** The job manager refused to register a background discussion; the command itself was handled. */
	registrationRejected?: true;
	/** User-facing feedback for the dispatch outcome. */
	message: string;
}

const QUESTION_PREVIEW_LENGTH = 80;

const DELIVERY_IDLE_POLL_MS = 250;

const teamSessionState = new WeakMap<
	AgentSession,
	{ sessionId: string; semaphore: Semaphore; readIsolationRoots: Set<string> }
>();

function getTeamSessionState(session: AgentSession, settings: Settings) {
	const sessionId = session.sessionManager.getSessionId();
	let state = teamSessionState.get(session);
	if (!state || state.sessionId !== sessionId) {
		state = {
			sessionId,
			semaphore: new Semaphore(cfgTaskMaxConcurrency.get(settings)),
			readIsolationRoots: new Set(),
		};
		teamSessionState.set(session, state);
	}
	return state;
}

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

type TeamDeliveryStatus = "completed" | "failed" | "cancelled";

export async function deliverTeamReport(
	session: Pick<AgentSession, "isStreaming" | "appendCustomMessage">,
	signal: AbortSignal,
	content: string,
	details: { jobId: string; question: string },
	onPersisted?: (content: string) => void | Promise<void>,
	options?: { timeoutMs?: number; pollMs?: number; isCurrentSession?: () => boolean },
): Promise<TeamDeliveryStatus> {
	const isCancelled = () => signal.aborted || options?.isCurrentSession?.() === false;
	return logger.withLogContext({ job_id: details.jobId }, async () => {
		const started = performance.now();
		let stage = "wait_idle";
		const finish = (result: TeamDeliveryStatus, category?: string): TeamDeliveryStatus => {
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
			return result;
		};
		logger.info("Team report delivery started", {
			component: "team.controller",
			event: "team_delivery_started",
			stage,
			result: "started",
			streaming: session.isStreaming,
			timeout_ms: options?.timeoutMs,
		});
		try {
			if (isCancelled()) return finish("cancelled");
			if (!(await waitForSessionIdle(session, signal, options))) {
				return isCancelled() ? finish("cancelled") : finish("failed", "idle_timeout");
			}
			logger.info("Team report delivery idle wait completed", {
				component: "team.controller",
				event: "team_delivery_wait_completed",
				stage,
				result: "completed",
				elapsed_ms: performance.now() - started,
			});
			if (isCancelled()) return finish("cancelled");
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
			// A receipt can arrive after cancellation. Keep the committed history,
			// but do not notify the caller or acknowledge delivery.
			if (isCancelled()) return finish("cancelled");
			stage = "post_persist";
			try {
				await onPersisted?.(content);
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
			return finish(isCancelled() ? "cancelled" : "completed");
		} catch (error) {
			if (isCancelled()) return finish("cancelled");
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
	return `${singleLine.slice(0, QUESTION_PREVIEW_LENGTH)}…`;
}

/** Resolve independent slots from settings and the effective available models. */
export function resolveTeamParticipantsForSession(session: AgentSession, settings: Settings): TeamMembersResult {
	const sessionModel = session.model;
	const configuredMembers = settings.rawValue(cfgTeamMembers);
	if (configuredMembers !== undefined && !Array.isArray(configuredMembers)) {
		return { ok: false, error: "team.members must be an array of model selectors. Fix it in config.yml." };
	}
	const availableModels = filterAvailableModelsByEnabledPatterns(
		session.modelRegistry.getAvailable(),
		cfgEnabledModels.get(settings),
		settings,
	);
	return resolveTeamParticipants({
		configuredMembers: configuredMembers ?? [],
		sessionModel,
		availableModels: cfgOffline.get(settings)
			? availableModels.filter(model => model.provider === sessionModel?.provider)
			: availableModels,
	});
}

/** Wire the runner deps from the live session. Exported for tests. */
export function buildRunnerDeps(
	session: AgentSession,
	settings: Settings,
	cwd: string,
	isCurrentSession?: () => boolean,
): TeamRunnerDeps {
	const sessionId = session.sessionManager.getSessionId();
	const activeModel = session.model;
	const modelRegistry = session.modelRegistry;
	const parentCapabilities = session.nativeChildCapabilities;
	const sessionHooks = resolveNativeChildSessionHooks({}, parentCapabilities);
	return {
		cwd,
		// Session-granted roots (CLI --dir, ACP/add-dir, settings-seeded) must
		// reach the read-only subagents too; dropping them would deny files the
		// main agent can read.
		additionalDirectories: session.sessionManager.getAdditionalDirectories(),
		settings,
		modelRegistry,
		...sessionHooks,
		authStorage: modelRegistry.authStorage,
		sessionFile: session.sessionFile ?? null,
		artifactsDir: session.sessionManager.getArtifactsDir(),
		parentLocalRoot: session.localRoot,
		readIsolationRoots: getTeamSessionState(session, settings).readIsolationRoots,
		parentActiveModelPattern: activeModel ? formatModelStringWithRouting(activeModel) : undefined,
		parentActiveProvider: activeModel?.provider,
		costGate: session.costGate,
		parentAgentId: MAIN_AGENT_ID,
		eventBus: session.eventBus,
		subagentEventBus: session.subagentEventBus,
		isCurrentSession: isCurrentSession ?? (() => session.sessionManager.getSessionId() === sessionId),
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
	const { session, settings, hooks, signal: requestSignal } = args;
	if (requestSignal?.aborted) return { started: false, message: "/team cancelled." };
	const sessionId = session.sessionManager.getSessionId();
	let sessionChanged = false;
	const isCurrentSession = (): boolean => !sessionChanged && session.sessionManager.getSessionId() === sessionId;
	// Best-effort transcript output: synchronous throws and rejected promises
	// must not turn a UI failure into a failed dispatch or discussion.
	const emitOutput = async (text: string): Promise<void> => {
		if (!isCurrentSession()) return;
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
	const report = async (text: string): Promise<void> => {
		if (!isCurrentSession()) return;
		try {
			hooks.showError?.(text);
		} catch (error) {
			logger.warn("Team error hook failed", {
				component: "team.controller",
				event: "team_error_hook_failed",
				stage: "ui",
				...logger.diagnosticError(error),
			});
		}
		await emitOutput(text);
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
		const message = "/team requires a session model as its main agent, but no model is selected.";
		await report(message);
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
		await report(members.error);
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
		const message =
			"Background jobs are unavailable: /team requires an async job manager for multi-stage discussions.";
		await report(message);
		return { started: false, message };
	}

	const cwd = args.cwd;
	const sessionModelPattern = formatModelStringWithRouting(sessionModel);
	const label = `/team ${previewQuestion(question)}`;

	let jobId: string | undefined;
	let registering = false;
	let unregisterSessionChange: (() => void) | undefined;
	const sessionAbort = new AbortController();
	const dispatchSignal = requestSignal ? AbortSignal.any([sessionAbort.signal, requestSignal]) : sessionAbort.signal;
	const cancelJob = (): void => {
		if (jobId) manager.cancel(jobId);
	};
	dispatchSignal.addEventListener("abort", cancelJob, { once: true });
	try {
		// Capture roots, artifacts, models and buses before the manager starts the
		// asynchronous job; the live AgentSession may later adopt another identity.
		const runnerDeps = buildRunnerDeps(session, settings, cwd, isCurrentSession);
		const maxConcurrency = cfgTaskMaxConcurrency.get(settings);
		const { semaphore } = getTeamSessionState(session, settings);
		semaphore.resize(maxConcurrency);
		unregisterSessionChange = session.registerSessionChangeCallback(() => {
			sessionChanged = true;
			sessionAbort.abort();
			unregisterSessionChange?.();
		});
		registering = true;
		jobId = manager.register(
			"task",
			label,
			async ({ jobId: owningJobId, signal: jobSignal, reportProgress }) =>
				logger.withLogContext({ job_id: owningJobId }, async () => {
					const signal = AbortSignal.any([jobSignal, dispatchSignal]);
					const cleanupSessionChange = (): void => {
						dispatchSignal.removeEventListener("abort", cancelJob);
						unregisterSessionChange?.();
						unregisterSessionChange = undefined;
					};
					signal.addEventListener("abort", cleanupSessionChange, { once: true });
					if (signal.aborted) cleanupSessionChange();
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
						const runner = createTeamSubagentRunner(runnerDeps);
						const onProgress = (update: TeamProgressUpdate): void => {
							if (signal.aborted || !isCurrentSession()) return;
							void reportProgress(update.text, { stage: update.stage, participants: update.participants });
							hooks.showStatus?.(update.text);
							void emitOutput(update.text);
						};
						const onReportPersisted = async (content: string): Promise<void> => {
							if (!isCurrentSession()) return;
							if (args.echoReport !== false) await emitOutput(content);
							if (signal.aborted || !isCurrentSession()) return;
							const ackStarted = performance.now();
							logger.info("Team report acknowledgement started", {
								component: "team.controller",
								event: "team_delivery_ack_started",
								stage: "ack",
								result: "started",
							});
							try {
								const acknowledgedCount = manager.acknowledgeDeliveries([owningJobId]);
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
							if (isCurrentSession()) await hooks.rebuildChat?.();
						};
						const result = await runTeamDiscussion({
							question,
							cwd,
							participants,
							sessionModelPattern,
							runner,
							signal,
							maxConcurrency,
							semaphore,
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
						const delivery =
							result.status === "cancelled"
								? "cancelled"
								: await deliverTeamReport(
										session,
										signal,
										result.status === "completed"
											? result.reportMarkdown!
											: assembleTeamFailure(question, result.failureReason ?? "未知原因"),
										{ jobId: owningJobId, question },
										onReportPersisted,
										{ isCurrentSession },
									);
						deliveryCompleted = delivery === "completed";
						if (delivery === "cancelled") {
							if (!jobSignal.aborted) manager.cancel(owningJobId);
							finishJob("cancelled");
							jobResult.text = `team discussion cancelled\n${jobResult.text}`;
							return jobResult;
						}
						if (delivery === "failed") {
							throw new AsyncJobError(
								`Team report delivery did not complete\n${jobResult.text}`,
								jobResult.structured,
							);
						}
						if (result.status === "failed") {
							throw new AsyncJobError(
								`${result.failureReason ?? "team discussion failed"}\n${jobResult.text}`,
								jobResult.structured,
							);
						}
						finishJob("completed");
						jobResult.text = `team discussion complete\n${jobResult.text}`;
						return jobResult;
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
							const message = `/team job ${owningJobId} failed. The result is still available at proc://${owningJobId}: ${reason}`;
							await emitOutput(message);
							try {
								if (isCurrentSession()) hooks.showError?.(message);
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
					} finally {
						signal.removeEventListener("abort", cleanupSessionChange);
						cleanupSessionChange();
					}
				}),
			{ ownerId: MAIN_AGENT_ID, suppressDelivery: true },
		);
		if (dispatchSignal.aborted) cancelJob();
	} catch (error) {
		dispatchSignal.removeEventListener("abort", cancelJob);
		unregisterSessionChange?.();
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
			"Could not start /team: background job registration failed.",
			reason,
			"Wait for existing jobs to finish or cancel them through Agent Hub or `hub cancel`, then retry.",
		].join("\n");
		await report(message);
		if (registering && jobId === undefined) return { started: false, registrationRejected: true, message };
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
		`/team discussion started (job ${jobId}, ${participants.length} independent agents, ${distinctModelCount} distinct models).`,
		"Follow progress in the status updates, view subagent details in Agent Hub, and cancel the background job with `hub cancel`.",
		`Original question: ${previewQuestion(question)}`,
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
		if (!isCurrentSession() || dispatchSignal.aborted) return { started: true, jobId, message: dispatchNotice };
		await session.appendCustomMessage(
			{
				customType: TEAM_DISPATCH_MESSAGE_TYPE,
				content: dispatchNotice,
				display: true,
				attribution: "agent",
				details: { jobId, question, dispatch: true },
			},
			{ signal: dispatchSignal, waitForIdle: false },
		);
		noticeDispatchCompleted = true;
		logFollowupStage("completed");
		noticeStage = "chat_rebuild";
		stageStarted = performance.now();
		logFollowupStage("started");
		if (!isCurrentSession()) return { started: true, jobId, message: dispatchNotice };
		await hooks.rebuildChat?.();
		logFollowupStage("completed");
		noticeStage = "status_update";
		stageStarted = performance.now();
		logFollowupStage("started");
		if (!isCurrentSession()) return { started: true, jobId, message: dispatchNotice };
		hooks.showStatus?.(`Dispatched /team discussion ${jobId}`);
		logFollowupStage("completed");
	} catch (error) {
		if (dispatchSignal.aborted) return { started: true, jobId, message: dispatchNotice };
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
		const failure = noticeDispatchCompleted
			? "the dispatch notice was saved, but the UI update failed"
			: "the dispatch notice could not be saved";
		await report(`/team started (job ${jobId}), but ${failure}: ${reason}`);
	}

	return { started: true, jobId, message: dispatchNotice };
}
