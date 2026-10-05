/**
 * Unified skill catalog + management service for RPC project mode
 * (requirement R1, rpc-ui-protocol.md §6 / §14.6).
 *
 * `RpcProjectSkillService` serves both `list_skills` views: `effective`
 * reports what a session actually uses (the caller's live session snapshot,
 * or a fresh `loadSkills` run against the live settings) and must never
 * impersonate that with a raw disk scan, while `management` re-runs discovery
 * through `loadSkillsWithShadowed` with the per-source toggles forced on and
 * the name filters bypassed, so disabled, ignored and same-name shadowed
 * skills stay visible for the GUI to re-enable or delete.
 *
 * Mutations write through the injected Settings instance (ignored names,
 * source toggles) or the real user/project skill directories (delete),
 * bump the single catalog revision, and fan out `skills_changed` /
 * `settings_changed` frames. Package/builtin/plugin skills are never deleted
 * here — they point back at their own package management (§14.6).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, normalizePathForComparison, pathIsWithin } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import type { AnySetting } from "../../config/registry";
import { UserSettingConflictError, type Settings } from "../../config/settings";
import { compareSkillOrder } from "../../discovery/helpers";
import {
	cfgDisabledExtensions,
	cfgSkills,
	cfgSkillsDisabledPaths,
	cfgSkillsEnableAgentsProject,
	cfgSkillsEnableAgentsUser,
	cfgSkillsEnableClaudeProject,
	cfgSkillsEnableClaudeUser,
	cfgSkillsEnableCodexUser,
	cfgSkillsEnablePiProject,
	cfgSkillsEnablePiUser,
	type SkillsSettings,
} from "../../extensibility/settings";
import { loadSkills, loadSkillsWithShadowed, type Skill, type SkillWarning } from "../../extensibility/skills";
import {
	formatRpcSkillId,
	RpcRevisionSource,
	type RpcProjectDeleteSkillResult,
	type RpcProjectErrorCode,
	type RpcProjectListSkillsResult,
	type RpcProjectReloadSkillsResult,
	type RpcProjectSetSkillEnabledResult,
	type RpcProjectSkillSummary,
	type RpcRevision,
	type RpcSkillState,
} from "./rpc-project-types";

/** Typed failure surfaced by the skill service; `code` maps to RpcProjectErrorCode (rpc-ui-protocol.md §14.1). */
export class RpcProjectSkillError extends Error {
	readonly code: RpcProjectErrorCode;

	constructor(code: RpcProjectErrorCode, message: string) {
		super(message);
		this.name = "RpcProjectSkillError";
		this.code = code;
	}
}

/** Render an unknown thrown value as the service error message. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Collaborators the skill service needs from the project-mode host. */
export interface RpcProjectSkillServiceDeps {
	/** Project root; fixed by the startup cwd in project mode. */
	readonly cwd: string;
	/** User agent dir (~/.omp/agent) backing the user skills directory. */
	readonly agentDir: string;
	/** Settings instance shared by this project (all layers already merged). */
	readonly getSettings: () => Settings;
	/** Refresh loaded sessions' effective skill snapshots; returns session ids adopted now vs pending. */
	/** True while a loaded execution owns this skill's resources. */
	readonly isSkillInUse?: (filePath: string) => boolean;
	readonly refreshSessions?: () =>
		| { adopted: string[]; pending: string[] }
		| Promise<{ adopted: string[]; pending: string[] }>;
	/** Outbound frame sink; hosts forward `skills_changed` / `settings_changed` frames to the client. */
	readonly emit: (frame: object) => void;
}

/** Options for {@link RpcProjectSkillService.list} (`list_skills`). */
export interface RpcProjectListSkillsOptions {
	/** `management`: full catalog incl. disabled/ignored/shadowed rows; `effective`: the session view. */
	readonly view: "management" | "effective";
	/** Binds effective-view cursors to their owning loaded session. */
	readonly sessionId?: string;
	/** Loaded session's live skill snapshot; preferred over a fresh load for the effective view. */
	readonly sessionSkills?: readonly Skill[];
	/** Explicit skills settings for the effective view; derived from the injected Settings when omitted. */
	readonly skillsSettings?: SkillsSettings;
	readonly cursor?: string;
	readonly limit?: number;
}

/** Input for {@link RpcProjectSkillService.setEnabled} (`set_skill_enabled`). */
export interface RpcProjectSetSkillEnabledInput {
	readonly skillId: string;
	readonly enabled: boolean;
	readonly scope: "user";
	/** Required revision of this concrete resource, not the skill catalog. */
	readonly expectedRevision: RpcRevision;
}

/** Input for {@link RpcProjectSkillService.delete} (`delete_skill`). */
export interface RpcProjectDeleteSkillInput {
	readonly skillId: string;
	/** Required revision of this concrete resource. */
	readonly expectedRevision: RpcRevision;
}

/**
 * Source strings (exactly as `loadSkills` reports them, `"<provider>:<level>"`)
 * that a settings toggle can turn off, mapped to the controlling key. Mirrors
 * `SKILL_SOURCE_KEYS` in rpc-fork-manage.ts; `pi:*` is that surface's legacy
 * wire label for the native provider, kept here for parity.
 */
const SKILL_SOURCE_SETTING_KEYS: Record<string, AnySetting | undefined> = {
	"native:user": cfgSkillsEnablePiUser,
	"native:project": cfgSkillsEnablePiProject,
	"pi:user": cfgSkillsEnablePiUser,
	"pi:project": cfgSkillsEnablePiProject,
	"codex:user": cfgSkillsEnableCodexUser,
	"claude:user": cfgSkillsEnableClaudeUser,
	"claude:project": cfgSkillsEnableClaudeProject,
	"agents:user": cfgSkillsEnableAgentsUser,
	"agents:project": cfgSkillsEnableAgentsProject,
};

/** Default and upper bound for `list_skills` pagination (`limit` clamps into range). */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** Resource operations require a strict descendant, never the skills root itself. */
function isWithinDir(parent: string, child: string): boolean {
	return normalizePathForComparison(parent) !== normalizePathForComparison(child) && pathIsWithin(parent, child);
}

/** Unified resource-backed catalog; content/config revisions guard each concrete skill. */
export class RpcProjectSkillService {
	readonly #deps: RpcProjectSkillServiceDeps;
	readonly #revision = new RpcRevisionSource("skills-r0");
	readonly #catalogKeys = new Map<string, string>();

	constructor(deps: RpcProjectSkillServiceDeps) {
		this.#deps = deps;
	}

	/** Current catalog revision; changes after every mutation and reload. */
	get revision(): RpcRevision {
		return this.#revision.current;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// list_skills
	// ─────────────────────────────────────────────────────────────────────────

	/** Lists a fresh management catalog or an actual loaded-session snapshot. */
	async list(options: RpcProjectListSkillsOptions): Promise<RpcProjectListSkillsResult> {
		if (options.view !== "management" && options.view !== "effective") {
			throw new RpcProjectSkillError("invalid_params", `Invalid view: ${String(options.view)}`);
		}
		const limit = this.#pageLimit(options.limit);
		const warnings: string[] = [];
		const rows =
			options.view === "effective" ? await this.#effectiveRows(options) : await this.#managementRows(warnings);
		rows.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
		const scope = JSON.stringify([this.#deps.cwd, options.view, options.sessionId ?? null]);
		const catalogKey = Bun.hash(JSON.stringify(rows)).toString(36);
		const previous = this.#catalogKeys.get(scope);
		if (previous !== undefined && previous !== catalogKey) this.#revision.bump();
		this.#catalogKeys.set(scope, catalogKey);
		const offset = this.#pageOffset(options.cursor, scope, catalogKey);
		const items = rows.slice(offset, offset + limit);
		return {
			items,
			revision: this.#revision.current,
			...(offset + limit < rows.length
				? {
						nextCursor: Buffer.from(JSON.stringify([scope, catalogKey, offset + limit])).toString("base64url"),
					}
				: {}),
			warnings,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// set_skill_enabled / delete_skill / reload_skills
	// ─────────────────────────────────────────────────────────────────────────

	/** A concrete user toggle never changes source switches or name-pattern ignores. */
	async setEnabled(command: RpcProjectSetSkillEnabledInput): Promise<RpcProjectSetSkillEnabledResult> {
		const { skillId, enabled, scope } = command;
		if (typeof skillId !== "string" || !skillId) {
			throw new RpcProjectSkillError("invalid_params", "skillId is required");
		}
		if (typeof enabled !== "boolean") {
			throw new RpcProjectSkillError("invalid_params", `Invalid enabled: ${String(enabled)}`);
		}
		if (scope !== "user") {
			throw new RpcProjectSkillError("scope_not_allowed", "Concrete skill settings support only user writes");
		}
		const settings = this.#deps.getSettings();
		const skill = await this.#findSkill(skillId);
		const canonical = normalizePathForComparison(skill.filePath);
		const rawDisabledPaths = settings.getUserSettingValue("skills.disabledPaths");
		const expectedDisabled =
			Array.isArray(rawDisabledPaths) &&
			rawDisabledPaths.some(
				filePath => typeof filePath === "string" && normalizePathForComparison(filePath) === canonical,
			);
		await this.#assertRevision(command.expectedRevision, skill);
		const contentDigest = skill.contentRevision;
		if (contentDigest === undefined) throw new RpcProjectSkillError("unsupported", "Skill has no content revision");
		try {
			await settings.saveUserSkillEnabled(skill.filePath, enabled, expectedDisabled, contentDigest);
		} catch (error) {
			if (error instanceof UserSettingConflictError) {
				throw new RpcProjectSkillError("revision_conflict", `Skill ${skill.name} changed; read it again`);
			}
			if (error instanceof RpcProjectSkillError) throw error;
			throw new RpcProjectSkillError(
				"persistence_failed",
				`Failed to persist skill settings for ${skillId}: ${errorMessage(error)}`,
			);
		}
		resetCapabilities();
		const catalogRevision = this.#revision.bump();
		const revision = await this.#resourceRevision(skill);
		this.#deps.emit({ type: "skills_changed", scope, revision: catalogRevision });
		this.#deps.emit({ type: "settings_changed", scope: "user" });
		const sessions = (await this.#deps.refreshSessions?.()) ?? { adopted: [], pending: [] };
		// A source switch, include filter, ignored pattern or higher-precedence
		// same-name resource can still keep this concrete skill out of the effective set.
		const { classify } = await this.#managementContext();
		const { state } = classify(skill);
		return {
			skillId,
			enabled,
			effective: state === "enabled",
			...(state !== "enabled" ? { pendingReason: state } : {}),
			revision,
			adoptedSessions: sessions.adopted,
			pendingSessions: sessions.pending,
		};
	}

	/**
	 * `delete_skill`: removes the skill's directory, but only under the user or
	 * project skills directories — builtin/plugin/skillshare skills reject with
	 * `unsupported` and point back at their own package management (§14.6).
	 */
	async delete(command: RpcProjectDeleteSkillInput): Promise<RpcProjectDeleteSkillResult> {
		const { skillId } = command;
		if (typeof skillId !== "string" || !skillId) {
			throw new RpcProjectSkillError("invalid_params", "skillId is required");
		}
		const skill = await this.#findSkill(skillId);
		await this.#assertRevision(command.expectedRevision, skill);
		const scope = this.#deleteScope(skill);
		if (scope === undefined) {
			throw new RpcProjectSkillError(
				"unsupported",
				`Skill ${skillId} is not in a user/project skills directory; remove it through its package manager`,
			);
		}
		if (this.#deps.isSkillInUse?.(skill.filePath)) {
			throw new RpcProjectSkillError("busy", `Skill ${skillId} is in use by an active session`);
		}
		try {
			await fs.rm(skill.baseDir, { recursive: true, force: false });
		} catch (error) {
			throw new RpcProjectSkillError(
				"execution_failed",
				`Failed to delete ${skill.baseDir}: ${errorMessage(error)}`,
			);
		}
		resetCapabilities();
		const revision = this.#revision.bump();
		this.#deps.emit({ type: "skills_changed", scope, revision });
		await this.#deps.refreshSessions?.();
		return { deleted: true, revision };
	}

	/**
	 * `reload_skills`: external edits and RPC edits share this refresh path —
	 * the capability caches are dropped, the management catalog re-loads from
	 * disk, and loaded sessions either adopt the new snapshot immediately or
	 * keep their current one until a safe boundary (reported per session id).
	 */
	async reload(scope: "user" | "project"): Promise<RpcProjectReloadSkillsResult> {
		if (scope !== "user" && scope !== "project") {
			throw new RpcProjectSkillError("invalid_params", `Invalid scope: ${String(scope)}`);
		}
		resetCapabilities();
		const catalog = await this.#loadManagementCatalog();
		const revision = this.#revision.bump();
		const sessions = (await this.#deps.refreshSessions?.()) ?? { adopted: [], pending: [] };
		this.#deps.emit({ type: "skills_changed", scope, revision });
		return {
			revision,
			warnings: catalog.warnings.map(warning => `${warning.skillPath}: ${warning.message}`),
			adoptedSessions: sessions.adopted,
			pendingSessions: sessions.pending,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Views and classification
	// ─────────────────────────────────────────────────────────────────────────

	/** Effective rows: every skill the session (or a live-settings load) actually uses. */
	async #effectiveRows(options: RpcProjectListSkillsOptions): Promise<RpcProjectSkillSummary[]> {
		if (options.sessionSkills === undefined) {
			throw new RpcProjectSkillError("invalid_params", "Effective view requires a loaded session snapshot");
		}
		const skills = options.sessionSkills;
		return Promise.all(skills.map(skill => this.#buildSummary(skill, "enabled", undefined, true)));
	}

	/** Management rows: discovered winners plus every shadowed/filtered row, each classified. */
	async #managementRows(warnings: string[]): Promise<RpcProjectSkillSummary[]> {
		const { catalog, classify } = await this.#managementContext();
		warnings.push(...catalog.warnings.map(warning => `${warning.skillPath}: ${warning.message}`));
		const rows: RpcProjectSkillSummary[] = [];
		const seen = new Set<string>();
		for (const skill of [...catalog.skills, ...catalog.shadowed]) {
			const skillId = formatRpcSkillId(skill.source, normalizePathForComparison(skill.filePath));
			if (seen.has(skillId)) continue;
			seen.add(skillId);
			const { state, shadowedBy } = classify(skill);
			rows.push(await this.#buildSummary(skill, state, shadowedBy));
		}
		return rows;
	}

	/** Management view context: one management discovery plus one effective load for state classification. */
	async #managementContext(): Promise<{
		catalog: { skills: Skill[]; shadowed: Skill[]; warnings: SkillWarning[]; skillsSettings: SkillsSettings };
		classify: (skill: Skill) => { state: RpcSkillState; shadowedBy?: string };
	}> {
		const settings = this.#deps.getSettings();
		const catalog = await this.#loadManagementCatalog();
		const effective = await this.#loadEffectiveSkills(catalog.skillsSettings);
		const effectiveIds = new Set(
			effective.skills.map(skill => formatRpcSkillId(skill.source, normalizePathForComparison(skill.filePath))),
		);
		const ignoredPatterns = catalog.skillsSettings.ignoredSkills ?? [];
		const disabledNames = new Set(
			cfgDisabledExtensions
				.get(settings)
				.filter(id => id.startsWith("skill:"))
				.map(id => id.slice(6)),
		);
		const shadowedIds = new Set(
			catalog.shadowed.map(skill => formatRpcSkillId(skill.source, normalizePathForComparison(skill.filePath))),
		);
		const disabledPaths = new Set(cfgSkillsDisabledPaths.get(settings).map(normalizePathForComparison));
		const classify = (skill: Skill): { state: RpcSkillState; shadowedBy?: string } => {
			const skillId = formatRpcSkillId(skill.source, normalizePathForComparison(skill.filePath));
			if (disabledPaths.has(normalizePathForComparison(skill.filePath))) return { state: "disabled" };
			if (effectiveIds.has(skillId)) return { state: "enabled" };
			// Why-is-it-not-effective precedence mirrors loadSkills' own gate
			// order: `skill:<name>` disabledExtensions entry, source toggle,
			// ignore pattern, then same-name shadowing.
			if (disabledNames.has(skill.name)) return { state: "disabled" };
			if (this.#isSourceDisabled(skill.source, settings)) return { state: "source_disabled" };
			if (ignoredPatterns.some(pattern => new Bun.Glob(pattern).match(skill.name))) return { state: "ignored" };
			if (shadowedIds.has(skillId)) {
				const winner = effective.skills.find(candidate => candidate.name === skill.name);
				return {
					state: "shadowed",
					...(winner !== undefined
						? { shadowedBy: formatRpcSkillId(winner.source, normalizePathForComparison(winner.filePath)) }
						: {}),
				};
			}
			// Not effective without a row-specific reason: the master
			// `skills.enabled` switch is off or the includeSkills allowlist
			// filtered the name.
			return { state: "disabled" };
		};
		return { catalog, classify };
	}

	/**
	 * Management discovery: the per-source toggles and the master `enabled`
	 * switch are forced on and the ignore/include filters bypassed, so
	 * disabled and ignored rows are still discovered (their state is
	 * re-derived per row from the live settings). `disabledExtensions` and
	 * `customDirectories` stay live — they scope provider discovery itself,
	 * and `skill:<name>` rows surface through the shadowed collection.
	 */
	async #loadManagementCatalog(): Promise<{
		skills: Skill[];
		shadowed: Skill[];
		warnings: SkillWarning[];
		skillsSettings: SkillsSettings;
	}> {
		const settings = this.#deps.getSettings();
		const skillsSettings = cfgSkills.get(settings);
		resetCapabilities();
		const result = await loadSkillsWithShadowed({
			cwd: this.#deps.cwd,
			...skillsSettings,
			enabled: true,
			enableCodexUser: true,
			enableClaudeUser: true,
			enableClaudeProject: true,
			enablePiUser: true,
			enablePiProject: true,
			enableAgentsUser: true,
			enableAgentsProject: true,
			ignoredSkills: [],
			disabledPaths: [],
			includeSkills: [],
			disabledExtensions: cfgDisabledExtensions.get(settings),
		});
		return { skills: result.skills, shadowed: result.shadowed, warnings: result.warnings, skillsSettings };
	}

	/** Prospective configured set, used only for management-state classification. */
	async #loadEffectiveSkills(skillsSettings: SkillsSettings): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
		const settings = this.#deps.getSettings();
		return loadSkills({
			cwd: this.#deps.cwd,
			...skillsSettings,
			disabledExtensions: cfgDisabledExtensions.get(settings),
		});
	}

	/** Locate a skill (winners and shadowed alike) in a fresh management discovery. */
	async #findSkill(skillId: string): Promise<Skill> {
		if (typeof skillId !== "string" || !skillId)
			throw new RpcProjectSkillError("invalid_params", "skillId is required");
		const catalog = await this.#loadManagementCatalog();
		const match = [...catalog.skills, ...catalog.shadowed].find(
			skill => formatRpcSkillId(skill.source, normalizePathForComparison(skill.filePath)) === skillId,
		);
		if (!match) throw new RpcProjectSkillError("not_found", `Unknown skill: ${skillId}`);
		return match;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Row building and small helpers
	// ─────────────────────────────────────────────────────────────────────────

	async #buildSummary(
		skill: Skill,
		state: RpcSkillState,
		shadowedBy?: string,
		adopted = false,
	): Promise<RpcProjectSkillSummary> {
		const actions: RpcProjectSkillSummary["actions"][number][] = ["copy"];
		if (state === "enabled") actions.push("disable");
		else actions.push("enable");
		if (this.#deleteScope(skill) !== undefined) actions.push("delete");
		return {
			skillId: formatRpcSkillId(skill.source, normalizePathForComparison(skill.filePath)),
			name: skill.name,
			description: skill.description,
			source: skill.source,
			scope: this.#scopeForSource(skill.source),
			writableScopes: ["user"],
			filePath: skill.filePath,
			hidden: skill.hide === true,
			state,
			effective: adopted,
			...(shadowedBy !== undefined ? { shadowedBy } : {}),
			revision: await this.#resourceRevision(skill, true),
			actions,
		};
	}

	/** `"<provider>:<level>"` → scope label; unleveled (package/builtin) sources keep their provider name. */
	#scopeForSource(source: string): string {
		const separator = source.indexOf(":");
		const level = separator === -1 ? "" : source.slice(separator + 1);
		if (level === "user" || level === "project") return level;
		return separator === -1 ? source : source.slice(0, separator);
	}

	/** The native provider's user skills directory (discovery/builtin.ts scans `<agentDir>/skills`). */
	#userSkillsDir(): string {
		return path.join(this.#deps.agentDir, "skills");
	}

	/** The native provider's project skills directory (`<cwd>/.omp/skills`). */
	#projectSkillsDir(): string {
		return path.join(this.#deps.cwd, CONFIG_DIR_NAME, "skills");
	}

	/** Which writable skills directory the skill lives in, if any (drives `delete` eligibility). */
	#deleteScope(skill: Skill): "user" | "project" | undefined {
		if (skill.source === "native:user" && isWithinDir(this.#userSkillsDir(), skill.baseDir)) return "user";
		if (skill.source === "native:project" && isWithinDir(this.#projectSkillsDir(), skill.baseDir)) return "project";
		return undefined;
	}

	/** Whether a settings toggle currently disables this skill's source. */
	#isSourceDisabled(source: string, settings: Settings): boolean {
		const key = SKILL_SOURCE_SETTING_KEYS[source];
		return key !== undefined && key.get(settings) === false;
	}

	#pageLimit(limit: number | undefined): number {
		if (
			limit !== undefined &&
			(typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)
		) {
			throw new RpcProjectSkillError("invalid_params", `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
		}
		return limit ?? DEFAULT_PAGE_LIMIT;
	}

	#pageOffset(cursor: string | undefined, scope: string, snapshot: string): number {
		if (cursor === undefined) return 0;
		let decoded: unknown;
		try {
			if (typeof cursor !== "string" || !cursor) throw new Error("empty cursor");
			decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		} catch {
			throw new RpcProjectSkillError("invalid_params", "Invalid skill cursor");
		}
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 3 ||
			typeof decoded[0] !== "string" ||
			typeof decoded[1] !== "string" ||
			!Number.isSafeInteger(decoded[2]) ||
			decoded[2] < 0
		) {
			throw new RpcProjectSkillError("invalid_params", "Invalid skill cursor");
		}
		if (decoded[0] !== scope || decoded[1] !== snapshot) {
			throw new RpcProjectSkillError("stale_cursor", "Skill cursor belongs to a different view or changed snapshot");
		}
		return decoded[2];
	}

	async #resourceRevision(skill: Skill, adopted = false): Promise<RpcRevision> {
		const settings = this.#deps.getSettings();
		const options = cfgSkills.get(settings);
		const content = adopted
			? skill.contentRevision
			: Bun.hash(await Bun.file(skill.filePath).arrayBuffer()).toString(36);
		if (content === undefined)
			throw new RpcProjectSkillError("unsupported", "Effective snapshot has no adopted content revision");
		const config = {
			enabled: options.enabled,
			sourceDisabled: this.#isSourceDisabled(skill.source, settings),
			disabled: options.disabledPaths.some(
				filePath => normalizePathForComparison(filePath) === normalizePathForComparison(skill.filePath),
			),
			ignored: options.ignoredSkills.filter(pattern => new Bun.Glob(pattern).match(skill.name)),
			included:
				options.includeSkills.length === 0 ||
				options.includeSkills.some(pattern => new Bun.Glob(pattern).match(skill.name)),
			extensionDisabled: cfgDisabledExtensions.get(settings).includes(`skill:${skill.name}`),
		};
		return `skill-${Bun.hash(JSON.stringify([content, config])).toString(36)}`;
	}

	async #assertRevision(expectedRevision: RpcRevision | undefined, skill: Skill): Promise<RpcRevision> {
		if (typeof expectedRevision !== "string" || !expectedRevision) {
			throw new RpcProjectSkillError("invalid_params", "expectedRevision is required");
		}
		const current = await this.#resourceRevision(skill);
		if (expectedRevision !== undefined && expectedRevision !== current) {
			throw new RpcProjectSkillError("revision_conflict", `Skill ${skill.name} changed; read it again`);
		}
		return current;
	}
}
