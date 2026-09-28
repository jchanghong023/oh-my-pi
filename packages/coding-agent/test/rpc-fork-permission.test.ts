import { describe, expect, test } from "bun:test";
import {
	RpcForkPermissionController,
	getRpcSubagentPermissionDelegate,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-permission";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgToolsApproval,
	cfgToolsApprovalMode,
	cfgToolsApprovalPrefixes,
} from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcForkCommandBase } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-types";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const makeContext = (emitted: object[]): RpcForkContext => ({
	session: {} as RpcForkContext["session"],
	emit: frame => emitted.push(frame),
	success: (id, command, data) => ({ id, type: "response", command, success: true, data }) as RpcResponse,
	error: (id, command, message, code) =>
		({ id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) }) as RpcResponse,
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
		expect(getRpcSubagentPermissionDelegate()).toBeTypeOf("function");

		h.host.dispose("RPC client disconnected before fork request completed");
		await expect(pending).rejects.toThrow("RPC client disconnected before fork request completed");
		expect(getRpcSubagentPermissionDelegate()).toBeUndefined();
	});

	test("subagent delegate tags origin and rides the same pending surface", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const delegate = getRpcSubagentPermissionDelegate()!;
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

	test("bash requests carry prefixSuggestion; allow_always_prefix persists the rule and skips later frames", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const first = h.requestPermission({ command: "npm test" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		expect(frame.prefixSuggestion).toBe("npm ");

		h.settleLast({ type: "permission_response", id: frame.id, option: "allow_always_prefix" });
		await expect(first).resolves.toMatchObject({ outcome: "selected", optionId: "allow_once" });
		const prefixes = cfgToolsApprovalPrefixes.get(h.settings) as Record<string, unknown>;
		expect(prefixes.bash).toEqual(["npm "]);
		// The whole-tool policy stays untouched: only the prefix is allowed.
		expect(cfgToolsApproval.get(h.settings)).toEqual({});

		// Matching command: prefix rule short-circuits without a frame.
		h.emitted.length = 0;
		await expect(h.requestPermission({ command: "npm run build" })).resolves.toMatchObject({
			outcome: "selected",
			optionId: "allow_once",
		});
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(0);

		// Non-matching command still prompts.
		const third = h.requestPermission({ command: "curl evil" });
		await Bun.sleep(0);
		expect(h.emitted).toHaveLength(1);
		const frame3 = h.emitted[0] as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: frame3.id, option: "allow_once" });
		await expect(third).resolves.toMatchObject({ outcome: "selected" });
	});

	test("duplicate allow_always_prefix responses do not duplicate the rule", async () => {
		const h = setupWithBridge({ mode: "always-ask" });
		const first = h.requestPermission({ command: "git status" });
		await Bun.sleep(0);
		const frame = h.emitted[0] as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: frame.id, option: "allow_always_prefix" });
		await expect(first).resolves.toMatchObject({ outcome: "selected" });
		// A second tool with a fresh policy still prompts; answering the same
		// prefix again must not append twice.
		const second = h.requestPermission({ command: "git push" });
		await Bun.sleep(0);
		const frame2 = h.emitted.at(-1) as Record<string, unknown>;
		h.settleLast({ type: "permission_response", id: frame2.id, option: "allow_always_prefix" });
		await expect(second).resolves.toMatchObject({ outcome: "selected" });
		const prefixes = cfgToolsApprovalPrefixes.get(h.settings) as Record<string, unknown>;
		expect(prefixes.bash).toEqual(["git "]);
	});

	test("set_approval_mode validates and persists; get_state helper reads the live mode", async () => {
		const h = setupWithBridge();
		const bad = await h.host.handleCommand({
			id: "m0",
			type: "set_approval_mode",
			mode: "chaos",
		} as RpcForkCommandBase);
		expect(bad).toMatchObject({ success: false });

		const good = await h.host.handleCommand({
			id: "m1",
			type: "set_approval_mode",
			mode: "write",
		} as RpcForkCommandBase);
		expect(good).toMatchObject({ command: "set_approval_mode", success: true, data: { approvalMode: "write" } });
		expect(cfgToolsApprovalMode.get(h.settings)).toBe("write");
	});

	test("commands and frames are gated on v3 negotiation", async () => {
		const emitted: object[] = [];
		const host = new RpcForkHost(makeContext(emitted));
		const settings = Settings.isolated();
		const session = {
			settings,
			agent: { state: { tools: [promptTool] } },
			setClientBridge: () => {},
		} as unknown as AgentSession;
		new RpcForkPermissionController(host, session);

		await expect(
			host.handleCommand({ id: "g1", type: "set_approval_mode", mode: "write" } as RpcForkCommandBase),
		).resolves.toBeUndefined();
		expect(host.handleControlFrame({ type: "permission_response", id: "x", option: "allow_once" })).toBe(false);
		expect(emitted).toHaveLength(0);
	});
});
