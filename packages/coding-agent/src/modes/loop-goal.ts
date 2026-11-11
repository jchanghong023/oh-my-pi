import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import loopGoalPrompt from "../prompts/loop-goal.md" with { type: "text" };
import { extractVisibleAssistantText } from "./rpc/rpc-live";

const renderGoalPrompt = prompt.compile(loopGoalPrompt.trimEnd());

export function renderLoopGoalPrompt(objective: string): string {
	return renderGoalPrompt({ objective });
}

export function isLoopGoalComplete(messages: readonly AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return (
			message.stopReason !== "toolUse" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			extractVisibleAssistantText(message) === "无"
		);
	}
	return false;
}
