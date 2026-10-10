import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	applyGoalAutoOrchestrateContext,
	buildGoalAutoOrchestrateMessage,
	filterGoalAutoOrchestrateMessages,
	stripGoalAutoOrchestrateContext,
} from "@oh-my-pi/pi-coding-agent/goals/request-context";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import unattended from "../../src/prompts/goals/goal-auto-orchestrate.md" with { type: "text" };

const objective = `Full objective\n${"保留长文本 & <b>markup</b> ".repeat(300)}\nFINAL_OBJECTIVE_SENTINEL`;
const instruction = prompt
	.compile(unattended.trim())({ objective: "", orchestrateRules: "" })
	.trim()
	.split("\n")
	.slice(-4)
	.join("\n");

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

function custom(customType: string, content: string, details?: Record<string, unknown>): AgentMessage {
	return { role: "custom", customType, content, display: false, timestamp: 1, ...(details ? { details } : {}) };
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(part => text(part)).join("\n");
	if (value && typeof value === "object" && "text" in value) return String(value.text);
	return "";
}

function providerContext(names: string[]): Context {
	return {
		systemPrompt: ["Host system authority remains unchanged."],
		messages: [{ role: "user", content: "Later user explicitly says: do not edit files.", timestamp: 2 }],
		tools: names.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
	};
}

describe("goal-auto-orchestrate request context", () => {
	test("renders the entire objective and shared dynamic rules exactly once with user attribution", () => {
		const current = state();
		const tools = ["task", "read", "write", "bash"];
		const message = buildGoalAutoOrchestrateMessage(current, tools);
		expect(message).toMatchObject({
			role: "custom",
			customType: "goal-auto-orchestrate-context",
			attribution: "user",
			details: { source: "goal-auto-orchestrate", goalId: "goal-a" },
		});
		const rendered = text(message?.content);
		expect(rendered.split(objective)).toHaveLength(2);
		expect(rendered.split(instruction)).toHaveLength(2);
		expect(rendered).toContain(renderOrchestrateNotice({ tools }, { authority: "user" }));
		expect(rendered).not.toContain("<system-notice>");
		expect(rendered).not.toContain("<system-reminder>");
		expect(current).toEqual(state());
	});

	test("rebuilds rules from current tools; missing task retains the objective and unattended strategy", () => {
		const current = state();
		const before = text(buildGoalAutoOrchestrateMessage(current, ["task", "read"])?.content);
		const unavailable = text(buildGoalAutoOrchestrateMessage(current, ["read"])?.content);
		const restored = text(buildGoalAutoOrchestrateMessage(current, ["task", "read", "bash"])?.content);
		expect(before).toContain(renderOrchestrateNotice({ tools: ["task", "read"] }, { authority: "user" }));
		expect(unavailable).toContain(objective);
		expect(unavailable).toContain(instruction);
		expect(unavailable).not.toContain(renderOrchestrateNotice({ tools: ["read"] }, { authority: "user" }));
		expect(restored).toContain(renderOrchestrateNotice({ tools: ["task", "read", "bash"] }, { authority: "user" }));
		expect(restored).not.toEqual(before);
		expect(current.autoOrchestrate).toBe(true);
	});

	test("only active explicit mode injects; pause, exiting, complete, legacy and drop do not", () => {
		const current = state();
		for (const stopped of [
			undefined,
			state({ autoOrchestrate: undefined }),
			state({ autoOrchestrate: false }),
			state({ enabled: false, goal: { ...current.goal, status: "paused" } }),
			state({ mode: "exiting", reason: "completed" }),
			state({ goal: { ...current.goal, status: "complete" } }),
			state({ goal: { ...current.goal, status: "budget-limited" } }),
		]) {
			expect(buildGoalAutoOrchestrateMessage(stopped, ["task"])).toBeUndefined();
			const context = providerContext(["task"]);
			expect(applyGoalAutoOrchestrateContext(context, stopped)).toEqual(context);
		}
	});

	test("deduplicates structured notices without deleting user prose or budget steering or history", () => {
		const user: AgentMessage = { role: "user", content: `orchestrate\n${instruction}\n${objective}`, timestamp: 2 };
		const budget = custom("goal-budget-limit", "Budget exhausted: wrap up now.");
		const unrelated = custom("extension-fixture", instruction);
		const messages = [
			custom("goal-mode-context", "stale goal"),
			custom("orchestrate-notice", "stale rules"),
			custom("goal-auto-orchestrate-context", "stale expanded feature"),
			user,
			budget,
			unrelated,
		];
		const saved = structuredClone(messages);
		expect(filterGoalAutoOrchestrateMessages(messages, state())).toEqual([user, budget, unrelated]);
		expect(messages).toEqual(saved);
		for (let count = 0; count < 5; count++) {
			const filtered = filterGoalAutoOrchestrateMessages(messages, state());
			expect(filtered).toEqual([user, budget, unrelated]);
		}
		expect(messages).toEqual(saved);
	});

	test("stopped mode removes feature-provenance notices but preserves genuine later keyword requests", () => {
		const tagged = { source: "goal-auto-orchestrate", goalId: "goal-a" };
		const genuine = custom("orchestrate-notice", "new user's ordinary keyword notice");
		const user: AgentMessage = {
			role: "user",
			content: "orchestrate this new task, but ask before changes",
			timestamp: 3,
		};
		const messages = [
			custom("goal-auto-orchestrate-context", "stale expanded feature", tagged),
			custom("orchestrate-notice", "old auto notice", tagged),
			custom("goal-mode-context", "old auto objective", tagged),
			genuine,
			user,
		];
		for (const stopped of [undefined, state({ enabled: false }), state({ autoOrchestrate: false })]) {
			expect(filterGoalAutoOrchestrateMessages(messages, stopped)).toEqual([genuine, user]);
		}
	});

	test("continuation provenance follows the current goal and never survives a stopped mode", () => {
		const current = custom("goal-auto-orchestrate-continuation", "continue", { goalId: "goal-a" });
		const stale = custom("goal-auto-orchestrate-continuation", "continue old goal", { goalId: "goal-b" });
		const ordinary = custom("goal-continuation", "ordinary objective");
		expect(filterGoalAutoOrchestrateMessages([current, stale, ordinary], state())).toEqual([current]);
		expect(filterGoalAutoOrchestrateMessages([current, stale, ordinary], undefined)).toEqual([ordinary]);
	});

	test("final provider context adds one user block, preserves later explicit input and system/tool authority", () => {
		const original = providerContext(["task", "read"]);
		const saved = structuredClone(original);
		const result = applyGoalAutoOrchestrateContext(original, state());
		expect(original).toEqual(saved);
		expect(result.systemPrompt).toEqual(original.systemPrompt);
		expect(result.tools).toEqual(original.tools);
		expect(result.messages.slice(0, original.messages.length)).toEqual(original.messages);
		const injected = result.messages.filter(message => text(message.content).includes(instruction));
		expect(injected).toHaveLength(1);
		expect(injected[0]?.role).toBe("user");
		expect(text(injected[0]?.content)).toContain(objective);
		// This static strategy explicitly subordinates itself to subsequent user
		// instructions; it must not overwrite or promote them to system authority.
		expect(instruction).toContain("本次用户的明确要求");
		const repeat = applyGoalAutoOrchestrateContext(original, state());
		expect(repeat).toEqual(result);
		expect(applyGoalAutoOrchestrateContext(result, state())).toEqual(result);
		const withoutTask = applyGoalAutoOrchestrateContext({ ...result, tools: [] }, state());
		expect(withoutTask.messages.filter(message => text(message.content).includes(instruction))).toHaveLength(1);
		expect(text(withoutTask.messages.at(-1)?.content)).not.toContain(
			renderOrchestrateNotice({ tools: ["task", "read"] }, { authority: "user" }),
		);
		expect(applyGoalAutoOrchestrateContext(result, undefined)).toEqual(original);
	});

	test("request-local todo state is refreshed with the rest of the context without accumulation", () => {
		const original = providerContext(["task", "read"]);
		const first = applyGoalAutoOrchestrateContext(original, state(), "TODO_SNAPSHOT_FIRST");
		const second = applyGoalAutoOrchestrateContext(first, state(), "TODO_SNAPSHOT_SECOND");
		expect(second.messages.filter(message => text(message.content).includes(instruction))).toHaveLength(1);
		expect(text(second.messages.at(-1)?.content)).toContain("TODO_SNAPSHOT_SECOND");
		expect(text(second.messages.at(-1)?.content)).not.toContain("TODO_SNAPSHOT_FIRST");
		expect(text(second.messages.at(-1)?.content)).toContain(objective);
		expect(second.messages.at(-1)?.role).toBe("user");
		expect(original.messages).toHaveLength(1);
	});

	test("auxiliary stripping removes only symbol-owned main expansion across shallow prepared snapshots", () => {
		const original = providerContext(["task", "read"]);
		original.messages[0]!.content = `Genuine user prose quoting the strategy:\n${instruction}`;
		markPerCallContextMessage(original.messages[0]!);
		const main = applyGoalAutoOrchestrateContext(original, state());
		expect(main.messages).toHaveLength(2);
		const prepared: Context = {
			...main,
			messages: main.messages.map(message => ({ ...message })),
		};
		const auxiliary = stripGoalAutoOrchestrateContext(prepared);
		expect(auxiliary.messages).toEqual(original.messages);
		expect(auxiliary.systemPrompt).toBe(original.systemPrompt);
		expect(auxiliary.tools).toBe(original.tools);
		expect(text(auxiliary.messages[0]?.content)).toContain(instruction);
		expect(prepared.messages).toHaveLength(2);
		expect(main.messages).toHaveLength(2);
		expect(stripGoalAutoOrchestrateContext(original)).toBe(original);
		expect(stripGoalAutoOrchestrateContext(auxiliary)).toBe(auxiliary);
	});
});
