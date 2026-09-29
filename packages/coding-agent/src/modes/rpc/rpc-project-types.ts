/**
 * Fork RPC project-mode protocol contract (rpc-ui-protocol.md §13—§15).
 *
 * Project mode (`omp --mode rpc-ui --rpc-project`, project root fixed by the
 * startup cwd) hosts multiple sessions in one process: every session-scoped
 * command carries `sessionId` (+ `sessionGeneration` for loaded sessions), all
 * outbound frames are stamped with the process instance id, and project-level
 * catalogs (commands, skills, model roles, subagents) are queryable with zero
 * sessions loaded. Wire framing, negotiation and the single-session legacy
 * mode are unchanged; these types extend the v3 fork contract only.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { FileEntry } from "../../session/session-entries";
import type { RpcResponse } from "./rpc-types";
import type { RpcForkSettingsEntry } from "./rpc-fork-config";
import type { RpcForkModelTestResult } from "./rpc-fork-types";

/** Stable identity of the single OMP process backing one project connection. */
export interface RpcProjectIdentity {
	/** Normalized absolute project root (the startup cwd). */
	readonly projectRoot: string;
}

/** Capabilities announced in `ready` for project mode (rpc-ui-protocol.md §14.2). */
export interface RpcProjectCapabilities {
	readonly projectMode: true;
	readonly multiSession: true;
	readonly commandCompletion: true;
	readonly executeCommand: true;
	readonly skillManagement: true;
	readonly subagentHistory: true;
	readonly subagentControl: true;
	readonly modelRoleConfig: true;
}

export const RPC_PROJECT_CAPABILITIES: RpcProjectCapabilities = {
	projectMode: true,
	multiSession: true,
	commandCompletion: true,
	executeCommand: true,
	skillManagement: true,
	subagentHistory: true,
	subagentControl: true,
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

/** Error codes project mode must distinguish (rpc-ui-protocol.md §14.1). */
export type RpcProjectErrorCode =
	| "invalid_params"
	| "not_found"
	| "session_not_loaded"
	| "stale_session"
	| "busy"
	| "unsupported"
	| "scope_not_allowed"
	| "revision_conflict"
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

/** Project session directory entry (rpc-ui-protocol.md §14.1 SessionSummary). */
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
}

export interface RpcProjectSessionCommandBase extends RpcProjectCommandBase {
	readonly sessionId: string;
	readonly sessionGeneration?: string;
}

/** `create_session`: open a new session in this project (rpc-ui-protocol.md §14.3). */
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
export interface RpcProjectCloseSessionCommand extends RpcProjectCommandBase {
	readonly type: "close_session";
	readonly sessionId: string;
	readonly cancelRunning?: boolean;
}

/** `rename_session`: rename by identity, works for not-loaded sessions too. */
export interface RpcProjectRenameSessionCommand extends RpcProjectCommandBase {
	readonly type: "rename_session";
	readonly sessionId: string;
	readonly name: string;
	readonly expectedRevision?: RpcRevision;
}

/** `delete_session`: remove history; refuses while busy unless cancelled. */
export interface RpcProjectDeleteSessionCommand extends RpcProjectCommandBase {
	readonly type: "delete_session";
	readonly sessionId: string;
	readonly expectedRevision?: RpcRevision;
	readonly cancelRunning?: boolean;
}

/** `get_model_roles`: full configurable role catalog (rpc-ui-protocol.md §14.7). */
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
	readonly expectedRevision?: RpcRevision;
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
// Command catalog, completion, execution (rpc-ui-protocol.md §14.5)
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

/** Exactly one of the three completion channels is used (§14.5). */
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

// ---------------------------------------------------------------------------
// Skill catalog & management (rpc-ui-protocol.md §14.6)
// ---------------------------------------------------------------------------

/** `skillId` encodes both the concrete source and the name: `"<source>/<name>"`. */
export function formatRpcSkillId(source: string, name: string): string {
	return `${source}/${name}`;
}

export function parseRpcSkillId(skillId: string): { source: string; name: string } {
	const slash = skillId.indexOf("/");
	if (slash <= 0 || slash >= skillId.length - 1) throw new Error(`Invalid skillId: ${skillId}`);
	return { source: skillId.slice(0, slash), name: skillId.slice(slash + 1) };
}

export type RpcSkillState = "enabled" | "disabled" | "ignored" | "source_disabled" | "shadowed";

export interface RpcProjectSkillSummary {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	/** `"<provider>:<level>"`, e.g. `"native:user"`. */
	readonly source: string;
	/** `"user" | "project" | "builtin" | "package" | "custom"`-style scope label. */
	readonly scope: string;
	readonly filePath: string;
	readonly hidden: boolean;
	/** Effective-vs-management state; management view may list non-active rows. */
	readonly state: RpcSkillState;
	/** True in the effective view (the version a session would actually use). */
	readonly effective: boolean;
	/** When shadowed by a same-name skill from a higher-priority source. */
	readonly shadowedBy?: string;
	readonly revision: RpcRevision;
	/** Management actions valid for this row. */
	readonly actions: readonly ("enable" | "disable" | "copy" | "delete")[];
}

export interface RpcProjectListSkillsCommand extends RpcProjectCommandBase {
	readonly type: "list_skills";
	/** `management`: full catalog incl. disabled/ignored/shadowed; `effective`: session view. */
	readonly view: "management" | "effective";
	readonly sessionId?: string;
	readonly cursor?: number;
	readonly limit?: number;
}

export interface RpcProjectListSkillsResult extends RpcProjectPage<RpcProjectSkillSummary> {
	readonly warnings: readonly string[];
}

export interface RpcProjectSetSkillEnabledCommand extends RpcProjectCommandBase {
	readonly type: "set_skill_enabled";
	readonly skillId: string;
	readonly enabled: boolean;
	readonly scope: "user" | "project";
	readonly expectedRevision?: RpcRevision;
}

export interface RpcProjectSetSkillEnabledResult {
	readonly skillId: string;
	readonly enabled: boolean;
	readonly effective: boolean;
	/** Why the toggle did not take effect (source disabled, shadowed, …). */
	readonly pendingReason?: string;
	readonly revision: RpcRevision;
}

export interface RpcProjectCopySkillCommand extends RpcProjectCommandBase {
	readonly type: "copy_skill";
	readonly skillId: string;
	readonly targetScope: "user" | "project";
	readonly targetName: string;
	readonly expectedRevision?: RpcRevision;
}

export interface RpcProjectCopySkillResult {
	readonly skillId: string;
	readonly name: string;
	readonly location: string;
	readonly revision: RpcRevision;
}

export interface RpcProjectDeleteSkillCommand extends RpcProjectCommandBase {
	readonly type: "delete_skill";
	readonly skillId: string;
	readonly expectedRevision?: RpcRevision;
}

export interface RpcProjectDeleteSkillResult {
	readonly deleted: true;
	readonly remainingPaths?: readonly string[];
	readonly revision: RpcRevision;
}

export interface RpcProjectReloadSkillsCommand extends RpcProjectCommandBase {
	readonly type: "reload_skills";
	readonly scope: "user" | "project";
}

export interface RpcProjectReloadSkillsResult {
	readonly revision: RpcRevision;
	readonly warnings: readonly string[];
	/** Sessions that already adopted the new catalog. */
	readonly adoptedSessions: readonly string[];
	/** Loaded sessions that keep their current snapshot until a safe boundary. */
	readonly pendingSessions: readonly string[];
}

// ---------------------------------------------------------------------------
// Subagent history catalog & control (rpc-ui-protocol.md §14.8)
// ---------------------------------------------------------------------------

export type RpcProjectSubagentStatus = "running" | "completed" | "failed" | "aborted" | "parked" | "interrupted";

export interface RpcProjectSubagentSummary {
	readonly subagentId: string;
	readonly name: string;
	readonly agentSource?: string;
	readonly description?: string;
	readonly task?: string;
	readonly status: RpcProjectSubagentStatus;
	/** Whether the persisted transcript is readable right now. */
	readonly recordReadable: boolean;
	readonly sessionFile?: string;
	readonly parentToolCallId?: string;
	readonly index?: number;
	readonly lastUpdate?: string;
	readonly availableActions: readonly ("send_message" | "stop")[];
}

export interface RpcProjectGetSubagentsCommand extends RpcProjectCommandBase {
	readonly type: "get_subagents";
	/** Parent session scope; required in project mode. */
	readonly sessionId?: string;
	readonly status?: "running" | "finished";
	readonly cursor?: number | string;
	readonly limit?: number;
}

export interface RpcProjectGetSubagentsResult extends RpcProjectPage<RpcProjectSubagentSummary> {}

export interface RpcProjectGetSubagentMessagesCommand extends RpcProjectCommandBase {
	readonly type: "get_subagent_messages";
	readonly sessionId: string;
	readonly subagentId: string;
	readonly fromByte?: number;
	readonly maxBytes?: number;
}

export interface RpcProjectSubagentMessagesResult {
	readonly subagentId: string;
	readonly sessionFile: string;
	readonly fromByte: number;
	readonly nextByte: number;
	readonly reset: boolean;
	readonly hasMore: boolean;
	readonly entries: FileEntry[];
	readonly messages: AgentMessage[];
	/** Present when a single record exceeds `maxBytes` and cannot be returned whole. */
	readonly recordTooLarge?: { readonly byteLength: number };
}

export interface RpcProjectControlSubagentCommand extends RpcProjectSessionCommandBase {
	readonly type: "control_subagent";
	readonly subagentId: string;
	readonly action: "send_message" | "stop";
	/** Required for `send_message`. */
	readonly message?: string;
}

export interface RpcProjectControlSubagentResult {
	readonly subagentId: string;
	readonly action: "send_message" | "stop";
	/** Synchronous result, or `accepted` for a tracked async operation. */
	readonly status: "sent" | "queued" | "stopped" | "stopping" | "accepted";
	readonly detail?: string;
	/** IRC delivery receipts for `send_message`, when produced. */
	readonly receipts?: readonly { readonly to: string; readonly outcome: string; readonly error?: string }[];
}

// ---------------------------------------------------------------------------
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
	| RpcProjectExecuteCommandCommand
	| RpcProjectListSkillsCommand
	| RpcProjectSetSkillEnabledCommand
	| RpcProjectCopySkillCommand
	| RpcProjectDeleteSkillCommand
	| RpcProjectReloadSkillsCommand
	| RpcProjectGetSubagentsCommand
	| RpcProjectGetSubagentMessagesCommand
	| RpcProjectControlSubagentCommand;

export type RpcProjectCommandType = RpcProjectCommand["type"];

export type RpcProjectResponseData =
	| { readonly command: "create_session"; readonly data: RpcProjectSessionSummary }
	| { readonly command: "list_sessions"; readonly data: RpcProjectPage<RpcProjectSessionSummary> }
	| { readonly command: "resume_session"; readonly data: RpcProjectSessionSummary }
	| {
			readonly command: "close_session";
			readonly data: {
				readonly sessionId: string;
				readonly state: "unloaded" | "closing";
				readonly revision: RpcRevision;
			};
	  }
	| { readonly command: "rename_session"; readonly data: RpcProjectSessionSummary }
	| {
			readonly command: "delete_session";
			readonly data: { readonly sessionId: string; readonly deleted: true; readonly revision: RpcRevision };
	  }
	| { readonly command: "get_model_roles"; readonly data: RpcProjectModelRolesResult }
	| { readonly command: "set_model_role"; readonly data: RpcProjectSetModelRoleResult }
	| { readonly command: "get_available_commands"; readonly data: RpcProjectAvailableCommandsResult }
	| { readonly command: "complete_command"; readonly data: RpcProjectCompletionResult }
	| { readonly command: "execute_command"; readonly data: RpcProjectExecuteCommandResult }
	| { readonly command: "list_skills"; readonly data: RpcProjectListSkillsResult }
	| { readonly command: "set_skill_enabled"; readonly data: RpcProjectSetSkillEnabledResult }
	| { readonly command: "copy_skill"; readonly data: RpcProjectCopySkillResult }
	| { readonly command: "delete_skill"; readonly data: RpcProjectDeleteSkillResult }
	| { readonly command: "reload_skills"; readonly data: RpcProjectReloadSkillsResult }
	| { readonly command: "get_subagents"; readonly data: RpcProjectGetSubagentsResult }
	| { readonly command: "get_subagent_messages"; readonly data: RpcProjectSubagentMessagesResult }
	| { readonly command: "control_subagent"; readonly data: RpcProjectControlSubagentResult }
	| {
			readonly command: "get_settings";
			readonly data: { readonly scope: "user" | "project"; readonly entries: RpcForkSettingsEntry[] };
	  }
	| { readonly command: "test_model"; readonly data: RpcForkModelTestResult };

/** Minimal structural supertype of the stock `RpcResponse` for host helpers. */
export type RpcAnyResponse = RpcResponse;

// ---------------------------------------------------------------------------
// Event frames (server → client), project mode stamps included
// ---------------------------------------------------------------------------

/** Fields stamped onto every project-mode frame (rpc-ui-protocol.md §15.1). */
export interface RpcProjectFrameStamp {
	readonly processInstanceId: string;
	readonly sessionId?: string;
	readonly sessionGeneration?: string;
}

export interface RpcProjectSessionsChangedFrame extends RpcProjectFrameStamp {
	readonly type: "sessions_changed";
	readonly revision: RpcRevision;
}

export interface RpcProjectSkillsChangedFrame extends RpcProjectFrameStamp {
	readonly type: "skills_changed";
	readonly scope: "user" | "project";
	readonly revision: RpcRevision;
}

export interface RpcProjectCatalogChangedFrame extends RpcProjectFrameStamp {
	readonly type: "command_catalog_changed";
	readonly revision: RpcRevision;
}

/** Terminal frame for accepted async management operations (§15.1). */
export interface RpcProjectOperationResultFrame extends RpcProjectFrameStamp {
	readonly type: "operation_result";
	readonly operationId: string;
	readonly requestId?: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly error?: string;
}

export type RpcProjectEventFrame =
	| RpcProjectSessionsChangedFrame
	| RpcProjectSkillsChangedFrame
	| RpcProjectCatalogChangedFrame
	| RpcProjectOperationResultFrame;
