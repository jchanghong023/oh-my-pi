import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../src/cli/args";
import { Settings } from "../../src/config/settings";
import { workspaceMode, ZCodeRuntimeControls } from "../../src/modes/zcode/controls";
import { AgentSession } from "../../src/session/agent-session";
import { resolveApproval, resolveApprovalFromContext } from "../../src/tools/approval";
import { cfgToolsApprovalMode } from "../../src/tools/settings";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { SessionManager } from "../../src/session/session-manager";
import { ZCodeCommandHost } from "../../src/modes/zcode/commands";
import { ZCodeProjection } from "../../src/modes/zcode/projection";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { GoalTool } from "../../src/goals/tools/goal-tool";
import type { ToolSession } from "../../src/tools";
import { createAgentSession, type CreateAgentSessionResult } from "../../src/sdk";
import { AgentRegistry } from "../../src/registry/agent-registry";

function fixture(initial = "yolo") {
	const settings = Settings.isolated({ "tools.approvalMode": initial });
	let planEnabled = false;
	const jobs = new Set(["owned"]);
	const session = {
		settings,
		getPlanModeState: () => ({ enabled: planEnabled }),
		cancelAsyncJob: (id: string) => jobs.delete(id),
	} as unknown as AgentSession;
	const controls = new ZCodeRuntimeControls(session, {
		setPlanEnabled: async enabled => {
			planEnabled = enabled;
		},
	});
	const permission = (tier: "read" | "write" | "exec") =>
		resolveApproval({ name: "test", approval: tier }, {}, resolveApprovalFromContext({ settings }).approvalMode)
			.policy;
	return { controls, settings, permission, jobs };
}

describe("ZCode direct session runtime controls", () => {
	it("projects workspace native defaults without applying a permission override", () => {
		const settings = Settings.isolated();
		expect(workspaceMode(settings)).toBe("yolo");
		expect(cfgToolsApprovalMode.get(settings)).toBe("yolo");
		expect(workspaceMode(Settings.isolated({ "tools.approvalMode": "write" }))).toBe("edit");
		expect(workspaceMode(Settings.isolated({ "tools.approvalMode": "guarded" }))).toBe("guarded");
	});
	it("accepts the generic guarded mode through the real CLI parser", () => {
		const args = parseArgs(["--approval-mode", "guarded"]);
		expect(args.approvalMode).toBe("guarded");
		expect(args.invalidFlagValues).toEqual([]);
	});
	it("preserves OMP defaults until an explicit user mode command and isolates sessions", async () => {
		const a = fixture();
		const b = fixture();
		expect(a.controls.snapshot()).toMatchObject({ mode: "yolo", approvalMode: "yolo", planEnabled: false });
		await a.controls.switchMode("build");
		expect(a.permission("read")).toBe("allow");
		expect(a.permission("write")).toBe("prompt");
		expect(a.permission("exec")).toBe("prompt");
		expect(b.permission("exec")).toBe("allow");
		await a.controls.switchMode("edit");
		expect(a.permission("write")).toBe("allow");
		expect(a.permission("exec")).toBe("prompt");
		await a.controls.switchMode("yolo");
		expect(a.permission("exec")).toBe("allow");
	});
	it("uses the selected session mode at actual SDK write execution and fails closed without a UI", async () => {
		const directory = TempDir.createSync("zcode-native-mode-write-");
		const auth = createInMemoryAuthStorage();
		const create = (name: string) =>
			createAgentSession({
				cwd: directory.path(),
				agentDir: directory.path(),
				sessionManager: SessionManager.inMemory(directory.path()),
				settings: Settings.isolated({ "tools.approvalMode": "always-ask", "compaction.enabled": false }),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, directory.join(`${name}-models.yml`)),
				model: getBundledModel("openai", "gpt-4o-mini"),
				agentRegistry: new AgentRegistry(),
				bindProcessState: false,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["write"],
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
		const a = await create("a");
		let b: CreateAgentSessionResult | undefined;
		try {
			b = await create("b");
			const controls = new ZCodeRuntimeControls(a.session, { setPlanEnabled: async () => {} });
			const write = a.session.getToolByName("write");
			const siblingWrite = b.session.getToolByName("write");
			if (!write || !siblingWrite) throw new Error("SDK did not register the native write tool");
			const context = a.getToolContext();
			expect(context.settings).toBe(a.session.settings);
			await controls.switchMode("build");
			await expect(
				write.execute("build-write", { path: "build.txt", content: "denied" }, undefined, undefined, context),
			).rejects.toThrow("requires approval but no interactive UI available");
			expect(await Bun.file(directory.join("build.txt")).exists()).toBe(false);
			await controls.switchMode("yolo");
			await write.execute("yolo-write", { path: "yolo.txt", content: "authorized" }, undefined, undefined, context);
			expect(await Bun.file(directory.join("yolo.txt")).text()).toBe("authorized");
			await expect(
				siblingWrite.execute(
					"sibling-write",
					{ path: "sibling.txt", content: "denied" },
					undefined,
					undefined,
					b.getToolContext(),
				),
			).rejects.toThrow("requires approval but no interactive UI available");
			expect(await Bun.file(directory.join("sibling.txt")).exists()).toBe(false);
		} finally {
			await b?.session.dispose();
			await a.session.dispose();
			auth.close();
			directory.removeSync();
		}
	});
	it("guarded allows ordinary execution but preserves mandatory dangerous tool prompts and hard deny", async () => {
		const { controls, settings, permission } = fixture();
		await controls.switchMode("guarded");
		expect(permission("exec")).toBe("allow");
		const dangerous = {
			name: "bash",
			approval: () => ({ tier: "exec" as const, override: true, reason: "Critical pattern detected" }),
		};
		expect(resolveApproval(dangerous, {}, cfgToolsApprovalMode.get(settings)).policy).toBe("prompt");
		expect(resolveApproval(dangerous, {}, cfgToolsApprovalMode.get(settings), { bash: "allow" }).policy).toBe(
			"prompt",
		);
		expect(resolveApproval(dangerous, {}, cfgToolsApprovalMode.get(settings), { bash: "deny" }).policy).toBe("deny");
		await controls.switchMode("yolo");
		expect(resolveApproval(dangerous, {}, cfgToolsApprovalMode.get(settings)).policy).toBe("allow");
	});
	it("plan uses the actual controller without changing its underlying approval policy", async () => {
		const { controls, settings } = fixture("write");
		await controls.switchMode("plan");
		expect(controls.snapshot()).toEqual({ mode: "plan", planEnabled: true, approvalMode: "write" });
		expect(cfgToolsApprovalMode.get(settings)).toBe("write");
		await controls.switchMode("build");
		expect(controls.snapshot()).toEqual({ mode: "build", planEnabled: false, approvalMode: "always-ask" });
	});
	it("does not claim a mode switch when the plan controller rejects it", async () => {
		const settings = Settings.isolated();
		const session = { settings, getPlanModeState: () => ({ enabled: true }) } as unknown as AgentSession;
		const controls = new ZCodeRuntimeControls(session, {
			setPlanEnabled: async () => {
				throw new Error("Plan remains active");
			},
		});
		await expect(controls.switchMode("edit")).rejects.toThrow("Plan remains active");
		expect(controls.snapshot().mode).toBe("plan");
		expect(cfgToolsApprovalMode.get(settings)).toBe("yolo");
	});
	it("cancels only an owned background work id, never foreground stop or another session", () => {
		const a = fixture();
		const b = fixture();
		expect(a.controls.cancelBackgroundWork("owned")).toEqual({ cancelled: true });
		expect(b.jobs.has("owned")).toBe(true);
		expect(() => a.controls.cancelBackgroundWork("foreign")).toThrow(
			"Background work is not running in this session",
		);
		expect(() => a.controls.cancelBackgroundWork("owned")).toThrow();
	});
	it("executes canonical Goal objectives through the shared set handler without losing input identity", async () => {
		const directory = TempDir.createSync("zcode-canonical-goal-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: { content: ["done"] } });
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime(model.provider, "fixture-control-key");
		const goalTool = new GoalTool({ getGoalRuntime: () => session.goalRuntime } as ToolSession);
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["test"], tools: [] },
				getApiKey: () => "test-key",
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(directory.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "goal.continuationModes": [] }),
			modelRegistry: new ModelRegistry(auth, directory.join("models.yml")),
			toolRegistry: new Map<string, AgentTool>([[goalTool.name, goalTool as unknown as AgentTool]]),
		});
		const host = new ZCodeCommandHost(session, directory.path(), () => {});
		const projection = new ZCodeProjection({ sessionId: session.sessionId, cwd: directory.path(), session });
		try {
			for (const objective of ["first objective", "replacement objective"]) {
				const sourceCommand = {
					sessionId: session.sessionId,
					commandId: objective,
					fingerprint: objective,
					type: "sendGoalCommand",
				};
				const receipt = await host.dispatch(`/goal set ${objective}`, {
					inputId: objective,
					inputClientId: "desktop",
					sourceCommand,
				});
				await receipt.completion;
				await session.waitForIdle();
				expect(session.getGoalModeState()?.goal).toMatchObject({ status: "active", objective });
				projection.refresh();
				expect(projection.snapshot().goal).toMatchObject({ status: "active", objective });
				const admitted = session.messages.find(message => message.role === "user" && message.inputId === objective);
				expect(admitted).toMatchObject({ inputId: objective, inputClientId: "desktop", sourceCommand });
			}
			host.cancel();
			await session.abort({ preserveQueuedInputs: true });
			projection.refresh();
			expect(session.getGoalModeState()?.goal.status).toBe("paused");
			expect(projection.snapshot().goal?.status).toBe("paused");
		} finally {
			projection.dispose();
			host.dispose();
			await session.dispose();
			auth.close();
			directory.removeSync();
		}
	});
	it("admits busy Goal commands into the native queue and stop holds their original identities", async () => {
		const directory = TempDir.createSync("zcode-held-goal-");
		const started = Promise.withResolvers<void>();
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for cancellation",
			parameters: type({}),
			execute: async (_id, _args, signal) => {
				started.resolve();
				if (!signal?.aborted) {
					const cancelled = Promise.withResolvers<void>();
					signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
					await cancelled.promise;
				}
				return { content: [{ type: "text", text: "cancelled" }] };
			},
		};
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: "wait", name: "wait", arguments: {} }] }],
			handler: { content: ["done"] },
		});
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime(model.provider, "fixture-control-key");
		const goalTool = new GoalTool({ getGoalRuntime: () => session.goalRuntime } as ToolSession);
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["test"], tools: [wait] },
				getApiKey: () => "test-key",
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(directory.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth, directory.join("models.yml")),
			toolRegistry: new Map<string, AgentTool>([
				[wait.name, wait],
				[goalTool.name, goalTool as unknown as AgentTool],
			]),
		});
		const host = new ZCodeCommandHost(session, directory.path(), () => {});
		const projection = new ZCodeProjection({ sessionId: session.sessionId, cwd: directory.path(), session });
		try {
			const running = session.prompt("wait");
			await started.promise;
			const receipt = await host.dispatch("/goal deliver all files", {
				inputId: "goal-command",
				inputClientId: "desktop",
				streamingBehavior: "followUp",
				sourceCommand: {
					sessionId: session.sessionId,
					commandId: "goal-command",
					fingerprint: "goal",
					type: "sendGoalCommand",
				},
			});
			await receipt.completion;
			expect(session.getGoalModeState()).toBeUndefined();
			expect(projection.snapshot().queue.items).toMatchObject([
				{ queueItemId: "goal-command", kind: "sendGoalCommand", text: "/goal deliver all files" },
			]);
			host.cancel();
			await session.abort({ preserveQueuedInputs: true });
			await running;
			projection.refresh();
			expect(projection.snapshot()).toMatchObject({
				queue: { autoDrain: false, items: [{ queueItemId: "goal-command", kind: "sendGoalCommand" }] },
				inputRouting: { mode: "choice" },
			});
			expect(session.mutateQueuedInput("goal-command", "edit", { text: "/goal corrected objective" })).toBe(true);
			expect(session.getQueuedMessages().followUp).toEqual(["/goal corrected objective"]);
			const promoted = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (
					event.type === "message_end" &&
					event.message.role === "user" &&
					event.message.inputId === "goal-command"
				)
					promoted.resolve();
			});
			session.setQueueAutoDrain(true);
			await promoted.promise;
			await session.waitForIdle();
			unsubscribe();
			expect(session.getGoalModeState()?.goal).toMatchObject({ status: "active", objective: "corrected objective" });
			expect(session.getQueuedInputMessages()).toEqual([]);
			expect(projection.snapshot().queue.items).toHaveLength(0);
		} finally {
			projection.dispose();
			host.dispose();
			await session.dispose();
			auth.close();
			directory.removeSync();
		}
	});
});
