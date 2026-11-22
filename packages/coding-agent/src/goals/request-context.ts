import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { MAGIC_KEYWORDS, renderOrchestrateNotice } from "../modes/magic-keywords";
import goalAutoOrchestratePrompt from "../prompts/goals/goal-auto-orchestrate.md" with { type: "text" };
import type { CustomMessage } from "../session/messages";
import { type ApprovalRecordSink, recordToolApprovalResolved } from "../session/tool-approval-records";
import type { LocalGoalModeState } from "./state";

export const GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE = "goal-auto-orchestrate";
const orchestrateKeyword = MAGIC_KEYWORDS.find(keyword => keyword.id === "orchestrate")!;
const renderGoalAutoOrchestrate = prompt.compile(goalAutoOrchestratePrompt.trim());

/**
 * Render a durable, user-authority notice at initial admission or a committed
 * compaction boundary. Callers persist it in the ordinary message journal.
 * Tool names are the enabled callable capabilities, including indirect tools.
 */
export function buildGoalAutoOrchestrateMessage(
	state: LocalGoalModeState | undefined,
	tools: readonly string[],
): CustomMessage | undefined {
	if (state?.autoOrchestrate !== true || !state.enabled || state.mode !== "active" || state.goal.status !== "active") {
		return undefined;
	}
	const orchestrateRules = orchestrateKeyword.requires.every(tool => tools.includes(tool))
		? renderOrchestrateNotice({ tools }, { authority: "user" })
		: undefined;
	return {
		role: "custom",
		customType: "goal-auto-orchestrate-context",
		// Preserve the saved objective verbatim, including whitespace and templates.
		content: renderGoalAutoOrchestrate({
			objective: state.goal.objective,
			orchestrateRules,
		}),
		display: false,
		attribution: "user",
		details: { source: GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE, goalId: state.goal.id },
		timestamp: Date.now(),
	};
}

export class GoalAutopilotRequest {
	constructor(
		readonly run: { goalId: string; sessionGeneration: number; review?: GoalAutopilotRequest },
		readonly isCurrent: () => boolean,
		readonly flushUsage: () => Promise<void>,
	) {}

	async currentAfterUsage(): Promise<boolean> {
		if (!this.isCurrent()) return false;
		await this.flushUsage();
		return this.isCurrent();
	}

	async approve(sink: ApprovalRecordSink | undefined, toolCallId: string, toolName: string, signal?: AbortSignal) {
		if (!(await this.currentAfterUsage()) || signal?.aborted)
			throw new Error("Goal Autopilot run is no longer active.");
		if (sink)
			await recordToolApprovalResolved(sink, { toolCallId, toolName, approved: true, reason: "goal-autopilot" });
	}
}

export function goalAutopilotRequest(context?: AgentToolContext): GoalAutopilotRequest | undefined {
	const scope = context?.toolCall?.requestScope;
	return scope instanceof GoalAutopilotRequest ? scope : undefined;
}
