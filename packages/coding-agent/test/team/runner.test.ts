/**
 * `/team` default-runner regressions: resolved-model guards and safe,
 * correlated termination diagnostics without changing participant errors.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createTeamSubagentRunner, modelMatches, TEAM_PROPOSAL_SCHEMA } from "@oh-my-pi/pi-coding-agent/team";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";

describe("team modelMatches", () => {
	const pattern = "openrouter/foo";

	it("rejects an unknown model instead of treating an unpinned child as a participant", () => {
		expect(modelMatches(undefined, pattern)).toBe(false);
		expect(modelMatches("", pattern)).toBe(false);
	});

	it("accepts thinking-suffix and routing annotations after the base id", () => {
		expect(modelMatches(`${pattern}[thinking]`, pattern)).toBe(true);
		expect(modelMatches(`${pattern}:some-profile`, pattern)).toBe(true);
		expect(modelMatches(`${pattern}@upstream-only`, pattern)).toBe(true);
	});

	it("rejects a genuinely different model", () => {
		expect(modelMatches("openrouter/other", pattern)).toBe(false);
		// A longer id sharing the prefix is a different model, not an annotation.
		expect(modelMatches("openrouter/foobar", pattern)).toBe(false);
	});
});

describe("team runner abort diagnostics", () => {
	// These are the executor's complete soft-stop and force-stop reason formats.
	// The executor boundary is scripted; allocation, classification, logging and
	// temporary-lease cleanup all run through the real team runner.
	const cases = [
		{
			name: "reports a soft request-budget stop without treating it as user cancellation",
			abortReason: "Soft request budget exceeded (7 requests; budget 5)",
			requests: 7,
			abortCategory: "request_budget_stop",
			budget: 5,
			cancel: false,
		},
		{
			name: "recognizes the complete executor hard-stop suffix",
			abortReason: "Soft request budget exceeded (8 requests; budget 5) — agent did not yield when force-stopped",
			requests: 8,
			abortCategory: "request_budget_hard_stop",
			budget: 5,
			cancel: false,
		},
		{
			name: "preserves an unknown private reason but does not classify a budget-like prefix as a budget stop",
			abortReason: "Soft request budget exceeded (9 requests; budget 5) private-abort-canary",
			requests: 9,
			abortCategory: "internal_abort",
			budget: undefined,
			cancel: false,
		},
		{
			name: "prioritizes caller cancellation over the returned internal budget stop",
			abortReason: "Soft request budget exceeded (8 requests; budget 5) — agent did not yield when force-stopped",
			requests: 8,
			abortCategory: "signal",
			budget: undefined,
			cancel: true,
		},
	];

	for (const scenario of cases) {
		it(scenario.name, async () => {
			const tempDir = TempDir.createSync("@pi-team-private-path-canary-");
			let authStorage: AuthStorage | undefined;
			let restoreExecutor: (() => void) | undefined;
			let disposeSink: (() => void) | undefined;
			const events: LogEvent[] = [];
			const operationId = `team-abort-test-${crypto.randomUUID()}`;
			const controller = new AbortController();
			const task = "private-task-canary";
			const output = "private-body-canary";
			const stderr = "private-stderr-canary";
			const executorError = "private-executor-error-canary";
			let childId: string | undefined;
			let leaseDir: string | undefined;
			try {
				authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
				const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
				const settings = Settings.isolated();
				const executor = spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
					childId = options.id;
					leaseDir = options.artifactsDir;
					expect(leaseDir).toBeDefined();
					expect(fs.existsSync(leaseDir!)).toBe(true);
					if (scenario.cancel) controller.abort("private-signal-canary");
					return {
						index: options.index,
						id: options.id,
						agent: options.agent.name,
						agentSource: options.agent.source,
						task: options.task,
						exitCode: 1,
						output,
						stderr,
						error: executorError,
						truncated: false,
						durationMs: 1,
						tokens: 0,
						requests: scenario.requests,
						aborted: true,
						abortReason: scenario.abortReason,
						resolvedModel: "openrouter/foo",
					};
				});
				restoreExecutor = () => executor.mockRestore();
				disposeSink = registerLogSink(event => {
					if (event.context?.operation_id === operationId) events.push(event);
				});
				const runner = createTeamSubagentRunner({
					cwd: tempDir.path(),
					settings,
					modelRegistry,
					authStorage,
					sessionFile: null,
					artifactsDir: tempDir.path(),
					parentAgentId: "Main",
				});
				const outcome = await logger.withLogContext({ operation_id: operationId }, () =>
					runner(
						{
							role: "proposer",
							modelPattern: "openrouter/foo",
							label: "team-proposal-A",
							task,
							schema: TEAM_PROPOSAL_SCHEMA,
						},
						controller.signal,
					),
				);
				expect(outcome).toEqual({
					ok: false,
					error: scenario.cancel ? "cancelled" : scenario.abortReason,
				});
				expect(executor).toHaveBeenCalledTimes(1);
				expect(fs.existsSync(leaseDir!)).toBe(false);

				const subprocessStarts = events.filter(event => event.context?.event === "team_subprocess_started");
				const subprocessEnds = events.filter(event => event.context?.event === "team_subprocess_finished");
				const runnerEnds = events.filter(
					event =>
						event.context?.event === "team_runner_failed" || event.context?.event === "team_runner_cancelled",
				);
				expect(subprocessStarts).toHaveLength(1);
				expect(subprocessEnds).toHaveLength(1);
				expect(runnerEnds).toHaveLength(1);
				expect(subprocessStarts[0].context?.child_agent_id).toBe(childId);
				expect(subprocessEnds[0].context?.child_agent_id).toBe(childId);
				expect(subprocessEnds[0].context).toMatchObject({
					exit_code: 1,
					aborted: true,
					stdout_chars: output.length,
					stderr_chars: stderr.length,
				});
				const startContext = subprocessStarts[0].context!;
				expect(startContext.team_run_id).toEqual(expect.any(String));
				expect(startContext.call_id).toEqual(expect.any(String));
				for (const event of [...subprocessEnds, ...runnerEnds]) {
					expect(event.level).toBe(scenario.cancel ? "info" : "error");
					expect(structuredClone(event.context)).toMatchObject({
						component: "team.runner",
						operation_id: operationId,
						team_run_id: startContext.team_run_id,
						call_id: startContext.call_id,
						role: "proposer",
						label: "team-proposal-A",
						stage: "subprocess",
						result: scenario.cancel ? "cancelled" : "failed",
						abort_category: scenario.abortCategory,
						request_count: scenario.requests,
						elapsed_ms: expect.any(Number),
					});
					expect(event.context?.elapsed_ms as number).toBeGreaterThanOrEqual(0);
					if (scenario.budget === undefined) {
						expect(event.context).not.toHaveProperty("soft_request_budget");
					} else {
						expect(event.context?.soft_request_budget).toBe(scenario.budget);
					}
				}
				if (!scenario.cancel) expect(runnerEnds[0].context?.failure_category).toBe("internal_abort");
				const logged = JSON.stringify(events);
				for (const privateValue of [
					task,
					output,
					stderr,
					executorError,
					scenario.abortReason,
					"private-abort-canary",
					"private-signal-canary",
					"private-path-canary",
					tempDir.path(),
					leaseDir!,
				]) {
					expect(logged).not.toContain(privateValue);
				}
			} finally {
				restoreExecutor?.();
				disposeSink?.();
				authStorage?.close();
				tempDir.removeSync();
			}
		});
	}
});
