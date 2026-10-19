import type { Model } from "@oh-my-pi/pi-ai";
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import { filterAvailableModelsByEnabledPatterns, resolveProviderModelReference } from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import type { Settings, SettingProvenance } from "../config/settings";
import { UserSettingError, type UserSettingSaveResult, type UserSettingSide } from "../config/user-settings";
import { resolveTeamParticipants, teamModelCapabilityIssue } from "./members";
import type {
	TeamConfigErrorCode,
	TeamConfigErrorData,
	TeamConfigIssue,
	TeamConfigModelsResult,
	TeamConfigParticipant,
	TeamConfigPreview,
	TeamConfigPreviewInput,
	TeamConfigSaveInput,
	TeamConfigSaveResult,
	TeamConfigSnapshot,
	TeamConfigSource,
	TeamMemberSlot,
	TeamModelRef,
} from "./config-types";

export class TeamConfigError extends Error {
	constructor(
		public readonly code: TeamConfigErrorCode,
		message: string,
		public readonly data?: TeamConfigErrorData,
	) {
		super(message);
		this.name = "TeamConfigError";
	}
}

export interface TeamConfigServiceDependencies {
	getSettings: () => Settings;
	getModelRegistry: () => ModelRegistry;
	getSessionModel: () => Model | undefined;
	emit?: (frame: object) => void;
	isCurrent?: () => boolean;
}

function ref(model: Model): TeamModelRef {
	return { provider: model.provider, modelId: model.id };
}
function key(model: Model): string {
	return `${model.provider}/${model.id}`;
}
function strings(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const entry of value) if (typeof entry !== "string") return false;
	return true;
}
function noWrites(): UserSettingSaveResult {
	return {
		saveState: "failed",
		writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
	};
}
function invalid(message: string): never {
	throw new TeamConfigError("invalid_params", message, noWrites());
}
function concrete(value: unknown): value is TeamModelRef {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 2 ||
		!Object.hasOwn(value, "provider") ||
		!Object.hasOwn(value, "modelId") ||
		!("provider" in value) ||
		!("modelId" in value)
	)
		return false;
	for (const field of [value.provider, value.modelId]) {
		if (
			typeof field !== "string" ||
			!field ||
			field.trim() !== field ||
			/\s|[*?[\]@]/u.test(field) ||
			field.toLowerCase() === "auto"
		)
			return false;
	}
	const suffix = String(value.modelId).split(":").at(-1);
	return (
		!String(value.provider).includes("/") &&
		!(String(value.modelId).includes(":") && parseConfiguredThinkingLevel(suffix) !== undefined)
	);
}
function selectors(value: unknown, allowRaw: boolean): string[] | undefined {
	if (value === null) return undefined;
	if (!Array.isArray(value)) invalid("members must be an array or null");
	return Array.from(value, (entry: unknown) => {
		if (
			allowRaw &&
			typeof entry === "object" &&
			entry !== null &&
			Object.keys(entry).length === 1 &&
			Object.hasOwn(entry, "rawSelector") &&
			"rawSelector" in entry &&
			typeof entry.rawSelector === "string"
		)
			return entry.rawSelector;
		if (!concrete(entry)) invalid("Each member must be a concrete {provider,modelId} reference");
		return `${entry.provider}/${entry.modelId}`;
	});
}
function source(value: SettingProvenance): TeamConfigSource | null {
	return value === "env" ? null : value;
}
function label(index: number): string {
	let result = "";
	do {
		result = String.fromCharCode(65 + (index % 26)) + result;
		index = Math.floor(index / 26) - 1;
	} while (index >= 0);
	return result;
}

/** Explicit configuration IO only; constructing or searching this service never refreshes a provider. */
export class TeamConfigService {
	readonly #settings: Settings;
	readonly #registry: ModelRegistry;
	readonly #sessionModel: Model | undefined;
	readonly #profile: string | null;
	constructor(readonly deps: TeamConfigServiceDependencies) {
		this.#settings = deps.getSettings();
		this.#registry = deps.getModelRegistry();
		this.#sessionModel = deps.getSessionModel();
		this.#profile = getActiveProfile() ?? null;
	}

	#assertCurrent(): void {
		if (
			this.deps.isCurrent?.() === false ||
			this.deps.getSettings() !== this.#settings ||
			this.deps.getModelRegistry() !== this.#registry
		) {
			throw new TeamConfigError(
				"execution_failed",
				"The initiating Team configuration context is no longer current",
				noWrites(),
			);
		}
	}

	#catalog(): { all: Model[]; available: Model[]; eligible: Model[] } {
		const all = this.#registry.getAll();
		const available = this.#registry.getAvailable();
		const enabled = filterAvailableModelsByEnabledPatterns(
			available,
			cfgEnabledModels.get(this.#settings),
			this.#settings,
		);
		return { all, available, eligible: enabled.filter(model => !teamModelCapabilityIssue(model)) };
	}

	#eligibility(
		model: Model,
		available: readonly Model[],
		eligible: readonly Model[],
	): { code: string; message: string } | undefined {
		const capability = teamModelCapabilityIssue(model);
		if (capability) return capability;
		if (eligible.some(candidate => key(candidate) === key(model))) return undefined;
		if (!this.#registry.hasConfiguredAuth(model))
			return { code: "unauthenticated", message: "Provider authentication is not configured" };
		return {
			code: "disabled",
			message: available.some(candidate => key(candidate) === key(model))
				? "Model is outside enabledModels"
				: "Provider or model is disabled or unavailable in this context",
		};
	}

	getModels(query?: string): TeamConfigModelsResult {
		this.#assertCurrent();
		if (query !== undefined && typeof query !== "string") invalid("query must be a string");
		const catalog = this.#catalog();
		// These are human search synonyms for catalog lineage, not model-id or eligibility policy.
		const aliases: Readonly<Record<string, string>> = {
			通义千问: "qwen",
			千问: "qwen",
			通义: "qwen",
			智谱清言: "glm",
			智谱: "glm",
		};
		let search = (query ?? "").trim().toLowerCase();
		for (const [alias, lineage] of Object.entries(aliases)) search = search.replaceAll(alias, `${lineage} `);
		const terms = search.split(/\s+/u).filter(Boolean);
		return {
			models: catalog.all
				.filter(model => {
					const text =
						`${model.provider} ${model.id} ${model.name} ${model.identity.class} ${model.identity.family ?? ""}`.toLowerCase();
					return terms.every(term => text.includes(term));
				})
				.map(model => {
					const issue = this.#eligibility(model, catalog.available, catalog.eligible);
					return {
						model: ref(model),
						name: model.name,
						selectable: !issue,
						...(issue ? { reasonCode: issue.code, reason: issue.message } : {}),
					};
				}),
		};
	}

	#slots(
		value: readonly string[],
		list: NonNullable<TeamConfigIssue["list"]>,
		issues: TeamConfigIssue[],
		catalog: { all: Model[]; available: Model[]; eligible: Model[] },
		provenance?: SettingProvenance,
	): TeamMemberSlot[] {
		return value.map((rawSelector, index) => {
			const selector = rawSelector.trim();
			const separator = selector.indexOf("/");
			const model =
				separator > 0
					? resolveProviderModelReference(selector.slice(0, separator), selector.slice(separator + 1), catalog.all)
					: undefined;
			const issue = model
				? this.#eligibility(model, catalog.available, catalog.eligible)
				: { code: "unresolved_model", message: `Cannot resolve exact model selector: ${rawSelector}` };
			if (issue)
				issues.push({
					code: issue.code,
					message: issue.message,
					target: "member",
					list,
					index,
					selector: rawSelector,
					...(provenance ? { source: provenance } : {}),
					...(list === "userMembers"
						? { side: "active" as const }
						: list === "persistentMembers"
							? { side: "persistent" as const }
							: {}),
				});
			return {
				index,
				rawSelector,
				model: model ? ref(model) : null,
				...(model ? { name: model.name } : {}),
				status: !model ? "unresolved" : issue ? "unavailable" : "available",
				...(issue ? { reasonCode: issue.code, reason: issue.message } : {}),
			};
		});
	}

	#projection(
		value: unknown,
		provenance: SettingProvenance,
		issues: TeamConfigIssue[],
		catalog: { all: Model[]; available: Model[]; eligible: Model[] },
		preview: boolean,
	): {
		effectiveMembers: TeamMemberSlot[] | null;
		source: TeamConfigSource | null;
		participants: TeamConfigParticipant[];
	} {
		const list = preview ? "preview.effectiveMembers" : "effectiveMembers";
		if (value !== undefined && !strings(value)) {
			issues.push({
				code: "invalid_config",
				message: "team.members must be an ordered string array",
				target: "config",
				source: provenance,
			});
			return { effectiveMembers: null, source: source(provenance), participants: [] };
		}
		const configured = value === undefined ? [] : value;
		const base = configured.length > 0 ? configured : this.#sessionModel ? [key(this.#sessionModel)] : null;
		const effectiveMembers = base ? this.#slots(base, list, issues, catalog, provenance) : null;
		const resolved = resolveTeamParticipants({
			configuredMembers: configured,
			sessionModel: this.#sessionModel,
			availableModels: catalog.eligible,
		});
		if (!resolved.ok && !issues.some(issue => issue.target === "member" || issue.target === "session_model")) {
			issues.push({
				code: "participants_unavailable",
				message: resolved.error,
				target: "config",
				source: provenance,
			});
		}
		return {
			effectiveMembers,
			source: source(provenance),
			participants: resolved.ok
				? resolved.participants.map(participant => ({
						index: participant.index,
						label: label(participant.index),
						model: ref(participant.model),
					}))
				: [],
		};
	}

	getConfig(preview?: TeamConfigPreviewInput): Promise<TeamConfigSnapshot> {
		return this.#readConfig(preview, false);
	}

	async #readConfig(preview: TeamConfigPreviewInput | undefined, acceptedSave: boolean): Promise<TeamConfigSnapshot> {
		if (!acceptedSave) this.#assertCurrent();
		let draft: string[] | undefined;
		if (preview !== undefined) {
			if (
				typeof preview !== "object" ||
				preview === null ||
				Array.isArray(preview) ||
				Object.keys(preview).some(field => field !== "clientRevision" && field !== "members") ||
				!Object.hasOwn(preview, "clientRevision") ||
				!Object.hasOwn(preview, "members") ||
				typeof preview.clientRevision !== "string" ||
				!preview.clientRevision.trim()
			)
				invalid("preview requires a nonempty clientRevision and members");
			draft = selectors(preview.members, true);
		}
		const stored = await this.#settings.readUserSetting("team.members");
		if (!acceptedSave) this.#assertCurrent();
		const catalog = this.#catalog();
		const issues: TeamConfigIssue[] = stored.issues.map(issue => ({
			code: issue.code,
			message: issue.message,
			target: "storage",
			...(issue.side ? { side: issue.side } : {}),
			...(issue.source ? { source: issue.source } : {}),
		}));
		const readSide = (
			side: UserSettingSide,
			list: "userMembers" | "persistentMembers",
			sideName: "active" | "persistent",
		): { readState: UserSettingSide["readState"]; members?: TeamMemberSlot[] | null } => {
			if (side.readState === "missing") return { readState: "missing", members: null };
			if (side.readState !== "present") return { readState: side.readState };
			if (!strings(side.value)) {
				issues.push({
					code: "invalid_config",
					message: "team.members must be an ordered string array",
					target: "config",
					side: sideName,
				});
				return { readState: "invalid" };
			}
			return { readState: "present", members: this.#slots(side.value, list, issues, catalog) };
		};
		const active = readSide(stored.active, "userMembers", "active");
		const persistent = readSide(stored.persistent, "persistentMembers", "persistent");
		const session = this.#sessionModel;
		const sessionResult = resolveTeamParticipants({
			configuredMembers: [],
			sessionModel: session,
			availableModels: catalog.eligible,
		});
		if (!sessionResult.ok) {
			const capability = session ? teamModelCapabilityIssue(session) : undefined;
			issues.push({
				code: capability?.code ?? "session_model_unavailable",
				message: capability?.message ?? sessionResult.error,
				target: "session_model",
			});
		}
		const projected = this.#settings.projectUserSetting("team.members", stored.active.value);
		const effective = this.#projection(projected.value, projected.source, issues, catalog, false);
		if (
			(active.readState === "invalid" || active.readState === "unreadable") &&
			(projected.source === "global" || projected.source === "default")
		) {
			effective.effectiveMembers = null;
			effective.participants = [];
		}
		const revision = active.readState === "invalid" || persistent.readState === "invalid" ? null : stored.revision;
		const config: TeamConfigSnapshot = {
			profile: this.#profile,
			revision,
			...(active.members !== undefined ? { userMembers: active.members } : {}),
			...(persistent.members !== undefined ? { persistentMembers: persistent.members } : {}),
			...effective,
			sessionModel: session ? { model: ref(session), name: session.name, available: sessionResult.ok } : null,
			issues,
			writableScopes: revision === null ? [] : ["user"],
			storage: {
				mode: stored.mode,
				syncState: stored.syncState,
				active: { readState: active.readState },
				persistent: { readState: persistent.readState },
			},
		};
		if (preview !== undefined) {
			const previewIssues = issues.filter(issue => issue.target === "session_model");
			const projection = this.#settings.projectUserSetting("team.members", draft);
			const draftPreview: TeamConfigPreview = {
				clientRevision: preview.clientRevision,
				userMembers: draft === undefined ? null : this.#slots(draft, "preview.userMembers", previewIssues, catalog),
				...this.#projection(projection.value, projection.source, previewIssues, catalog, true),
				issues: previewIssues,
			};
			if (previewIssues.some(issue => issue.target === "member" && issue.list === "preview.effectiveMembers"))
				draftPreview.participants = [];
			config.preview = draftPreview;
		}
		return config;
	}

	async setConfig(input: TeamConfigSaveInput): Promise<TeamConfigSaveResult> {
		this.#assertCurrent();
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			Object.keys(input).some(field => !["scope", "expectedRevision", "members"].includes(field))
		)
			invalid("Invalid Team configuration request");
		if (
			!Object.hasOwn(input, "scope") ||
			!Object.hasOwn(input, "members") ||
			!Object.hasOwn(input, "expectedRevision")
		)
			invalid("scope, members and expectedRevision are required");
		if (input.scope !== "user")
			throw new TeamConfigError("scope_not_allowed", "Only user scope is writable", noWrites());
		if (typeof input.expectedRevision !== "string" || !input.expectedRevision.trim())
			invalid("expectedRevision is required");
		const requested = selectors(input.members, false);
		const catalog = this.#catalog();
		const issues: TeamConfigIssue[] = [];
		if (requested) this.#slots(requested, "userMembers", issues, catalog);
		if (issues.length)
			throw new TeamConfigError("invalid_params", "One or more members are unavailable", { ...noWrites(), issues });
		// Save only literal catalog identities: query aliases are not write identities.
		for (const member of input.members ?? []) {
			if (!catalog.all.some(model => model.provider === member.provider && model.id === member.modelId))
				invalid(`Unknown concrete model: ${member.provider}/${member.modelId}`);
		}
		let receipt: UserSettingSaveResult;
		let failure: { code: TeamConfigErrorCode; message: string } | undefined;
		let storageIssues: TeamConfigIssue[] | undefined;
		try {
			receipt = await this.#settings.saveUserSetting("team.members", requested, input.expectedRevision);
		} catch (error) {
			if (error instanceof UserSettingError) {
				receipt = error.data;
				failure = { code: error.code, message: error.message };
				storageIssues = error.issues?.map(issue => ({
					code: issue.code,
					message: issue.message,
					target: "storage",
					...(issue.side ? { side: issue.side } : {}),
					...(issue.source ? { source: issue.source } : {}),
				}));
			} else {
				receipt = {
					saveState: "unknown",
					writes: { active: { status: "unknown" }, persistent: { status: "unknown" } },
				};
				failure = { code: "execution_failed", message: error instanceof Error ? error.message : String(error) };
			}
		}
		const committed = receipt.writes.active.status === "saved" || receipt.writes.persistent.status === "saved";
		if (
			committed &&
			this.deps.isCurrent?.() !== false &&
			this.deps.getSettings() === this.#settings &&
			this.deps.getModelRegistry() === this.#registry
		) {
			try {
				this.deps.emit?.({ type: "settings_changed", scope: "user" });
			} catch (error) {
				failure ??= { code: "execution_failed", message: error instanceof Error ? error.message : String(error) };
			}
		}
		let config: TeamConfigSnapshot;
		try {
			config = await this.#readConfig(undefined, true);
		} catch (error) {
			throw new TeamConfigError(
				failure?.code ?? "execution_failed",
				failure?.message ?? (error instanceof Error ? error.message : String(error)),
				{
					...receipt,
					...(storageIssues ? { issues: storageIssues } : {}),
					effectiveMatchesRequested: false,
					effectiveNote: "Fresh configuration could not be read",
				},
			);
		}
		const expectedSlots = requested ?? null;
		const actualSlots = config.userMembers?.map(slot => slot.rawSelector) ?? null;
		const userMatches =
			config.userMembers !== undefined && JSON.stringify(expectedSlots) === JSON.stringify(actualSlots);
		const effectiveMatchesRequested =
			userMatches &&
			(config.source === "global" || config.source === "default") &&
			config.effectiveMembers !== null &&
			config.effectiveMembers.every(slot => slot.status === "available");
		const result: TeamConfigSaveResult = {
			...receipt,
			config,
			effectiveMatchesRequested,
			...(!effectiveMatchesRequested
				? {
						effectiveNote: !userMatches
							? "The fresh user value differs from this request's confirmed writes"
							: "A higher-priority layer overrides the request or the effective roster is unavailable",
					}
				: {}),
		};
		if (failure || receipt.saveState !== "complete")
			throw new TeamConfigError(
				failure?.code ?? "persistence_failed",
				failure?.message ?? "Configuration save was not complete",
				{ ...result, ...(storageIssues ? { issues: storageIssues } : {}) },
			);
		return result;
	}
}
