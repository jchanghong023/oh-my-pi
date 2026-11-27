import type { Model } from "@oh-my-pi/pi-ai";
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { filterAvailableModelsByEnabledPatterns } from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import type { Settings, SettingProvenance } from "../config/settings";
import { UserSettingError, type UserSettingSaveResult } from "../config/user-settings";
import { parseConfiguredThinkingLevel } from "../thinking/levels";
import { expandTeamRoster, resolveTeamMemberReference, teamModelCapabilityIssue } from "./members";
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
import { cfgTeamMembers } from "./settings";

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
	persistentSettings?: Settings;
	emit?: (frame: object) => void;
	isCurrent?: () => boolean;
}

function ref(model: Model): TeamModelRef {
	return { provider: model.provider, modelId: model.id };
}
type TeamCatalog = { all: Model[]; available: Model[]; enabled: Model[] };

function strings(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const entry of value) if (typeof entry !== "string") return false;
	return true;
}
function noWrites(): UserSettingSaveResult {
	return {
		saveState: "failed",
		write: { status: "not_attempted" },
	};
}
function invalid(message: string): never {
	throw new TeamConfigError("invalid_params", message, noWrites());
}
function concreteIdentity(provider: string, modelId: string): boolean {
	if (!provider || provider.includes("/") || provider.includes("@") || !modelId) return false;
	for (const field of [provider, modelId]) {
		if (/\s|[*?[\]]/u.test(field) || field.toLowerCase() === "auto") return false;
	}
	const colon = modelId.lastIndexOf(":");
	return colon < 0 || parseConfiguredThinkingLevel(modelId.slice(colon + 1)) === undefined;
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
	return (
		typeof value.provider === "string" &&
		typeof value.modelId === "string" &&
		concreteIdentity(value.provider, value.modelId)
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
	readonly #persistentSettings: Settings;
	readonly #registry: ModelRegistry;
	readonly #profile: string | null;
	constructor(readonly deps: TeamConfigServiceDependencies) {
		this.#settings = deps.getSettings();
		this.#persistentSettings = deps.persistentSettings ?? this.#settings;
		this.#registry = deps.getModelRegistry();
		this.#profile = getActiveProfile() ?? null;
	}

	#assertCurrent(): void {
		if (
			this.deps.isCurrent?.() === false ||
			this.deps.getSettings() !== this.#settings ||
			(getActiveProfile() ?? null) !== this.#profile ||
			this.deps.getModelRegistry() !== this.#registry
		) {
			throw new TeamConfigError(
				"execution_failed",
				"The initiating Team configuration context is no longer current",
				noWrites(),
			);
		}
	}

	#catalog(): TeamCatalog {
		const all = this.#registry.getAll();
		const available = this.#registry.getAvailable();
		const enabled = filterAvailableModelsByEnabledPatterns(
			available,
			cfgEnabledModels.get(this.#settings),
			this.#settings,
		);
		return { all, available, enabled };
	}

	#eligibility(model: Model, catalog: TeamCatalog): { code: string; message: string } | undefined {
		const capability = teamModelCapabilityIssue(model);
		if (capability) return capability;
		if (catalog.enabled.some(candidate => candidate.provider === model.provider && candidate.id === model.id))
			return undefined;
		if (!this.#registry.hasConfiguredAuth(model))
			return { code: "unauthenticated", message: "Provider authentication is not configured" };
		return {
			code: "disabled",
			message: catalog.available.some(
				candidate => candidate.provider === model.provider && candidate.id === model.id,
			)
				? "Model is outside enabledModels"
				: "Provider or model is disabled or unavailable in this context",
		};
	}

	#candidateIssue(model: Model, catalog: TeamCatalog): { code: string; message: string } | undefined {
		if (!concreteIdentity(model.provider, model.id))
			return { code: "invalid_model", message: "Model does not have a concrete Team configuration identity" };
		return this.#eligibility(model, catalog);
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
					const issue = this.#candidateIssue(model, catalog);
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
		catalog: TeamCatalog,
		provenance?: SettingProvenance,
		isLiteral?: (index: number) => boolean,
	): TeamMemberSlot[] {
		return value.map((rawSelector, index) => {
			const literal = isLiteral?.(index);
			const model = literal
				? resolveTeamMemberReference(rawSelector, catalog.all, true)
				: (resolveTeamMemberReference(rawSelector, catalog.enabled) ??
					resolveTeamMemberReference(rawSelector, catalog.all));
			const issue = model
				? literal
					? this.#candidateIssue(model, catalog)
					: this.#eligibility(model, catalog)
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
		catalog: TeamCatalog,
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
		const effectiveMembers = this.#slots(configured, list, issues, catalog, provenance);
		const participants = effectiveMembers.every(slot => slot.status === "available")
			? expandTeamRoster(effectiveMembers, (slot, index) => ({
					index,
					label: label(index),
					model: slot.model!,
				}))
			: [];
		return { effectiveMembers, source: source(provenance), participants };
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
		const stored = await this.#persistentSettings.readUserSetting(cfgTeamMembers.id);
		if (!acceptedSave) this.#assertCurrent();
		const catalog = this.#catalog();
		const issues: TeamConfigIssue[] = stored.issues.map(issue => ({
			code: issue.code,
			message: issue.message,
			target: "storage",
			...(issue.source ? { source: issue.source } : {}),
		}));
		let readState = stored.readState === "present" && stored.value === null ? "missing" : stored.readState;
		let userMembers: TeamMemberSlot[] | null | undefined;
		if (readState === "missing") userMembers = null;
		else if (readState === "present") {
			if (!strings(stored.value)) {
				issues.push({
					code: "invalid_config",
					message: "team.members must be an ordered string array",
					target: "config",
				});
				readState = "invalid";
			} else {
				userMembers = this.#slots(stored.value, "userMembers", issues, catalog);
			}
		}
		let value: unknown;
		let provenance: SettingProvenance;
		if (acceptedSave) {
			value = this.#settings.rawValue(cfgTeamMembers);
			// A higher layer can set null to mask the user roster; rawValue treats it as unset.
			provenance =
				value === undefined
					? this.#settings.projectUserSetting(cfgTeamMembers.id, undefined).source
					: cfgTeamMembers.provenance(this.#settings);
		} else {
			({ value, source: provenance } = this.#settings.projectUserSetting(cfgTeamMembers.id, stored.value));
		}
		const effective = this.#projection(value, provenance, issues, catalog, false);
		if (
			!acceptedSave &&
			(readState === "invalid" || readState === "unreadable") &&
			(provenance === "global" || provenance === "default")
		) {
			effective.effectiveMembers = null;
			effective.participants = [];
		}
		const revision = readState === "invalid" ? null : stored.revision;
		const config: TeamConfigSnapshot = {
			profile: this.#profile,
			revision,
			...(userMembers !== undefined ? { userMembers } : {}),
			...effective,
			sessionModel: null,
			issues,
			writableScopes: revision === null ? [] : ["user"],
			storage: { readState },
		};
		if (preview !== undefined) {
			const previewIssues: TeamConfigIssue[] = [];
			const projection = this.#settings.projectUserSetting(cfgTeamMembers.id, draft);
			const draftPreview: TeamConfigPreview = {
				clientRevision: preview.clientRevision,
				userMembers:
					draft === undefined
						? null
						: this.#slots(
								draft,
								"preview.userMembers",
								previewIssues,
								catalog,
								undefined,
								index => !("rawSelector" in preview.members![index]!),
							),
				...this.#projection(projection.value, projection.source, previewIssues, catalog, true),
				issues: previewIssues,
			};
			if (
				previewIssues.some(issue => issue.target === "member" && issue.list === "preview.effectiveMembers") ||
				(draftPreview.source === "global" && draftPreview.userMembers?.some(slot => slot.status !== "available"))
			)
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
		this.#validateSlots(requested);
		return this.#save(requested, input.expectedRevision);
	}

	/** Check a session-only roster against the same current catalog as a saved roster. */
	validateTeamMembers(value: unknown): void {
		this.#assertCurrent();
		this.#checkedMembers(value);
	}

	/** Save the ordered provider/model IDs used by the setting's text interfaces. */
	async saveTeamConfig(members: unknown, expectedRevision: string): Promise<TeamConfigSaveResult> {
		this.#assertCurrent();
		if (typeof expectedRevision !== "string" || !expectedRevision.trim()) invalid("expectedRevision is required");
		return this.#save(this.#checkedMembers(members), expectedRevision);
	}

	#checkedMembers(value: unknown): string[] {
		if (!strings(value)) invalid("team.members must be an ordered string array");
		this.#validateSlots(value);
		return value;
	}

	#validateSlots(requested: readonly string[] | undefined): void {
		if (!requested?.length) return;
		const issues: TeamConfigIssue[] = [];
		this.#slots(requested, "userMembers", issues, this.#catalog(), undefined, () => true);
		if (issues.length)
			throw new TeamConfigError(
				"invalid_params",
				`One or more members are unavailable: ${issues.map(issue => `${issue.selector}: ${issue.message}`).join("; ")}`,
				{ ...noWrites(), issues },
			);
	}

	async #save(requested: readonly string[] | undefined, expectedRevision: string): Promise<TeamConfigSaveResult> {
		let receipt: UserSettingSaveResult;
		let failure: { code: TeamConfigErrorCode; message: string } | undefined;
		let storageIssues: TeamConfigIssue[] | undefined;
		try {
			receipt = await this.#persistentSettings.saveUserSetting(cfgTeamMembers.id, requested, expectedRevision);
		} catch (error) {
			if (error instanceof UserSettingError) {
				receipt = error.data;
				failure = { code: error.code, message: error.message };
				storageIssues = error.issues?.map(issue => ({
					code: issue.code,
					message: issue.message,
					target: "storage",
					...(issue.source ? { source: issue.source } : {}),
				}));
			} else {
				receipt = {
					saveState: "unknown",
					write: { status: "unknown" },
				};
				failure = { code: "execution_failed", message: error instanceof Error ? error.message : String(error) };
			}
		}
		const committed = receipt.write.status === "saved";
		if (committed) {
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
		const userSlots = config.userMembers;
		const userMatches =
			requested === undefined
				? userSlots === null
				: userSlots != null &&
					userSlots.length === requested.length &&
					userSlots.every((slot, index) => slot.rawSelector === requested[index]);
		const effectiveMatchesRequested =
			userMatches &&
			config.effectiveMembers !== null &&
			config.effectiveMembers.length === (requested?.length ?? 0) &&
			config.effectiveMembers.every(
				(slot, index) =>
					slot.status === "available" &&
					slot.model !== null &&
					`${slot.model.provider}/${slot.model.modelId}` === requested?.[index],
			);
		const userMismatch = "The fresh user value differs from this request's confirmed writes";
		const result: TeamConfigSaveResult = {
			...receipt,
			config,
			effectiveMatchesRequested,
			...(!effectiveMatchesRequested
				? {
						effectiveNote: !userMatches
							? userMismatch
							: config.source === "global" || config.source === "default"
								? "The saved Team roster is not active in this session"
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
		// A committed write can be superseded before readback. Do not let callers adopt the other writer's version.
		if (!userMatches) throw new TeamConfigError("revision_conflict", userMismatch, result);
		return result;
	}
}
