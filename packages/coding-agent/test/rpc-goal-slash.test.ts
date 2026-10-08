import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	RpcGoalController,
	type RpcGoalSession,
	type RpcGoalSlashRuntime,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function fixture(continuation = false) {
	let state: GoalModeState | undefined;
	let tools = ["read"];
	let allowContinuation = true;
	let confirmDrop = false;
	const output: string[] = [];
	const continuations: string[] = [];
	const transcript = { id: "session-a" };
	const goalRuntime = new GoalRuntime({
		getState: () => state,
		setState: next => {
			state = next;
		},
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: event => controller.observe(event as AgentSessionEvent),
		persist: () => {},
		sendHiddenMessage: async () => {},
		now: () => 1_000,
	});
	const session = {
		settings: Settings.isolated({ "goal.continuationModes": continuation ? ["rpc"] : ["interactive"] }),
		sessionManager: {
			getSessionId: () => transcript.id,
			buildSessionContext: () => ({ mode: "none" }),
			appendModeChange: () => {},
			appendCustomEntry: () => {},
		},
		goalRuntime,
		getGoalModeState: () => state,
		setGoalModeState: (next: GoalModeState | undefined) => {
			state = next;
		},
		getPlanModeState: () => undefined,
		getEnabledToolNames: () => [...tools],
		setActiveToolsByName: async (names: string[]) => {
			tools = [...names];
		},
		sendGoalModeContext: async () => {},
		getTodoPhases: () => [],
		promptCustomMessage: async (message: { customType: string }) => {
			continuations.push(message.customType);
			return true;
		},
		waitForIdle: async () => {},
		isStreaming: false,
		isDisposed: false,
		isSessionTransitioning: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
	};
	const controller = new RpcGoalController(session as unknown as RpcGoalSession, undefined, () => allowContinuation);
	const runtime: RpcGoalSlashRuntime = {
		output: text => {
			output.push(text);
		},
		ui: {
			select: async () => "Show details",
			confirm: async () => confirmDrop,
		},
	};
	return {
		controller,
		runtime,
		output,
		continuations,
		transcript,
		state: () => state,
		tools: () => tools,
		setConfirm: (value: boolean) => {
			confirmDrop = value;
		},
		setContinuationAllowed: (value: boolean) => {
			allowContinuation = value;
		},
	};
}

async function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("RPC goal slash adapter", () => {
	test("set creates and replaces through GoalRuntime without racing its first prompt with auto-continuation", async () => {
		const f = fixture(true);
		expect(await f.controller.handleSlash("set first objective", f.runtime)).toEqual({ prompt: "first objective" });
		const firstId = f.state()?.goal.id;
		expect(f.state()?.goal).toMatchObject({ objective: "first objective", status: "active" });
		expect(f.tools()).toEqual(["read", "goal"]);
		expect(f.controller.continuationPending).toBe(false);
		await tick();
		expect(f.continuations).toEqual([]);
		expect(await f.controller.handleSlash("set replacement", f.runtime)).toEqual({ prompt: "replacement" });
		expect(f.state()?.goal.id).not.toBe(firstId);
		expect(f.state()?.goal.objective).toBe("replacement");
		await tick();
		expect(f.continuations).toEqual([]);
	});

	test("pause/resume preserve the same goal, and drop confirmation restores the original tools only when accepted", async () => {
		const f = fixture();
		await f.controller.handleSlash("set objective", f.runtime);
		const id = f.state()?.goal.id;
		await f.controller.handleSlash("pause", f.runtime);
		expect(f.state()?.goal).toMatchObject({ id, status: "paused" });
		expect(f.tools()).toEqual(["read"]);
		expect(await f.controller.handleSlash("set another", f.runtime).catch(error => error.message)).toContain(
			"paused",
		);
		await f.controller.handleSlash("resume", f.runtime);
		expect(f.state()?.goal).toMatchObject({ id, status: "active" });
		expect(f.tools()).toEqual(["read", "goal"]);
		await f.controller.handleSlash("drop", f.runtime);
		expect(f.state()?.goal.id).toBe(id);
		f.setConfirm(true);
		await f.controller.handleSlash("drop", f.runtime);
		expect(f.state()).toBeUndefined();
		expect(f.tools()).toEqual(["read"]);
	});

	test("budget edits reject malformed and unsafe values, retain the goal, and can clear its budget", async () => {
		const f = fixture();
		await f.controller.handleSlash("set objective", f.runtime);
		const id = f.state()?.goal.id;
		await f.controller.handleSlash("budget 500", f.runtime);
		expect(f.state()?.goal).toMatchObject({ id, tokenBudget: 500 });
		for (const value of ["0", "10junk", "9007199254740992"]) {
			expect(await f.controller.handleSlash(`budget ${value}`, f.runtime).catch(error => error.message)).toContain(
				"positive integer",
			);
			expect(f.state()?.goal.tokenBudget).toBe(500);
		}
		await f.controller.handleSlash("budget off", f.runtime);
		expect(f.state()?.goal.id).toBe(id);
		expect(f.state()?.goal.tokenBudget).toBeUndefined();
	});

	test("loop ownership suppresses goal continuation until the host refreshes its gate", async () => {
		const f = fixture(true);
		f.setContinuationAllowed(false);
		await f.controller.handle({ op: "create", objective: "objective" });
		f.controller.observe({ type: "agent_end", isTerminal: true, messages: [] });
		await tick();
		expect(f.continuations).toEqual([]);
		expect(f.controller.continuationPending).toBe(false);
		f.setContinuationAllowed(true);
		f.controller.refresh();
		await tick();
		expect(f.continuations).toEqual(["goal-continuation"]);
	});

	test("a confirmation returned after a session switch cannot drop the new session's goal", async () => {
		const f = fixture();
		await f.controller.handleSlash("set old objective", f.runtime);
		const waiting = Promise.withResolvers<boolean>();
		const requested = Promise.withResolvers<void>();
		f.runtime.ui = {
			select: async () => undefined,
			confirm: async () => {
				requested.resolve();
				return await waiting.promise;
			},
		};
		const dropping = f.controller.handleSlash("drop", f.runtime);
		await requested.promise;
		await f.controller.beginSessionChange();
		f.transcript.id = "session-b";
		await f.controller.endSessionChange();
		await f.controller.handleSlash("set new objective", f.runtime);
		const outputBefore = [...f.output];
		waiting.resolve(true);
		await dropping;
		expect(f.state()?.goal.objective).toBe("new objective");
		expect(f.tools()).toEqual(["read", "goal"]);
		expect(f.output).toEqual(outputBefore);
	});
});
