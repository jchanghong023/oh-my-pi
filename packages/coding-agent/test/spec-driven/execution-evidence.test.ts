import { expect, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { StructuredSubagentRequest } from "../../src/task/structured-subagent";
import { ExecutionEvidence } from "../../src/spec-driven/execution-evidence";

function fixture() {
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const journal = {
		getBranch: () => entries.slice(),
		appendCustomEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
			return String(entries.length);
		},
	};
	const request = (agent = "task", sessionId = "executor", invocationKind: "task" | "eval" = "task") =>
		({
			agent,
			invocationKind,
			session: { sessionManager: { getSessionId: () => sessionId } },
		}) as unknown as StructuredSubagentRequest;
	const result = (agent: string, exitCode = 0, extra: Partial<SingleResult> = {}) =>
		({ agent, exitCode, ...extra }) as SingleResult;
	return { journal, request, result, evidence: new ExecutionEvidence(journal, "executor") };
}

test("writable task settlement followed by settled reviewer survives native history recovery", () => {
	const { evidence, request, result, journal } = fixture();
	const readonly = request();
	evidence.start(readonly);
	evidence.observeSession(readonly, false);
	evidence.settled(readonly, result("task"));
	expect(() => evidence.check()).toThrow("可写 task");
	const worker = request();
	evidence.start(worker);
	evidence.observeSession(worker, true);
	expect(() => evidence.check()).toThrow("尚未结清");
	expect(() => new ExecutionEvidence(journal, "executor").check()).toThrow("历史结果不可恢复");
	evidence.settled(worker, result("task"));
	expect(() => evidence.check()).toThrow("reviewer");
	const review = request("reviewer");
	evidence.start(review);
	evidence.settled(review, result("reviewer"));
	expect(() => evidence.check()).not.toThrow();
	expect(() => new ExecutionEvidence(journal, "executor").check()).not.toThrow();
	evidence.reset();
	expect(() => new ExecutionEvidence(journal, "executor").check()).toThrow("可写 task");
});

test("failed, aborted, unrelated and out-of-order children never supply successful evidence", () => {
	const { evidence, request, result } = fixture();
	const unrelated = request("task", "other");
	evidence.start(unrelated);
	evidence.observeSession(unrelated, true);
	evidence.settled(unrelated, result("task"));
	const evalChild = request("task", "executor", "eval");
	evidence.start(evalChild);
	evidence.observeSession(evalChild, true);
	evidence.settled(evalChild, result("task"));
	expect(() => evidence.check()).toThrow("可写 task");
	const worker = request();
	const premature = request("reviewer");
	evidence.start(worker);
	evidence.observeSession(worker, true);
	evidence.start(premature);
	evidence.settled(worker, result("task"));
	evidence.settled(premature, result("reviewer"));
	expect(() => evidence.check()).toThrow("reviewer");
	const failed = request("reviewer");
	evidence.start(failed);
	evidence.settled(failed, result("reviewer", 0, { aborted: true }));
	expect(() => evidence.check()).toThrow("reviewer");
	const reviewer = request("reviewer");
	evidence.start(reviewer);
	evidence.settled(reviewer, result("reviewer"));
	expect(() => evidence.check()).not.toThrow();
	const nextWorker = request();
	evidence.start(nextWorker);
	evidence.observeSession(nextWorker, true);
	evidence.settled(nextWorker, result("task", 1));
	expect(() => evidence.check()).toThrow("可写 task");
});
