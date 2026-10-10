import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { prompt } from "@oh-my-pi/pi-utils";
import { MAGIC_KEYWORDS, renderOrchestrateNotice } from "../modes/magic-keywords";
import goalAutoOrchestratePrompt from "../prompts/goals/goal-auto-orchestrate.md" with { type: "text" };
import type { CustomMessage } from "../session/messages";
import { renderGoalPrompt } from "./runtime";
import type { GoalModeState } from "./state";

export const GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE = "goal-auto-orchestrate";
const CONTEXT_TYPE = "goal-auto-orchestrate-context";
const CONTINUATION_TYPE = "goal-auto-orchestrate-continuation";
const orchestrateKeyword = MAGIC_KEYWORDS.find(keyword => keyword.id === "orchestrate")!;
const renderGoalAutoOrchestrate = prompt.compile(goalAutoOrchestratePrompt.trim());
// Provider-only provenance: never serialized into the session or sent on the wire.
const kGoalAutoOrchestrateContext = Symbol("provider.message.goalAutoOrchestrateContext");
type GoalContextMessage = Message & { [kGoalAutoOrchestrateContext]?: true };

function isActive(state: GoalModeState | undefined): state is GoalModeState {
	return (
		state?.autoOrchestrate === true &&
		state.enabled === true &&
		state.mode === "active" &&
		state.goal.status === "active"
	);
}

/**
 * Filter a main request's AgentMessage view before custom-message conversion.
 * `messages` is the current request/steering view, not mutable session history;
 * `state` is the live session goal snapshot. No text matching or history edits.
 * Goal-stamped keyword notices stay suppressed after pause, replacement or drop;
 * genuinely later ordinary keyword notices have no feature provenance and survive.
 */
export function filterGoalAutoOrchestrateMessages(
	messages: AgentMessage[],
	state: GoalModeState | undefined,
): AgentMessage[] {
	const active = isActive(state);
	return messages.filter(message => {
		if (message.role !== "custom") return true;
		if (message.customType === CONTEXT_TYPE) return false;
		const details =
			message.details && typeof message.details === "object"
				? (message.details as { source?: unknown; goalId?: unknown })
				: undefined;
		if (message.customType === CONTINUATION_TYPE) {
			return active && (details?.goalId === undefined || details.goalId === state.goal.id);
		}
		if (message.customType === "orchestrate-notice" || message.customType === "goal-mode-context") {
			return !active && details?.source !== GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE;
		}
		// Ordinary continuation history contains an objective already supplied by
		// the explicit request view; keep ordinary goal behavior outside this mode.
		if (active && message.customType === "goal-continuation") return false;
		return true;
	});
}

/**
 * Build one transient, user-authority context from the full saved objective.
 * `state` is read anew for each request; `tools` names current callable tools,
 * including enabled indirect tools absent from top-level provider schemas.
 * The shared keyword requirement gates only orchestration rules, never the goal.
 * `todoContext` is the optional live, plain user-authority rendering of existing
 * Goal todos, constrained to the same callable-tool snapshot.
 */
export function buildGoalAutoOrchestrateMessage(
	state: GoalModeState | undefined,
	tools: readonly string[],
	todoContext?: string,
): CustomMessage | undefined {
	if (!isActive(state)) return undefined;
	const orchestrateRules = orchestrateKeyword.requires.every(tool => tools.includes(tool))
		? renderOrchestrateNotice({ tools }, { authority: "user" })
		: undefined;
	const message: CustomMessage = {
		role: "custom",
		customType: CONTEXT_TYPE,
		// Compile without post-formatting: preserve the saved objective verbatim,
		// including whitespace, blank lines, markdown and template-looking text.
		content: renderGoalAutoOrchestrate({
			objective: state.goal.objective,
			goalContext: renderGoalPrompt("active", state.goal, { omitObjective: true, authority: "user" }),
			todoContext,
			orchestrateRules,
		}),
		display: false,
		attribution: "user",
		details: { source: GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE, goalId: state.goal.id },
		timestamp: 0,
	};
	markPerCallContextMessage(message, GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE);
	return message;
}

/**
 * Remove only this feature's transient provider view from an auxiliary request.
 * `context` may be a main snapshot or a side context built with the main Agent's
 * provider transform; ordinary user text and other per-call messages survive.
 * Symbols survive shallow request projections but never enter persisted history.
 */
export function stripGoalAutoOrchestrateContext(context: Context): Context {
	if (!context.messages.some(message => (message as GoalContextMessage)[kGoalAutoOrchestrateContext])) return context;
	return {
		...context,
		messages: context.messages.filter(message => !(message as GoalContextMessage)[kGoalAutoOrchestrateContext]),
	};
}

/**
 * Apply only at the main Agent's final provider-context boundary, after shared
 * provider transforms. `callableToolNames` is the current enabled capability set,
 * including indirect tools, not `context.tools`' top-level schemas. `state` is
 * the current session goal. Auxiliary/subagent callers must not use this.
 * Reapplying replaces our symbol-stamped view, never matches/deletes user text.
 * `todoContext` supplies existing live Goal todo rules/state, never a saved notice.
 */
export function applyGoalAutoOrchestrateContext(
	context: Context,
	state: GoalModeState | undefined,
	callableToolNames: readonly string[],
	todoContext?: string,
): Context {
	const stripped = stripGoalAutoOrchestrateContext(context);
	const messages = stripped.messages;
	const goalContext = buildGoalAutoOrchestrateMessage(state, callableToolNames, todoContext);
	if (!goalContext) return stripped;
	const message: UserMessage & { [kGoalAutoOrchestrateContext]: true } = {
		role: "user",
		content:
			typeof goalContext.content === "string" ? [{ type: "text", text: goalContext.content }] : goalContext.content,
		attribution: "user",
		timestamp: goalContext.timestamp,
		[kGoalAutoOrchestrateContext]: true,
	};
	markPerCallContextMessage(message, GOAL_AUTO_ORCHESTRATE_CONTEXT_SOURCE);
	return { ...stripped, messages: [...messages, message] };
}
