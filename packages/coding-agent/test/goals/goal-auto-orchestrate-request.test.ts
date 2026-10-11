import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildGoalAutoOrchestrateMessage } from "@oh-my-pi/pi-coding-agent/goals/request-context";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";

const objective = `  Full objective\r\n\n{{objective}} $& <b>markup</b>\t\n${"保留长文本 & 原样内容 ".repeat(300)}\nFINAL_OBJECTIVE_SENTINEL  \n`;

function state(overrides: Partial<GoalModeState> = {}): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		autoOrchestrate: true,
		goal: {
			id: "goal-a",
			objective,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		},
		...overrides,
	};
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(part => text(part)).join("\n");
	if (value && typeof value === "object" && "text" in value) return String(value.text);
	return "";
}

function render(current: GoalModeState, tools: string[]) {
	const message = buildGoalAutoOrchestrateMessage(current, tools);
	if (!message) throw new Error("Expected an active automatic goal to construct a persistent notice");
	return message;
}

describe("goal-auto-orchestrate persistent notice rendering", () => {
	test("preserves the full saved objective literally through serialization and provider conversion", () => {
		const current = state();
		const message = render(current, ["task", "read", "write", "bash"]);
		expect(message).toMatchObject({
			role: "custom",
			customType: "goal-auto-orchestrate-context",
			attribution: "user",
			details: { source: "goal-auto-orchestrate", goalId: "goal-a" },
		});
		const saved: typeof message = JSON.parse(JSON.stringify(message));
		expect(text(saved.content).split(objective)).toHaveLength(2);
		const provider = convertToLlm([saved]);
		expect(provider).toHaveLength(1);
		expect(provider[0]).toMatchObject({ role: "user", attribution: "user" });
		expect(text(provider[0]?.content)).toBe(text(message.content));
		expect(text(provider[0]?.content).split(objective)).toHaveLength(2);
		expect(current).toEqual(state());
	});

	test("uses shared user-authority expansion without promoting either notice or later user input", () => {
		const tools = ["task", "read", "write", "bash"];
		const message = render(state(), tools);
		const later: AgentMessage = {
			role: "user",
			content: "Do not edit files; inspect only.",
			attribution: "user",
			timestamp: 2,
		};
		const provider = convertToLlm([message, later]);
		expect(text(provider[0]?.content)).toContain(renderOrchestrateNotice({ tools }, { authority: "user" }));
		expect(text(provider[0]?.content)).not.toContain("<system-notice>");
		expect(text(provider[0]?.content)).not.toContain("<system-reminder>");
		expect(provider.map(entry => entry.role)).toEqual(["user", "user"]);
		expect(provider[1]).toEqual(later);
	});

	test("reads enabled indirect capabilities at construction and skips only rules when task is absent", () => {
		const current = state();
		const enabled = ["task", "read", "eval"];
		const indirect = render(current, enabled);
		const expanded = renderOrchestrateNotice({ tools: enabled }, { authority: "user" });
		expect(text(convertToLlm([indirect])[0]?.content)).toContain(expanded);

		const withoutTask = render(current, ["read", "eval"]);
		const unavailable = text(convertToLlm([withoutTask])[0]?.content);
		expect(unavailable).toContain(objective);
		expect(unavailable).not.toContain(expanded);
		expect(unavailable).not.toContain(renderOrchestrateNotice({ tools: ["read", "eval"] }, { authority: "user" }));
		const changed = ["task", "read", "eval", "bash"];
		const changedRules = renderOrchestrateNotice({ tools: changed }, { authority: "user" });
		expect(changedRules).not.toEqual(expanded);
		expect(text(render(current, changed).content)).toContain(changedRules);
		expect(text(indirect.content)).toContain(expanded);
		expect(current.autoOrchestrate).toBe(true);
	});

	test("does not construct a notice for ordinary, missing, paused, exiting, complete or budget-limited goals", () => {
		const current = state();
		for (const stopped of [
			undefined,
			state({ autoOrchestrate: undefined }),
			state({ autoOrchestrate: false }),
			state({ enabled: false }),
			state({ enabled: false, goal: { ...current.goal, status: "paused" } }),
			state({ goal: { ...current.goal, status: "paused" } }),
			state({ mode: "exiting", reason: "completed" }),
			state({ goal: { ...current.goal, status: "complete" } }),
			state({ goal: { ...current.goal, status: "budget-limited" } }),
		]) {
			expect(buildGoalAutoOrchestrateMessage(stopped, ["task"])).toBeUndefined();
		}
	});
});
