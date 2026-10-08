import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as conditions from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { RpcLoopController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-loop";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const agentEnd = { type: "agent_end", isTerminal: true, messages: [] } satisfies AgentSessionEvent;

describe("RPC loop continuation", () => {
	const controllers: RpcLoopController[] = [];
	afterEach(() => {
		for (const controller of controllers) controller.clear();
		controllers.length = 0;
		vi.restoreAllMocks();
	});

	function fixture(mode: "prompt" | "compact" | "reset" = "prompt") {
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
			isSessionTransitioning: false,
			waitForIdle: async () => {},
			getVibeModeState: () => undefined,
			compact: async () => {
				actions.push("compact");
			},
		};
		let dropped = 0;
		let continuationAllowed = true;
		const controller = new RpcLoopController(session as unknown as AgentSession, {
			output: text => output.push(text),
			submit: async text => {
				actions.push(`submit:${transcript.id}:${text}`);
			},
			reset: async () => {
				actions.push("reset");
				transcript.id = "session-b";
				return true;
			},
			onContinuationDropped: () => dropped++,
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
		f.controller.observe(agentEnd);
		await Bun.sleep(850);
		expect(f.actions).toEqual(["submit:session-a:work"]);
	});
});
