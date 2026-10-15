import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, StopReason } from "@oh-my-pi/pi-ai";
import { GoalContinuationGuard } from "@oh-my-pi/pi-coding-agent/goals/state";

function textTurn(stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "I will call the read tool now." }],
		api: "anthropic-messages",
		provider: "company",
		model: "test-model",
		stopReason,
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const toolTurn: AgentMessage[] = [
	{
		...textTurn("toolUse"),
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "task.txt" } }],
	},
	{
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "Actual task evidence" }],
		isError: false,
		timestamp: 0,
	},
];

describe("bounded goal tool-call recovery", () => {
	it("gives a text-only continuation one recovery, then stops with an unfinished-goal notice", () => {
		const guard = new GoalContinuationGuard();
		expect(guard.observe([textTurn()])).toBe("recover");
		expect(guard.recoveryPending).toBe(true);
		expect(guard.observe([textTurn()])).toBe("stop");
		expect(guard.recoveryPending).toBe(false);
		expect(guard.stopNotice).toContain("unfinished");
		expect(guard.observe([textTurn()])).toBe("stop");
	});

	it("resumes after real tool evidence without replenishing recovery and creating an alternating empty loop", () => {
		const guard = new GoalContinuationGuard();
		expect(guard.observe([textTurn()])).toBe("recover");
		expect(guard.observe(toolTurn)).toBe("continue");
		expect(guard.recoveryPending).toBe(false);
		expect(guard.observe([textTurn()])).toBe("stop");
	});

	it("preserves ordinary error and empty-output stops after a recovery made tool progress", () => {
		const stops: AgentMessage[][] = [
			...(["error", "aborted", "length"] as const).map(reason => [textTurn(reason)]),
			[],
			[{ ...textTurn(), content: [] }],
			[{ ...textTurn(), content: [{ type: "text", text: " \n" }] }],
		];
		for (const messages of stops) {
			const guard = new GoalContinuationGuard();
			expect(guard.observe([textTurn()])).toBe("recover");
			expect(guard.observe(toolTurn)).toBe("continue");
			expect(guard.observe(messages)).toBe("stop");
			expect(guard.stopNotice).toBeUndefined();
			expect(guard.recoveryPending).toBe(false);
			// Neither real work nor an ordinary stop replenishes the stretch's quota.
			expect(guard.observe([textTurn()])).toBe("stop");
			expect(guard.recoveryPending).toBe(false);
		}
	});

	it("retains tool evidence across maintenance runs without spending the recovery opportunity", () => {
		const guard = new GoalContinuationGuard();
		guard.recordActivity(toolTurn.slice(0, 1));
		guard.recordActivity(toolTurn.slice(1));
		expect(guard.observe([textTurn()])).toBe("continue");
		expect(guard.recoveryPending).toBe(false);
		expect(guard.observe([textTurn()])).toBe("recover");
	});

	it("clears another submission's buffered tool evidence when the host resets the continuation stretch", () => {
		const guard = new GoalContinuationGuard();
		guard.recordActivity(toolTurn);
		guard.reset();
		expect(guard.observe([textTurn()])).toBe("recover");
	});

	it("keeps repeated-tool evidence terminal instead of forcing more side effects", () => {
		const guard = new GoalContinuationGuard();
		expect(guard.observe(toolTurn)).toBe("continue");
		guard.recordActivity(toolTurn.slice(0, 1));
		expect(guard.observe(toolTurn.slice(1))).toBe("stop");
		expect(guard.recoveryPending).toBe(false);
		expect(guard.stopNotice).toBeUndefined();
	});

	it("does not turn errors, aborts, output truncation or empty turns into forced-tool requests", () => {
		for (const reason of ["error", "aborted", "length"] as const) {
			const guard = new GoalContinuationGuard();
			expect(guard.observe([textTurn(reason)])).toBe("stop");
			expect(guard.recoveryPending).toBe(false);
		}
		const guard = new GoalContinuationGuard();
		expect(guard.observe([])).toBe("stop");
		expect(guard.observe([{ ...textTurn(), content: [] }])).toBe("stop");
	});

	it("reports a recovery stopped before any assistant output instead of silently leaving the goal unfinished", () => {
		const guard = new GoalContinuationGuard();
		expect(guard.observe([textTurn()])).toBe("recover");
		expect(
			guard.observe([
				{
					role: "custom",
					customType: "goal-tool-recovery",
					content: "Continue the unfinished objective.",
					display: false,
					timestamp: 0,
				},
			]),
		).toBe("stop");
		expect(guard.stopNotice).toContain("unfinished");
		expect(guard.recoveryPending).toBe(false);
	});

	it("reports a failed recovery but does not warn on a user abort", () => {
		const guard = new GoalContinuationGuard();
		guard.observe([textTurn()]);
		expect(guard.observe([textTurn("error")])).toBe("stop");
		expect(guard.stopNotice).toContain("unfinished");
		guard.reset();
		guard.observe([textTurn()]);
		expect(guard.observe([textTurn("aborted")])).toBe("stop");
		expect(guard.stopNotice).toBeUndefined();
	});

	it("allows another bounded recovery only after the host explicitly re-arms the continuation stretch", () => {
		const guard = new GoalContinuationGuard();
		guard.observe([textTurn()]);
		guard.observe([textTurn()]);
		guard.reset();
		expect(guard.observe([textTurn()])).toBe("recover");
		expect(guard.observe([textTurn()])).toBe("stop");
	});
});
