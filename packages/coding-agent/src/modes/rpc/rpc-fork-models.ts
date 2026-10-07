/**
 * Fork RPC model-role catalog and persistence service (rpc-ui-protocol.md).
 *
 * Serves the full configurable role catalog (`get_model_roles`) and the
 * per-role scoped write path (`set_model_role`). Role discovery, resolution,
 * and provenance come straight from the shared {@link Settings} instance and
 * the process-wide {@link ModelRegistry}: every role OMP knows — built-in
 * (hidden ones included), custom roles from `modelTags`/`cycleOrder`, and any
 * remaining key of the merged `modelRoles` record — is listed even when
 * nothing is configured and no model is available; roles without a resolvable
 * target carry `unresolvedReason` instead of disappearing. Writes reuse the
 * existing role persistence machinery (`setModelRole` + `flush`) so user
 * config, project layers, and runtime overrides keep their documented
 * precedence, and the returned descriptor reports the post-save truth (a
 * saved-but-overridden value shows the overriding source). The service never
 * touches the protocol channel; the host passes an `emit` callback for the
 * `settings_changed` fan-out.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { MAX_THINKING_SUFFIX_OPTIONS, parseThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { DEFAULT_MODEL_ROLE_ALIAS, getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS } from "../../config/model-roles";
import type { ModelRegistry } from "../../config/model-registry";
import { ModelRoleConflictError, type Settings, type SettingProvenance } from "../../config/settings";
import { formatRoleModelValue, resolveRoleModelFull } from "../../session/role-models";
import type {
	RpcForkErrorCode,
	RpcModelRef,
	RpcModelRoleDescriptor,
	RpcModelRoleSelection,
	RpcModelRolesResult,
	RpcSetModelRoleResult,
} from "./rpc-fork-types";

/** Typed failure surfaced by the role service. */
export class RpcModelRoleError extends Error {
	readonly code: RpcForkErrorCode;

	constructor(code: RpcForkErrorCode, message: string) {
		super(message);
		this.name = "RpcModelRoleError";
		this.code = code;
	}
}

/** Collaborators the role service needs from the RPC host. */
export interface RpcModelRoleServiceDeps {
	/** Settings instance shared by this process (all layers already merged). */
	readonly getSettings: () => Settings;
	/** Process-wide model registry backing availability and selector formatting. */
	readonly getModelRegistry: () => ModelRegistry;
	/** Outbound frame sink; the host forwards `settings_changed` frames to the client. */
	readonly emit: (frame: object) => void;
	/**
	 * Reload the persisted config layers of the hosted session's own Settings
	 * clone after a role save. Sessions snapshot the global layer via
	 * `cloneForCwd` at creation, so without this their role resolution
	 * (`/switch @role`, subagent role picks) keeps the pre-save value.
	 */
	readonly reloadSessionSettings?: () => Promise<void>;
}

/** Options for {@link RpcModelRoleService.listRoles}. */
export interface RpcModelRoleListOptions {
	/**
	 * Live-session passthrough echoed as `sessionModel` so the GUI can show the
	 * session's actual model next to the persisted catalog. The service itself
	 * needs no session.
	 */
	readonly sessionModel?: RpcModelRef;
}

/** Options for {@link RpcModelRoleService.setRole}. */
export interface RpcModelRoleSetOptions {
	readonly roleId: string;
	/** Wire contract allows `"user"` only; other runtime values reject with scope_not_allowed. */
	readonly scope: "user";
	readonly selection: RpcModelRoleSelection;
	/** Required revision of this user role slot, not the role catalog. */
	readonly expectedRevision: string;
}

/** Map settings provenance onto the descriptor source union. `getModelRoleProvenance` never returns `"env"`. */
function roleDescriptorSource(provenance: SettingProvenance): RpcModelRoleDescriptor["source"] {
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
 * among the currently available models (including an empty catalog).
 */
function unresolvedRoleReason(explicitValue: string | undefined, warning: string | undefined): string {
	if (warning) return warning;
	if (explicitValue === undefined) return "not_configured";
	if (explicitValue === DEFAULT_MODEL_ROLE_ALIAS) return "auto";
	return "no_matching_model";
}

/**
 * Model-role catalog + per-role persistence for the fork RPC surface. All
 * reads need no session by construction; the per-role revision detects stale
 * `expectedRevision` attempts (concurrent GUI edits).
 */
export class RpcModelRoleService {
	readonly #deps: RpcModelRoleServiceDeps;
	readonly #roleWrites = new Map<string, Promise<unknown>>();

	constructor(deps: RpcModelRoleServiceDeps) {
		this.#deps = deps;
	}

	/**
	 * Full role catalog: every known role with its name, configurability,
	 * explicit configured value, best-effort resolved model (or unresolved
	 * reason), provenance, writable scopes, and revision. Resolution runs
	 * against the full registry pool (`getAvailable("all")`) so kind-section
	 * roles (image/speech/…) resolve too; an empty pool lists every role with
	 * an `unresolvedReason` instead of hiding rows.
	 */
	async listRoles(options: RpcModelRoleListOptions = {}): Promise<RpcModelRolesResult> {
		const settings = this.#deps.getSettings();
		const availableModels = this.#deps.getModelRegistry().getAvailable("all");
		const roles = this.#catalogRoleIds(settings).map(role => this.#buildDescriptor(role, settings, availableModels));
		return {
			roles,
			...(options.sessionModel ? { sessionModel: { model: options.sessionModel } } : {}),
		};
	}

	/**
	 * Persist one role selection. Only user scope is writable through this
	 * entry point: the value is formatted with the shared role formatting
	 * helper, validated against the registry and the role's acceptance
	 * predicate, written via `setModelRole`, and awaited through `flush`
	 * before `persisted: true` is reported. `null` clears the explicit value
	 * (OMP's fallback semantics apply); `{ kind: "auto" }` persists the `*`
	 * auto marker. A stale `expectedRevision` rejects with
	 * `revision_conflict`.
	 */
	async setRole(command: RpcModelRoleSetOptions): Promise<RpcSetModelRoleResult> {
		const previous = this.#roleWrites.get(command.roleId) ?? Promise.resolve();
		const write = previous.then(
			() => this.#setRole(command),
			() => this.#setRole(command),
		);
		this.#roleWrites.set(command.roleId, write);
		try {
			return await write;
		} finally {
			if (this.#roleWrites.get(command.roleId) === write) this.#roleWrites.delete(command.roleId);
		}
	}

	async #setRole(command: RpcModelRoleSetOptions): Promise<RpcSetModelRoleResult> {
		const settings = this.#deps.getSettings();
		const registry = this.#deps.getModelRegistry();
		const { roleId, selection } = command;

		if (typeof roleId !== "string" || !this.#catalogRoleIds(settings).includes(roleId)) {
			throw new RpcModelRoleError("not_found", `Unknown model role: ${String(roleId)}`);
		}

		// Wire-level scope guard: the declared type is "user", but the raw
		// frame value is untyped at runtime and needs a distinct error code.
		const scope: unknown = command.scope;
		if (scope !== "user") {
			throw new RpcModelRoleError("scope_not_allowed", "Model roles support only user writes");
		}
		if (typeof command.expectedRevision !== "string" || !command.expectedRevision) {
			throw new RpcModelRoleError("invalid_params", "expectedRevision is required");
		}

		const expectedValue = settings.getGlobalModelRole(roleId);
		const currentRevision = this.#roleRevision(roleId, expectedValue);
		if (command.expectedRevision !== undefined && command.expectedRevision !== currentRevision) {
			throw new RpcModelRoleError("revision_conflict", `Model role ${roleId} changed; read the role again`);
		}

		const value = this.#formatSelection(settings, registry, roleId, selection);
		try {
			await settings.saveUserModelRole(roleId, value, expectedValue);
		} catch (error) {
			if (error instanceof ModelRoleConflictError) {
				throw new RpcModelRoleError("revision_conflict", error.message);
			}
			throw new RpcModelRoleError(
				"persistence_failed",
				`Failed to persist model role ${roleId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Sessions hold cloneForCwd snapshots of the global layer: reload their
		// persisted layers so post-save role resolution adopts the new value.
		await this.#deps.reloadSessionSettings?.();
		this.#deps.emit({ type: "settings_changed", scope: "user" });
		// Fresh post-save read: provenance naturally reports a higher layer
		// (runtime/overlay/project) when one still owns the effective value.
		const role = this.#buildDescriptor(roleId, settings, registry.getAvailable("all"));
		const effectiveNote = this.#effectiveNote(role, selection);
		return { role, persisted: true, ...(effectiveNote ? { effectiveNote } : {}) };
	}

	/** Catalog ids: `getKnownRoleIds` order first, then leftover merged `modelRoles` keys (deduped). */
	#catalogRoleIds(settings: Settings): string[] {
		const roles = [...MODEL_ROLE_IDS, ...getKnownRoleIds(settings)];
		const uniqueRoles = [...new Set(roles)];
		const seen = new Set<string>(uniqueRoles);
		for (const role in settings.getModelRoles()) {
			if (seen.has(role)) continue;
			seen.add(role);
			uniqueRoles.push(role);
		}
		return uniqueRoles;
	}

	#roleRevision(role: string, value: string | undefined): string {
		return `role-${Bun.hash(JSON.stringify([role, value ?? null])).toString(36)}`;
	}

	/** Build one catalog row from live settings. */
	#buildDescriptor(role: string, settings: Settings, availableModels: Model[]): RpcModelRoleDescriptor {
		const info = getRoleInfo(role, settings);
		const explicitValue = settings.getModelRole(role);
		// Zero-session resolution: without a live session there is no
		// session-current model, so the `default` role resolves purely from
		// configuration (sessions report their actual model via `sessionModel`).
		const resolved = resolveRoleModelFull(settings, role, availableModels, undefined);
		return {
			roleId: role,
			name: info.name,
			...(info.tag ? { description: info.tag } : {}),
			configurable: true,
			...(explicitValue !== undefined ? { explicitValue } : {}),
			userValue: settings.getGlobalModelRole(role) ?? null,
			projectValue: settings.getProjectModelRole(role) ?? null,
			candidateModels: availableModels
				.filter(info.accepts)
				.map(model => ({ provider: model.provider, modelId: model.id })),
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
			writableScopes: ["user"],
			hidden: info.hidden === true,
			section: info.section,
			revision: this.#roleRevision(role, settings.getGlobalModelRole(role)),
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
		if (selection === null) return undefined;
		if (typeof selection !== "object" || Array.isArray(selection) || !("kind" in selection)) {
			throw new RpcModelRoleError("invalid_params", "A valid selection is required");
		}
		if (selection.kind === "auto") return DEFAULT_MODEL_ROLE_ALIAS;
		if (selection.kind !== "model" || !("model" in selection)) {
			throw new RpcModelRoleError("invalid_params", "A valid selection is required");
		}
		const modelSelection = selection.model;
		if (
			!modelSelection ||
			typeof modelSelection !== "object" ||
			Array.isArray(modelSelection) ||
			!("provider" in modelSelection) ||
			!("modelId" in modelSelection)
		) {
			throw new RpcModelRoleError("invalid_params", "A model selection is required");
		}
		const provider = modelSelection.provider;
		const modelId = modelSelection.modelId;
		const thinkingLevel = "thinkingLevel" in modelSelection ? modelSelection.thinkingLevel : undefined;
		if (
			typeof provider !== "string" ||
			typeof modelId !== "string" ||
			(thinkingLevel !== undefined && typeof thinkingLevel !== "string")
		) {
			throw new RpcModelRoleError("invalid_params", "Model selection fields are invalid");
		}
		const available = registry.getAvailable("all");
		const model = available.find(candidate => candidate.provider === provider && candidate.id === modelId);
		if (!model) {
			throw new RpcModelRoleError("invalid_params", `Model not available: ${String(provider)}/${String(modelId)}`);
		}
		if (!getRoleInfo(roleId, settings).accepts(model)) {
			throw new RpcModelRoleError(
				"invalid_params",
				`Model ${model.provider}/${model.id} does not fit role ${roleId}`,
			);
		}
		const level =
			thinkingLevel === undefined ? undefined : parseThinkingSuffix(thinkingLevel, MAX_THINKING_SUFFIX_OPTIONS);
		if (thinkingLevel !== undefined && level === undefined) {
			throw new RpcModelRoleError("invalid_params", `Invalid thinking level: ${String(thinkingLevel)}`);
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
	#effectiveNote(role: RpcModelRoleDescriptor, selection: RpcModelRoleSelection): string | undefined {
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
