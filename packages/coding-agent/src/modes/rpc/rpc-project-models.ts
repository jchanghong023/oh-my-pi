/**
 * Fork RPC project-mode model-role catalog and persistence service
 * (requirement R6, rpc-ui-protocol.md §8.3/§14.7).
 *
 * Serves the full configurable role catalog (`get_model_roles`) and the
 * per-role scoped write path (`set_model_role`) with ZERO loaded sessions:
 * role discovery, resolution, and provenance come straight from the shared
 * {@link Settings} instance and the process-wide {@link ModelRegistry},
 * never from a live AgentSession. Every role OMP knows — built-in (hidden
 * ones included), custom roles from `modelTags`/`cycleOrder`, and any
 * remaining key of the merged `modelRoles` record — is listed even when
 * nothing is configured and no model is available (requirement O24): roles
 * without a resolvable target carry `unresolvedReason` instead of
 * disappearing. Writes reuse the existing role persistence machinery
 * (`setModelRole` + `flush`) so user config, project layers, and runtime
 * overrides keep their documented precedence, and the returned descriptor
 * reports the post-save truth (a saved-but-overridden value shows the
 * overriding source). The service never touches the protocol channel; hosts
 * pass an `emit` callback for the `settings_changed` fan-out.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { MAX_THINKING_SUFFIX_OPTIONS, parseThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { DEFAULT_MODEL_ROLE_ALIAS, getKnownRoleIds, getRoleInfo, isKindRole } from "../../config/model-roles";
import { cfgCycleOrder, cfgModelRoleStorage } from "../../config/model-settings";
import type { ModelRegistry } from "../../config/model-registry";
import { withActiveSettings, type Settings, type SettingProvenance } from "../../config/settings";
import { formatRoleModelValue, resolveRoleModelFull } from "../../session/role-models";
import { RpcRevisionSource } from "./rpc-project-types";
import type {
	RpcModelRef,
	RpcModelRoleSelection,
	RpcProjectErrorCode,
	RpcProjectModelRolesResult,
	RpcProjectRoleDescriptor,
	RpcProjectSetModelRoleResult,
	RpcRevision,
} from "./rpc-project-types";

/** Typed failure surfaced by the role service; `code` maps to RpcProjectErrorCode (rpc-ui-protocol.md §14.1). */
export class RpcProjectModelRoleError extends Error {
	readonly code: RpcProjectErrorCode;

	constructor(code: RpcProjectErrorCode, message: string) {
		super(message);
		this.name = "RpcProjectModelRoleError";
		this.code = code;
	}
}

/** Collaborators the role service needs from the project-mode host. */
export interface RpcProjectModelRoleServiceDeps {
	/** Settings instance shared by this project (all layers already merged). */
	readonly getSettings: () => Settings;
	/** Process-wide model registry backing availability and selector formatting. */
	readonly getModelRegistry: () => ModelRegistry;
	/** Outbound frame sink; hosts forward `settings_changed` frames to the client. */
	readonly emit: (frame: object) => void;
}

/** Options for {@link RpcProjectModelRoleService.listRoles}. */
export interface RpcProjectModelRoleListOptions {
	/**
	 * Loaded-session passthrough echoed as `sessionModel` so the GUI can show
	 * the session's actual model next to the persisted catalog
	 * (rpc-ui-protocol.md §14.7). The service itself needs no session.
	 */
	readonly sessionInfo?: {
		readonly sessionId: string;
		readonly sessionGeneration: string;
		readonly model?: RpcModelRef;
	};
}

/** Options for {@link RpcProjectModelRoleService.setRole}. */
export interface RpcProjectModelRoleSetOptions {
	readonly roleId: string;
	/** Wire contract allows `"user"` only; other runtime values reject with unsupported/scope_not_allowed. */
	readonly scope: "user";
	readonly selection: RpcModelRoleSelection;
	/** When provided, must match the current catalog revision (revision_conflict otherwise). */
	readonly expectedRevision?: RpcRevision;
}

/** Map settings provenance onto the descriptor source union. `getModelRoleProvenance` never returns `"env"`. */
function roleDescriptorSource(provenance: SettingProvenance): RpcProjectRoleDescriptor["source"] {
	switch (provenance) {
		case "runtime":
		case "overlay":
		case "project":
		case "global":
			return provenance;
		default:
			return "default";
	}
}

/**
 * Why a role did not resolve: the resolver's own warning when it produced one;
 * `not_configured` when nothing is configured; `auto` for the explicit
 * auto-policy marker (the `*` selector `setRole` persists for auto
 * selections); `no_matching_model` when a configured selector has no match
 * among the currently available models (including an empty catalog, R6/O24).
 */
function unresolvedRoleReason(explicitValue: string | undefined, warning: string | undefined): string {
	if (warning) return warning;
	if (explicitValue === undefined) return "not_configured";
	if (explicitValue === DEFAULT_MODEL_ROLE_ALIAS) return "auto";
	return "no_matching_model";
}

/**
 * Model-role catalog + per-role persistence for project mode. All reads are
 * zero-session by construction; the single catalog revision bumps after every
 * successful write so clients can detect stale `expectedRevision` attempts.
 */
export class RpcProjectModelRoleService {
	readonly #deps: RpcProjectModelRoleServiceDeps;
	readonly #rolesRevision = new RpcRevisionSource("roles-r0");

	constructor(deps: RpcProjectModelRoleServiceDeps) {
		this.#deps = deps;
	}

	/** Current catalog revision; changes after every successful role write. */
	get revision(): RpcRevision {
		return this.#rolesRevision.current;
	}

	/**
	 * Full role catalog (rpc-ui-protocol.md §14.7): every known role with its
	 * name, configurability, explicit configured value, best-effort resolved
	 * model (or unresolved reason), provenance, writable scopes, and revision.
	 * Resolution runs against the full registry pool (`getAvailable("all")`)
	 * so kind-section roles (image/speech/…) resolve too; an empty pool lists
	 * every role with an `unresolvedReason` instead of hiding rows (O24).
	 */
	async listRoles(options: RpcProjectModelRoleListOptions = {}): Promise<RpcProjectModelRolesResult> {
		const settings = this.#deps.getSettings();
		const availableModels = this.#deps.getModelRegistry().getAvailable("all");
		const revision = this.#rolesRevision.current;
		const roles = this.#catalogRoleIds(settings).map(role =>
			this.#buildDescriptor(role, settings, availableModels, revision),
		);
		return {
			roles,
			revision,
			...(options.sessionInfo ? { sessionModel: { ...options.sessionInfo } } : {}),
		};
	}

	/**
	 * Persist one role selection (rpc-ui-protocol.md §14.7). Only user scope is
	 * writable through this entry point: the value is formatted with the shared
	 * role formatting helper, validated against the registry and the role's
	 * acceptance predicate, written via `setModelRole`, and awaited through
	 * `flush` before `persisted: true` is reported. `null` clears the explicit
	 * value (OMP's fallback semantics apply); `{ kind: "auto" }` persists the
	 * `*` auto marker. Project-scope writes reject (`unsupported` when project
	 * writes are not enabled at all, `scope_not_allowed` otherwise); a stale
	 * `expectedRevision` rejects with `revision_conflict`.
	 */
	async setRole(command: RpcProjectModelRoleSetOptions): Promise<RpcProjectSetModelRoleResult> {
		const settings = this.#deps.getSettings();
		const registry = this.#deps.getModelRegistry();
		const { roleId, selection } = command;

		if (typeof roleId !== "string" || !this.#catalogRoleIds(settings).includes(roleId)) {
			throw new RpcProjectModelRoleError("not_found", `Unknown model role: ${String(roleId)}`);
		}

		// Wire-level scope guard: the declared type is "user", but the raw
		// frame value is untyped at runtime and needs distinct error codes.
		const scope: unknown = command.scope;
		if (scope !== "user") {
			if (scope === "project" && !this.#projectScopeWritable(settings, roleId)) {
				throw new RpcProjectModelRoleError(
					"unsupported",
					"Project writes not enabled: modelRoleStorage is global and the role has no project value",
				);
			}
			throw new RpcProjectModelRoleError(
				"scope_not_allowed",
				`Unsupported scope for model roles: ${String(scope)} (only "user" writes are persisted)`,
			);
		}

		if (command.expectedRevision !== undefined && command.expectedRevision !== this.#rolesRevision.current) {
			throw new RpcProjectModelRoleError(
				"revision_conflict",
				`Expected role-catalog revision ${command.expectedRevision} but current is ${this.#rolesRevision.current}`,
			);
		}

		if (this.#isInternalRole(roleId, settings)) {
			throw new RpcProjectModelRoleError(
				"unsupported",
				`Role ${roleId} is internal and not configurable (see the catalog's nonConfigurableReason)`,
			);
		}

		const value = this.#formatSelection(settings, registry, roleId, selection);
		try {
			await withActiveSettings(settings, async () => {
				settings.setModelRole(roleId, value);
				await settings.flush();
			});
		} catch (error) {
			throw new RpcProjectModelRoleError(
				"persistence_failed",
				`Failed to persist model role ${roleId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const revision = this.#rolesRevision.bump();
		this.#deps.emit({ type: "settings_changed", scope: "user" });
		// Fresh post-save read: provenance naturally reports a higher layer
		// (runtime/overlay/project) when one still owns the effective value.
		const role = this.#buildDescriptor(roleId, settings, registry.getAvailable("all"), revision);
		const effectiveNote = this.#effectiveNote(role, selection);
		return { role, revision, persisted: true, ...(effectiveNote ? { effectiveNote } : {}) };
	}

	/** Catalog ids: `getKnownRoleIds` order first, then leftover merged `modelRoles` keys (deduped). */
	#catalogRoleIds(settings: Settings): string[] {
		const roles = [...getKnownRoleIds(settings)];
		const seen = new Set<string>(roles);
		for (const role in settings.getModelRoles()) {
			if (seen.has(role)) continue;
			seen.add(role);
			roles.push(role);
		}
		return roles;
	}

	/**
	 * Internal-role rule (R6/§14.7): a role is non-configurable ONLY when it is
	 * a kind-section role the TUI hides (`getRoleInfo(...).hidden`) that is
	 * neither explicitly configured nor part of the model cycle — i.e. pure
	 * internal machinery with no user-facing selector. Everything else stays
	 * editable by design: hidden roles must still be LISTED (with
	 * `hidden: true`) so the GUI can explain them, hidden chat/custom roles
	 * remain configurable, and any role with an explicit value or cycle-order
	 * membership can be edited or cleared. Unknown custom roles default to
	 * configurable (deliberately generous).
	 */
	#isInternalRole(role: string, settings: Settings): boolean {
		if (!isKindRole(role)) return false;
		if (settings.getModelRole(role) !== undefined) return false;
		if (cfgCycleOrder.get(settings).includes(role)) return false;
		return getRoleInfo(role, settings).hidden === true;
	}

	/** Project scope is only writable when project storage is on or a project value exists. */
	#projectScopeWritable(settings: Settings, role: string): boolean {
		return cfgModelRoleStorage.get(settings) === "project" || settings.getProjectModelRole(role) !== undefined;
	}

	/** Writable scopes for one role: user always; project only when a project layer is declared/present. */
	#writableScopes(settings: Settings, role: string): ("user" | "project")[] {
		return this.#projectScopeWritable(settings, role) ? ["user", "project"] : ["user"];
	}

	/** Build one catalog row from live settings; `revision` is the catalog revision at read time. */
	#buildDescriptor(
		role: string,
		settings: Settings,
		availableModels: Model[],
		revision: RpcRevision,
	): RpcProjectRoleDescriptor {
		const info = getRoleInfo(role, settings);
		const explicitValue = settings.getModelRole(role);
		// Zero-session resolution: without a live session there is no
		// session-current model, so the `default` role resolves purely from
		// configuration (sessions report their actual model via `sessionModel`).
		const resolved = resolveRoleModelFull(settings, role, availableModels, undefined);
		const internal = this.#isInternalRole(role, settings);
		return {
			roleId: role,
			name: info.name,
			...(info.tag ? { description: info.tag } : {}),
			configurable: !internal,
			...(internal
				? { nonConfigurableReason: "Internal kind role: hidden from the model selector with no explicit value" }
				: {}),
			...(explicitValue !== undefined ? { explicitValue } : {}),
			...(resolved.model
				? {
						effectiveModel: {
							provider: resolved.model.provider,
							modelId: resolved.model.id,
							...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
						},
					}
				: { unresolvedReason: unresolvedRoleReason(explicitValue, resolved.warning) }),
			source: roleDescriptorSource(settings.getModelRoleProvenance(role)),
			writableScopes: this.#writableScopes(settings, role),
			hidden: info.hidden === true,
			section: info.section,
			revision,
		};
	}

	/**
	 * Build the persisted selector string for one selection: a concrete
	 * `provider/modelId[:level]` (the model must exist in the registry pool and
	 * pass the role's acceptance predicate), the `*` auto marker, or
	 * `undefined` to clear the explicit value.
	 */
	#formatSelection(
		settings: Settings,
		registry: ModelRegistry,
		roleId: string,
		selection: RpcModelRoleSelection,
	): string | undefined {
		// Loose null check: a missing wire value behaves like an explicit clear.
		if (selection == null) return undefined;
		if (selection.kind === "auto") return DEFAULT_MODEL_ROLE_ALIAS;
		const { provider, modelId, thinkingLevel } = selection.model;
		const available = registry.getAvailable("all");
		const model = available.find(candidate => candidate.provider === provider && candidate.id === modelId);
		if (!model) {
			throw new RpcProjectModelRoleError(
				"invalid_params",
				`Model not available: ${String(provider)}/${String(modelId)}`,
			);
		}
		if (!getRoleInfo(roleId, settings).accepts(model)) {
			throw new RpcProjectModelRoleError(
				"invalid_params",
				`Model ${model.provider}/${model.id} does not fit role ${roleId}`,
			);
		}
		const level =
			thinkingLevel === undefined ? undefined : parseThinkingSuffix(thinkingLevel, MAX_THINKING_SUFFIX_OPTIONS);
		if (thinkingLevel !== undefined && level === undefined) {
			throw new RpcProjectModelRoleError("invalid_params", `Invalid thinking level: ${String(thinkingLevel)}`);
		}
		// `formatRoleModelValue` types its override as ThinkingLevel but only
		// forwards it to `formatModelSelectorValue`, which also accepts the
		// `auto` sentinel the parser above already validated.
		return formatRoleModelValue(settings, registry, roleId, model, undefined, level as ThinkingLevel | undefined);
	}

	/**
	 * Human-readable note for a saved row: explains when a layer above the user
	 * config still owns the effective value (session runtime override, config
	 * overlay, or a project-scoped assignment), and when the saved selection
	 * intentionally has no fixed concrete model (auto policy / no current
	 * match). Absent when the saved value simply took effect.
	 */
	#effectiveNote(role: RpcProjectRoleDescriptor, selection: RpcModelRoleSelection): string | undefined {
		const action = selection == null ? "Cleared the user config value" : "Saved to user config";
		if (role.source === "runtime" || role.source === "overlay" || role.source === "project") {
			return `${action}; effective source: ${role.source} (the user value applies once that layer changes)`;
		}
		if (selection != null && selection.kind === "auto") {
			return `${action}; the role resolves through OMP's automatic selection policy at use time`;
		}
		if (selection != null && selection.kind === "model" && role.effectiveModel === undefined) {
			return `${action}; no currently available model matches the saved selection`;
		}
		return undefined;
	}
}
