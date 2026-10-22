import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { LoopHost } from "@oh-my-pi/pi-coding-agent/modes/zcode/hosts/loop-host";
import { PlanHost, type PlanHostSession } from "@oh-my-pi/pi-coding-agent/modes/zcode/hosts/plan-host";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import { dispatchApprovedPlan } from "@oh-my-pi/pi-coding-agent/plan-mode/session-approval";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PlanProposalHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

const loops: LoopHost[] = [];
afterEach(() => {
	for (const loop of loops) loop.clear();
	loops.length = 0;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

function createHost(cwd: string) {
	const original = getBundledModel("anthropic", "claude-sonnet-4-5");
	const planModel = getBundledModel("anthropic", "claude-opus-4-5");
	let model = original;
	let thinking: ConfiguredThinkingLevel | undefined = ThinkingLevel.Low;
	let state: PlanModeState | undefined;
	let enabled = ["read", "mcp__server_tool"];
	let mounted = ["read", "mcp__server_tool"];
	let proposal: PlanProposalHandler | null = null;
	let manager = SessionManager.inMemory(cwd);
	let generation = 0;
	let streaming = false;
	const planPath = `${cwd}/PLAN.md`;
	const output: string[] = [];
	const background: Promise<void>[] = [];
	const submitted: Array<{ text: string; synthetic?: boolean }> = [];
	const repeated: string[] = [];
	const ui: Pick<ExtensionUIContext, "select" | "input" | "confirm"> = {
		select: async () => undefined,
		input: async () => undefined,
		confirm: async () => true,
	};
	const session: PlanHostSession &
		Pick<AgentSession, "setPlanReferencePath" | "markPlanReferenceSent" | "prompt" | "followUp"> = {
		settings: Settings.isolated(),
		get sessionManager() {
			return manager;
		},
		get sessionId() {
			return manager.getSessionId();
		},
		get sessionGeneration() {
			return generation;
		},
		isDisposed: false,
		get isStreaming() {
			return streaming;
		},
		isSessionTransitioning: false,
		get model() {
			return model;
		},
		getPlanModeState: () => state,
		setPlanModeState: next => {
			state = next;
		},
		getGoalModeState: () => undefined,
		getVibeModeState: () => undefined,
		getPlanReferencePath: () => planPath,
		getEnabledToolNames: () => [...enabled],
		getMountedXdevToolNames: () => [...mounted],
		hasBuiltInTool: name => name === "write",
		setActiveToolsByName: async tools => {
			enabled = [...tools];
		},
		setActiveToolPresentation: async (tools, devices) => {
			enabled = [...tools];
			mounted = [...devices];
		},
		restoreNonMCPToolPresentation: async (tools, devices) => {
			enabled = [...tools, ...enabled.filter(name => name.startsWith("mcp__"))];
			mounted = [...devices, ...mounted.filter(name => name.startsWith("mcp__"))];
		},
		setPlanProposalHandler: handler => {
			proposal = handler;
		},
		preparePlanForReview: async title => ({
			content: [{ type: "text", text: "Plan ready for review." }],
			details: { planFilePath: planPath, title, planExists: true },
		}),
		sendPlanModeContext: async () => {},
		configuredThinkingLevel: () => thinking,
		resolveRoleModelWithThinking: () => ({
			model: planModel,
			thinkingLevel: ThinkingLevel.High,
			explicitThinkingLevel: true,
			warning: undefined,
		}),
		setModelTemporary: async (next, level) => {
			model = next;
			thinking = level;
		},
		setThinkingLevel: level => {
			thinking = level;
		},
		waitForIdle: async () => {},
		runModeExitTeardown: async task => task(),
		abort: async () => {
			streaming = false;
			observe({ type: "agent_end", messages: [], isTerminal: true });
		},
		markPlanInternalAbortPending: () => {},
		clearPlanInternalAbortPending: () => {},
		setPlanReferencePath: () => {},
		markPlanReferenceSent: () => {},
		prompt: async (text, options) => {
			submitted.push({ text, synthetic: options?.synthetic });
			return true;
		},
		followUp: async (text, _images, options) => {
			submitted.push({ text, synthetic: options?.synthetic });
		},
	};
	const loopSession = Object.assign(session, {
		isCompacting: false,
		hasPostPromptWork: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
	});
	const loop = new LoopHost(loopSession as AgentSession, {
		output: text => output.push(text),
		submit: async (text, current) => {
			if (current()) repeated.push(text);
		},
		reset: async () => false,
		onContinuationDropped: () => {},
		continuationAllowed: () => !controller.reviewPending,
	});
	loops.push(loop);
	const controller = new PlanHost(
		session,
		ui,
		text => output.push(text),
		task => {
			background.push(task());
		},
		() => loop.refresh(),
	);
	const observe = (event: AgentSessionEvent) => {
		// Match rpc-mode's loop/plan ordering; the abort above emits the real review yield.
		loop.observe(event);
		controller.observe(event);
	};
	const drain = async () => {
		for (let index = 0; index < background.length; index++) await background[index];
	};
	const propose = async (): Promise<AgentSessionEvent> => {
		if (!proposal) throw new Error("Plan proposal handler was not installed");
		const result = await proposal("fix-plan");
		return {
			type: "tool_execution_end",
			toolCallId: "plan-1",
			toolName: "write",
			isError: false,
			result: {
				content: result.content,
				details: {
					xdev: { tool: PROPOSE_DEVICE_NAME, mode: "execute", args: { title: "fix-plan" }, inner: result.details },
				},
			},
		} as AgentSessionEvent;
	};
	const changeSession = () => {
		manager = SessionManager.inMemory(cwd);
		generation++;
	};
	const setStreaming = (value: boolean) => {
		streaming = value;
	};
	return {
		controller,
		loop,
		repeated,
		observe,
		session,
		ui,
		output,
		background,
		submitted,
		drain,
		propose,
		original,
		planModel,
		planPath,
		changeSession,
		setStreaming,
	};
}

describe("ZCode plan mode host", () => {
	test("entering with a task activates guarded write and plan role, then toggles paused and off", async () => {
		await using root = await TempDir.create("rpc-plan-toggle-");
		const host = createHost(root.absolute());
		expect(await host.controller.handle("inspect the parser")).toEqual({ prompt: "inspect the parser" });
		expect(host.session.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: host.planPath });
		expect(host.session.getEnabledToolNames()).toContain("write");
		expect(host.session.model).toEqual(host.planModel);
		expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		await host.controller.handle("");
		await host.drain();
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.model).toEqual(host.original);
		expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
		expect(host.session.sessionManager.buildSessionContext().mode).toBe("plan_paused");
		await host.controller.handle("");
		expect(host.session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	test("an enabled extension replacement of write is excluded and reported to the host", async () => {
		await using root = await TempDir.create("rpc-plan-shadowed-write-");
		const host = createHost(root.absolute());
		await host.session.setActiveToolPresentation(["read", "write"], ["read"]);
		vi.spyOn(host.session, "hasBuiltInTool").mockReturnValue(false);
		await host.controller.handle("");
		expect(host.session.getEnabledToolNames()).toEqual(["read"]);
		expect(host.output).toContain(
			"Plan mode: the `write` tool is provided by an extension and cannot submit plans. Disable it to use plan mode.",
		);
		await host.controller.handle("");
		await host.drain();
		expect(host.session.getEnabledToolNames()).toEqual(["read", "write"]);
	});

	test("rejecting an existing draft's exit confirmation preserves planning", async () => {
		await using root = await TempDir.create("rpc-plan-draft-");
		const host = createHost(root.absolute());
		await Bun.write(host.planPath, "# Draft\nKeep investigating.");
		vi.spyOn(host.ui, "confirm").mockResolvedValue(false);
		await host.controller.handle("");
		await host.controller.handle("");
		await host.drain();
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(host.session.model).toEqual(host.planModel);
		expect(host.submitted).toEqual([]);
	});

	test("an unsubmitted slugged draft requires exit confirmation and survives prompted reentry", async () => {
		await using root = await TempDir.create("rpc-plan-slug-draft-");
		const host = createHost(root.absolute());
		vi.spyOn(host.session.sessionManager, "getArtifactsDir").mockReturnValue(root.absolute());
		vi.spyOn(host.session, "getPlanReferencePath").mockReturnValue("local://PLAN.md");
		const confirm = vi.spyOn(host.ui, "confirm").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await host.controller.handle("");
		await Bun.write(`${root.absolute()}/local/parser-plan.md`, "# Parser draft\nNot yet submitted for review.");
		await host.controller.handle("");
		await host.drain();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		await host.controller.handle("");
		await host.drain();
		expect(host.session.sessionManager.buildSessionContext().mode).toBe("plan_paused");
		expect(await host.controller.handle("refine the draft")).toEqual({ prompt: "refine the draft" });
		expect(host.session.getPlanModeState()?.planFilePath).toBe("local://parser-plan.md");
	});

	test("rejected proposal keeps planning; approval restores tools/model and dispatches the displayed plan", async () => {
		await using root = await TempDir.create("rpc-plan-approve-");
		const host = createHost(root.absolute());
		const content = "# Parser fix\nPreserve trailing tokens.";
		await Bun.write(host.planPath, content);
		await host.controller.handle("");
		vi.spyOn(host.ui, "confirm").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		host.controller.observe(await host.propose());
		expect(host.controller.reviewPending).toBe(true);
		await host.drain();
		expect(host.output).toContain(content);
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(host.submitted).toEqual([]);
		host.controller.observe(await host.propose());
		await host.drain();
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
		expect(host.session.model).toEqual(host.original);
		expect(host.submitted).toHaveLength(1);
		expect(host.submitted[0]?.text).toContain(content);
		expect(host.submitted[0]?.synthetic).toBe(true);
		expect(host.controller.reviewPending).toBe(false);
	});

	test("rejecting approval re-arms the loop after the proposal abort without another agent_end", async () => {
		await using root = await TempDir.create("rpc-plan-loop-reject-");
		const host = createHost(root.absolute());
		await Bun.write(host.planPath, "# Draft plan");
		await host.controller.handle("");
		await host.loop.handle("2 1s improve the draft");
		host.loop.capturePrompt("improve the draft");
		const reply = Promise.withResolvers<boolean>();
		const shown = Promise.withResolvers<void>();
		vi.spyOn(host.ui, "confirm").mockImplementation(async () => {
			shown.resolve();
			return reply.promise;
		});
		host.observe(await host.propose());
		await shown.promise;
		vi.useFakeTimers();
		await advance(1000);
		expect(host.repeated).toEqual([]);
		expect(host.loop.continuationPending).toBe(false);
		reply.resolve(false);
		await host.drain();
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(host.loop.continuationPending).toBe(true);
		await advance(1000);
		expect(host.repeated).toEqual(["improve the draft"]);
		expect(host.submitted).toEqual([]);
	});

	for (const action of ["abort", "new_session"] as const) {
		test(`${action} during approval never revives a loop on a late rejected response`, async () => {
			await using root = await TempDir.create(`rpc-plan-loop-${action}-`);
			const host = createHost(root.absolute());
			await Bun.write(host.planPath, "# Draft plan");
			await host.controller.handle("");
			await host.loop.handle("2 1s improve the draft");
			host.loop.capturePrompt("improve the draft");
			const reply = Promise.withResolvers<boolean>();
			const shown = Promise.withResolvers<void>();
			vi.spyOn(host.ui, "confirm").mockImplementation(async () => {
				shown.resolve();
				return reply.promise;
			});
			host.observe(await host.propose());
			await shown.promise;
			host.controller.cancel();
			if (action === "abort") {
				host.loop.pause();
				await host.session.abort();
			} else {
				host.loop.clear();
				await host.controller.beginSessionChange();
				host.changeSession();
				await host.controller.endSessionChange();
			}
			vi.useFakeTimers();
			reply.resolve(false);
			await host.drain();
			await advance(1000);
			expect(host.repeated).toEqual([]);
			expect(host.submitted).toEqual([]);
			expect(host.loop.continuationPending).toBe(false);
			expect(host.loop.enabled).toBe(action === "abort");
		});
	}

	test("approval dispatch does not independently re-arm the loop before execution yields", async () => {
		await using root = await TempDir.create("rpc-plan-loop-approve-");
		const host = createHost(root.absolute());
		await Bun.write(host.planPath, "# Approved plan");
		await host.controller.handle("");
		await host.loop.handle("2 1s improve the draft");
		host.loop.capturePrompt("improve the draft");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(host.session, "prompt").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			host.observe({ type: "agent_end", messages: [], isTerminal: true });
			return true;
		});
		host.observe(await host.propose());
		await started.promise;
		expect(host.controller.reviewPending).toBe(false);
		expect(host.loop.continuationPending).toBe(false);
		vi.useFakeTimers();
		await advance(1000);
		expect(host.repeated).toEqual([]);
		release.resolve();
		await host.drain();
		expect(host.loop.continuationPending).toBe(true);
		await advance(1000);
		expect(host.repeated).toEqual(["improve the draft"]);
	});

	test("operator cancellation releases review without executing a late affirmative reply", async () => {
		await using root = await TempDir.create("rpc-plan-cancel-");
		const host = createHost(root.absolute());
		await Bun.write(host.planPath, "# Pending plan");
		await host.controller.handle("");
		const reply = Promise.withResolvers<boolean>();
		const shown = Promise.withResolvers<void>();
		vi.spyOn(host.ui, "confirm").mockImplementation(async (_title, _message, options) => {
			shown.resolve();
			options?.signal?.addEventListener("abort", () => reply.resolve(false), { once: true });
			return reply.promise;
		});
		host.controller.observe(await host.propose());
		await shown.promise;
		host.controller.cancel();
		reply.resolve(true);
		await host.drain();
		expect(host.submitted).toEqual([]);
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
	});

	test("session switching drops delayed source proposals and non-detaching navigation does not abort", async () => {
		await using root = await TempDir.create("rpc-plan-switch-");
		const host = createHost(root.absolute());
		await host.controller.handle("");
		const sourceProposal = await host.propose();
		const abort = vi.spyOn(host.session, "abort");
		await host.controller.beginSessionChange({ detachesRun: false });
		await host.controller.endSessionChange({ detachesRun: false });
		expect(abort).not.toHaveBeenCalled();
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		await host.controller.beginSessionChange();
		host.changeSession();
		await host.controller.endSessionChange();
		host.controller.observe(sourceProposal);
		await host.drain();
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.submitted).toEqual([]);
	});

	for (const operation of ["branch", "fork"]) {
		for (const mode of ["plan", "none"] as const) {
			test(`${operation} into ${mode} history restores the original tools and model on exit`, async () => {
				await using root = await TempDir.create(`rpc-plan-${operation}-${mode}-`);
				const host = createHost(root.absolute());
				await host.controller.handle("");
				await host.controller.beginSessionChange({ detachesRun: false });
				host.changeSession();
				host.session.sessionManager.appendModeChange(
					mode,
					mode === "plan" ? { planFilePath: host.planPath } : undefined,
				);
				await host.controller.endSessionChange({ detachesRun: false });
				if (mode === "plan") {
					expect(host.session.getPlanModeState()?.enabled).toBe(true);
					expect(host.session.getEnabledToolNames()).toContain("write");
					expect(host.session.model).toEqual(host.planModel);
					await host.controller.handle("");
					await host.drain();
				}
				expect(host.session.getPlanModeState()).toBeUndefined();
				expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
				expect(host.session.model).toEqual(host.original);
				expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
			});
		}
	}

	test("non-detaching branch restoration waits for a streaming turn's terminal boundary", async () => {
		await using root = await TempDir.create("rpc-plan-branch-streaming-");
		const host = createHost(root.absolute());
		await host.controller.handle("");
		host.setStreaming(true);
		const restore = vi.spyOn(host.session, "setModelTemporary");
		await host.controller.beginSessionChange({ detachesRun: false });
		host.changeSession();
		await host.controller.endSessionChange({ detachesRun: false });
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
		expect(host.session.model).toEqual(host.planModel);
		expect(restore).not.toHaveBeenCalled();
		// Another history move before the yield must retain the deferred restore.
		await host.controller.beginSessionChange({ detachesRun: false });
		host.session.sessionManager.appendModeChange("none");
		await host.controller.endSessionChange({ detachesRun: false });
		host.setStreaming(false);
		host.observe({ type: "agent_end", messages: [], isTerminal: true });
		await host.drain();
		expect(host.session.model).toEqual(host.original);
		expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
	});

	test("detaching after a streaming history move does not restore the source model in the destination", async () => {
		await using root = await TempDir.create("rpc-plan-pending-switch-");
		const host = createHost(root.absolute());
		await host.controller.handle("");
		host.setStreaming(true);
		await host.controller.beginSessionChange({ detachesRun: false });
		host.changeSession();
		await host.controller.endSessionChange({ detachesRun: false });
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.model).toEqual(host.planModel);

		await host.controller.beginSessionChange();
		host.changeSession();
		const destinationModel = getBundledModel("anthropic", "claude-haiku-4-5");
		await host.session.setModelTemporary(destinationModel, ThinkingLevel.Medium);
		await host.controller.endSessionChange();
		host.setStreaming(false);
		host.observe({ type: "agent_end", messages: [], isTerminal: true });
		await host.drain();
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.model).toEqual(destinationModel);
		expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
	});

	for (const detachesRun of [false, true]) {
		test(`a no-op session change with detachesRun=${detachesRun} retains the same-run deferred restore`, async () => {
			await using root = await TempDir.create("rpc-plan-pending-noop-");
			const host = createHost(root.absolute());
			await host.controller.handle("");
			host.setStreaming(true);
			await host.controller.beginSessionChange({ detachesRun: false });
			host.changeSession();
			await host.controller.endSessionChange({ detachesRun: false });
			expect(host.session.getPlanModeState()).toBeUndefined();
			expect(host.session.model).toEqual(host.planModel);

			// A cancelled picker or no-op switch has not detached this streaming run.
			await host.controller.beginSessionChange({ detachesRun });
			await host.controller.endSessionChange({ detachesRun });
			expect(host.session.model).toEqual(host.planModel);
			host.setStreaming(false);
			host.observe({ type: "agent_end", messages: [], isTerminal: true });
			await host.drain();
			expect(host.session.model).toEqual(host.original);
			expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		});
	}

	test("a streaming branch into plan history retains the original restoration model", async () => {
		await using root = await TempDir.create("rpc-plan-branch-plan-streaming-");
		const host = createHost(root.absolute());
		await host.controller.handle("");
		host.setStreaming(true);
		const restore = vi.spyOn(host.session, "setModelTemporary");
		await host.controller.beginSessionChange({ detachesRun: false });
		host.changeSession();
		host.session.sessionManager.appendModeChange("plan", { planFilePath: host.planPath });
		await host.controller.endSessionChange({ detachesRun: false });
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(restore).not.toHaveBeenCalled();
		host.setStreaming(false);
		host.observe({ type: "agent_end", messages: [], isTerminal: true });
		await host.drain();
		await host.controller.handle("");
		await host.drain();
		expect(host.session.model).toEqual(host.original);
		expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
	});

	test("same-session tree moves reconcile plan history while cancelled navigation keeps its snapshot", async () => {
		await using root = await TempDir.create("rpc-plan-tree-");
		const host = createHost(root.absolute());
		const manager = host.session.sessionManager;
		manager.appendModeChange("none");
		const beforePlan = manager.getLeafId()!;
		await host.controller.handle("");
		const planLeaf = manager.getLeafId()!;
		const activate = vi.spyOn(host.session, "setActiveToolsByName");
		await host.controller.beginSessionChange({ detachesRun: false });
		await host.controller.endSessionChange({ detachesRun: false });
		expect(activate).not.toHaveBeenCalled();
		expect(manager.getLeafId()).toBe(planLeaf);
		await host.controller.beginSessionChange({ detachesRun: false });
		manager.branch(beforePlan);
		await host.controller.endSessionChange({ detachesRun: false });
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
		expect(host.session.model).toEqual(host.original);
		await expect(host.propose()).rejects.toThrow("Plan proposal handler was not installed");
		await host.controller.beginSessionChange({ detachesRun: false });
		manager.branch(planLeaf);
		await host.controller.endSessionChange({ detachesRun: false });
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(host.session.getEnabledToolNames()).toContain("write");
		expect(host.session.model).toEqual(host.planModel);
		await expect(host.propose()).resolves.toMatchObject({ type: "tool_execution_end" });
		await host.controller.handle("");
		await host.drain();
		expect(host.session.model).toEqual(host.original);
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
	});

	test("failed tool activation rolls back mode and the original presentation", async () => {
		await using root = await TempDir.create("rpc-plan-fail-");
		const host = createHost(root.absolute());
		vi.spyOn(host.session, "setActiveToolsByName").mockRejectedValueOnce(new Error("tool partition failed"));
		await expect(host.controller.handle("")).rejects.toThrow("tool partition failed");
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.session.getEnabledToolNames()).toEqual(["read", "mcp__server_tool"]);
		expect(host.session.model).toEqual(host.original);
	});

	test("entering during a turn defers plan-model replacement until the terminal yield", async () => {
		await using root = await TempDir.create("rpc-plan-deferred-");
		const host = createHost(root.absolute());
		host.setStreaming(true);
		await host.controller.handle("");
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(host.session.model).toEqual(host.original);
		host.setStreaming(false);
		host.controller.observe({ type: "agent_end", messages: [], isTerminal: true });
		await host.drain();
		expect(host.session.model).toEqual(host.planModel);
		await host.controller.handle("");
		await host.drain();
		expect(host.session.model).toEqual(host.original);
	});

	test("operator cancellation at the terminal yield retains the deferred plan role", async () => {
		await using root = await TempDir.create("rpc-plan-deferred-cancel-");
		const host = createHost(root.absolute());
		const waiting = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(host.session, "waitForIdle").mockImplementation(async () => {
			started.resolve();
			await waiting.promise;
		});
		host.setStreaming(true);
		await host.controller.handle("");
		host.setStreaming(false);
		host.controller.observe({ type: "agent_end", messages: [], isTerminal: true });
		await started.promise;
		host.controller.cancel();
		waiting.resolve();
		await host.drain();
		expect(host.session.getPlanModeState()?.enabled).toBe(true);
		expect(host.session.model).toEqual(host.planModel);
		expect(host.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
	});

	test("approval holds automatic turns through title persistence until execution is dispatched", async () => {
		await using root = await TempDir.create("rpc-plan-dispatch-gate-");
		const host = createHost(root.absolute());
		await Bun.write(host.planPath, "# Approved plan");
		await host.controller.handle("");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(host.session.sessionManager, "setSessionName").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return true;
		});
		const gatesAtDispatch: boolean[] = [];
		vi.spyOn(host.session, "prompt").mockImplementation(async () => {
			gatesAtDispatch.push(host.controller.reviewPending);
			return true;
		});
		host.controller.observe(await host.propose());
		await started.promise;
		expect(host.session.getPlanModeState()).toBeUndefined();
		expect(host.controller.reviewPending).toBe(true);
		expect(gatesAtDispatch).toEqual([]);
		release.resolve();
		await host.drain();
		expect(gatesAtDispatch).toEqual([false]);
		expect(host.controller.reviewPending).toBe(false);
	});

	test("abort during the shared approval tail's asynchronous title save prevents execution", async () => {
		await using root = await TempDir.create("rpc-plan-tail-cancel-");
		const host = createHost(root.absolute());
		const cancelled = new AbortController();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(host.session.sessionManager, "setSessionName").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return true;
		});
		const task = dispatchApprovedPlan(host.session as AgentSession, {
			planFilePath: host.planPath,
			title: "approval-race",
			planContent: "# Approved",
			preserveContext: true,
			signal: cancelled.signal,
		});
		await started.promise;
		cancelled.abort();
		release.resolve();
		await expect(task).rejects.toThrow("Plan approval cancelled");
		expect(host.submitted).toEqual([]);
	});
});
