import { prompt } from "@oh-my-pi/pi-utils";
import { MAGIC_KEYWORDS, renderOrchestrateNotice } from "../modes/magic-keywords";
import goalAutoOrchestratePrompt from "../prompts/goals/goal-auto-orchestrate.md" with { type: "text" };
import type { CustomMessage } from "../session/messages";
import { renderGoalPrompt } from "./runtime";
import type { GoalModeState } from "./state";

export const GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE = "goal-auto-orchestrate";
const orchestrateKeyword = MAGIC_KEYWORDS.find(keyword => keyword.id === "orchestrate")!;
const renderGoalAutoOrchestrate = prompt.compile(goalAutoOrchestratePrompt.trim());

/**
 * Render a durable, user-authority notice at initial admission or a committed
 * compaction boundary. Callers persist it in the ordinary message journal.
 * Tool names are the enabled callable capabilities, including indirect tools.
 */
export function buildGoalAutoOrchestrateMessage(
	state: GoalModeState | undefined,
	tools: readonly string[],
	todoContext?: string,
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
			goalContext: renderGoalPrompt("active", state.goal, {
				omitObjective: true,
				authority: "user",
				omitGoalToolInstructions: !tools.includes("goal"),
			}),
			todoContext,
			orchestrateRules,
		}),
		display: false,
		attribution: "user",
		details: { source: GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE, goalId: state.goal.id },
		timestamp: Date.now(),
	};
}
