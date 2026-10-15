import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { type Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { UsageStatistics } from "../session/session-entries";

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	autoOrchestrate?: boolean;
	goal: Goal;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);

export function parseGoalSubcommand(args: string): {
	sub: GoalSubcommand | undefined;
	rest: string;
} {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

/** Rebuild a persisted goal from `mode_change` data; undefined when the record is malformed. */
export function goalFromModeData(modeData: Record<string, unknown> | undefined): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Digest of a turn's tool calls and results. Identical activity is terminal;
 * empty activity is eligible only for the guard's bounded tool-call recovery.
 */
export function goalContinuationActivity(messages: readonly AgentMessage[]): string {
	const digests: string[] = [];
	const record = (value: unknown): void => {
		const serialized = stableStringifyJson(value);
		digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") record(["call", block.name, block.arguments]);
			}
		} else if (message.role === "toolResult") {
			record(["result", message.toolName, message.content, message.isError === true]);
		}
	}
	return digests.join(":");
}

/** One forced-tool recovery per uninterrupted continuation stretch; real work does not replenish it. */
export class GoalContinuationGuard {
	#previousActivity: string | undefined;
	#pendingActivity = "";
	#recoveryUsed = false;
	#recoveryPending = false;
	#stoppedWithoutTools = false;

	get recoveryPending(): boolean {
		return this.#recoveryPending;
	}

	get stopNotice(): string | undefined {
		return this.#stoppedWithoutTools
			? "Goal automatic continuation stopped: the model did not produce a tool call after one forced-tool recovery. The goal is still unfinished; check the model or gateway's tool-calling support."
			: undefined;
	}

	reset(): void {
		this.#previousActivity = undefined;
		this.#pendingActivity = "";
		this.#recoveryUsed = false;
		this.#recoveryPending = false;
		this.#stoppedWithoutTools = false;
	}

	/** Keep only tool evidence across maintenance runs of the same pending submission. */
	recordActivity(messages: readonly AgentMessage[]): void {
		const activity = goalContinuationActivity(messages);
		if (activity.length === 0) return;
		this.#pendingActivity = this.#pendingActivity ? `${this.#pendingActivity}:${activity}` : activity;
	}

	observe(messages: readonly AgentMessage[]): "continue" | "recover" | "stop" {
		const currentActivity = goalContinuationActivity(messages);
		const activity =
			this.#pendingActivity && currentActivity
				? `${this.#pendingActivity}:${currentActivity}`
				: this.#pendingActivity || currentActivity;
		this.#pendingActivity = "";
		const previous = this.#previousActivity;
		this.#previousActivity = activity;
		const wasRecovery = this.#recoveryPending;
		this.#recoveryPending = false;
		this.#stoppedWithoutTools = false;
		const assistant = messages.findLast(message => message.role === "assistant");
		if (activity.length > 0) {
			// Cached maintenance evidence must not override a later tool-free failure.
			if (
				currentActivity.length === 0 &&
				assistant?.role === "assistant" &&
				(assistant.stopReason === "error" ||
					assistant.stopReason === "length" ||
					assistant.stopReason === "aborted")
			) {
				return "stop";
			}
			return activity === previous ? "stop" : "continue";
		}
		if (assistant?.role === "assistant" && assistant.stopReason === "aborted") return "stop";
		if (wasRecovery) {
			this.#stoppedWithoutTools = true;
			return "stop";
		}
		if (assistant?.role !== "assistant" || assistant.stopReason !== "stop") return "stop";
		if (!assistant.content.some(block => block.type === "text" && block.text.trim().length > 0)) return "stop";
		if (this.#recoveryUsed) {
			this.#stoppedWithoutTools = true;
			return "stop";
		}
		this.#recoveryUsed = true;
		this.#recoveryPending = true;
		return "recover";
	}
}
