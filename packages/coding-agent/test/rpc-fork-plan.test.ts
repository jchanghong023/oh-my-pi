import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import { RpcForkPlanController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-plan";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const makeContext = (emitted: object[], dispatched: Array<() => Promise<void>>): RpcForkContext => ({
	session: {} as RpcForkContext["session"],
	emit: frame => emitted.push(frame),
	success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
	error: (id, command, message, code) =>
		({ id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) }) as RpcResponse,
	// Background prompt turns (approve/refine) are queued, not awaited, so the
	// command answers immediately; tests flush them explicitly.
	dispatchForkPromptTurn: run => {
		dispatched.push(run);
	},
});

interface PlanSessionMocks {
	activeTools: string[];
	planState: { enabled: boolean; planFilePath: string; workflow?: string } | undefined;
	prompts: string[];
	proposalHandler: ((title: string) => unknown) | null;
	modeChanges: Array<Record<string, unknown>>;
	referencePath: string | undefined;
	referenceSent: number;
}

function setupPlanSession(): { session: AgentSession; mocks: PlanSessionMocks } {
	const mocks: PlanSessionMocks = {
		activeTools: ["read", "edit", "bash"],
		planState: undefined,
		prompts: [],
		proposalHandler: null,
		modeChanges: [],
		referencePath: undefined,
		referenceSent: 0,
	};
	const session = {
		getEnabledToolNames: () => mocks.activeTools,
		hasBuiltInTool: (name: string) => name === "read" || name === "edit" || name === "write",
		setActiveToolsByName: async (names: string[]) => {
			mocks.activeTools = [...names];
		},
		getPlanModeState: () => mocks.planState,
		setPlanModeState: (state: { enabled: boolean; planFilePath: string; workflow?: string } | undefined) => {
			mocks.planState = state
				? { enabled: state.enabled, planFilePath: state.planFilePath, workflow: state.workflow }
				: undefined;
		},
		getPlanReferencePath: () => mocks.referencePath,
		setPlanReferencePath: (value: string) => {
			mocks.referencePath = value;
		},
		markPlanReferenceSent: () => {
			mocks.referenceSent++;
		},
		setPlanProposalHandler: (handler: ((title: string) => unknown) | null) => {
			mocks.proposalHandler = handler;
		},
		preparePlanForReview: async (title: string) => ({ details: { tool: "xd://propose", title } }),
		sendPlanModeContext: async () => {},
		isStreaming: false,
		followUp: async (message: string) => {
			mocks.prompts.push(`followUp:${message}`);
		},
		prompt: async (message: string) => {
			mocks.prompts.push(`prompt:${message}`);
			return true;
		},
		settings: {} as AgentSession["settings"],
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionName: () => undefined,
			setSessionName: async () => true,
			appendModeChange: (mode: string, data: Record<string, unknown>) => {
				mocks.modeChanges.push({ mode, ...data });
			},
			getArtifactsDir: () => process.cwd(),
			getSessionId: () => "plan-sess",
		},
		getAvailableModels: () => [],
	} as unknown as AgentSession;
	return { session, mocks };
}

function setup(session: AgentSession): {
	run: (command: object) => Promise<RpcResponse>;
	controller: RpcForkPlanController;
	flushDispatches: () => Promise<void>;
} {
	const dispatched: Array<() => Promise<void>> = [];
	const host = new RpcForkHost(makeContext([], dispatched));
	host.activate();
	const controller = new RpcForkPlanController(host, session);
	return {
		run: command => host.handleCommand(command as { type: string }) as Promise<RpcResponse>,
		controller,
		flushDispatches: async () => {
			while (dispatched.length > 0) {
				const run = dispatched.shift();
				if (run) await run();
			}
		},
	};
}

describe("RpcForkPlanController (5.3)", () => {
	test("set_plan_mode enters with write augmentation, get_plan_state reflects, exit restores", async () => {
		const { session, mocks } = setupPlanSession();
		const { run } = setup(session);

		const enter = (await run({ id: "p1", type: "set_plan_mode", enabled: true })) as Extract<
			RpcResponse,
			{ command: "set_plan_mode"; success: true }
		>;
		expect(enter.data!.enabled).toBe(true);
		expect(enter.data!.planFilePath).toBe("local://PLAN.md");
		expect(mocks.activeTools).toEqual(["read", "edit", "bash", "write"]);
		expect(mocks.planState).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(mocks.modeChanges).toEqual([{ mode: "plan", planFilePath: "local://PLAN.md" }]);

		const state = await run({ id: "p2", type: "get_plan_state" });
		expect(state).toMatchObject({
			command: "get_plan_state",
			success: true,
			data: { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" },
		});

		const exit = await run({ id: "p3", type: "set_plan_mode", enabled: false });
		expect(exit).toMatchObject({ success: true, data: { enabled: false } });
		expect(mocks.activeTools).toEqual(["read", "edit", "bash"]);
		expect(mocks.planState).toBeUndefined();
		expect(mocks.proposalHandler).toBeNull();
	});

	test("/plan text interception toggles plan mode without prompting the model", async () => {
		const { session, mocks } = setupPlanSession();
		const { controller } = setup(session);

		await expect(controller.interceptSlashPlan("/plan")).resolves.toBe(true);
		expect(mocks.planState).toMatchObject({ enabled: true });
		expect(mocks.prompts).toEqual([]);

		await expect(controller.interceptSlashPlan("/plan off")).resolves.toBe(true);
		expect(mocks.planState).toBeUndefined();
		await expect(controller.interceptSlashPlan("explain /plan to me")).resolves.toBe(false);
		// Only a bare single-line `/plan`/`/plan off` toggles: other arguments and
		// multi-line prompts starting with `/plan` reach the model untouched.
		await expect(controller.interceptSlashPlan("/plan now")).resolves.toBe(false);
		await expect(controller.interceptSlashPlan("/plan\nreview the plan and continue")).resolves.toBe(false);
		expect(mocks.planState).toBeUndefined();
	});

	test("read_plan and list_plans surface plan file content", async () => {
		await using dir = await TempDir.create("rpc-plan-files-");
		const root = path.resolve(dir.path());
		const planPath = path.join(root, "demo-plan.md");
		await fs.writeFile(planPath, "# Demo plan\n\n1. step one");
		const { session } = setupPlanSession();
		const { run } = setup(session);

		const read = (await run({ id: "r1", type: "read_plan", path: planPath })) as Extract<
			RpcResponse,
			{ command: "read_plan"; success: true }
		>;
		expect(read.data!.content).toContain("# Demo plan");
		expect(path.resolve(read.data!.path)).toBe(planPath);

		const missing = await run({ type: "read_plan", path: path.join(root, "nope-plan.md") });
		expect(missing).toMatchObject({ success: false, code: "plan_not_found" });

		const invalid = await run({ type: "read_plan" });
		expect(invalid).toMatchObject({ success: false });
		void root;
	});

	test("approve_plan: refine prompts feedback, reject exits, approve dispatches the approved prompt", async () => {
		await using dir = await TempDir.create("rpc-plan-approve-");
		const root = path.resolve(dir.path());
		const planPath = path.join(root, "ship-plan.md");
		await fs.writeFile(planPath, "# Ship plan\n\n1. build");

		const { session, mocks } = setupPlanSession();
		const { run, flushDispatches } = setup(session);
		await run({ type: "set_plan_mode", enabled: true });

		const refineMissing = await run({ type: "approve_plan", decision: "refine" });
		expect(refineMissing).toMatchObject({ success: false });

		const refine = await run({ id: "a1", type: "approve_plan", decision: "refine", feedback: "add tests" });
		expect(refine).toMatchObject({ success: true, data: { decision: "refine", dispatched: true } });
		// The command answers before the turn runs: the feedback prompt only
		// reaches the session once the background dispatch is flushed.
		expect(mocks.prompts).toEqual([]);
		await flushDispatches();
		expect(mocks.prompts.at(-1)).toBe("prompt:add tests");
		expect(mocks.planState).toMatchObject({ enabled: true });

		const reject = await run({ id: "a2", type: "approve_plan", decision: "reject" });
		expect(reject).toMatchObject({ success: true, data: { decision: "reject", dispatched: false } });
		expect(mocks.planState).toBeUndefined();
		// Restore returns the pre-entry tool set (without the write augmentation).
		expect(mocks.activeTools).toEqual(["read", "edit", "bash"]);

		// Re-enter for the approve path, pointing the plan reference at the real file.
		mocks.referencePath = planPath;
		await run({ type: "set_plan_mode", enabled: true });
		const approve = (await run({ id: "a3", type: "approve_plan", decision: "approve" })) as RpcResponse;
		expect(approve).toMatchObject({ success: true });
		expect((approve as { data?: { dispatched: boolean } }).data?.dispatched).toBe(true);
		// Plan exit happens before the response; the execution turn does not.
		expect(mocks.planState).toBeUndefined();
		expect(mocks.prompts).toEqual(["prompt:add tests"]);
		await flushDispatches();
		expect(mocks.referenceSent).toBe(1);
		expect(mocks.referencePath).toBe(planPath);
		expect(mocks.prompts.at(-1)).toContain("Ship plan");
		expect(mocks.prompts.at(-1)).toContain("1. build");

		const notActive = await run({ type: "approve_plan", decision: "approve" });
		expect(notActive).toMatchObject({ success: false, code: "plan_not_active" });
	});

	test("approve_plan: refine without plan mode is rejected as plan_not_active", async () => {
		const { session } = setupPlanSession();
		const { run } = setup(session);
		const result = await run({ id: "r1", type: "approve_plan", decision: "refine", feedback: "try again" });
		expect(result).toMatchObject({ success: false, code: "plan_not_active" });
	});
});
