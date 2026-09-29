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
 * skills stay visible for the GUI to re-enable, copy or delete.
 *
 * Mutations write through the injected Settings instance (ignored names,
 * source toggles) or the real user/project skill directories (copy, delete),
 * bump the single catalog revision, and fan out `skills_changed` /
 * `settings_changed` frames. Package/builtin/plugin skills are never deleted
 * here — they point back at their own package management (§14.6).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import type { AnySetting } from "../../config/registry";
import { withActiveSettings, type Settings } from "../../config/settings";
import { compareSkillOrder } from "../../discovery/helpers";
import {
	cfgDisabledExtensions,
	cfgSkills,
	cfgSkillsEnableAgentsProject,
	cfgSkillsEnableAgentsUser,
	cfgSkillsEnableClaudeProject,
	cfgSkillsEnableClaudeUser,
	cfgSkillsEnableCodexUser,
	cfgSkillsEnablePiProject,
	cfgSkillsEnablePiUser,
	cfgSkillsIgnoredSkills,
	type SkillsSettings,
} from "../../extensibility/settings";
import { loadSkills, loadSkillsWithShadowed, type Skill, type SkillWarning } from "../../extensibility/skills";
import {
	formatRpcSkillId,
	parseRpcSkillId,
	RpcRevisionSource,
	type RpcProjectCopySkillResult,
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

/** Collaborators the skill service needs from the project-mode host. */
export interface RpcProjectSkillServiceDeps {
	/** Project root; fixed by the startup cwd in project mode. */
	readonly cwd: string;
	/** User agent dir (~/.omp/agent) backing the user skills directory. */
	readonly agentDir: string;
	/** Settings instance shared by this project (all layers already merged). */
	readonly getSettings: () => Settings;
	/** Refresh loaded sessions' effective skill snapshots; returns session ids adopted now vs pending. */
	readonly refreshSessions?: () => { adopted: string[]; pending: string[] };
	/** Outbound frame sink; hosts forward `skills_changed` / `settings_changed` frames to the client. */
	readonly emit: (frame: object) => void;
}

/** Options for {@link RpcProjectSkillService.list} (`list_skills`). */
export interface RpcProjectListSkillsOptions {
	/** `management`: full catalog incl. disabled/ignored/shadowed rows; `effective`: the session view. */
	readonly view: "management" | "effective";
	/** Loaded session's live skill snapshot; preferred over a fresh load for the effective view. */
	readonly sessionSkills?: readonly Skill[];
	/** Explicit skills settings for the effective view; derived from the injected Settings when omitted. */
	readonly skillsSettings?: SkillsSettings;
	readonly cursor?: number;
	readonly limit?: number;
}

/** Input for {@link RpcProjectSkillService.setEnabled} (`set_skill_enabled`). */
export interface RpcProjectSetSkillEnabledInput {
	readonly skillId: string;
	readonly enabled: boolean;
	readonly scope: "user" | "project";
	/** When provided, must match the current catalog revision (revision_conflict otherwise). */
	readonly expectedRevision?: RpcRevision;
}

/** Input for {@link RpcProjectSkillService.copy} (`copy_skill`). */
export interface RpcProjectCopySkillInput {
	readonly skillId: string;
	readonly targetScope: "user" | "project";
	readonly targetName: string;
	/** When provided, must match the current catalog revision (revision_conflict otherwise). */
	readonly expectedRevision?: RpcRevision;
}

/** Input for {@link RpcProjectSkillService.delete} (`delete_skill`). */
export interface RpcProjectDeleteSkillInput {
	readonly skillId: string;
	/** When provided, must match the current catalog revision (revision_conflict otherwise). */
	readonly expectedRevision?: RpcRevision;
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

/** Skill directory names are also file names — no traversal, no separator tricks. */
const TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether `child` is at or below `parent`, tolerating Windows drive-letter casing. */
function isWithinDir(parent: string, child: string): boolean {
	const parentPath = path.resolve(parent);
	const childPath = path.resolve(child);
	const relative = path.relative(
		process.platform === "win32" ? parentPath.toLowerCase() : parentPath,
		process.platform === "win32" ? childPath.toLowerCase() : childPath,
	);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Whether the path exists (false on any stat error). */
/** Rewrite (or insert) the frontmatter `name` of a SKILL.md so the copy owns its new identity. */
async function rewriteSkillFrontmatterName(skillMdPath: string, name: string): Promise<void> {
	let content = await fs.readFile(skillMdPath, "utf8");
	if (content.startsWith("---\n")) {
		const end = content.indexOf("\n---", 4);
		if (end !== -1) {
			const frontmatter = content.slice(0, end);
			if (/^name:/m.test(frontmatter)) content = content.replace(/^name:.*$/m, `name: ${name}`);
			else content = `---\nname: ${name}\n${content.slice(4)}`;
			await fs.writeFile(skillMdPath, content);
			return;
		}
	}
	await fs.writeFile(skillMdPath, `---\nname: ${name}\ndescription: copied skill\n---\n\n${content}`);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/** Parse a `skillId`, mapping malformed input to `invalid_params`. */
function parseSkillIdOrThrow(skillId: string): { source: string; name: string } {
	try {
		return parseRpcSkillId(skillId);
	} catch (error) {
		throw new RpcProjectSkillError("invalid_params", error instanceof Error ? error.message : String(error));
	}
}

/**
 * Unified skill catalog + management service for RPC project mode. One
 * revision covers the whole catalog; it bumps after every mutation and reload,
 * and `expectedRevision` on the mutation inputs gates against stale clients.
 */
export class RpcProjectSkillService {
	readonly #deps: RpcProjectSkillServiceDeps;
	readonly #revision = new RpcRevisionSource("skills-r0");

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

	/**
	 * `list_skills`: offset-paginated skill rows. The `effective` view prefers
	 * the caller's live session snapshot (falling back to a live-settings
	 * load); the `management` view re-discovers everything, including
	 * disabled, ignored and shadowed rows, and classifies each row's state
	 * against the live settings and the effective set.
	 */
	async list(options: RpcProjectListSkillsOptions): Promise<RpcProjectListSkillsResult> {
		if (options.view !== "management" && options.view !== "effective") {
			throw new RpcProjectSkillError("invalid_params", `Invalid view: ${String(options.view)}`);
		}
		const { cursor, limit } = this.#pagination(options.cursor, options.limit);
		const warnings: string[] = [];
		const rows =
			options.view === "effective"
				? await this.#effectiveRows(options, warnings)
				: await this.#managementRows(warnings);
		rows.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
		const items = rows.slice(cursor, cursor + limit);
		return {
			items,
			revision: this.#revision.current,
			...(cursor + limit < rows.length ? { nextCursor: String(cursor + limit) } : {}),
			warnings,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// set_skill_enabled / copy_skill / delete_skill / reload_skills
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * `set_skill_enabled`: disabling adds the name to `skills.ignoredSkills`;
	 * enabling removes it and re-opens a source the toggle had closed (when a
	 * settings key controls that source). The effective state is re-derived
	 * after the write so `effective`/`pendingReason` report the real outcome —
	 * a shadowed name or a still-disabled source stays pending.
	 */
	async setEnabled(command: RpcProjectSetSkillEnabledInput): Promise<RpcProjectSetSkillEnabledResult> {
		const { skillId, enabled, scope } = command;
		if (typeof skillId !== "string" || !skillId) {
			throw new RpcProjectSkillError("invalid_params", "skillId is required");
		}
		if (typeof enabled !== "boolean") {
			throw new RpcProjectSkillError("invalid_params", `Invalid enabled: ${String(enabled)}`);
		}
		if (scope !== "user" && scope !== "project") {
			throw new RpcProjectSkillError("invalid_params", `Invalid scope: ${String(scope)}`);
		}
		this.#assertRevision(command.expectedRevision);
		const { source, name } = parseSkillIdOrThrow(skillId);
		const settings = this.#deps.getSettings();
		const skill = await this.#findSkill(source, name);
		try {
			await withActiveSettings(settings, async () => {
				cfgSkillsIgnoredSkills.setMember(settings, name, { member: !enabled });
				if (enabled) {
					const key = SKILL_SOURCE_SETTING_KEYS[source];
					if (key !== undefined && key.get(settings) === false) key.set(settings, true);
				}
				await settings.flush();
			});
		} catch (error) {
			throw new RpcProjectSkillError(
				"persistence_failed",
				`Failed to persist skill settings for ${skillId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		resetCapabilities();
		const revision = this.#revision.bump();
		this.#deps.emit({ type: "skills_changed", scope, revision });
		this.#deps.emit({ type: "settings_changed", scope: "user" });
		// Fresh post-save classification: the row may still be shadowed by a
		// same-name skill or filtered by a glob the ignore-list removal missed.
		const { classify } = await this.#managementContext();
		const { state } = classify(skill);
		return {
			skillId,
			enabled,
			effective: state === "enabled",
			...(state !== "enabled" ? { pendingReason: state } : {}),
			revision,
		};
	}

	/**
	 * `copy_skill`: recursively copies the skill's directory into the user or
	 * project skills directory under `targetName`. An existing target rejects
	 * with `invalid_params`; filesystem failures reject with `execution_failed`.
	 */
	async copy(command: RpcProjectCopySkillInput): Promise<RpcProjectCopySkillResult> {
		const { skillId, targetScope, targetName } = command;
		if (typeof skillId !== "string" || !skillId) {
			throw new RpcProjectSkillError("invalid_params", "skillId is required");
		}
		if (targetScope !== "user" && targetScope !== "project") {
			throw new RpcProjectSkillError("invalid_params", `Invalid targetScope: ${String(targetScope)}`);
		}
		const trimmedName = typeof targetName === "string" ? targetName.trim() : "";
		if (!TARGET_NAME_PATTERN.test(trimmedName)) {
			throw new RpcProjectSkillError("invalid_params", `Invalid targetName: ${String(targetName)}`);
		}
		this.#assertRevision(command.expectedRevision);
		const { source, name } = parseSkillIdOrThrow(skillId);
		const skill = await this.#findSkill(source, name);
		const targetDir = path.join(
			targetScope === "user" ? this.#userSkillsDir() : this.#projectSkillsDir(),
			trimmedName,
		);
		if (await pathExists(targetDir)) {
			throw new RpcProjectSkillError("invalid_params", `target exists: ${targetDir}`);
		}
		try {
			await fs.mkdir(path.dirname(targetDir), { recursive: true });
			await fs.cp(skill.baseDir, targetDir, { recursive: true });
			// Rewrite the frontmatter name so the copy surfaces under its new
			// identity instead of being deduped away as a same-name shadow of the
			// source (§6.2: a copy is a NEW skill identity).
			await rewriteSkillFrontmatterName(path.join(targetDir, "SKILL.md"), trimmedName);
		} catch (error) {
			throw new RpcProjectSkillError(
				"execution_failed",
				`Failed to copy ${skill.baseDir} to ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		resetCapabilities();
		const revision = this.#revision.bump();
		this.#deps.emit({ type: "skills_changed", scope: targetScope, revision });
		return {
			skillId: formatRpcSkillId(targetScope === "user" ? "native:user" : "native:project", trimmedName),
			name: trimmedName,
			location: targetDir,
			revision,
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
		this.#assertRevision(command.expectedRevision);
		const { source, name } = parseSkillIdOrThrow(skillId);
		const skill = await this.#findSkill(source, name);
		const scope = this.#deleteScope(skill);
		if (scope === undefined) {
			throw new RpcProjectSkillError(
				"unsupported",
				`Skill ${skillId} is not in a user/project skills directory; remove it through its package manager`,
			);
		}
		try {
			await fs.rm(skill.baseDir, { recursive: true, force: false });
		} catch (error) {
			throw new RpcProjectSkillError(
				"execution_failed",
				`Failed to delete ${skill.baseDir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		resetCapabilities();
		const revision = this.#revision.bump();
		this.#deps.emit({ type: "skills_changed", scope, revision });
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
		const sessions = this.#deps.refreshSessions?.() ?? { adopted: [], pending: [] };
		this.#deps.emit({ type: "skills_changed", scope, revision });
		return {
			revision,
			warnings: catalog.warnings.map(warning => `${warning.skillPath}: ${warning.message}`),
			adoptedSessions: sessions.adopted,
			pendingSessions: sessions.pending,
		};
	}

	/** No-op; kept for symmetry with the other project-mode services. */
	dispose(): void {}

	// ─────────────────────────────────────────────────────────────────────────
	// Views and classification
	// ─────────────────────────────────────────────────────────────────────────

	/** Effective rows: every skill the session (or a live-settings load) actually uses. */
	async #effectiveRows(options: RpcProjectListSkillsOptions, warnings: string[]): Promise<RpcProjectSkillSummary[]> {
		let skills: readonly Skill[];
		if (options.sessionSkills !== undefined) {
			// The loaded session's live snapshot is the truth for this view; a
			// disk scan must never impersonate the session's effective state.
			skills = options.sessionSkills;
		} else {
			const settings = this.#deps.getSettings();
			const skillsSettings = options.skillsSettings ?? cfgSkills.get(settings);
			const result = await loadSkills({
				cwd: this.#deps.cwd,
				...skillsSettings,
				disabledExtensions: cfgDisabledExtensions.get(settings),
			});
			skills = result.skills;
			warnings.push(...result.warnings.map(warning => `${warning.skillPath}: ${warning.message}`));
		}
		return skills.map(skill => this.#buildSummary(skill, "enabled"));
	}

	/** Management rows: discovered winners plus every shadowed/filtered row, each classified. */
	async #managementRows(warnings: string[]): Promise<RpcProjectSkillSummary[]> {
		const { catalog, classify } = await this.#managementContext();
		warnings.push(...catalog.warnings.map(warning => `${warning.skillPath}: ${warning.message}`));
		const rows: RpcProjectSkillSummary[] = [];
		const seen = new Set<string>();
		for (const skill of [...catalog.skills, ...catalog.shadowed]) {
			const skillId = formatRpcSkillId(skill.source, skill.name);
			if (seen.has(skillId)) continue;
			seen.add(skillId);
			const { state, shadowedBy } = classify(skill);
			rows.push(this.#buildSummary(skill, state, shadowedBy));
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
		const effectiveIds = new Set(effective.skills.map(skill => formatRpcSkillId(skill.source, skill.name)));
		const ignoredPatterns = catalog.skillsSettings.ignoredSkills ?? [];
		const disabledNames = new Set(
			cfgDisabledExtensions
				.get(settings)
				.filter(id => id.startsWith("skill:"))
				.map(id => id.slice(6)),
		);
		const shadowedIds = new Set(catalog.shadowed.map(skill => formatRpcSkillId(skill.source, skill.name)));
		const classify = (skill: Skill): { state: RpcSkillState; shadowedBy?: string } => {
			const skillId = formatRpcSkillId(skill.source, skill.name);
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
					...(winner !== undefined ? { shadowedBy: formatRpcSkillId(winner.source, winner.name) } : {}),
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
			includeSkills: [],
			disabledExtensions: cfgDisabledExtensions.get(settings),
		});
		return { skills: result.skills, shadowed: result.shadowed, warnings: result.warnings, skillsSettings };
	}

	/** Effective load with the live settings — what a freshly built session would use. */
	async #loadEffectiveSkills(skillsSettings: SkillsSettings): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
		const settings = this.#deps.getSettings();
		return await loadSkills({
			cwd: this.#deps.cwd,
			...skillsSettings,
			disabledExtensions: cfgDisabledExtensions.get(settings),
		});
	}

	/** Locate a skill (winners and shadowed alike) in a fresh management discovery. */
	async #findSkill(source: string, name: string): Promise<Skill> {
		const catalog = await this.#loadManagementCatalog();
		return this.#skillFromCatalog(catalog, source, name);
	}

	#skillFromCatalog(catalog: { skills: Skill[]; shadowed: Skill[] }, source: string, name: string): Skill {
		const match = [...catalog.skills, ...catalog.shadowed].find(
			skill => skill.source === source && skill.name === name,
		);
		if (match === undefined) {
			throw new RpcProjectSkillError("not_found", `Unknown skill: ${formatRpcSkillId(source, name)}`);
		}
		return match;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Row building and small helpers
	// ─────────────────────────────────────────────────────────────────────────

	#buildSummary(skill: Skill, state: RpcSkillState, shadowedBy?: string): RpcProjectSkillSummary {
		const actions: RpcProjectSkillSummary["actions"][number][] = ["copy"];
		if (state === "enabled") actions.push("disable");
		else if (state === "ignored") actions.push("enable");
		if (this.#deleteScope(skill) !== undefined) actions.push("delete");
		return {
			skillId: formatRpcSkillId(skill.source, skill.name),
			name: skill.name,
			description: skill.description,
			source: skill.source,
			scope: this.#scopeForSource(skill.source),
			filePath: skill.filePath,
			hidden: skill.hide === true,
			state,
			effective: state === "enabled",
			...(shadowedBy !== undefined ? { shadowedBy } : {}),
			revision: this.#revision.current,
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
		if (isWithinDir(this.#userSkillsDir(), skill.baseDir)) return "user";
		if (isWithinDir(this.#projectSkillsDir(), skill.baseDir)) return "project";
		return undefined;
	}

	/** Whether a settings toggle currently disables this skill's source. */
	#isSourceDisabled(source: string, settings: Settings): boolean {
		const key = SKILL_SOURCE_SETTING_KEYS[source];
		return key !== undefined && key.get(settings) === false;
	}

	/** Offset pagination: cursor defaults to 0, limit to 50 and clamps into [1, 200]. */
	#pagination(cursor: number | undefined, limit: number | undefined): { cursor: number; limit: number } {
		if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
			throw new RpcProjectSkillError("invalid_params", `Invalid cursor: ${String(cursor)}`);
		}
		if (limit !== undefined && !Number.isFinite(limit)) {
			throw new RpcProjectSkillError("invalid_params", `Invalid limit: ${String(limit)}`);
		}
		return {
			cursor: cursor ?? 0,
			limit: Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT),
		};
	}

	/** `expectedRevision` guard for the mutation inputs (no-op when omitted). */
	#assertRevision(expectedRevision: RpcRevision | undefined): void {
		if (expectedRevision !== undefined && expectedRevision !== this.#revision.current) {
			throw new RpcProjectSkillError(
				"revision_conflict",
				`Expected skill-catalog revision ${expectedRevision} but current is ${this.#revision.current}`,
			);
		}
	}
}
