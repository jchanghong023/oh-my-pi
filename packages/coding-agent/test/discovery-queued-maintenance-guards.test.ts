import { describe, expect, it, spyOn } from "bun:test";
import { Agent, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

describe("queued pending-budget terminal boundaries", () => {
	// Terminal ownership prevents maintenance admission without consuming or rewriting queued inputs.
	it.each(["cancelled", "disposed", "settled"] as const)(
		"does not compact a %s session for queued pending input",
		async state => {
			const model = createMockModel({ responses: [] });
			const agent = new Agent({ initialState: { model: model.model, tools: [] } });
			const queued = { role: "user" as const, content: "pending ".repeat(20_000), timestamp: 1 };
			agent.followUp(queued);
			// These lifecycle guards precede all context/model/config reads, which is the boundary under test.
			const host = {
				agent,
				isDisposed: () => state === "disposed",
				isGeneratingHandoff: () => false,
			} as unknown as SessionMaintenanceHost;
			const maintenance = new SessionMaintenance(host);
			const compact = spyOn(maintenance, "runAutoCompaction");
			const controller = new AbortController();
			if (state === "cancelled") controller.abort(new Error("cancelled turn"));
			const context: AgentTurnEndContext | undefined =
				state === "settled"
					? undefined
					: {
							message: queued,
							toolResults: [],
							willContinue: false,
						};
			try {
				await maintenance.maintainContextMidRun([], controller.signal, context);

				expect(compact).not.toHaveBeenCalled();
				expect(agent.peekFollowUpQueue()).toEqual([queued]);
				expect(agent.state.messages).toEqual([]);
			} finally {
				compact.mockRestore();
				agent.clearAllQueues();
			}
		},
	);
});
