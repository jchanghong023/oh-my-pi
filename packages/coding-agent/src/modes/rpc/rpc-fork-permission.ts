/**
 * Fork-extension tool permission approval (requirement 4.1, rpc-ui-protocol.md).
 *
 * Routes the ACP permission gateway (`session/session-tools.ts`
 * `#wrapToolForAcpPermission`) through the RPC transport: the controller
 * implements the stock `ClientBridge.requestPermission` interface, emits a
 * structured `permission_request` frame, and settles it from the
 * `permission_response` bypass frame. Option semantics, in-memory session
 * grants, and fail-closed behavior stay in the existing gateway; persistence
 * reuses the `tools.approval.<tool>` config keys (hot reload applies them to
 * future calls, so an allowed policy stops emitting frames).
 *
 * Subagent sessions delegate through a process-level delegate installed on v3
 * activation; `task/executor.ts` injects an origin-tagged bridge at subagent
 * spawn/revive when (and only when) the delegate is registered, so TUI/ACP
 * paths keep building subagents exactly as before.
 */
import { Snowflake, isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../session/client-bridge";
import type { AgentSession } from "../../session/agent-session";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type ApprovalMode,
	type ResolvedApproval,
	denyError,
	resolveApproval,
	resolveApprovalFromContext,
} from "../../tools/approval";
import { cfgToolsApproval, cfgToolsApprovalMode } from "../../tools/settings";
import type { Settings } from "../../config/settings";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

/** Origin attached to permission requests raised inside a subagent session. */
export interface RpcPermissionOrigin {
	subagentId: string;
	agentType: string;
}

/** Server → client: structured tool approval request (v3 only). */
export interface RpcForkPermissionRequestFrame {
	type: "permission_request";
	id: string;
	toolCallId: string;
	toolName: string;
	tier: "read" | "write" | "exec";
	reason?: string;
	approvalMode: ApprovalMode;
	details: string[];
	input: unknown;
	origin?: RpcPermissionOrigin;
}

/** Client → server bypass frame settling a permission_request. */
export interface RpcForkPermissionResponseFrame {
	type: "permission_response";
	id: string;
	option: "allow_once" | "allow_session" | "allow_always" | "reject_once" | "reject_always";
	feedback?: string;
}

const PERMISSION_RESPONSE_OPTIONS = new Set([
	"allow_once",
	"allow_session",
	"allow_always",
	"reject_once",
	"reject_always",
]);

const MAX_PERMISSION_INPUT_CHARS = 32 * 1024;

/** Bounded truncation for the structured `input` preview payload. */
function boundedInput(input: unknown): unknown {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(input ?? null);
	} catch {
		return null;
	}
	if (serialized.length <= MAX_PERMISSION_INPUT_CHARS) return input;
	return serialized.slice(0, MAX_PERMISSION_INPUT_CHARS);
}

function normalizeDetails(details: string | string[] | undefined): string[] {
	if (details === undefined) return [];
	if (typeof details === "string") return details ? [details] : [];
	return details.filter(line => typeof line === "string" && line.length > 0);
}

function selectedOutcome(
	optionId: "allow_once" | "allow_always" | "reject_once" | "reject_always",
): ClientBridgePermissionOutcome {
	return { outcome: "selected", optionId, kind: optionId };
}

interface PendingPermissionRequest {
	settle: (response: PermissionResponse) => void;
	fail: (error: Error) => void;
}

/** Validated `permission_response` payload handed to the awaiting gate. */
interface PermissionResponse {
	option: "allow_once" | "allow_session" | "allow_always" | "reject_once" | "reject_always";
	feedback?: string;
}

interface PermissionResolutionHost {
	readonly settings: Settings | undefined;
	readonly tools: readonly AgentTool[];
}

/**
 * Core approval flow shared by the main-session bridge and subagent
 * delegation: resolve policy from the live settings, short-circuit allow/deny
 * without a frame, and otherwise emit `permission_request` and await
 * `permission_response`.
 */
async function requestRpcPermission(
	host: PermissionResolutionHost,
	pending: Map<string, PendingPermissionRequest>,
	emit: (frame: object) => void,
	toolCall: ClientBridgePermissionToolCall,
	signal: AbortSignal | undefined,
	origin?: RpcPermissionOrigin,
): Promise<ClientBridgePermissionOutcome> {
	const toolName = toolCall.toolName;
	const tool = host.tools.find(candidate => candidate.name === toolName) ?? ({ name: toolName } as AgentTool);
	const args = toolCall.rawInput;
	const { approvalMode, userPolicies } = resolveApprovalFromContext(
		host.settings ? { settings: host.settings } : undefined,
	);
	const resolved: ResolvedApproval = resolveApproval(tool, args, approvalMode, userPolicies);
	if (resolved.policy === "deny") throw denyError(resolved, toolName);
	if (resolved.policy === "allow") return selectedOutcome("allow_once");

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<PermissionResponse | undefined>();
	let settled = false;
	const finishSettle = (settle: () => void) => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", onAbort);
		pending.delete(id);
		settle();
	};
	const onAbort = () => finishSettle(() => resolve(undefined));
	signal?.addEventListener("abort", onAbort, { once: true });
	pending.set(id, {
		settle: response => finishSettle(() => resolve(response)),
		fail: error => finishSettle(() => reject(error)),
	});

	const request: RpcForkPermissionRequestFrame = {
		type: "permission_request",
		id,
		toolCallId: toolCall.toolCallId,
		toolName,
		tier: resolved.tier,
		...(resolved.reason ? { reason: resolved.reason } : {}),
		approvalMode,
		details: normalizeDetails(tool.formatApprovalDetails?.(args)),
		input: boundedInput(args),
		...(origin ? { origin } : {}),
	};
	emit(request);
	const response = await promise;
	if (!response) return { outcome: "cancelled" };
	const feedback =
		typeof response.feedback === "string" && response.feedback.trim() ? response.feedback.trim() : undefined;
	switch (response.option) {
		case "allow_once":
			return selectedOutcome("allow_once");
		case "allow_session":
			// The gateway's in-memory map is the session grant (ACP semantics).
			return selectedOutcome("allow_always");
		case "allow_always": {
			if (!host.settings) throw new ToolError(`Cannot persist tool approval: session settings unavailable`);
			cfgToolsApproval.setEntry(host.settings, toolName, "allow");
			return selectedOutcome("allow_always");
		}
		case "reject_once":
			if (feedback) throw new ToolError(`Tool call denied by user (${toolName}): ${feedback}`);
			return selectedOutcome("reject_once");
		case "reject_always": {
			if (!host.settings) throw new ToolError(`Cannot persist tool denial: session settings unavailable`);
			cfgToolsApproval.setEntry(host.settings, toolName, "deny");
			if (feedback) throw new ToolError(`Tool call denied by user (${toolName}): ${feedback}`);
			return selectedOutcome("reject_always");
		}
	}
}

type RpcSubagentPermissionDelegate = (request: {
	subagentId: string;
	agentType: string;
	toolCall: ClientBridgePermissionToolCall;
	signal: AbortSignal | undefined;
}) => Promise<ClientBridgePermissionOutcome>;

let activeSubagentDelegate: RpcSubagentPermissionDelegate | undefined;

/** Registered by the RPC fork controller on v3 activation; inert everywhere else. */
export function getRpcSubagentPermissionDelegate(): RpcSubagentPermissionDelegate | undefined {
	return activeSubagentDelegate;
}

function setRpcSubagentPermissionDelegate(delegate: RpcSubagentPermissionDelegate | undefined): void {
	activeSubagentDelegate = delegate;
}

/**
 * Bridge injected into subagent sessions by `task/executor.ts` when the RPC
 * delegate is registered. Origin-tagged requests settle on the main
 * connection's permission surface.
 */
export function createRpcSubagentPermissionBridge(origin: RpcPermissionOrigin): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		requestPermission: (toolCall, _options, signal) => {
			const delegate = getRpcSubagentPermissionDelegate();
			if (!delegate) {
				return Promise.reject(new Error("Permission delegation is not available for this session"));
			}
			return delegate({ subagentId: origin.subagentId, agentType: origin.agentType, toolCall, signal });
		},
	};
}

const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;

function isApprovalMode(value: string): value is (typeof APPROVAL_MODES)[number] {
	return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** Owns the v3 permission surface: bridge activation, frames, and `set_approval_mode`. */
export class RpcForkPermissionController {
	readonly #pending = new Map<string, PendingPermissionRequest>();
	#active = false;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
	) {
		host.registerFrameHandler(parsed => this.#handleFrame(parsed));
		host.registerDisposer(reason => this.#dispose(reason));
		host.registerActivation(() => this.#activate());
		host.registerCommand("set_approval_mode", command => this.#setApprovalMode(command));
	}

	/** Current tier mode as reported by `get_state` (live settings, yolo default parity). */
	static currentApprovalMode(session: AgentSession): ApprovalMode {
		return resolveApprovalFromContext(session.settings ? { settings: session.settings } : undefined).approvalMode;
	}

	#activate(): void {
		if (this.#active) return;
		this.#active = true;
		this.session.setClientBridge(this.#bridge());
		setRpcSubagentPermissionDelegate(({ subagentId, agentType, toolCall, signal }) =>
			requestRpcPermission(
				this.#resolutionHost(),
				this.#pending,
				frame => this.host.context.emit(frame),
				toolCall,
				signal,
				{ subagentId, agentType },
			),
		);
	}

	#bridge(): ClientBridge {
		return {
			capabilities: { requestPermission: true },
			requestPermission: (toolCall, _options, signal) =>
				requestRpcPermission(
					this.#resolutionHost(),
					this.#pending,
					frame => this.host.context.emit(frame),
					toolCall,
					signal,
				),
		};
	}

	#resolutionHost(): PermissionResolutionHost {
		return {
			settings: this.session.settings,
			tools: this.session.agent.state.tools,
		};
	}

	async #setApprovalMode(command: RpcForkCommandBase): Promise<RpcResponse> {
		const rawMode = (command as { mode?: unknown }).mode;
		if (typeof rawMode !== "string" || !isApprovalMode(rawMode)) {
			return this.host.context.error(
				command.id,
				"set_approval_mode",
				`Invalid approval mode: ${String(rawMode)} (expected always-ask, write, or yolo)`,
			);
		}
		const mode = rawMode;
		// Persists to the global config and applies in-process immediately
		// (Settings.writeValue rebuilds merged layers synchronously).
		cfgToolsApprovalMode.set(this.session.settings, mode);
		return this.host.context.success(command.id, "set_approval_mode", { approvalMode: mode });
	}

	#handleFrame(parsed: unknown): boolean {
		if (!isRecord(parsed) || parsed.type !== "permission_response") return false;
		if (typeof parsed.id !== "string") return false;
		const pending = this.#pending.get(parsed.id);
		if (!pending) return true;
		const option = parsed.option;
		if (typeof option !== "string" || !PERMISSION_RESPONSE_OPTIONS.has(option)) {
			pending.fail(new Error(`Permission response used unknown option: ${String(option)}`));
			return true;
		}
		pending.settle({
			option: option as PermissionResponse["option"],
			...(typeof parsed.feedback === "string" ? { feedback: parsed.feedback } : {}),
		});
		return true;
	}

	#dispose(reason: string): void {
		for (const pending of this.#pending.values()) {
			pending.fail(new Error(reason));
		}
		this.#pending.clear();
		setRpcSubagentPermissionDelegate(undefined);
		this.#active = false;
	}
}
