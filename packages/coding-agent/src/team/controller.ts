/**
 * `/team` command controller.
 *
 * Bridges the slash command to the orchestrator through the session's async
 * job manager (the /tan precedent): the job signal is the command's
 * cancellation signal and propagates into every subagent; stage progress rides
 * the existing job/status surfaces (no new TUI panels — child detail stays in
 * the Agent Hub); the final report lands as one markdown message in the
 * transcript via `sendCustomMessage`, never as a model-facing delivery.
 */
import { getCompanyChatModels } from "../config/company-models";
import { isCompanyLaneActive } from "../config/company-provider";
import type { Settings } from "../config/settings";
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

function previewQuestion(question: string): string {
	const singleLine = question.trim().replace(/\s+/g, " ");
	if (singleLine.length <= QUESTION_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, QUESTION_PREVIEW_LENGTH - 1)}…`;
}

/** Resolve the participant set from settings + process state. Exported for the command layer and tests. */
export function resolveTeamParticipantsForSession(session: AgentSession, settings: Settings) {
	const sessionModel = session.model;
	const offlineLaneActive = isCompanyLaneActive();
	const companyModelPatterns = offlineLaneActive
		? getCompanyChatModels().map(model => `${model.provider}/${model.id}`)
		: [];
	return resolveTeamParticipants({
		configuredMembers: settings.get("team.members") as string[],
		offlineLaneActive,
		companyModelPatterns,
		sessionModel,
		availableModels: session.modelRegistry.getAvailable(),
	});
}

function buildRunnerDeps(session: AgentSession, settings: Settings, cwd: string): TeamRunnerDeps {
	const modelRegistry = session.modelRegistry;
	return {
		cwd,
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
	const { session, settings, hooks } = args;
	const report = (text: string): void => {
		hooks.showError?.(text);
		void hooks.output?.(text);
	};

	const sessionModel = session.model;
	if (!sessionModel) {
		const message = "/team 需要一个当前会话模型（主代理），但当前会话未选择模型。";
		report(message);
		return { started: false, message };
	}

	const members = resolveTeamParticipantsForSession(session, settings);
	let participants: TeamParticipant[];
	if (members.ok) {
		participants = members.participants;
	} else {
		report(members.error);
		return { started: false, message: members.error };
	}

	const manager = session.asyncJobManager;
	if (!manager) {
		const message = "后台任务不可用：/team 依赖会话的 async job 能力来承载多阶段讨论。";
		report(message);
		return { started: false, message };
	}

	const cwd = args.cwd;
	const sessionModelPattern = `${sessionModel.provider}/${sessionModel.id}`;
	const label = `/team ${previewQuestion(question)}`;

	let jobId: string;
	try {
		jobId = manager.register(
			"task",
			label,
			async ({ signal, reportProgress }) => {
				const runner = createTeamSubagentRunner(buildRunnerDeps(session, settings, cwd));
				const onProgress = (update: TeamProgressUpdate): void => {
					void reportProgress(update.text, { stage: update.stage, participants: update.participants });
					hooks.showStatus?.(update.text);
				};
				const result = await runTeamDiscussion({
					question,
					cwd,
					participants,
					sessionModelPattern,
					runner,
					signal,
					maxConcurrency: settings.get("task.maxConcurrency"),
					onProgress,
				});
				const deliver = async (content: string): Promise<void> => {
					await session.sendCustomMessage(
						{
							customType: TEAM_RESULT_MESSAGE_TYPE,
							content,
							display: true,
							attribution: "agent",
							details: { jobId, question },
						},
						{ triggerTurn: false, deliverAs: "nextTurn" },
					);
					await hooks.rebuildChat?.();
				};
				if (result.status === "completed") {
					await deliver(result.reportMarkdown!);
					return "team discussion complete";
				}
				if (result.status === "cancelled") {
					return "team discussion cancelled";
				}
				await deliver(assembleTeamFailure(question, result.failureReason ?? "未知原因"));
				throw new Error(result.failureReason ?? "team discussion failed");
			},
			{ ownerId: MAIN_AGENT_ID },
		);
	} catch (error) {
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
	// The user-facing report lands in the transcript directly; suppress the
	// job manager's model-facing result delivery so no agent turn is triggered.
	manager.acknowledgeDeliveries([jobId]);

	const dispatchNotice = [
		`/team 多模型讨论已启动（任务 ${jobId}，${participants.length} 个参与模型）。`,
		"阶段进度见状态提示，子代理明细可在 Agent Hub 查看；取消经后台任务取消入口（hub cancel）执行。",
		`原始问题：${previewQuestion(question)}`,
		`[team-dispatch ${jobId}]`,
	].join("\n");
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
	await hooks.rebuildChat?.();
	hooks.showStatus?.(`Dispatched /team discussion ${jobId}`);

	return { started: true, jobId, message: dispatchNotice };
}
