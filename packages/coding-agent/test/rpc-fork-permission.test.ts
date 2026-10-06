import { describe, expect, test } from "bun:test";
import {
	RpcForkPermissionController,
	scopeSubagentApprovalForDelegation,
	getRpcSubagentPermissionDelegate,
	createRpcSubagentPermissionBridge,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-permission";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const makeContext = (emitted: object[]): RpcForkContext => ({
	emit: frame => emitted.push(frame),
});

// Tier-only declaration, mirroring the real bash tool: no explicit per-tool
// policy, so user `tools.approval` entries decide the outcome.
const promptTool: AgentTool = {
	name: "bash",
	approval: { tier: "exec" },
	formatApprovalDetails: () => "command preview line",
} as unknown as AgentTool;

interface Harness {
	emitted: object[];
	host: RpcForkHost;
	settings: Settings;
	requestPermission: (args: unknown, toolName?: string) => Promise<unknown>;
	settleLast: (response: object) => boolean;
}

// The main-session bridge is created inside #activate(); expose it through the
// session's setClientBridge capture.
const captured: Array<{ requestPermission: (toolCall: unknown, o: unknown, s?: AbortSignal) => Promise<unknown> }> = [];

function setupWithBridge(options?: {
	mode?: "always-ask" | "write" | "yolo";
	policies?: Record<string, string>;
}): Harness {
	const emitted: object[] = [];
	const host = new RpcForkHost(makeContext(emitted));
	const settings = Settings.isolated();
	if (options?.mode) cfgToolsApprovalMode.set(settings, options.mode);
	for (const [tool, policy] of Object.entries(options?.policies ?? {})) {
		cfgToolsApproval.setEntry(settings, tool, policy);
	}
	captured.length = 0;
	const session = {
		settings,
		agent: { state: { tools: [promptTool] } },
		setClientBridge: (bridge: (typeof captured)[number]) => captured.push(bridge),
	} as unknown as AgentSession;
	new RpcForkPermissionController(host, session);
	host.activate();
	expect(captured).toHaveLength(1);
	return {
		emitted,
		host,
		settings,
		requestPermission: (args: unknown, toolName = "bash") =>
			captured[0]!.requestPermission(
				{ toolCallId: "toolu_1", toolName, title: "Allow tool: bash", status: "pending", rawInput: args },
				[],
			),
		settleLast: response => host.handleControlFrame(response),
	};
}

describe("RpcForkPermissionController (4.1)", () => {
	test("subagent bridges keep their owner across other sessions' activation and disposal", async () => {
		const a = setupWithBridge({ mode: "always-ask" });
		const b = setupWithBridge({ mode: "yolo" });
		const delegate = getRpcSubagentPermissionDelegate(a.settings)!;
		const bridge = createRpcSubagentPermissionBridge({ subagentId: "a-child", agentType: "worker" }, delegate);
		const call = {
			toolCallId: "child-call",
			toolName: "bash",
			title: "bash",
			status: "pending" as const,
			rawInput: { command: "pwd" },
		};
		const pending = bridge.requestPermission!(call, [], undefined);
		const frame = a.emitted.at(-1) as Record<string, unknown>;
		expect(frame).toMatchObject({ type: "permission_request", origin: { subagentId: "a-child" } });
		expect(b.emitted).toEqual([]);
		b.host.dispose("close B");
		expect(getRpcSubagentPermissionDelegate(a.settings)).toBe(delegate);
		a.settleLast({ type: "permission_response", id: frame.id, option: "allow_once" });
		await expect(pending).resolves.toMatchObject({ optionId: "allow_once" });
		a.host.dispose("close A");
		await expect(bridge.requestPermission!(call, [], undefined)).rejects.toThrow(/disconnected/);
	});

	test("prompt policy emits a structured permission_request; allow_once resolves", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const pending = h.requestPermission({ command: "ls -la" });

		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(1);
		const frame = h.emitted[0] as Record<string, unknown>;
		expect(frame.type).toBe("permission_request");
		expect(frame.toolCallId).toBe("toolu_1");
		expect(frame.toolName).toBe("bash");
		expect(frame.tier).toBe("exec");
		expect(frame.approvalMode).toBe("always-ask");
		expect(frame.details).toEqual(["command preview line"]);
		expect(frame.input).toEqual({ command: "ls -la" });
		expect(frame.origin).toBeUndefined();

		expect(h.settleLast({ type: "permission_response", id: frame.id, option: "allow_once" })).toBe(true);
		await expect(pending).resolves.toMatchObject({ outcome: "selected", optionId: "allow_once" });
	});

	test("allow_session maps to the gateway's in-memory grant (allow_always kind)", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const pending = h.requestPermission({ command: "whoami" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: frame.id, option: "allow_session" });
		await expect(pending).resolves.toMatchObject({ outcome: "selected", optionId: "allow_always" });
		// No config entry was written for a session-scoped grant.
		expect(cfgToolsApproval.get(h.settings)).toEqual({});
	});

	test("allow_always persists tools.approval.<tool>: allow and later calls skip the frame", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const first = h.requestPermission({ command: "echo hi" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: frame.id, option: "allow_always" });
		await expect(first).resolves.toMatchObject({ outcome: "selected", optionId: "allow_always" });
		expect(cfgToolsApproval.get(h.settings)).toEqual({ bash: "allow" });

		// Persisted policy short-circuits: resolved allow → no frame.
		h.emitted.length = 0;
		await expect(h.requestPermission({ command: "echo again" })).resolves.toMatchObject({
			outcome: "selected",
			optionId: "allow_once",
		});
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(0);
	});

	test("deny policy fails closed with the policy error and never emits a frame", async () => {
		const h = setupWithBridge({ mode: "always-ask", policies: { bash: "deny" } });
		await expect(h.requestPermission({ command: "rm -rf /" })).rejects.toThrow(/bash/);
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(0);
	});

	test("reject_once with feedback throws the reason back to the model", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const pending = h.requestPermission({ command: "make test" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		h.settleLast({
			type: "permission_response",
			id: frame.id,
			option: "reject_once",
			feedback: "use pnpm instead",
		});
		await expect(pending).rejects.toThrow("Tool call denied by user (bash): use pnpm instead");
	});

	test("reject_always persists tools.approval.<tool>: deny; the standard proxy rejection text is upstream's", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const pending = h.requestPermission({ command: "curl evil" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: frame.id, option: "reject_always" });
		// Without feedback the bridge resolves and the session-tools proxy throws
		// its standard "Tool call rejected by user" text (unchanged upstream path).
		await expect(pending).resolves.toMatchObject({ outcome: "selected", optionId: "reject_always" });
		expect(cfgToolsApproval.get(h.settings)).toEqual({ bash: "deny" });

		// Persisted deny now fails closed before any frame.
		h.emitted.length = 0;
		await expect(h.requestPermission({ command: "curl again" })).rejects.toThrow(/bash/);
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(0);
	});

	test("unknown response option fails closed", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const pending = h.requestPermission({ command: "x" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		expect(h.settleLast({ type: "permission_response", id: frame.id, option: "maybe" })).toBe(true);
		await expect(pending).rejects.toThrow("unknown option");
	});

	test("client disconnect rejects the pending permission (fail-closed) and clears the delegate", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const pending = h.requestPermission({ command: "sleep" });
		await Bun.sleep(0);
		expect(getRpcSubagentPermissionDelegate(h.settings)).toBeTypeOf("function");

		h.host.dispose("RPC client disconnected before fork request completed");
		await expect(pending).rejects.toThrow("RPC client disconnected before fork request completed");
		expect(getRpcSubagentPermissionDelegate(h.settings)).toBeUndefined();
	});
	test("abort closes the pending approval on both the runtime and client surfaces", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const bridge = captured[0]!;
		const call = {
			toolCallId: "cancelled-call",
			toolName: "bash",
			title: "bash",
			status: "pending",
			rawInput: { command: "sleep" },
		};
		const controller = new AbortController();
		const pending = bridge.requestPermission(call, [], controller.signal);
		const request = h.emitted.at(-1) as Record<string, unknown>;
		expect(h.host.hasPendingRequests).toBe(true);
		controller.abort();
		await expect(pending).resolves.toEqual({ outcome: "cancelled" });
		expect(h.host.hasPendingRequests).toBe(false);
		expect(h.emitted.at(-1)).toMatchObject({
			type: "extension_ui_request",
			method: "cancel",
			targetId: request.id,
		});

		h.emitted.length = 0;
		await expect(bridge.requestPermission(call, [], controller.signal)).resolves.toEqual({ outcome: "cancelled" });
		expect(h.emitted).toEqual([]);
		h.host.dispose("cleanup");
	});

	test("a bridge installed before disconnect rejects later requests fail-closed without a frame", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		h.host.dispose("RPC client disconnected before fork request completed");

		// A queued prompt draining after EOF can still reach the stale bridge:
		// it must reject instead of hanging on a dead connection.
		h.emitted.length = 0;
		await expect(h.requestPermission({ command: "sleep" })).rejects.toThrow(
			"RPC client disconnected before permission could be requested",
		);
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(0);
	});

	test("subagent delegate tags origin and rides the same pending surface", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const delegate = getRpcSubagentPermissionDelegate(h.settings)!;
		const pending = delegate({
			subagentId: "sub-7",
			agentType: "explorer",
			toolCall: {
				toolCallId: "toolu_9",
				toolName: "bash",
				title: "x",
				status: "pending",
				rawInput: { command: "ls" },
			},
			signal: undefined,
		});
		await Bun.sleep(0);
		const frame = h.emitted.at(-1) as Record<string, unknown>;
		expect(frame.origin).toEqual({ subagentId: "sub-7", agentType: "explorer" });
		h.settleLast({ type: "permission_response", id: frame.id, option: "allow_once" });
		await expect(pending).resolves.toMatchObject({ outcome: "selected", optionId: "allow_once" });
		// Clean the process-global delegate so later tests see an inactive surface.
		h.host.dispose("test cleanup");
	});

	test("removed prefix auto-approval response is rejected without granting access", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const first = h.requestPermission({ command: "npm test" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		expect(frame.prefixSuggestion).toBeUndefined();
		expect(h.settleLast({ type: "permission_response", id: frame.id, option: "allow_always_prefix" })).toBe(true);
		await expect(first).rejects.toThrow("unknown option");
		expect(cfgToolsApproval.get(h.settings)).toEqual({});

		h.emitted.length = 0;
		const second = h.requestPermission({ command: "npm install" });
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(1);
		const nextFrame = h.emitted[0] as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: nextFrame.id, option: "allow_once" });
		await expect(second).resolves.toMatchObject({ outcome: "selected", optionId: "allow_once" });
	});

	test("scopeSubagentApprovalForDelegation sets session-local prompt policies only under RPC v3", () => {
		const makeSub = (parent: Settings) => parent.overlay({ "tools.approvalMode": "yolo" });

		// Deterministic start: no delegate registered (prior tests leave one
		// behind), so scoping must be a no-op on subagent settings — the
		// unattended yolo overlay keeps running non-bridged tools.
		setupWithBridge({ mode: "always-ask" }).host.dispose("reset delegate");
		expect(getRpcSubagentPermissionDelegate(Settings.isolated())).toBeUndefined();

		const standaloneParent = Settings.isolated();
		const untouched = makeSub(standaloneParent);
		scopeSubagentApprovalForDelegation({ settings: untouched } as unknown as AgentSession);
		expect(cfgToolsApprovalMode.get(untouched)).toBe("yolo");
		expect(cfgToolsApproval.get(untouched)).toEqual({});

		// With the v3 delegate active, the four gateway-covered tools get
		// session-local prompt policies; the approvalMode overlay and the
		// parent are untouched.
		const h = setupWithBridge({ mode: "write" });
		const delegatedParent = Settings.isolated();
		const delegated = makeSub(delegatedParent);
		scopeSubagentApprovalForDelegation(
			{ settings: delegated } as unknown as AgentSession,
			getRpcSubagentPermissionDelegate(h.settings),
		);
		const policies = cfgToolsApproval.get(delegated);
		expect(Object.keys(policies).sort()).toEqual(["bash", "delete", "edit", "move"]);
		expect(Object.values(policies).every(policy => policy === "prompt")).toBe(true);
		expect(cfgToolsApprovalMode.get(delegated)).toBe("yolo");
		expect(cfgToolsApprovalMode.isConfigured(delegatedParent)).toBe(false);
		expect(cfgToolsApprovalMode.get(h.settings)).toBe("write");
		h.host.dispose("test cleanup");
	});

	test("interaction frames are gated on v3 negotiation", () => {
		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		const settings = Settings.isolated();
		const session = {
			settings,
			agent: { state: { tools: [promptTool] } },
			setClientBridge: () => {},
		} as unknown as AgentSession;
		new RpcForkPermissionController(host, session);

		expect(host.handleControlFrame({ type: "permission_response", id: "x", option: "allow_once" })).toBe(false);
		expect(emitted).toHaveLength(0);
	});
});
