/**
 * Fork RPC project-mode protocol contract (rpc-ui-protocol.md).
 *
 * Project mode (`omp --mode rpc-ui --rpc-project`, project root fixed by the
 * startup cwd) hosts multiple sessions in one process: every session-scoped
 * command carries `sessionId` (+ `sessionGeneration` for loaded sessions), all
 * outbound frames are stamped with the process instance id, and project-level
 * catalogs (commands, model roles) are queryable with zero
 * sessions loaded. Wire framing, negotiation and the single-session legacy
 * mode are unchanged; these types extend the v3 fork contract only.
 */

/** Stable identity of the single OMP process backing one project connection. */
export interface RpcProjectIdentity {
	/** Normalized absolute project root (the startup cwd). */
	readonly projectRoot: string;
}

/** Capabilities announced in `ready` for project mode (rpc-ui-protocol.md). */
export interface RpcProjectCapabilities {
	readonly projectMode: true;
	readonly multiSession: true;
	readonly commandCompletion: true;
	readonly executeCommand: true;
	readonly modelRoleConfig: true;
}

export const RPC_PROJECT_CAPABILITIES: RpcProjectCapabilities = {
	projectMode: true,
	multiSession: true,
	commandCompletion: true,
	executeCommand: true,
	modelRoleConfig: true,
};

/** Extra fields the project-mode `ready` frame carries. */
export interface RpcProjectReadyInfo {
	/** Distinguishes single-session (`"rpc-ui"`) from project (`"rpc-ui-project"`) hosts. */
	readonly mode: "rpc-ui-project";
	readonly projectIdentity: RpcProjectIdentity;
	readonly processInstanceId: string;
	readonly capabilities: RpcProjectCapabilities;
}

/** Error codes project mode must distinguish (rpc-ui-protocol.md). */
export type RpcProjectErrorCode =
	| "invalid_params"
	| "not_found"
	| "session_not_loaded"
	| "stale_session"
	| "busy"
	| "unsupported"
	| "scope_not_allowed"
	| "revision_conflict"
	| "stale_revision"
	| "stale_cursor"
	| "permission_denied"
	| "persistence_failed"
	| "execution_failed";

/** Model reference used across project commands (provider + modelId pair). */
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

/** Load state of a session relative to this process. */
export type RpcProjectSessionLoadState = "not_loaded" | "loading" | "loaded" | "closing";

/** Best-effort run state for a loaded session. */
export type RpcProjectSessionRunState = "idle" | "streaming" | "waiting_interaction" | "closing";

/** Project session directory entry (rpc-ui-protocol.md). */
export interface RpcProjectSessionSummary {
	readonly sessionId: string;
	readonly name?: string;
	readonly sessionFile?: string;
	readonly loadState: RpcProjectSessionLoadState;
	readonly runState?: RpcProjectSessionRunState;
	/** Present for loaded sessions only; changes when the instance is rebuilt. */
	readonly sessionGeneration?: string;
	readonly createdAt?: string;
	readonly modifiedAt?: string;
	readonly messageCount?: number;
	readonly revision: string;
}

/** Stable resource revision handle; opaque to clients, compared by OMP only. */
export type RpcRevision = string;

/** Monotonic in-process revision source for project catalogs. */
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

/** Cursor-paginated result envelope. */
export interface RpcProjectPage<T> {
	readonly items: T[];
	readonly revision: RpcRevision;
	readonly nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Commands (client → server). `id` is required in project mode; session-level
// commands additionally carry `sessionId` (+ `sessionGeneration` when the
// session must be loaded). Responses reuse the stock `RpcResponse` envelope.
// ---------------------------------------------------------------------------

export interface RpcProjectCommandBase {
	readonly id: string;
	readonly type: string;
	/** Required whenever sessionId identifies a loaded instance. */
	readonly sessionGeneration?: string;
}

export interface RpcProjectSessionCommandBase extends RpcProjectCommandBase {
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

/** `create_session`: open a new session in this project (rpc-ui-protocol.md). */
export interface RpcProjectCreateSessionCommand extends RpcProjectCommandBase {
	readonly type: "create_session";
	readonly name?: string;
	readonly model?: RpcModelRef;
}

/** `list_sessions`: project directory merging saved + loaded sessions. */
export interface RpcProjectListSessionsCommand extends RpcProjectCommandBase {
	readonly type: "list_sessions";
	readonly cursor?: string;
	readonly limit?: number;
	readonly loadState?: "loaded" | "not_loaded";
}

/** `resume_session`: load persisted history by stable identity (idempotent). */
export interface RpcProjectResumeSessionCommand extends RpcProjectCommandBase {
	readonly type: "resume_session";
	readonly sessionId: string;
}

/** `close_session`: unload the instance, keep history. */
export interface RpcProjectCloseSessionCommand extends RpcProjectSessionCommandBase {
	readonly type: "close_session";
	readonly cancelRunning?: boolean;
}

/** `rename_session`: rename by identity, works for not-loaded sessions too. */
export interface RpcProjectRenameSessionCommand extends RpcProjectCommandBase {
	readonly type: "rename_session";
	readonly sessionId: string;
	readonly name: string;
	readonly expectedRevision: RpcRevision;
}

/** `delete_session`: remove history; refuses while busy unless cancelled. */
export interface RpcProjectDeleteSessionCommand extends RpcProjectCommandBase {
	readonly type: "delete_session";
	readonly sessionId: string;
	readonly sessionGeneration?: string;
	readonly expectedRevision: RpcRevision;
	readonly cancelRunning?: boolean;
}

/** `get_model_roles`: full configurable role catalog (rpc-ui-protocol.md). */
export interface RpcProjectGetModelRolesCommand extends RpcProjectCommandBase {
	readonly type: "get_model_roles";
	/** Optional loaded session; adds that session's temporary override info. */
	readonly sessionId?: string;
}

/** `set_model_role`: persist one role selection (scoped, per-role revision). */
export interface RpcProjectSetModelRoleCommand extends RpcProjectCommandBase {
	readonly type: "set_model_role";
	readonly roleId: string;
	readonly scope: "user";
	readonly selection: RpcModelRoleSelection;
	readonly expectedRevision: RpcRevision;
}

/** One role row of the catalog. */
export interface RpcProjectRoleDescriptor {
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
	readonly revision: RpcRevision;
}

export interface RpcProjectModelRolesResult {
	readonly roles: RpcProjectRoleDescriptor[];
	readonly revision: RpcRevision;
	/** Present when a loaded session was supplied: its current actual model. */
	readonly sessionModel?: {
		readonly sessionId: string;
		readonly sessionGeneration: string;
		readonly model?: RpcModelRef;
	};
}

export interface RpcProjectSetModelRoleResult {
	readonly role: RpcProjectRoleDescriptor;
	readonly revision: RpcRevision;
	readonly persisted: true;
	/** Sessions whose role resolution picks the new value on next use. */
	readonly effectiveNote?: string;
}

// ---------------------------------------------------------------------------
// Command catalog, completion, execution (rpc-ui-protocol.md)
// ---------------------------------------------------------------------------

/** Why a catalog command is currently unavailable. */
export type RpcCommandAvailability =
	| { readonly available: true }
	| { readonly available: false; readonly reason: "session_required" | "disabled" | "unsupported" | string };

export interface RpcProjectCommandDescriptor {
	/** Stable catalog identity: the canonical command name. */
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly description?: string;
	readonly inputHint?: string;
	readonly subcommands?: readonly { readonly name: string; readonly description?: string; readonly usage?: string }[];
	readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
	/** Where execution is routed. */
	readonly execution: "omp" | "host_action";
	/** Catalog scope: project-level execution vs session-bound. */
	readonly scope: "project" | "session";
	readonly availability: RpcCommandAvailability;
}

export interface RpcProjectAvailableCommandsResult {
	readonly commands: RpcProjectCommandDescriptor[];
	readonly revision: RpcRevision;
}

export type RpcProjectCompletionKind = "command" | "argument" | "skill" | "subcommand";

export interface RpcProjectCompletionItem {
	readonly label: string;
	readonly insertText: string;
	/** Replacement range in UTF-16 code units, left-inclusive / right-exclusive. */
	readonly replaceStart: number;
	readonly replaceEnd: number;
	readonly kind: RpcProjectCompletionKind;
	readonly description?: string;
	readonly hint?: string;
}

export interface RpcProjectCompleteCommandCommand extends RpcProjectCommandBase {
	readonly type: "complete_command";
	readonly text: string;
	/** UTF-16 cursor position within `text`. */
	readonly cursor: number;
	readonly sessionId?: string;
	readonly catalogRevision?: RpcRevision;
}

export interface RpcProjectCompletionResult {
	readonly items: RpcProjectCompletionItem[];
	/** Revision actually used (current when the caller's was stale). */
	readonly revision: RpcRevision;
}

export interface RpcProjectExecuteCommandCommand extends RpcProjectCommandBase {
	readonly type: "execute_command";
	readonly text: string;
	readonly sessionId?: string;
	readonly sessionGeneration?: string;
	readonly catalogRevision?: RpcRevision;
}

/** Exactly one of the three completion channels is used. */
export interface RpcProjectExecuteCommandResult {
	/** Local completion: the command fully ran without a model turn. */
	readonly completed?: boolean;
	readonly output?: string;
	/** Command started a model turn; the original request id gets `prompt_result`. */
	readonly agentInvoked?: boolean;
	/** Residual prompt forwarded to the model (e.g. magic keywords). */
	readonly agentPrompt?: string;
	/** Structured host action for the caller to perform (open editor, panel…). */
	readonly hostAction?: { readonly kind: string; readonly payload?: object };
	readonly error?: { readonly message: string; readonly code?: string };
}

// Project command union and typed response payloads
// ---------------------------------------------------------------------------

export type RpcProjectCommand =
	| RpcProjectCreateSessionCommand
	| RpcProjectListSessionsCommand
	| RpcProjectResumeSessionCommand
	| RpcProjectCloseSessionCommand
	| RpcProjectRenameSessionCommand
	| RpcProjectDeleteSessionCommand
	| RpcProjectGetModelRolesCommand
	| RpcProjectSetModelRoleCommand
	| RpcProjectCompleteCommandCommand
	| RpcProjectExecuteCommandCommand;

// ---------------------------------------------------------------------------
// Event frames (server → client), project mode stamps included
// ---------------------------------------------------------------------------

/** Fields stamped onto every project-mode frame (rpc-ui-protocol.md). */
export interface RpcProjectFrameStamp {
	readonly processInstanceId: string;
	readonly sessionId?: string;
	readonly sessionGeneration?: string;
}

export interface RpcProjectSessionsChangedFrame extends RpcProjectFrameStamp {
	readonly type: "sessions_changed";
	readonly revision: RpcRevision;
}

export interface RpcProjectCatalogChangedFrame extends RpcProjectFrameStamp {
	readonly type: "command_catalog_changed";
	readonly revision: RpcRevision;
}

/** Terminal frame for accepted async management operations. */
export interface RpcProjectOperationResultFrame extends RpcProjectFrameStamp {
	readonly type: "operation_result";
	readonly operationId: string;
	readonly requestId?: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly error?: string;
}

export type RpcProjectEventFrame =
	| RpcProjectSessionsChangedFrame
	| RpcProjectCatalogChangedFrame
	| RpcProjectOperationResultFrame;
