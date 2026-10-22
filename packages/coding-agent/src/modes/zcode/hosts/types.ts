/**
 * Shared types for the ZCode command hosts (hosts/).
 *
 * Derived from the fork's former RPC v3 surface (`modes/rpc/rpc-fork-types.ts`,
 * removed when `modes/rpc` was restored to upstream): only the shapes the
 * in-process command hosts actually consume survive here. Wire-protocol
 * surface (protocol negotiation, team frames, session-directory entries) was
 * dropped together with the RPC mode extensions that served it.
 */

/** Error codes the host commands distinguish. */
export type HostErrorCode =
	| "invalid_params"
	| "invalid_config"
	| "not_found"
	| "unsupported"
	| "scope_not_allowed"
	| "revision_conflict"
	| "persistence_failed"
	| "execution_failed";

/** Model reference used across host commands (provider + modelId pair). */
export interface ModelRef {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: string;
}

/**
 * A persisted model-role selection. `model` sets (or, when `selection` is
 * `null`, clears) the explicit value for a role; the auto-selection policy is
 * expressed by the `auto` marker instead of pretending to be a concrete model.
 */
export type ModelRoleSelection =
	| { readonly kind: "model"; readonly model: ModelRef }
	| { readonly kind: "auto" }
	| null;

/** One role row of the catalog. */
export interface ModelRoleDescriptor {
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
	readonly candidateModels: readonly ModelRef[];
	/** Resolved effective model identity, when it resolves. */
	readonly effectiveModel?: ModelRef;
	readonly unresolvedReason?: string;
	/** Where the effective value comes from. */
	readonly source: "runtime" | "overlay" | "project" | "global" | "default";
	/** Scopes writes are accepted for; project writes only when supported. */
	readonly writableScopes: readonly ("user" | "project")[];
	readonly hidden: boolean;
	readonly section: "chat" | "kind";
	readonly revision: string;
}

export interface ModelRolesResult {
	readonly roles: ModelRoleDescriptor[];
	/** Present when a live session exists: its current actual model. */
	readonly sessionModel?: { readonly model?: ModelRef };
}

export interface SetModelRoleResult {
	readonly role: ModelRoleDescriptor;
	readonly persisted: true;
	/**
	 * Human-readable note when the saved value did not simply take effect: a
	 * layer above the user config still owns the effective value, or the saved
	 * selection has no fixed concrete model. Absent when it took effect.
	 */
	readonly effectiveNote?: string;
}

/** Why a catalog command is currently unavailable. */
export type CommandAvailability =
	| { readonly available: true }
	| { readonly available: false; readonly reason: "tui_only" | "unsupported" | string };

export interface CommandDescriptor {
	/** Stable catalog identity: the canonical command name. */
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly description?: string;
	readonly inputHint?: string;
	readonly subcommands?: readonly { readonly name: string; readonly description?: string; readonly usage?: string }[];
	readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
	/** Where execution is routed: OMP handles it, or a TUI runtime is required. */
	readonly execution: "omp" | "tui";
	readonly availability: CommandAvailability;
}

export type CompletionKind = "command" | "argument" | "skill" | "subcommand";

export interface CompletionItem {
	readonly label: string;
	readonly insertText: string;
	/** Replacement range in UTF-16 code units, left-inclusive / right-exclusive. */
	readonly replaceStart: number;
	readonly replaceEnd: number;
	readonly kind: CompletionKind;
	readonly description?: string;
	readonly hint?: string;
}

export interface CompleteCommandResult {
	readonly items: CompletionItem[];
	/** Revision actually used (current when the caller's was stale). */
	readonly revision: string;
}

/** Stable resource revision handle; opaque to consumers, compared by OMP only. */
export type Revision = string;

/** Monotonic in-process revision source for host catalogs. */
export class RevisionSource {
	#counter = 0;
	#current: Revision;

	constructor(seed = "r0") {
		this.#current = seed;
	}

	get current(): Revision {
		return this.#current;
	}

	bump(): Revision {
		this.#current = `r${++this.#counter}-${Date.now().toString(36)}`;
		return this.#current;
	}
}
