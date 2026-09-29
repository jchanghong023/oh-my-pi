/**
 * Unified command catalog + dynamic completion engine for RPC project mode
 * (requirement R2, rpc-ui-protocol.md §7 / §14.5).
 *
 * `RpcCommandCatalogService` owns the project-level `/command` catalog:
 * `buildCatalog` snapshots descriptors — a live session listing via
 * `buildAvailableSlashCommands` when a session-like object is supplied, a
 * project-scoped static view (builtin registry + discovered skills) otherwise
 * — `complete` produces side-effect-free command-name and argument
 * completions, and `resolve` gives `execute_command` a strict
 * builtin/skill/unknown verdict so unknown commands never fall through to the
 * model.
 *
 * Argument completions come from the runtime-free static materialization in
 * `builtin-registry.ts` (`BUILTIN_SLASH_COMMANDS`), so completion never
 * constructs a TUI runtime and never prompts, writes, or executes anything;
 * the only state this service mutates is its own catalog cache and revision.
 */
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import { cfgSkills, type SkillsSettings } from "../../extensibility/settings";
import { getSkillSlashCommandName, loadSkills, type Skill } from "../../extensibility/skills";
import {
	buildAvailableSlashCommands,
	type InternalAvailableSlashCommand,
} from "../../slash-commands/available-commands";
import {
	BUILTIN_SLASH_COMMANDS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	lookupBuiltinSlashCommand,
	type TuiBuiltinSlashCommand,
} from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../../slash-commands/types";
import {
	RpcRevisionSource,
	type RpcCommandAvailability,
	type RpcProjectCommandDescriptor,
	type RpcProjectCompletionItem,
	type RpcProjectCompletionResult,
	type RpcRevision,
} from "./rpc-project-types";

/** Reusable availability verdicts (frozen shapes, compared by reason string). */
const AVAILABLE: RpcCommandAvailability = { available: true };
const TUI_ONLY: RpcCommandAvailability = { available: false, reason: "tui_only" };
const UNSUPPORTED: RpcCommandAvailability = { available: false, reason: "unsupported" };
const SESSION_REQUIRED: RpcCommandAvailability = { available: false, reason: "session_required" };

/**
 * Builtin commands that are safe to describe (and, for the handler-bearing
 * ones, executable) with zero sessions loaded: process/global settings,
 * help surfaces, auth, marketplace, and project-level info commands. Every
 * other builtin operates on session state and reports
 * `session_required` until a session exists.
 */
const PROJECT_SCOPED_BUILTIN_NAMES = new Set([
	"settings",
	"setup",
	"skills",
	"help",
	"hotkeys",
	"changelog",
	"exit",
	"quit",
	"login",
	"logout",
	"marketplace",
	"plugins",
	"reload-plugins",
	"stats",
	"usage",
	"extensions",
	"tools",
	"resume",
	"session",
	"new",
	"wiki",
	"repo",
]);

/** Wire-error failure carrying the project-mode `invalid_params` code. */
export class RpcCommandCatalogError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "RpcCommandCatalogError";
	}
}

/** Internal catalog row: descriptor fields plus execution-relevant facts. */
export interface RpcCommandCatalogEntry {
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly description?: string;
	readonly inputHint?: string;
	readonly subcommands?: readonly { name: string; description?: string; usage?: string }[];
	readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
	/** true when execution requires a loaded session */
	readonly requiresSession: boolean;
	/** builtin has a non-TUI business handler (handle or handleTui) */
	readonly executable: boolean;
}

/** Session-like input the catalog accepts (passed through verbatim). */
export interface RpcCommandCatalogSession {
	/** buildAvailableSlashCommands-compatible session-like object (optional). */
	readonly session?: object;
}

/** Strict `execute_command` resolution verdict (see {@link RpcCommandCatalogService.resolve}). */
export interface RpcCommandResolution {
	readonly kind: "builtin" | "skill" | "session" | "unknown";
	readonly name?: string;
	/** Canonical unified spec, present for `kind: "builtin"`. */
	readonly spec?: SlashCommandSpec;
	/** Bare skill name (no `skill:` prefix), present for `kind: "skill"`. */
	readonly skillName?: string;
}

export interface RpcCommandCatalogOptions {
	/** Project root the catalog is scoped to (the fixed startup cwd). */
	readonly cwd: string;
	/** Live settings access; `undefined` falls back to setting defaults. */
	readonly getSettings: () => Settings | undefined;
}

/** Cached catalog snapshot: completion rows plus the wire descriptors. */
interface RpcCommandCatalogSnapshot {
	readonly entries: readonly RpcCommandCatalogEntry[];
	readonly descriptors: RpcProjectCommandDescriptor[];
}

/**
 * Score a catalog label (command name or alias) against a typed query.
 * Exact match 1000, prefix 900, substring 700, no match 0 (filtered out).
 * Both sides are compared lowercased; callers pass the raw label.
 */
export function scoreCommandText(text: string, query: string): number {
	const lower = text.toLowerCase();
	if (lower === query) return 1000;
	if (lower.startsWith(query)) return 900;
	if (lower.includes(query)) return 700;
	return 0;
}

/**
 * Builtin availability when a session listing is present: RPC can route
 * `handle`; `handleTui`-only commands are TUI business; a handler-less spec
 * cannot run anywhere.
 */
function builtinSessionAvailability(spec: SlashCommandSpec | undefined): RpcCommandAvailability {
	if (spec?.handle) return AVAILABLE;
	if (spec?.handleTui) return TUI_ONLY;
	return UNSUPPORTED;
}

/** Find the static (runtime-free) TUI builtin materialization by name or alias. */
function findTuiBuiltin(name: string): TuiBuiltinSlashCommand | undefined {
	return BUILTIN_SLASH_COMMANDS.find(
		command => command.name === name || (command.aliases ?? []).some(alias => alias === name),
	);
}

/** Find a catalog row by invocation name or alias (exact match, mirroring dispatcher lookup). */
function findEntryByInvocation(
	entries: readonly RpcCommandCatalogEntry[],
	name: string,
): RpcCommandCatalogEntry | undefined {
	return entries.find(entry => entry.name === name || (entry.aliases ?? []).some(alias => alias === name));
}

/** Project the internal entry onto the wire descriptor shape. */
function descriptorFor(
	entry: RpcCommandCatalogEntry,
	execution: "omp" | "host_action",
	scope: "project" | "session",
	availability: RpcCommandAvailability,
): RpcProjectCommandDescriptor {
	return {
		name: entry.name,
		...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
		...(entry.description ? { description: entry.description } : {}),
		...(entry.inputHint ? { inputHint: entry.inputHint } : {}),
		...(entry.subcommands?.length ? { subcommands: entry.subcommands } : {}),
		source: entry.source,
		execution,
		scope,
		availability,
	};
}

/**
 * Unified `/command` catalog for one RPC project host: descriptor snapshots
 * (`get_available_commands`), dynamic zero-side-effect completion
 * (`complete_command`), and strict resolution for `execute_command`.
 *
 * The catalog is cached until {@link invalidate} is called (settings changes,
 * plugin reloads, skill mutations); every rebuild is observable through the
 * monotonic {@link revision}.
 */
export class RpcCommandCatalogService {
	readonly #cwd: string;
	readonly #getSettings: () => Settings | undefined;
	#snapshot: RpcCommandCatalogSnapshot | undefined;
	readonly #revisions = new RpcRevisionSource("cmd-r0");

	constructor(options: RpcCommandCatalogOptions) {
		this.#cwd = options.cwd;
		this.#getSettings = options.getSettings;
	}

	/** Current catalog revision; bumped by {@link invalidate}, stable across rebuilds. */
	get revision(): RpcRevision {
		return this.#revisions.current;
	}

	/** Drop the cached catalog and announce a new revision (`command_catalog_changed`). */
	invalidate(): void {
		this.#snapshot = undefined;
		this.#revisions.bump();
	}

	/**
	 * Snapshot the catalog as wire descriptors. With a session-like object the
	 * live `buildAvailableSlashCommands` listing is projected (execution "omp",
	 * scope "session"; handler-less builtins stay listed but report
	 * `tui_only`/`unsupported`). Without one, the static project view lists
	 * every builtin — `PROJECT_SCOPED_BUILTIN_NAMES` are project-scoped, the
	 * rest report `session_required` — plus `/skill:<name>` rows from
	 * `loadSkills`, gated by `skills.enableSkillCommands` (default true).
	 */
	async buildCatalog(sessionLike?: RpcCommandCatalogSession["session"]): Promise<RpcProjectCommandDescriptor[]> {
		const snapshot = await this.#ensureSnapshot(sessionLike);
		return snapshot.descriptors;
	}

	/**
	 * Zero-side-effect completion for `complete_command`. Cursor must be an
	 * integer within `0..text.length` (UTF-16 units), else
	 * {@link RpcCommandCatalogError} with code `invalid_params`. Text before
	 * the cursor that does not start with `/` yields no items. A bare
	 * `/prefix` completes command names (and aliases; skills surface as kind
	 * `skill`); `/name arg…` completes builtin arguments through the static
	 * `BUILTIN_SLASH_COMMANDS` materialization, which never needs a runtime.
	 */
	async complete(options: {
		text: string;
		cursor: number;
		sessionLike?: RpcCommandCatalogSession["session"];
	}): Promise<RpcProjectCompletionResult> {
		const { text, cursor, sessionLike } = options;
		if (typeof text !== "string") {
			throw new RpcCommandCatalogError("text must be a string", "invalid_params");
		}
		if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) {
			throw new RpcCommandCatalogError(
				`cursor must be an integer between 0 and text.length (${text.length})`,
				"invalid_params",
			);
		}
		const head = text.slice(0, cursor);
		if (!head.startsWith("/")) return { items: [], revision: this.revision };
		const snapshot = await this.#ensureSnapshot(sessionLike);
		const items = /\s/.test(head.slice(1))
			? await this.#completeArguments(head, snapshot.entries, cursor)
			: this.#completeCommandName(head, snapshot.entries);
		return { items, revision: this.revision };
	}

	/**
	 * Strict resolution for `execute_command`: builtin lookup by name AND
	 * alias wins; a leading `/skill:<name>` token resolves as a skill; anything
	 * else is `unknown`, so the executor can reject instead of letting
	 * unrecognized input fall through to the model.
	 */
	async resolve(text: string, sessionLike?: object): Promise<RpcCommandResolution> {
		const parsed = parseSlashCommand(text);
		if (parsed) {
			const spec = lookupBuiltinSlashCommand(parsed.name);
			if (spec) return { kind: "builtin", name: spec.name, spec };
		}
		if (text.startsWith("/")) {
			const token = text.slice(1).split(/\s/, 1)[0] ?? "";
			if (token.startsWith("skill:")) {
				const skillName = token.slice("skill:".length);
				if (skillName) return { kind: "skill", name: `skill:${skillName}`, skillName };
			}
		}
		if (sessionLike && text.startsWith("/")) {
			const name = text.slice(1).split(/\s/, 1)[0] ?? "";
			const snapshot = await this.#ensureSnapshot(sessionLike);
			const entry = findEntryByInvocation(snapshot.entries, name);
			if (entry) return { kind: "session", name: entry.name };
		}
		return parsed?.name ? { kind: "unknown", name: parsed.name } : { kind: "unknown" };
	}

	async #ensureSnapshot(sessionLike?: object): Promise<RpcCommandCatalogSnapshot> {
		// Session command lists can change independently (extensions, skills,
		// custom commands). Never reuse another session's or the project view.
		if (sessionLike) return this.#buildSessionSnapshot(sessionLike);
		if (!this.#snapshot) {
			this.#snapshot = await this.#buildProjectSnapshot();
		}
		return this.#snapshot;
	}

	/** Live catalog from the session's own available-command listing. */
	async #buildSessionSnapshot(sessionLike: object): Promise<RpcCommandCatalogSnapshot> {
		const available = await buildAvailableSlashCommands(sessionLike as never);
		const entries: RpcCommandCatalogEntry[] = [];
		const descriptors: RpcProjectCommandDescriptor[] = [];
		for (const command of available) {
			const entry = entryFromAvailable(command);
			entries.push(entry);
			descriptors.push(
				descriptorFor(
					entry,
					"omp",
					"session",
					command.source === "builtin"
						? builtinSessionAvailability(lookupBuiltinSlashCommand(command.name))
						: AVAILABLE,
				),
			);
		}
		return { entries, descriptors };
	}

	/** Session-free catalog: full builtin registry (project/session scoped) plus skill commands. */
	async #buildProjectSnapshot(): Promise<RpcCommandCatalogSnapshot> {
		const entries: RpcCommandCatalogEntry[] = [];
		const descriptors: RpcProjectCommandDescriptor[] = [];
		for (const spec of BUILTIN_SLASH_COMMANDS_INTERNAL) {
			const requiresSession = !PROJECT_SCOPED_BUILTIN_NAMES.has(spec.name);
			const hint = spec.acpInputHint ?? spec.inlineHint;
			const entry: RpcCommandCatalogEntry = {
				name: spec.name,
				...(spec.aliases?.length ? { aliases: spec.aliases } : {}),
				description: spec.description,
				...(hint ? { inputHint: hint } : {}),
				...(spec.subcommands?.length ? { subcommands: spec.subcommands } : {}),
				source: "builtin",
				requiresSession,
				executable: Boolean(spec.handle ?? spec.handleTui),
			};
			entries.push(entry);
			descriptors.push(
				descriptorFor(
					entry,
					"omp",
					requiresSession ? "session" : "project",
					requiresSession ? SESSION_REQUIRED : builtinSessionAvailability(spec),
				),
			);
		}
		for (const skill of await this.#loadSkillCommands()) {
			const entry: RpcCommandCatalogEntry = {
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				inputHint: "arguments",
				source: "skill",
				requiresSession: true,
				executable: true,
			};
			entries.push(entry);
			descriptors.push(descriptorFor(entry, "omp", "session", SESSION_REQUIRED));
		}
		return { entries, descriptors };
	}

	/** Skills as `/skill:<name>` commands; empty when skills or skill commands are disabled. */
	async #loadSkillCommands(): Promise<Skill[]> {
		const skillsSettings = this.#skillsSettings();
		if (skillsSettings.enableSkillCommands === false) return [];
		const { skills } = await loadSkills({ ...skillsSettings, cwd: this.#cwd });
		return skills;
	}

	#skillsSettings(): SkillsSettings {
		const settings = this.#getSettings();
		return settings ? cfgSkills.get(settings) : {};
	}

	/** Command-NAME completion over catalog names, aliases, and skill rows. */
	#completeCommandName(head: string, entries: readonly RpcCommandCatalogEntry[]): RpcProjectCompletionItem[] {
		const query = head.slice(1).toLowerCase();
		const scored: Array<{ score: number; item: RpcProjectCompletionItem }> = [];
		for (const entry of entries) {
			const kind = entry.source === "skill" ? "skill" : "command";
			const score = scoreCommandText(entry.name, query);
			if (score > 0) {
				scored.push({
					score,
					item: {
						label: entry.name,
						insertText: `/${entry.name} `,
						replaceStart: 0,
						replaceEnd: head.length,
						kind,
						...(entry.description ? { description: entry.description } : {}),
						...(entry.inputHint ? { hint: entry.inputHint } : {}),
					},
				});
			}
			for (const alias of entry.aliases ?? []) {
				const aliasScore = scoreCommandText(alias, query);
				if (aliasScore <= 0) continue;
				scored.push({
					score: aliasScore,
					item: {
						label: alias,
						insertText: `/${alias} `,
						replaceStart: 0,
						replaceEnd: head.length,
						kind: "command",
						...(entry.description ? { description: entry.description } : {}),
						...(entry.inputHint ? { hint: entry.inputHint } : {}),
					},
				});
			}
		}
		scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
		return scored.map(candidates => candidates.item);
	}

	/**
	 * ARGUMENT completion via the static builtin materialization. Requires a
	 * catalog row for the invocation AND a runtime-free
	 * `getArgumentCompletions` on the materialized builtin (subcommand-bearing
	 * commands except runtime-backed `/mcp`, plus `/move`); everything else —
	 * including skills, file/extension/custom commands, and `allowArgs: false`
	 * builtins — completes nothing.
	 */
	async #completeArguments(
		head: string,
		entries: readonly RpcCommandCatalogEntry[],
		cursor: number,
	): Promise<RpcProjectCompletionItem[]> {
		const parsed = parseSlashCommand(head);
		if (!parsed) return [];
		if (!findEntryByInvocation(entries, parsed.name)) return [];
		const builtin = findTuiBuiltin(parsed.name);
		if (!builtin?.getArgumentCompletions || builtin.allowArgs !== true) return [];
		const result = builtin.getArgumentCompletions(parsed.args);
		const items: readonly AutocompleteItem[] = (Array.isArray(result) ? result : await result) ?? [];
		return items.map((item: AutocompleteItem) => ({
			label: item.label,
			insertText: item.value,
			replaceStart: cursor - parsed.args.length,
			replaceEnd: cursor,
			kind: "argument" as const,
			...(item.description ? { description: item.description } : {}),
			...(item.hint ? { hint: item.hint } : {}),
		}));
	}
}

/**
 * Catalog row from a live `InternalAvailableSlashCommand`, cross-referencing
 * the builtin registry for handler presence.
 */
function entryFromAvailable(command: InternalAvailableSlashCommand): RpcCommandCatalogEntry {
	const spec = command.source === "builtin" ? lookupBuiltinSlashCommand(command.name) : undefined;
	return {
		name: command.name,
		...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
		...(command.description ? { description: command.description } : {}),
		...(command.input?.hint ? { inputHint: command.input.hint } : {}),
		...(command.subcommands?.length ? { subcommands: command.subcommands } : {}),
		source: command.source,
		requiresSession: command.source === "builtin" ? !PROJECT_SCOPED_BUILTIN_NAMES.has(command.name) : true,
		executable: spec ? Boolean(spec.handle ?? spec.handleTui) : true,
	};
}
