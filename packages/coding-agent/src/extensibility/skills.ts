import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir, parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { skillCapability } from "../capability/skill";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { SkillsSettings } from "./settings";
import { type Skill as CapabilitySkill, isUserSourceEnabled, loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import { allowsSkillTokens, SKILL_TOKEN_RE } from "@oh-my-pi/pi-tui/prompt/skill-tokens";
import autoloadTemplate from "../prompts/skills/autoload.md" with { type: "text" };
import userInvocationTemplate from "../prompts/skills/user-invocation.md" with { type: "text" };
import type { SkillPromptDetails } from "../session/messages";
import { expandTilde } from "../tools/path-utils";

export { allowsSkillTokens, SKILL_TOKEN_RE };

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * (when enabled) `/skill:<name>`, but is excluded from the rendered system
	 * prompt's `<skills>` listing.
	 */
	hide?: boolean;
	/**
	 * Filesystem-resolved plugin root for Agent Plugin skills (spec §4.1):
	 * every `skill://` resource access must realpath-resolve within it.
	 */
	containRoot?: string;
	/** Source metadata for display */
	_source?: SourceMeta;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

/**
 * Whether `name` is already claimed by an active authored (non-managed) skill.
 *
 * Managed (auto-learn) skills resolve dead-last in discovery, so an authored
 * skill of the same name always wins (see `loadSkills`) and a managed skill
 * written under an authored name is silently dropped — it never surfaces.
 * `manage_skill` create consults this to refuse the write up front instead of
 * reporting a false "Created" for a skill that can never appear.
 */
export function isNameClaimedByAuthoredSkill(name: string): boolean {
	return getActiveSkills().some(
		skill => skill.name === name && skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID,
	);
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home: os.homedir(), repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: options.source,
			...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
	};
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
	/** Disabled extension ids (`disabledExtensions`); `skill:<name>` entries hide those skills. */
	disabledExtensions?: string[];
	/**
	 * Session-local extension roots. Post-startup reloads pass their live
	 * session value so explicit roots, discovery mode, and configured
	 * extensions all survive outside the construction-time invocation scope.
	 */
	extensionRoots?: EffectiveExtensionRoots;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	return await loadSkillsWithDiscovery(options);
}

/** Result of {@link loadSkillsWithShadowed}. */
export interface LoadSkillsWithShadowedResult extends LoadSkillsResult {
	/**
	 * Every discovered skill that did not make the final list: candidates that
	 * lost to another skill with the same name (name dedup, symlink dedup,
	 * custom-directory override, managed-skill vetoes), plus skills the
	 * pre-dedup filters dropped (source toggles, ignore/include patterns,
	 * `skill:<name>` disabledExtensions entries). Management catalogs use this
	 * to surface same-name duplicates a plain load silently drops; WHY an
	 * entry lost is the caller's to derive by re-checking its own settings.
	 */
	shadowed: Skill[];
}

/**
 * Like {@link loadSkills}, but also collects the skills a plain load silently
 * drops so management surfaces can list them. `skills` and `warnings` are
 * identical to {@link loadSkills}.
 */
export async function loadSkillsWithShadowed(options: LoadSkillsOptions = {}): Promise<LoadSkillsWithShadowedResult> {
	const shadowed: Skill[] = [];
	const result = await loadSkillsWithDiscovery(options, shadowed);
	return { skills: result.skills, warnings: result.warnings, shadowed };
}

/** Convert a discovered capability skill to the public {@link Skill} shape. */
function capabilitySkillToSkill(capSkill: CapabilitySkill, options?: { sanitizeDescription?: boolean }): Skill {
	const rawDescription = typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "";
	return {
		name: capSkill.name,
		description: options?.sanitizeDescription ? sanitizeManagedDescription(rawDescription) : rawDescription,
		filePath: capSkill.path,
		baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
		source: `${capSkill._source.provider}:${capSkill.level}`,
		...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
		hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
		_source: capSkill._source,
	};
}

/**
 * Shared pipeline behind {@link loadSkills} and {@link loadSkillsWithShadowed}.
 * When `shadowed` is supplied, it collects every discovered skill that lost.
 */
async function loadSkillsWithDiscovery(options: LoadSkillsOptions = {}, shadowed?: Skill[]): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		enableCodexUser = true,
		enableClaudeUser = false,
		enableClaudeProject = true,
		enablePiUser = true,
		enablePiProject = true,
		enableAgentsUser = true,
		enableAgentsProject = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
		extensionRoots,
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}
	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		// Managed skills (auto-learn) are OMP-native and discovered unconditionally
		// — third-party CLI toggles must never silently hide them (cf. #2401). The
		// master `enabled` flag above still gates them.
		if (provider === MANAGED_SKILLS_PROVIDER_ID) return true;
		if (provider === "codex" && level === "user") return enableCodexUser || isUserSourceEnabled("codex");
		if (provider === "claude" && level === "user") return enableClaudeUser || isUserSourceEnabled("claude");
		if (provider === "claude" && level === "project") return enableClaudeProject;
		if (provider === "native" && level === "user") return enablePiUser;
		if (provider === "native" && level === "project") return enablePiProject;
		if (provider === "agents" && level === "user") return enableAgentsUser;
		if (provider === "agents" && level === "project") return enableAgentsProject;
		// User-scope claude-plugins skills carry the root's origin (#10743). omp's
		// own installs (`omp` registry, `--plugin-dir`) are not the foreign
		// ~/.claude/plugins tree, so the foreign opt-in gate applies only to
		// claude-origin roots — parity with allowedRoots() in
		// discovery/claude-plugins.ts. Without this, #10666's root-level fix is
		// re-dropped here for every user-level claude-plugins skill.
		if (provider === "claude-plugins" && source.origin !== undefined && source.origin !== "claude") return true;
		if (level === "user") return isUserSourceEnabled(provider);
		return true;
	}

	// Use capability API to load all skills
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, {
		cwd,
		disabledExtensions,
		extensionRoots,
	});

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	// Select authored skills from the pre-dedup superset. `loadCapability`
	// dedupes before source toggles, so a disabled high-priority provider must
	// not hide an enabled lower-priority provider with the same skill name.
	const seenAuthoredSkillNames = new Set<string>();
	const filteredSkills = result.all.filter(capSkill => {
		if (capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID) return false;
		if (disabledSkillNames.has(capSkill.name)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
			return false;
		}
		if (!isSourceEnabled(capSkill._source)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
			return false;
		}
		if (matchesIgnorePatterns(capSkill.name)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
			return false;
		}
		if (!matchesIncludePatterns(capSkill.name)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
			return false;
		}
		if (seenAuthoredSkillNames.has(capSkill.name)) {
			// Same-name candidate from a lower-priority discovery: the first one
			// won, this one is only visible to management catalogs.
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
			return false;
		}
		seenAuthoredSkillNames.add(capSkill.name);
		return true;
	});

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
			continue;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill));
		} else {
			skillMap.set(capSkill.name, capabilitySkillToSkill(capSkill));
			realPathSet.add(resolvedPath);
		}
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{ skill: Skill; path: string }> = [];
	for (const { expandedDir, scanResult } of customDirectoryResults) {
		for (const capSkill of scanResult.items) {
			const skill: Skill = {
				name: capSkill.name,
				description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
				source: "custom:user",
				...(capSkill.containRoot !== undefined && { containRoot: capSkill.containRoot }),
				hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
				_source: { ...capSkill._source, providerName: "Custom" },
			};
			if (disabledSkillNames.has(capSkill.name)) {
				if (shadowed) shadowed.push(skill);
				continue;
			}
			if (matchesIgnorePatterns(capSkill.name)) {
				if (shadowed) shadowed.push(skill);
				continue;
			}
			if (!matchesIncludePatterns(capSkill.name)) {
				if (shadowed) shadowed.push(skill);
				continue;
			}
			allCustomSkills.push({ skill, path: capSkill.path });
		}
		collisionWarnings.push(...(scanResult.warnings ?? []).map(message => ({ skillPath: expandedDir, message })));
	}

	const customRealPaths = await Promise.all(
		allCustomSkills.map(async ({ path }) => {
			try {
				return await fs.realpath(path);
			} catch {
				return path;
			}
		}),
	);

	for (let i = 0; i < allCustomSkills.length; i++) {
		const { skill } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) {
			if (shadowed) shadowed.push(skill);
			continue;
		}

		const existing = skillMap.get(skill.name);
		if (existing) {
			// A skill name claimed by a DEFAULT-path provider (e.g.
			// ~/.claude/skills/<name>) yields to the explicitly configured
			// skills.customDirectories entry — the user's custom dir is the
			// higher-priority source (issue #7190). Only same-source custom
			// duplicates keep first-wins.
			const isCustomExisting = existing.source.startsWith("custom:");
			if (!isCustomExisting) {
				// The displaced default-path skill is the same-name loser.
				if (shadowed) shadowed.push(existing);
				skillMap.set(skill.name, skill);
				realPathSet.add(resolvedPath);
				continue;
			}
			collisionWarnings.push({
				skillPath: skill.filePath,
				message: `name collision: "${skill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
			if (shadowed) shadowed.push(skill);
		} else {
			skillMap.set(skill.name, skill);
			realPathSet.add(resolvedPath);
		}
	}

	// Managed (auto-learn) skills resolve dead-last with first-wins. Source from
	// result.all (pre-dedup): capability-level dedup runs BEFORE isSourceEnabled,
	// so a managed skill can be shadowed by a higher-priority authored skill that
	// is itself disabled here — managed must stay visible regardless of toggles.
	// Validate the on-disk name (a hand-placed managed file could carry an unsafe
	// frontmatter name) and re-sanitize the description on read. Descriptions and
	// names both render unescaped into the system prompt.
	const managedCandidates = result.all.filter(
		capSkill =>
			capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID &&
			isValidManagedSkillName(capSkill.name) &&
			!disabledSkillNames.has(capSkill.name) &&
			!matchesIgnorePatterns(capSkill.name) &&
			matchesIncludePatterns(capSkill.name),
	);
	// Names claimed by any ENABLED authored skill (from the pre-dedup superset).
	// Managed defers to these even when capability dedup hid an enabled authored
	// skill behind a disabled higher-priority one, so managed never masks it.
	const enabledAuthoredNames = new Set(
		result.all
			.filter(
				capSkill => capSkill._source.provider !== MANAGED_SKILLS_PROVIDER_ID && isSourceEnabled(capSkill._source),
			)
			.map(capSkill => capSkill.name),
	);
	const managedRealPaths = await Promise.all(
		managedCandidates.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);
	for (let i = 0; i < managedCandidates.length; i++) {
		const capSkill = managedCandidates[i];
		const resolvedPath = managedRealPaths[i];
		if (realPathSet.has(resolvedPath)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill, { sanitizeDescription: true }));
			continue;
		}
		if (enabledAuthoredNames.has(capSkill.name)) {
			// an enabled authored skill owns this name; the managed twin loses
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill, { sanitizeDescription: true }));
			continue;
		}
		// Already claimed — e.g. by a custom-directory skill. LOAD-BEARING: custom
		// dirs never enter `result.all`, so they are absent from `enabledAuthoredNames`
		// above; this map check is the ONLY veto that lets a custom-dir authored skill
		// win over a same-named managed one. The custom-dir loop (which populates
		// skillMap, ~30 lines up) MUST run before this block — do not reorder.
		if (skillMap.has(capSkill.name)) {
			if (shadowed) shadowed.push(capabilitySkillToSkill(capSkill, { sanitizeDescription: true }));
			continue;
		}
		skillMap.set(capSkill.name, capabilitySkillToSkill(capSkill, { sanitizeDescription: true }));
		realPathSet.add(resolvedPath);
	}

	const skills = Array.from(skillMap.values());
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

/**
 * Parsed `/skill:<name>` invocation: either at the start of the draft (the
 * traditional slash-command position) or as a `/skill:<name>` token embedded
 * mid-prompt. For the mid-prompt form the surrounding prose is threaded
 * through as `args` so the skill sees the full user request.
 */
export interface ParsedSkillInvocation {
	/** Bare skill name without the leading `skill:` prefix. */
	name: string;
	/** User-supplied arguments (everything outside the `/skill:<name>` token). */
	args: string;
	/** The draft as submitted (trimmed), token in place — drives the transcript layout. */
	prompt: string;
}

/**
 * Detect a `/skill:<name>` invocation in a user draft.
 *
 * Returns `undefined` when the text contains no skill token. Otherwise:
 *   - Leading form (`/skill:foo bar baz`): name=`foo`, args=`bar baz`.
 *   - Mid-prompt form (`fix the bug /skill:foo focus on auth`): name=`foo`,
 *     args=`fix the bug focus on auth` — the surrounding prose collapsed
 *     into a single args string.
 *
 * Mid-prompt detection is gated by {@link allowsSkillTokens}.
 */
export function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined {
	const trimmedStart = text.trimStart();
	const prompt = trimmedStart.trimEnd();
	if (trimmedStart.startsWith("/skill:")) {
		const spaceIndex = trimmedStart.search(/\s/);
		const name =
			spaceIndex === -1 ? trimmedStart.slice("/skill:".length) : trimmedStart.slice("/skill:".length, spaceIndex);
		if (!name) return undefined;
		const args = spaceIndex === -1 ? "" : trimmedStart.slice(spaceIndex + 1).trim();
		return { name, args, prompt };
	}
	if (!allowsSkillTokens(trimmedStart)) return undefined;
	SKILL_TOKEN_RE.lastIndex = 0;
	const match = SKILL_TOKEN_RE.exec(text);
	if (!match) return undefined;
	const tokenStart = match.index + match[1].length;
	const tokenEnd = match.index + match[0].length;
	const name = match[2];
	const before = text.slice(0, tokenStart).trimEnd();
	const after = text.slice(tokenEnd).trimStart();
	const args = [before, after]
		.filter(part => part.length > 0)
		.join(" ")
		.trim();
	return { name, args, prompt };
}

export type SkillInvocationKind = "user" | "autoload";

/** What the user typed around a skill token: `args` feed the template, `prompt` only the transcript. */
export type SkillPromptInput = Pick<ParsedSkillInvocation, "args"> & Partial<Pick<ParsedSkillInvocation, "prompt">>;

export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath" | "baseDir">,
	input: SkillPromptInput,
	invocation: SkillInvocationKind = "user",
): Promise<BuiltSkillPromptMessage> {
	const content = await Bun.file(skill.filePath).text();
	// Only the body is used: keep HTML comments (`repair: false`) and leave YAML
	// diagnostics to the loader, which already parsed this frontmatter.
	const body = parseFrontmatter(content, { source: skill.filePath, repair: false, level: "off" }).body.trim();
	const trimmedArgs = input.args.trim();
	let message: string;
	if (invocation === "user") {
		// User-invoked skills announce themselves and expose their skill directory
		// so the model resolves the skill's own relative paths (scripts/, templates/).
		message = prompt
			.render(userInvocationTemplate, {
				name: skill.name,
				body,
				baseDir: skill.baseDir,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	} else {
		// Autoload skills are hidden, non-user context — they MUST NOT claim the
		// user invoked them; this keeps the minimal provenance-only format.
		message = prompt
			.render(autoloadTemplate, {
				body,
				filePath: skill.filePath,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	}
	return {
		message,
		details: {
			name: skill.name,
			path: skill.filePath,
			args: trimmedArgs || undefined,
			prompt: input.prompt,
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}
