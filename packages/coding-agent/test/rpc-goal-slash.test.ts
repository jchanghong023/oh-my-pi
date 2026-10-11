import { describe, expect, spyOn, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	RpcGoalController,
	type RpcGoalSession,
	type RpcGoalSlashRuntime,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { logger } from "@oh-my-pi/pi-utils";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";

function fixture(continuation = false, goalEnabled = true) {
	let state: GoalModeState | undefined;
	let tools = ["read"];
	let allowContinuation = true;
	let confirmDrop = false;
	const output: string[] = [];
	const continuations: string[] = [];
	const continuationMessages: Array<{ customType: string; details?: unknown }> = [];
	const transcript = { id: "session-a" };
	const contexts = new Map<string, Pick<SessionContext, "mode" | "modeData">>();
	const goalRuntime = new GoalRuntime({
		getState: () => state,
		setState: next => {
			state = next;
		},
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: event => controller.observe(event as AgentSessionEvent),
		persist: (mode, next) => {
			contexts.set(transcript.id, {
				mode,
				modeData: next
					? { goal: { ...next.goal }, ...(next.autoOrchestrate === true ? { autoOrchestrate: true } : {}) }
					: undefined,
			});
		},
		sendHiddenMessage: async () => {},
		now: () => 1_000,
	});
	const session = {
		settings: Settings.isolated({
			"goal.continuationModes": continuation ? ["rpc"] : ["interactive"],
			"goal.enabled": goalEnabled,
		}),
		sessionManager: {
			getSessionId: () => transcript.id,
			buildSessionContext: () => contexts.get(transcript.id) ?? { mode: "none" },
			appendModeChange: (mode: string) => {
				contexts.set(transcript.id, { mode });
			},
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
		promptCustomMessage: async (message: { customType: string; details?: unknown }) => {
			continuations.push(message.customType);
			continuationMessages.push(message);
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
		session,
		output,
		continuations,
		continuationMessages,
		transcript,
		contexts,
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

	test("failed slash tool activation preserves the original exception and diagnoses the committed goal", async () => {
		const f = fixture();
		const objective = "PRIVATE_GOAL_ACTIVATION_OBJECTIVE";
		const failure = Object.assign(new Error("PRIVATE_ACTIVATION_ERROR C:\\PRIVATE_ACTIVATION_PATH\\goal"), {
			code: "EACCES",
		});
		const events: LogEvent[] = [];
		const dispose = registerLogSink(event => events.push(event));
		const activate = spyOn(f.session, "setActiveToolsByName").mockImplementation(async () => {
			throw failure;
		});
		try {
			await expect(
				logger.withLogContext({ request_id: "goal-activation-request" }, () =>
					f.controller.handleSlash(`set ${objective}`, f.runtime),
				),
			).rejects.toBe(failure);
			expect(activate).toHaveBeenCalledWith(["read", "goal"]);
			expect(f.state()).toMatchObject({ enabled: true, goal: { objective, status: "active" } });
			expect(f.contexts.get(f.transcript.id)).toMatchObject({
				mode: "goal",
				modeData: { goal: { id: f.state()!.goal.id, objective } },
			});
			expect(f.tools()).toEqual(["read"]);
			expect(f.output).toEqual([]);
			expect(f.controller.continuationPending).toBe(false);
			const started = events.find(event => event.context?.event === "goal_enter_started");
			const terminals = events.filter(event => event.context?.event === "goal_enter_terminal");
			expect(started?.level).toBe("info");
			expect(started?.context?.operation_id).toEqual(expect.any(String));
			expect(terminals).toHaveLength(1);
			expect(structuredClone(terminals[0])).toMatchObject({
				level: "error",
				context: {
					component: "rpc-goal",
					stage: "activate_tools",
					result: "failed",
					partial: true,
					state_committed: true,
					runtime_start_completed: true,
					previous_tools_captured: true,
					tools_activation_completed: false,
					context_sent: false,
					error_type: "Error",
					error_code: "EACCES",
					operation_id: started!.context!.operation_id,
					request_id: "goal-activation-request",
					session_id: f.transcript.id,
					goal_id: f.state()!.goal.id,
					elapsed_ms: expect.any(Number),
					stage_elapsed_ms: expect.any(Number),
				},
			});
			expect(terminals[0]!.context!.elapsed_ms as number).toBeGreaterThanOrEqual(0);
			expect(terminals[0]!.context!.stage_elapsed_ms as number).toBeGreaterThanOrEqual(0);
			expect(events.some(event => event.context?.event === "goal_enter_completed")).toBe(false);
			const serialized = JSON.stringify(events);
			for (const canary of [objective, "PRIVATE_ACTIVATION_ERROR", "PRIVATE_ACTIVATION_PATH"])
				expect(serialized).not.toContain(canary);
		} finally {
			activate.mockRestore();
			dispose();
		}
	});

	test("failed pause tool restoration reports cleared internal state without claiming restoration", async () => {
		const f = fixture();
		const objective = "PRIVATE_GOAL_RESTORATION_OBJECTIVE";
		await f.controller.handleSlash(`set ${objective}`, f.runtime);
		const goalId = f.state()!.goal.id;
		const failure = Object.assign(new Error("PRIVATE_RESTORATION_ERROR C:\\PRIVATE_RESTORATION_PATH\\goal"), {
			code: "EIO",
		});
		const events: LogEvent[] = [];
		const dispose = registerLogSink(event => events.push(event));
		const restore = spyOn(f.session, "setActiveToolsByName").mockImplementation(async () => {
			throw failure;
		});
		try {
			await expect(
				logger.withLogContext({ request_id: "goal-restoration-request" }, () =>
					f.controller.handle({ op: "pause" }),
				),
			).rejects.toBe(failure);
			expect(restore).toHaveBeenCalledWith(["read"]);
			expect(f.state()).toMatchObject({ enabled: false, goal: { id: goalId, status: "paused" } });
			expect(f.contexts.get(f.transcript.id)).toMatchObject({
				mode: "goal_paused",
				modeData: { goal: { id: goalId, status: "paused" } },
			});
			expect(f.tools()).toEqual(["read", "goal"]);
			expect(f.controller.continuationPending).toBe(false);
			const started = events.find(event => event.context?.event === "goal_exit_started");
			const terminals = events.filter(event => event.context?.event === "goal_exit_terminal");
			expect(started?.level).toBe("info");
			expect(started?.context?.operation_id).toEqual(expect.any(String));
			expect(terminals).toHaveLength(1);
			expect(structuredClone(terminals[0])).toMatchObject({
				level: "error",
				context: {
					component: "rpc-goal",
					stage: "restore_tools",
					result: "failed",
					partial: true,
					state_committed: true,
					previous_tools_cleared: true,
					continuation_reset: true,
					tools_restoration_completed: false,
					error_type: "Error",
					error_code: "EIO",
					operation_id: started!.context!.operation_id,
					request_id: "goal-restoration-request",
					session_id: f.transcript.id,
					goal_id: goalId,
					elapsed_ms: expect.any(Number),
					stage_elapsed_ms: expect.any(Number),
				},
			});
			expect(terminals[0]!.context!.elapsed_ms as number).toBeGreaterThanOrEqual(0);
			expect(terminals[0]!.context!.stage_elapsed_ms as number).toBeGreaterThanOrEqual(0);
			expect(events.some(event => event.context?.event === "goal_exit_completed")).toBe(false);
			const serialized = JSON.stringify(events);
			for (const canary of [objective, "PRIVATE_RESTORATION_ERROR", "PRIVATE_RESTORATION_PATH"])
				expect(serialized).not.toContain(canary);
		} finally {
			restore.mockRestore();
			dispose();
		}
	});

	test("explicit auto-orchestrate creates and replaces goals without forcing continuation", async () => {
		const f = fixture();
		expect(await f.controller.handleSlash("  unattended objective  ", f.runtime, { autoOrchestrate: true })).toEqual({
			prompt: "unattended objective",
			goalAutoOrchestrateInitialId: f.state()?.goal.id,
		});
		const markedId = f.state()?.goal.id;
		expect(f.state()).toMatchObject({ enabled: true, autoOrchestrate: true });
		expect(await f.controller.handleSlash("set ordinary replacement", f.runtime)).toEqual({
			prompt: "ordinary replacement",
		});
		expect(f.state()?.goal.id).not.toBe(markedId);
		expect(f.state()?.autoOrchestrate).not.toBe(true);
		expect(await f.controller.handleSlash("set marked replacement", f.runtime, { autoOrchestrate: true })).toEqual({
			prompt: "marked replacement",
			goalAutoOrchestrateInitialId: f.state()?.goal.id,
		});
		expect(f.state()).toMatchObject({ autoOrchestrate: true, goal: { objective: "marked replacement" } });
		const replacementId = f.state()?.goal.id;
		await f.controller.handleSlash("not a replacement", f.runtime);
		expect(f.state()).toMatchObject({ autoOrchestrate: true, goal: { id: replacementId } });
		f.controller.observe({ type: "agent_end", isTerminal: true, messages: [] });
		f.controller.refresh();
		await tick();
		expect(f.continuations).toEqual([]);
		expect(f.controller.continuationPending).toBe(false);
	});

	test("allowed auto-orchestrate continuation identifies its goal without changing ordinary continuation", async () => {
		const f = fixture(true);
		await f.controller.handleSlash("set marked objective", f.runtime, { autoOrchestrate: true });
		const goalId = f.state()!.goal.id;
		f.controller.observe({ type: "agent_end", isTerminal: true, messages: [] });
		await tick();
		expect(f.continuationMessages).toHaveLength(1);
		expect(f.continuationMessages[0]).toMatchObject({
			customType: "goal-auto-orchestrate-continuation",
			details: { source: "goal-auto-orchestrate", goalId },
		});
		await f.controller.handleSlash("set ordinary objective", f.runtime);
		f.controller.observe({ type: "agent_end", isTerminal: true, messages: [] });
		await tick();
		expect(f.continuations).toEqual(["goal-auto-orchestrate-continuation", "goal-continuation"]);
		expect(f.continuationMessages[1]?.details).toBeUndefined();
	});

	test("management through either command preserves the original marked or ordinary mode", async () => {
		for (const autoOrchestrate of [true, false]) {
			const f = fixture();
			await f.controller.handleSlash("set objective", f.runtime, { autoOrchestrate });
			const id = f.state()?.goal.id;
			for (const options of [undefined, { autoOrchestrate: true }]) {
				await f.controller.handleSlash("show", f.runtime, options);
				await f.controller.handleSlash("", f.runtime, options);
				await f.controller.handleSlash("budget 500", f.runtime, options);
				expect(f.state()?.goal.tokenBudget).toBe(500);
				expect(
					await f.controller.handleSlash("budget 0", f.runtime, options).catch(error => error.message),
				).toContain("positive integer");
				await f.controller.handleSlash("budget off", f.runtime, options);
				expect(f.state()?.goal.tokenBudget).toBeUndefined();
				await f.controller.handleSlash("pause", f.runtime, options);
				expect(f.state()).toMatchObject({ enabled: false, goal: { id, status: "paused" } });
				expect(
					await f.controller.handleSlash("set replacement", f.runtime, options).catch(error => error.message),
				).toContain("paused");
				expect(f.state()?.goal.id).toBe(id);
				expect(f.state()?.autoOrchestrate === true).toBe(autoOrchestrate);
				await f.controller.handleSlash("resume", f.runtime, options);
				expect(f.state()).toMatchObject({ enabled: true, goal: { id, status: "active" } });
				expect(f.state()?.autoOrchestrate === true).toBe(autoOrchestrate);
				await f.controller.handleSlash("drop", f.runtime, options);
				expect(f.state()?.goal.id).toBe(id);
				expect(f.state()?.autoOrchestrate === true).toBe(autoOrchestrate);
			}
			f.setConfirm(true);
			await f.controller.handleSlash("drop", f.runtime, { autoOrchestrate: true });
			expect(f.state()).toBeUndefined();
			expect(f.tools()).toEqual(["read"]);
		}
	});

	test("cancelled and failed host dialogs cannot create, replace, or remove an auto-orchestrate marker", async () => {
		const f = fixture();
		const options = { autoOrchestrate: true };
		f.runtime.ui!.input = async () => undefined;
		expect(await f.controller.handleSlash("", f.runtime, options)).toBeUndefined();
		expect(f.state()).toBeUndefined();
		f.runtime.ui!.input = async () => {
			throw new Error("host dialog failed");
		};
		expect(await f.controller.handleSlash("", f.runtime, options).catch(error => error.message)).toContain(
			"host dialog failed",
		);
		expect(f.state()).toBeUndefined();
		await f.controller.handleSlash("set objective", f.runtime, options);
		const before = structuredClone(f.state());
		for (const command of ["set", "budget"]) {
			f.runtime.ui!.input = async () => undefined;
			expect(await f.controller.handleSlash(command, f.runtime)).toBeUndefined();
			expect(f.state()).toEqual(before);
			f.runtime.ui!.input = async () => {
				throw new Error("host dialog failed");
			};
			expect(await f.controller.handleSlash(command, f.runtime).catch(error => error.message)).toContain(
				"host dialog failed",
			);
			expect(f.state()).toEqual(before);
		}
		f.runtime.ui!.select = async () => undefined;
		expect(await f.controller.handleSlash("", f.runtime)).toBeUndefined();
		expect(f.state()).toEqual(before);
		f.runtime.ui!.select = async () => {
			throw new Error("host dialog failed");
		};
		expect(await f.controller.handleSlash("", f.runtime).catch(error => error.message)).toContain(
			"host dialog failed",
		);
		expect(f.state()).toEqual(before);
		await f.controller.handleSlash("drop", f.runtime, options);
		expect(f.state()).toEqual(before);
		f.runtime.ui!.confirm = async () => {
			throw new Error("host dialog failed");
		};
		expect(await f.controller.handleSlash("drop", f.runtime, options).catch(error => error.message)).toContain(
			"host dialog failed",
		);
		expect(f.state()).toEqual(before);
		f.runtime.ui = undefined;
		expect(await f.controller.handleSlash("drop", f.runtime, options).catch(error => error.message)).toContain(
			"host confirmation dialog",
		);
		expect(f.state()).toEqual(before);
	});

	test("reattach restores only a strict persisted marker and follows ordinary startup and session-switch lifecycle", async () => {
		const f = fixture();
		await f.controller.handleSlash("set marked objective", f.runtime, { autoOrchestrate: true });
		const markedGoal = structuredClone(f.state()!.goal);
		await f.controller.reconcile();
		expect(f.state()).toMatchObject({ enabled: false, autoOrchestrate: true, goal: { status: "paused" } });
		await f.controller.handleSlash("resume", f.runtime);
		expect(f.state()).toMatchObject({ enabled: true, autoOrchestrate: true, goal: { id: markedGoal.id } });
		for (const [id, marker] of [
			["legacy", undefined],
			["ordinary", false],
			["invalid-marker", "true"],
		] as const) {
			f.contexts.set(id, {
				mode: "goal",
				modeData: { goal: { ...markedGoal, id, objective: `${id} objective` }, autoOrchestrate: marker },
			});
			await f.controller.beginSessionChange();
			f.transcript.id = id;
			await f.controller.endSessionChange();
			expect(f.state()).toMatchObject({
				enabled: true,
				goal: { id, objective: `${id} objective`, status: "active" },
			});
			expect(f.state()?.autoOrchestrate).not.toBe(true);
			await f.controller.handleSlash("pause", f.runtime, { autoOrchestrate: true });
			await f.controller.handleSlash("resume", f.runtime, { autoOrchestrate: true });
			expect(f.state()?.autoOrchestrate).not.toBe(true);
		}
		await f.controller.beginSessionChange();
		f.transcript.id = "session-a";
		await f.controller.endSessionChange();
		expect(f.state()).toMatchObject({ enabled: true, autoOrchestrate: true, goal: { id: markedGoal.id } });
		await f.controller.beginSessionChange();
		f.transcript.id = "empty";
		await f.controller.endSessionChange();
		expect(f.state()).toBeUndefined();
		expect(f.tools()).toEqual(["read"]);
		await tick();
		expect(f.continuations).toEqual([]);
	});

	test("reconcile clears corrupt persisted goals with WARN but treats disabled goals as INFO suppression", async () => {
		for (const goalEnabled of [true, false]) {
			const f = fixture(false, goalEnabled);
			const objective = "PRIVATE_PERSISTED_GOAL_OBJECTIVE";
			const rawCanary = "PRIVATE_RAW_GOAL_MODE_DATA";
			f.contexts.set(f.transcript.id, {
				mode: "goal",
				modeData: {
					goal: {
						id: "saved-goal",
						objective,
						status: "active",
						tokensUsed: goalEnabled ? "invalid" : 0,
						timeUsedSeconds: 0,
						createdAt: 1_000,
						updatedAt: 1_000,
					},
					rawCanary,
				},
			});
			const events: LogEvent[] = [];
			const dispose = registerLogSink(event => events.push(event));
			try {
				expect(await f.controller.reconcile()).toBeUndefined();
				expect(await f.controller.handle({ op: "get" })).toEqual({ goal: null, state: null });
				expect(f.contexts.get(f.transcript.id)).toEqual({ mode: "none" });
				expect(f.tools()).toEqual(["read"]);
				const started = events.find(event => event.context?.event === "goal_reconcile_started");
				const decisions = events.filter(event =>
					["goal_reconcile_discarded", "goal_reconcile_suppressed"].includes(String(event.context?.event)),
				);
				expect(started?.context?.operation_id).toEqual(expect.any(String));
				expect(decisions).toHaveLength(1);
				expect(decisions[0]).toMatchObject({
					level: goalEnabled ? "warn" : "info",
					context: {
						component: "rpc-goal",
						event: goalEnabled ? "goal_reconcile_discarded" : "goal_reconcile_suppressed",
						stage: "restore",
						result: goalEnabled ? "discarded" : "suppressed",
						reason: goalEnabled ? "goal_mode_data_invalid" : "goal_disabled",
						saved_mode: "goal",
						operation_id: started!.context!.operation_id,
						session_id: f.transcript.id,
					},
				});
				const completed = events.find(event => event.context?.event === "goal_reconcile_completed");
				expect(structuredClone(completed)).toMatchObject({
					level: "info",
					context: {
						result: "inactive",
						operation_id: started!.context!.operation_id,
						elapsed_ms: expect.any(Number),
					},
				});
				expect(completed!.context!.elapsed_ms as number).toBeGreaterThanOrEqual(0);
				expect(events.some(event => event.level === "error")).toBe(false);
				const serialized = JSON.stringify(events);
				expect(serialized).not.toContain(objective);
				expect(serialized).not.toContain(rawCanary);
			} finally {
				dispose();
			}
		}
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
		await f.controller.handleSlash("set old objective", f.runtime, { autoOrchestrate: true });
		const waiting = Promise.withResolvers<boolean>();
		const requested = Promise.withResolvers<void>();
		f.runtime.ui = {
			select: async () => undefined,
			confirm: async () => {
				requested.resolve();
				return await waiting.promise;
			},
		};
		const dropping = f.controller.handleSlash("drop", f.runtime, { autoOrchestrate: true });
		await requested.promise;
		await f.controller.beginSessionChange();
		f.transcript.id = "session-b";
		await f.controller.endSessionChange();
		await f.controller.handleSlash("set new objective", f.runtime);
		const outputBefore = [...f.output];
		waiting.resolve(true);
		await dropping;
		expect(f.state()?.goal.objective).toBe("new objective");
		expect(f.state()?.autoOrchestrate).not.toBe(true);
		expect(f.tools()).toEqual(["read", "goal"]);
		expect(f.output).toEqual(outputBefore);
	});
});
