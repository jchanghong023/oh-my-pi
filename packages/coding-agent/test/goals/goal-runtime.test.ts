import { describe, expect, it } from "bun:test";
import {
	GoalRuntime,
	type GoalRuntimeHost,
	goalTokenDelta,
	renderGoalPrompt,
	renderTrustedObjective,
} from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeState, GoalRuntimeEvent, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import { escapeXmlText } from "@oh-my-pi/pi-utils";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship <fast> & safely",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: cloneGoal(state.goal) } : undefined;
}

function cloneEvent(event: GoalRuntimeEvent): GoalRuntimeEvent {
	if (event.type === "goal_updated") {
		return {
			...event,
			goal: event.goal ? cloneGoal(event.goal) : null,
			state: cloneState(event.state),
		};
	}
	return { ...event };
}

function createHarness(initial: { state?: GoalModeState; usage?: GoalTokenUsage; now?: number } = {}) {
	let state = cloneState(initial.state);
	let usage = createUsage(initial.usage);
	let now = initial.now ?? 0;
	const events: GoalRuntimeEvent[] = [];
	const persists: Array<{ mode: "goal" | "goal_paused" | "none"; state?: GoalModeState }> = [];
	const hiddenMessages: Array<{ customType: string; content: string; deliverAs?: "steer" | "followUp" | "nextTurn" }> =
		[];
	const host: GoalRuntimeHost = {
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(usage),
		emit: async event => {
			events.push(cloneEvent(event));
		},
		persist: (mode, persistedState) => {
			persists.push({ mode, state: cloneState(persistedState) });
		},
		sendHiddenMessage: async message => {
			hiddenMessages.push({ ...message });
		},
		now: () => now,
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => cloneState(state),
		setState: (next: GoalModeState | undefined) => {
			state = cloneState(next);
		},
		setUsage: (next: Partial<GoalTokenUsage>) => {
			usage = createUsage(next);
		},
		advance: (ms: number) => {
			now += ms;
		},
		events,
		persists,
		hiddenMessages,
	};
}

describe("goal runtime", () => {
	it("sets orchestration only for successful explicit creation or replacement and ordinary replacements clear it", async () => {
		const harness = createHarness();
		const created = await harness.runtime.createGoal({ objective: "  First  ", autoOrchestrate: true });
		expect(created.goal.objective).toBe("First");
		expect(harness.getState()?.autoOrchestrate).toBe(true);
		expect(harness.persists.at(-1)?.state?.autoOrchestrate).toBe(true);

		const ordinary = await harness.runtime.replaceGoal({ objective: "Second" });
		expect(ordinary.autoOrchestrate).toBeUndefined();
		expect(ordinary.goal.id).not.toBe(created.goal.id);
		expect(harness.getState()?.goal.objective).toBe("Second");
		expect(harness.persists.at(-1)?.state?.autoOrchestrate).toBeUndefined();

		await harness.runtime.replaceGoal({ objective: "Third", autoOrchestrate: true });
		expect(harness.getState()?.autoOrchestrate).toBe(true);
		const disabled = await harness.runtime.replaceGoal({ objective: "Fourth", autoOrchestrate: false });
		expect(disabled.autoOrchestrate).toBeUndefined();
		expect(harness.persists.at(-1)?.state?.autoOrchestrate).toBeUndefined();
	});

	it("does not carry a completed or dropped goal's orchestration into ordinary creation", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "First", autoOrchestrate: true });
		await harness.runtime.completeGoalFromTool();
		const ordinary = await harness.runtime.createGoal({ objective: "Second" });
		expect(ordinary.autoOrchestrate).toBeUndefined();
		expect(ordinary.goal.objective).toBe("Second");
		expect(harness.persists.at(-1)?.state?.autoOrchestrate).toBeUndefined();

		await harness.runtime.replaceGoal({ objective: "Third", autoOrchestrate: true });
		await harness.runtime.dropGoal();
		expect(harness.getState()).toBeUndefined();
		expect(harness.persists.at(-1)).toEqual({ mode: "none", state: undefined });
		const recreated = await harness.runtime.createGoal({ objective: "Fourth" });
		expect(recreated.autoOrchestrate).toBeUndefined();
		expect(harness.persists.at(-1)?.state?.goal.objective).toBe("Fourth");
	});

	it("leaves the goal, orchestration, accounting, and persistence untouched when create or replace fails", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", autoOrchestrate: true, goal: createGoal() },
		});
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_000);
		harness.setUsage({ input: 12 });
		const original = harness.getState();
		const accounting = harness.runtime.snapshot;

		await expect(harness.runtime.createGoal({ objective: " ", autoOrchestrate: false })).rejects.toThrow(
			"objective is required",
		);
		await expect(
			harness.runtime.createGoal({ objective: "Next", tokenBudget: 0, autoOrchestrate: false }),
		).rejects.toThrow("positive integer");
		await expect(harness.runtime.createGoal({ objective: "Next" })).rejects.toThrow("already has a goal");
		await expect(harness.runtime.replaceGoal({ objective: " " })).rejects.toThrow("objective is required");
		await expect(
			harness.runtime.replaceGoal({ objective: "Next", tokenBudget: 1.5, autoOrchestrate: false }),
		).rejects.toThrow("positive integer");
		await expect(harness.runtime.onBudgetMutated(0)).rejects.toThrow("positive integer");
		expect(harness.getState()).toEqual(original);
		expect(harness.runtime.snapshot).toEqual(accounting);
		expect(harness.persists).toHaveLength(0);
		expect(harness.events).toHaveLength(0);

		await harness.runtime.pauseGoal();
		const paused = harness.getState();
		const persistCount = harness.persists.length;
		const eventCount = harness.events.length;
		await expect(harness.runtime.replaceGoal({ objective: "Next", autoOrchestrate: false })).rejects.toThrow(
			"no goal is active",
		);
		expect(harness.getState()).toEqual(paused);
		expect(harness.persists).toHaveLength(persistCount);
		expect(harness.events).toHaveLength(eventCount);

		const empty = createHarness();
		await expect(empty.runtime.replaceGoal({ objective: "Next", autoOrchestrate: true })).rejects.toThrow(
			"no goal is active",
		);
		expect(empty.getState()).toBeUndefined();
		expect(empty.persists).toHaveLength(0);
		expect((await empty.runtime.createGoal({ objective: "Ordinary" })).autoOrchestrate).toBeUndefined();
	});

	it("preserves orchestration through usage, budget, pause, resume, completion, and accounting resets", async () => {
		const harness = createHarness();
		const original = await harness.runtime.createGoal({
			objective: "Keep the full objective",
			tokenBudget: 10,
			autoOrchestrate: true,
		});
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		harness.setUsage({ input: 3, cacheWrite: 2, cacheRead: 1_000 });
		await harness.runtime.onToolCompleted("read");
		expect(harness.getState()?.goal.tokensUsed).toBe(5);
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);

		harness.setUsage({ input: 4, cacheWrite: 2, output: 1 });
		await harness.runtime.onGoalToolCompleted();
		expect(harness.getState()?.goal.tokensUsed).toBe(7);
		harness.setUsage({ input: 5, cacheWrite: 2, output: 1 });
		await harness.runtime.onAgentEnd();
		expect(harness.getState()?.goal.tokensUsed).toBe(8);

		await harness.runtime.onBudgetMutated(8);
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(1);
		await harness.runtime.onBudgetMutated(20);
		expect(harness.getState()?.goal.status).toBe("active");
		await harness.runtime.onBudgetMutated(undefined);
		expect(harness.getState()?.goal.tokenBudget).toBeUndefined();
		await harness.runtime.pauseGoal();
		expect(harness.getState()?.enabled).toBe(false);
		await harness.runtime.onBudgetMutated(25);
		expect(harness.getState()?.goal.status).toBe("paused");
		expect(harness.getState()?.enabled).toBe(false);
		await harness.runtime.resumeGoal();
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.autoOrchestrate).toBe(true);
		await harness.runtime.completeGoalFromTool();
		expect(harness.getState()).toMatchObject({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			autoOrchestrate: true,
			goal: { id: original.goal.id, objective: "Keep the full objective", status: "complete" },
		});
		harness.runtime.clearAccounting();
		expect(harness.getState()?.autoOrchestrate).toBe(true);
		await expect(harness.runtime.resumeGoal()).rejects.toThrow("already complete");
		expect(harness.getState()?.autoOrchestrate).toBe(true);
		expect(harness.persists.every(entry => entry.state?.autoOrchestrate === true)).toBe(true);
		for (const event of harness.events) {
			if (event.type === "goal_updated") expect(event.state?.autoOrchestrate).toBe(true);
		}
	});

	it("retains orchestration across internal reconciliation and interruption without auto-starting restored goals", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", autoOrchestrate: true, goal: createGoal() },
		});
		const preserved = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		expect(preserved?.enabled).toBe(true);
		expect(preserved?.autoOrchestrate).toBe(true);
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		await harness.runtime.onTaskAborted({ reason: "internal" });
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.persists.at(-1)?.state?.autoOrchestrate).toBe(true);

		const restored = await harness.runtime.onThreadResumed();
		expect(restored).toMatchObject({ enabled: false, autoOrchestrate: true, goal: { status: "paused" } });
		await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		expect(harness.getState()?.enabled).toBe(false);
		await harness.runtime.resumeGoal();
		await harness.runtime.onTaskAborted({ reason: "interrupted" });
		expect(harness.getState()).toMatchObject({
			enabled: false,
			autoOrchestrate: true,
			goal: { status: "paused" },
		});
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
		expect(harness.persists.every(entry => entry.state?.autoOrchestrate === true)).toBe(true);
	});

	it("keeps legacy state ordinary through restoration, management, usage, and completion", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		const restored = await harness.runtime.onThreadResumed();
		expect(restored?.enabled).toBe(false);
		expect(restored?.autoOrchestrate).toBeUndefined();
		await harness.runtime.resumeGoal();
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ input: 5 });
		await harness.runtime.onToolCompleted("read");
		await harness.runtime.onBudgetMutated(5);
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		await harness.runtime.onBudgetMutated(undefined);
		await harness.runtime.pauseGoal();
		await harness.runtime.resumeGoal();
		await harness.runtime.completeGoalFromTool();
		expect(harness.getState()?.autoOrchestrate).toBeUndefined();
		expect(harness.persists.every(entry => entry.state?.autoOrchestrate === undefined)).toBe(true);
	});

	it("keeps marked continuation audits and budgets without duplicating the per-request objective", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({
			objective: "Unique saved objective <unsafe>",
			tokenBudget: 50,
			autoOrchestrate: true,
		});
		const continuation = harness.runtime.buildContinuationPrompt();
		expect(continuation).not.toContain("Unique saved objective");
		expect(continuation).not.toContain("<objective>");
		expect(continuation).toContain("Token budget: 50");
		expect(continuation).toContain('Before `goal({op:"complete"})`');
		await harness.runtime.pauseGoal();
		expect(harness.runtime.buildContinuationPrompt()).toBeUndefined();
		await harness.runtime.resumeGoal();
		expect(harness.runtime.buildContinuationPrompt()).not.toContain("Unique saved objective");
		await harness.runtime.replaceGoal({ objective: "Ordinary objective <unsafe>" });
		expect(harness.runtime.buildContinuationPrompt()).toContain("Ordinary objective &lt;unsafe&gt;");
	});

	it("retains the objective and wrap-up steer when a marked goal reaches its budget limit", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({
			objective: "Finish the marked task",
			tokenBudget: 5,
			autoOrchestrate: true,
		});
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ output: 5 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()).toMatchObject({
			autoOrchestrate: true,
			goal: { status: "budget-limited", tokensUsed: 5 },
		});
		expect(harness.runtime.buildContinuationPrompt()).toBeUndefined();
		expect(harness.hiddenMessages[0]?.content).toContain("Finish the marked task");
		expect(harness.hiddenMessages[0]?.content).toContain("NEVER start new substantive work");
	});

	it("counts cache writes but ignores cache reads in token deltas", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 13, output: 6, cacheRead: 999, cacheWrite: 8 }),
				createUsage({ input: 10, output: 4, cacheRead: 1, cacheWrite: 5 }),
			),
		).toBe(8);
	});

	it("clamps token deltas at zero across usage resets", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 2 }),
				createUsage({ input: 100, output: 50, cacheRead: 500, cacheWrite: 20 }),
			),
		).toBe(0);
	});

	it("advances wall-clock accounting only by persisted whole seconds", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		harness.setUsage(createUsage({ input: 1 }));
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(1);

		harness.advance(400);
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(1);

		harness.advance(700);
		harness.setUsage(createUsage({ input: 2 }));
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(3);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(3_000);
		expect(harness.persists).toHaveLength(2);
	});

	it("does not persist snapshots on wall-clock-only flushes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		// Flush wall-clock time without any token usage changes.
		await harness.runtime.flushUsage("suppressed");
		// The in-memory state should still be updated.
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		// But it should not write/persist to the session log.
		expect(harness.persists).toHaveLength(0);
	});

	it("persists wall-clock-only usage before internal compaction or session-switch aborts", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		await harness.runtime.onTaskAborted({ reason: "internal" });

		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.persists).toHaveLength(1);
		expect(harness.persists[0]).toMatchObject({
			mode: "goal",
			state: { goal: { timeUsedSeconds: 2 } },
		});
	});

	it("resets wall-clock baseline when preserving an active goal after a no-goal switch", async () => {
		const goal = createGoal();
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setState(undefined);
		harness.advance(10_000);
		harness.setState({ enabled: true, mode: "active", goal });

		const resumed = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		harness.advance(1_000);
		await harness.runtime.flushUsage("suppressed");

		expect(resumed?.goal.status).toBe("active");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(11_000);
	});

	it("clears stale accounting when reconciling to a no-goal session", async () => {
		const goal = createGoal();
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setState(undefined);
		harness.runtime.clearAccounting();
		harness.advance(10_000);
		harness.setState({ enabled: true, mode: "active", goal });

		await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		harness.advance(1_000);
		await harness.runtime.flushUsage("suppressed");

		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(11_000);
	});

	it("steers only once until a budget mutation resets the cycle", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 10, tokensUsed: 8 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ input: 2 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]).toMatchObject({
			customType: "goal-budget-limit",
			deliverAs: "steer",
		});

		harness.setUsage({ input: 5 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.hiddenMessages).toHaveLength(1);

		await harness.runtime.onBudgetMutated(20);
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.tokenBudget).toBe(20);
		expect(harness.hiddenMessages).toHaveLength(1);

		harness.setUsage({ input: 15 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(2);
	});

	it("pauses an active goal when an interruption aborts the task", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ output: 4 });
		await harness.runtime.onTaskAborted({ reason: "interrupted" });

		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.goal.status).toBe("paused");
		expect(state?.goal.tokensUsed).toBe(4);
		expect(state?.goal.timeUsedSeconds).toBe(1);
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("auto-pauses active goals when a thread resumes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const resumed = await harness.runtime.onThreadResumed();
		expect(resumed?.enabled).toBe(false);
		expect(resumed?.goal.status).toBe("paused");
		expect(harness.getState()?.enabled).toBe(false);
		expect(harness.getState()?.goal.status).toBe("paused");
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("preserves an active goal during internal session-switch reconciliation", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const resumed = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });

		expect(resumed?.enabled).toBe(true);
		expect(resumed?.goal.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.persists).toHaveLength(0);
	});

	it("renders transient active goal rules as plain user context without repeating the saved objective", () => {
		const goal = createGoal({ objective: "Saved <objective>", tokenBudget: 50, tokensUsed: 12, timeUsedSeconds: 3 });
		const context = renderGoalPrompt("active", goal, { omitObjective: true, authority: "user" });
		expect(context).not.toContain("Saved");
		expect(context).not.toContain("<goal_context>");
		expect(context).not.toContain("<objective>");
		expect(context).not.toContain("Objective below");
		expect(context).toContain("Tokens used: 12");
		expect(context).toContain("Token budget: 50");
		expect(context).toContain("Tokens remaining: 38");
		expect(context).toContain("Time used: 3 seconds");
		expect(context).toContain('`goal({op:"complete"})`: only verified completion');
		expect(context).toContain("audit current repo state against every concrete deliverable");
		expect(context).toContain("Budget exhaustion ≠ completion");

		const ordinary = renderGoalPrompt("active", goal);
		expect(ordinary).toContain("<goal_context>");
		expect(ordinary).toContain("<objective>\nSaved &lt;objective&gt;\n</objective>");
	});

	it("escapes XML in goal helpers and rendered prompts", () => {
		const objective = "Fix <root>&keep>safe";
		const goal = createGoal({ objective });
		const prompt = renderGoalPrompt("active", goal);

		expect(renderTrustedObjective(objective)).toBe("<objective>\nFix &lt;root&gt;&amp;keep&gt;safe\n</objective>");
		expect(prompt).toContain("Fix &lt;root&gt;&amp;keep&gt;safe");
		expect(prompt).not.toContain(objective);
	});

	it("escapeXmlText escapes only the XML-significant trio and leaves other characters untouched", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
		expect(escapeXmlText("'\"`")).toBe("'\"`");
	});

	it("onBudgetMutated downward to below current usage flips active to budget-limited and steers", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 100, tokensUsed: 30, status: "active" }),
			},
		});

		const next = await harness.runtime.onBudgetMutated(20);

		expect(next?.goal.status).toBe("budget-limited");
		expect(next?.goal.tokenBudget).toBe(20);
		expect(next?.goal.tokensUsed).toBe(30);
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]?.customType).toBe("goal-budget-limit");
	});

	it("dropGoal emits goal_updated with the dropped goal and clears persisted state", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ id: "g-99", objective: "Ship soon" }),
			},
		});

		const dropped = await harness.runtime.dropGoal();

		expect(dropped?.status).toBe("dropped");
		expect(dropped?.id).toBe("g-99");
		expect(harness.getState()).toBeUndefined();
		const lastEvent = harness.events.at(-1);
		if (lastEvent?.type !== "goal_updated") {
			throw new Error("expected goal_updated event after dropGoal");
		}
		expect(lastEvent.goal?.status).toBe("dropped");
		expect(lastEvent.state?.enabled).toBe(false);
	});

	it("replaces an active goal with a fresh active goal", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: "Existing", tokenBudget: 100 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ input: 12 });

		const next = await harness.runtime.replaceGoal({ objective: "Second", tokenBudget: 25 });

		expect(next.enabled).toBe(true);
		expect(next.goal.objective).toBe("Second");
		expect(next.goal.status).toBe("active");
		expect(next.goal.tokenBudget).toBe(25);
		expect(next.goal.tokensUsed).toBe(0);
		expect(next.goal.timeUsedSeconds).toBe(0);
		expect(next.goal.id).not.toBe("goal-1");
		expect(harness.persists.at(-1)?.state?.goal.objective).toBe("Second");
	});
});
