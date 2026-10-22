import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import * as conditions from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { GoalHost, type GoalHostSession } from "@oh-my-pi/pi-coding-agent/modes/zcode/hosts/goal-host";
import { LoopHost } from "@oh-my-pi/pi-coding-agent/modes/zcode/hosts/loop-host";
import { isRpcSessionSettled } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const agentEnd = { type: "agent_end", isTerminal: true, messages: [] } satisfies AgentSessionEvent;

describe("ZCode host loop continuation", () => {
	const controllers: LoopHost[] = [];
	afterEach(() => {
		for (const controller of controllers) controller.clear();
		controllers.length = 0;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function fixture(
		mode: "prompt" | "compact" | "reset" = "prompt",
		onDropped?: () => void,
		submit?: (text: string, current: () => boolean) => Promise<void>,
	) {
		const actions: string[] = [];
		const output: string[] = [];
		const transcript = { id: "session-a" };
		const session = {
			settings: Settings.isolated({ "loop.mode": mode }),
			sessionManager: { getSessionId: () => transcript.id, getCwd: () => process.cwd() },
			isDisposed: false,
			isStreaming: false,
			isCompacting: false,
			hasPostPromptWork: false,
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			hasPendingAsyncWork: () => false,
			isSessionTransitioning: false,
			waitForIdle: async () => {},
			getVibeModeState: () => undefined,
			compact: async () => {
				actions.push("compact");
			},
		};
		let dropped = 0;
		let continuationAllowed = true;
		const controller = new LoopHost(session as unknown as AgentSession, {
			output: text => output.push(text),
			submit:
				submit ??
				(async text => {
					actions.push(`submit:${transcript.id}:${text}`);
				}),
			reset: async () => {
				actions.push("reset");
				transcript.id = "session-b";
				return true;
			},
			onContinuationDropped: () => {
				dropped++;
				onDropped?.();
			},
			continuationAllowed: () => continuationAllowed,
		});
		controllers.push(controller);
		return {
			controller,
			session,
			transcript,
			actions,
			output,
			dropped: () => dropped,
			setContinuationAllowed: (value: boolean) => {
				continuationAllowed = value;
			},
		};
	}

	async function advance(ms: number): Promise<void> {
		vi.advanceTimersByTime(ms);
		for (let i = 0; i < 16; i++) await Promise.resolve();
	}

	test("positional intervals return the first prompt immediately and count it toward the total", async () => {
		vi.useFakeTimers();
		const f = fixture();
		expect(await f.controller.handle("3 1s work")).toEqual({ prompt: "work" });
		expect(f.actions).toEqual([]);
		expect(f.controller.continuationPending).toBe(false);
		f.controller.capturePrompt("work");
		// Time spent in the first turn must not shorten its terminal-to-next-start gap.
		await advance(850);
		f.controller.observe(agentEnd);
		f.controller.observe(agentEnd);
		await advance(999);
		expect(f.actions).toEqual([]);
		await advance(1);
		expect(f.actions).toEqual(["submit:session-a:work"]);
		expect(f.controller.continuationPending).toBe(false);
		await advance(150);
		expect(f.actions).toHaveLength(1);
		f.controller.observe(agentEnd);
		await advance(1000);
		expect(f.actions).toEqual(["submit:session-a:work", "submit:session-a:work"]);
		f.controller.observe(agentEnd);
		expect(f.controller.enabled).toBe(false);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.output.at(-1)).toBe("Loop limit reached. Loop mode disabled.");
	});

	for (const cancel of [false, true]) {
		test(`gate-queued loop input stays unsettled until ${cancel ? "cancellation" : "submission completes"}`, async () => {
			vi.useFakeTimers();
			const gate = Promise.withResolvers<void>();
			const submissions: string[] = [];
			const f = fixture("prompt", undefined, async (text, current) => {
				await gate.promise;
				if (current()) submissions.push(text);
			});
			await f.controller.handle("3 1s repeat");
			f.controller.capturePrompt("repeat");
			f.controller.observe(agentEnd);
			await advance(1000);
			expect(f.controller.continuationPending).toBe(true);
			expect(isRpcSessionSettled(f.session, () => f.controller.continuationPending)).toBe(false);
			expect(submissions).toEqual([]);
			if (cancel) {
				f.controller.pause();
				expect(f.controller.continuationPending).toBe(false);
				expect(isRpcSessionSettled(f.session, () => f.controller.continuationPending)).toBe(true);
			}
			gate.resolve();
			await advance(0);
			expect(submissions).toEqual(cancel ? [] : ["repeat"]);
			expect(f.controller.continuationPending).toBe(false);
			expect(isRpcSessionSettled(f.session, () => f.controller.continuationPending)).toBe(true);
		});
	}

	test("an inline admitted turn schedules its successor before its submit promise returns", async () => {
		vi.useFakeTimers();
		const release = Promise.withResolvers<void>();
		const submissions: string[] = [];
		const f = fixture("prompt", undefined, async text => {
			submissions.push(text);
			if (submissions.length === 1) {
				f.controller.observe(agentEnd);
				await release.promise;
			}
		});
		await f.controller.handle("3 1s repeat");
		f.controller.capturePrompt("repeat");
		f.controller.observe(agentEnd);
		await advance(1000);
		expect(submissions).toEqual(["repeat"]);
		expect(f.controller.continuationPending).toBe(true);
		release.resolve();
		await advance(0);
		expect(f.controller.continuationPending).toBe(true);
		await advance(1000);
		expect(submissions).toEqual(["repeat", "repeat"]);
		expect(f.controller.continuationPending).toBe(false);
	});

	test("a positional count of one includes the first manual prompt and never evaluates a repeat condition", async () => {
		vi.useFakeTimers();
		const condition = spyOn(conditions, "evaluateLoopCondition").mockResolvedValue({ kind: "continue" });
		const f = fixture();
		expect(await f.controller.handle("1 1s --while 'ready'")).toBeUndefined();
		expect(f.controller.enabled).toBe(true);
		f.controller.capturePrompt("manual first turn");
		f.controller.observe(agentEnd);
		expect(f.controller.enabled).toBe(false);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.actions).toEqual([]);
		expect(condition).not.toHaveBeenCalled();
	});

	test("exhausting an interval loop releases the goal at the same production terminal yield", async () => {
		const f = fixture("prompt", () => goal?.refresh());
		const state: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-a",
				objective: "finish the remaining work",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		};
		const admitted = Promise.withResolvers<void>();
		const submissions: string[] = [];
		const session = {
			...f.session,
			settings: Settings.isolated({ "goal.continuationModes": ["rpc"] }),
			getPlanModeState: () => undefined,
			getGoalModeState: () => state,
			getTodoPhases: () => [],
			goalRuntime: { buildContinuationPrompt: () => "continue the remaining goal" },
			promptCustomMessage: async (message: { customType: string }) => {
				submissions.push(message.customType);
				admitted.resolve();
				return true;
			},
		};
		const goal = new GoalHost(session as unknown as GoalHostSession, undefined, () => !f.controller.enabled);
		await f.controller.handle("1 1s work");
		f.controller.capturePrompt("work");
		// rpc-mode observes Goal before loop: Goal first encounters the loop host gate.
		goal.observe(agentEnd);
		expect(goal.continuationPending).toBe(false);
		f.controller.observe(agentEnd);
		expect(f.controller.enabled).toBe(false);
		expect(goal.continuationPending).toBe(true);
		await admitted.promise;
		expect(submissions).toEqual(["goal-continuation"]);
		expect(f.actions).toEqual([]);
		goal.stopForHostAbort();
	});

	test("duration deadlines wake before a longer interval without evaluating a condition", async () => {
		vi.useFakeTimers();
		const condition = spyOn(conditions, "evaluateLoopCondition").mockResolvedValue({ kind: "continue" });
		const f = fixture();
		expect(await f.controller.handle("1s 1h --while 'ready' work")).toEqual({ prompt: "work" });
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		expect(f.controller.continuationPending).toBe(true);
		await advance(1000);
		expect(f.controller.enabled).toBe(false);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.actions).toEqual([]);
		expect(condition).not.toHaveBeenCalled();
		expect(f.dropped()).toBeGreaterThan(0);
		expect(f.output.at(-1)).toBe("Loop time limit reached. Loop mode disabled.");
	});

	test("duration expiry cancels a condition that outlives the interval", async () => {
		vi.useFakeTimers();
		const waiting = Promise.withResolvers<conditions.LoopConditionVerdict>();
		let signal: AbortSignal | undefined;
		spyOn(conditions, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
			signal = options.signal;
			return await waiting.promise;
		});
		const f = fixture();
		await f.controller.handle("2s 1s --while 'ready' work");
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		await advance(1000);
		expect(signal?.aborted).toBe(false);
		await advance(1000);
		expect(f.controller.enabled).toBe(false);
		expect(f.controller.continuationPending).toBe(false);
		expect(signal?.aborted).toBe(true);
		waiting.resolve({ kind: "continue" });
		await advance(0);
		expect(f.actions).toEqual([]);
	});

	test("duration expiry releases a continuation even when the host idle promise stays pending", async () => {
		vi.useFakeTimers();
		const idle = Promise.withResolvers<void>();
		const f = fixture();
		f.session.waitForIdle = () => idle.promise;
		await f.controller.handle("2s 1s work");
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		await advance(1000);
		expect(f.controller.continuationPending).toBe(true);
		await advance(1000);
		expect(f.controller.enabled).toBe(false);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.dropped()).toBeGreaterThan(0);
		idle.resolve();
		await advance(0);
		expect(f.actions).toEqual([]);
	});

	test("pausing an interval cancels its timer and resumes without recounting the first turn", async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.controller.handle("2 1s work");
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		f.controller.pause();
		await advance(1000);
		expect(f.controller.enabled).toBe(true);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.actions).toEqual([]);
		f.controller.capturePrompt("replacement");
		f.controller.observe(agentEnd);
		await advance(1000);
		expect(f.actions).toEqual(["submit:session-a:replacement"]);
		f.controller.observe(agentEnd);
		expect(f.controller.enabled).toBe(false);
	});

	test("session cleanup cancels both interval and deadline timers", async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.controller.handle("1s 2s work");
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		f.controller.clear();
		f.transcript.id = "session-b";
		const outputBefore = [...f.output];
		await advance(2000);
		expect(f.controller.enabled).toBe(false);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.actions).toEqual([]);
		expect(f.output).toEqual(outputBefore);
		// A new legacy loop must not inherit the old interval.
		await f.controller.handle("1");
		f.controller.capturePrompt("new session");
		f.controller.observe(agentEnd);
		await advance(800);
		expect(f.actions).toEqual(["submit:session-b:new session"]);
	});

	test("maintenance polling does not repeat the configured interval", async () => {
		vi.useFakeTimers();
		const polling = Promise.withResolvers<void>();
		const sleep = spyOn(Bun, "sleep").mockImplementation(() => polling.promise);
		const f = fixture();
		await f.controller.handle("2 2s work");
		f.controller.capturePrompt("work");
		f.session.hasPostPromptWork = true;
		f.controller.observe(agentEnd);
		await advance(2000);
		expect(f.actions).toEqual([]);
		expect(f.controller.continuationPending).toBe(true);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(800);
		f.session.hasPostPromptWork = false;
		polling.resolve();
		await advance(0);
		expect(f.actions).toEqual(["submit:session-a:work"]);
	});

	test("inline skills repeat through the host pipeline; exhausted limits never run another condition", async () => {
		const condition = spyOn(conditions, "evaluateLoopCondition").mockResolvedValue({ kind: "continue" });
		const f = fixture();
		const text = "/skill:fix repair the failing test";
		expect(await f.controller.handle(`1 --while 'check-ready' ${text}`)).toEqual({ prompt: text });
		f.controller.capturePrompt(text);
		f.controller.observe({ ...agentEnd, isTerminal: false });
		expect(f.controller.continuationPending).toBe(false);
		f.controller.observe(agentEnd);
		expect(f.controller.continuationPending).toBe(true);
		expect(condition).not.toHaveBeenCalled();
		await Bun.sleep(850);
		expect(f.actions).toEqual([`submit:session-a:${text}`]);
		expect(condition).toHaveBeenCalledTimes(1);
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		expect(f.controller.enabled).toBe(false);
		expect(f.actions).toHaveLength(1);
		expect(condition).toHaveBeenCalledTimes(1);
	});

	test("host abort cancels a pending condition and a new manual prompt resumes the same budget", async () => {
		const waiting = Promise.withResolvers<conditions.LoopConditionVerdict>();
		let signal: AbortSignal | undefined;
		spyOn(conditions, "evaluateLoopCondition")
			.mockImplementationOnce(async (_condition, options) => {
				signal = options.signal;
				return await waiting.promise;
			})
			.mockResolvedValue({ kind: "continue" });
		const f = fixture();
		await f.controller.handle("1 --while 'wait-ready'");
		f.controller.capturePrompt("first");
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		f.controller.pause();
		expect(signal?.aborted).toBe(true);
		waiting.resolve({ kind: "continue" });
		await Bun.sleep(0);
		expect(f.controller.enabled).toBe(true);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.actions).toEqual([]);
		f.controller.observe(agentEnd);
		expect(f.controller.continuationPending).toBe(false);
		f.controller.capturePrompt("replacement");
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		expect(f.actions).toEqual(["submit:session-a:replacement"]);
	});

	test("session changes cancel condition work and discard old-session status and submissions", async () => {
		const waiting = Promise.withResolvers<conditions.LoopConditionVerdict>();
		let signal: AbortSignal | undefined;
		spyOn(conditions, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
			signal = options.signal;
			return await waiting.promise;
		});
		const f = fixture();
		await f.controller.handle("--while 'wait-ready'");
		f.controller.capturePrompt("old session");
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		const outputBefore = [...f.output];
		f.controller.clear();
		f.transcript.id = "session-b";
		waiting.resolve({ kind: "error", message: "old-session failure" });
		await Bun.sleep(0);
		expect(signal?.aborted).toBe(true);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.controller.enabled).toBe(false);
		expect(f.actions).toEqual([]);
		expect(f.output).toEqual(outputBefore);
		expect(f.dropped()).toBeGreaterThan(0);
	});

	for (const mode of ["compact", "reset"] as const) {
		test(`${mode} loops perform the configured action before submitting into the correct transcript`, async () => {
			const f = fixture(mode);
			await f.controller.handle("1");
			f.controller.capturePrompt("continue work");
			f.controller.observe(agentEnd);
			await Bun.sleep(850);
			expect(f.actions).toEqual([mode, `submit:${mode === "reset" ? "session-b" : "session-a"}:continue work`]);
			expect(f.controller.continuationPending).toBe(false);
		});
	}

	test("a satisfied condition stops the loop without spending another iteration or submitting", async () => {
		spyOn(conditions, "evaluateLoopCondition").mockResolvedValue({ kind: "halt", message: "Condition satisfied." });
		const f = fixture();
		await f.controller.handle("2 --until 'done'");
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		expect(f.actions).toEqual([]);
		expect(f.controller.enabled).toBe(false);
		expect(f.output.at(-1)).toBe("Condition satisfied.");
	});

	test("a plan review gate drops a waiting continuation and preserves its budget until approval", async () => {
		const waiting = Promise.withResolvers<conditions.LoopConditionVerdict>();
		spyOn(conditions, "evaluateLoopCondition")
			.mockImplementationOnce(() => waiting.promise)
			.mockResolvedValue({ kind: "continue" });
		const f = fixture();
		await f.controller.handle("1 --while 'review-ready'");
		f.controller.capturePrompt("work");
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		f.setContinuationAllowed(false);
		waiting.resolve({ kind: "continue" });
		await Bun.sleep(0);
		expect(f.controller.enabled).toBe(true);
		expect(f.controller.continuationPending).toBe(false);
		expect(f.actions).toEqual([]);
		f.setContinuationAllowed(true);
		f.controller.refresh();
		await Bun.sleep(850);
		expect(f.actions).toEqual(["submit:session-a:work"]);
	});
});
