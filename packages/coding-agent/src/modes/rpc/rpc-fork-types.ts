/**
 * Fork-extension RPC protocol surface (protocol v3).
 *
 * ZCode embeds one OMP process per session over the upstream single-session
 * RPC mode. On top of that wire the fork adds: a rich command catalog with
 * dynamic argument completion, persisted model-role configuration, and
 * directory-level session management (list/rename/delete of saved sessions).
 * Upstream clients stay on v1/v2 and never see these commands; a client sees
 * the surface only after `negotiate_protocol {protocolVersion:3}`.
 */

/** Fork protocol version; implies v2 chunked framing. */
export const RPC_FORK_PROTOCOL_VERSION = 3;

/** Versions announced in the `ready` frame: upstream v1/v2 plus the fork v3 surface. */
export const RPC_SUPPORTED_PROTOCOL_VERSIONS: [1, 2, 3] = [1, 2, RPC_FORK_PROTOCOL_VERSION];

/** True for every version `negotiate_protocol` accepts (v2 baseline + fork v3). */
export function isNegotiableRpcProtocolVersion(version: number): version is 2 | 3 {
	return version === 2 || version === RPC_FORK_PROTOCOL_VERSION;
}

/** Capabilities announced in the v3 negotiation response. */
export interface RpcForkCapabilities {
	readonly commandCompletion: true;
	readonly modelRoleConfig: true;
	readonly sessionDirectory: true;
}

export const RPC_FORK_CAPABILITIES: RpcForkCapabilities = {
	commandCompletion: true,
	modelRoleConfig: true,
	sessionDirectory: true,
};

/** Error codes the fork commands distinguish. */
export type RpcForkErrorCode =
	| "invalid_params"
	| "not_found"
	| "unsupported"
	| "scope_not_allowed"
	| "revision_conflict"
	| "persistence_failed"
	| "execution_failed";

/** Model reference used across fork commands (provider + modelId pair). */
export interface RpcModelRef {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: string;
}

/**
 * A persisted model-role selection. `model` sets (or, when `selection` is
 * `null`, clears) the explicit value for a role; the auto-selection policy is
 * expressed by the `auto` marker instead of pretending to be a concrete model.
 */
export type RpcModelRoleSelection =
	| { readonly kind: "model"; readonly model: RpcModelRef }
	| { readonly kind: "auto" }
	| null;

/** One role row of the catalog. */
export interface RpcModelRoleDescriptor {
	readonly roleId: string;
	readonly name: string;
	readonly description?: string;
	/** False only for internal roles OMP declares non-configurable. */
	readonly configurable: boolean;
	readonly nonConfigurableReason?: string;
	/** Explicit configured value for the scope, `undefined` = not configured. */
	readonly explicitValue?: string;
	/** Explicit persisted layers, distinct from runtime/project-effective selection. */
	readonly userValue: string | null;
	readonly projectValue: string | null;
	readonly candidateModels: readonly RpcModelRef[];
	/** Resolved effective model identity, when it resolves. */
	readonly effectiveModel?: RpcModelRef;
	readonly unresolvedReason?: string;
	/** Where the effective value comes from. */
	readonly source: "runtime" | "overlay" | "project" | "global" | "default";
	/** Scopes writes are accepted for; project writes only when supported. */
	readonly writableScopes: readonly ("user" | "project")[];
	readonly hidden: boolean;
	readonly section: "chat" | "kind";
	readonly revision: string;
}

export interface RpcModelRolesResult {
	readonly roles: RpcModelRoleDescriptor[];
	/** Present when a live session exists: its current actual model. */
	readonly sessionModel?: { readonly model?: RpcModelRef };
}

export interface RpcSetModelRoleResult {
	readonly role: RpcModelRoleDescriptor;
	readonly persisted: true;
	/**
	 * Human-readable note when the saved value did not simply take effect: a
	 * layer above the user config still owns the effective value, or the saved
	 * selection has no fixed concrete model. Absent when it took effect.
	 */
	readonly effectiveNote?: string;
}

/** Why a catalog command is currently unavailable. */
export type RpcCommandAvailability =
	| { readonly available: true }
	| { readonly available: false; readonly reason: "tui_only" | "unsupported" | string };

export interface RpcCommandDescriptor {
	/** Stable catalog identity: the canonical command name. */
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly description?: string;
	readonly inputHint?: string;
	readonly subcommands?: readonly { readonly name: string; readonly description?: string; readonly usage?: string }[];
	readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
	/** Where execution is routed: OMP handles it, or a TUI runtime is required. */
	readonly execution: "omp" | "tui";
	readonly availability: RpcCommandAvailability;
}

export interface RpcAvailableCommandsResult {
	readonly commands: RpcCommandDescriptor[];
	readonly revision: string;
}

export type RpcCompletionKind = "command" | "argument" | "skill" | "subcommand";

export interface RpcCompletionItem {
	readonly label: string;
	readonly insertText: string;
	/** Replacement range in UTF-16 code units, left-inclusive / right-exclusive. */
	readonly replaceStart: number;
	readonly replaceEnd: number;
	readonly kind: RpcCompletionKind;
	readonly description?: string;
	readonly hint?: string;
}

export interface RpcCompleteCommandResult {
	readonly items: RpcCompletionItem[];
	/** Revision actually used (current when the caller's was stale). */
	readonly revision: string;
}

/** Stable resource revision handle; opaque to clients, compared by OMP only. */
export type RpcRevision = string;

/** Monotonic in-process revision source for fork catalogs. */
export class RpcRevisionSource {
	#counter = 0;
	#current: RpcRevision;

	constructor(seed = "r0") {
		this.#current = seed;
	}

	get current(): RpcRevision {
		return this.#current;
	}

	bump(): RpcRevision {
		this.#current = `r${++this.#counter}-${Date.now().toString(36)}`;
		return this.#current;
	}
}

/** Saved-session directory entry as served by `list_sessions`. */
export interface RpcSessionSummary {
	readonly sessionId: string;
	readonly name?: string;
	readonly sessionFile?: string;
	/** True when the entry is the session this process hosts. */
	readonly current: boolean;
	readonly createdAt?: string;
	readonly modifiedAt?: string;
	readonly messageCount?: number;
	readonly revision: string;
}
