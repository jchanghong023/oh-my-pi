/**
 * Unified command catalog + dynamic completion engine for RPC project mode
 * (rpc-ui-protocol.md).
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
import type { AgentSession } from "../../session/agent-session";
import type { MCPManager } from "../../mcp";
import {
	buildDirectoryArgumentCompletions,
	buildEffortArgumentCompletions,
	buildMcpArgumentCompletions,
	buildModelSelectorCompletions,
} from "../../slash-commands/builtin-completions";
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
	type RpcProjectCompletionKind,
	type RpcProjectCompletionResult,
	type RpcRevision,
} from "./rpc-project-types";

/** Reusable availability verdicts (frozen shapes, compared by reason string). */
const AVAILABLE: RpcCommandAvailability = { available: true };
const UNAVAILABLE_BUSINESS: RpcCommandAvailability = { available: false, reason: "omp_handler_unavailable" };
const UNSUPPORTED: RpcCommandAvailability = { available: false, reason: "unsupported" };
const SESSION_REQUIRED: RpcCommandAvailability = { available: false, reason: "session_required" };

/** Commands implemented by project orchestration, rather than a TUI runtime. */
const PROJECT_SCOPED_BUILTIN_NAMES: Readonly<Record<string, true>> = {
	new: true,
	resume: true,
	settings: true,
	setup: true,
	hotkeys: true,
	wiki: true,
	repo: true,
	git: true,
	exit: true,
	quit: true,
	restart: true,
	record: true,
	move: true,
};

/** Pure presentation/project-switch actions; business handlers are never replaced by these. */
const RPC_PROJECT_HOST_ACTIONS: Readonly<Record<string, string | undefined>> = {
	hotkeys: "show_shortcuts",
	extensions: "open_extensions",
	agents: "open_agents",
	wiki: "open_wiki",
	repo: "open_repository",
	git: "open_git",
	tree: "select_session_branch",
	branch: "select_branch_message",
	fork: "select_fork_message",
	debug: "open_debug_tools",
	exit: "close_view",
	quit: "close_view",
	restart: "restart_project",
	record: "toggle_recording",
	move: "open_project",
};
export function getRpcProjectHostAction(name: string): string | undefined {
	return Object.hasOwn(RPC_PROJECT_HOST_ACTIONS, name) ? RPC_PROJECT_HOST_ACTIONS[name] : undefined;
}
const PROJECT_ROUTED_BUSINESS: Readonly<Record<string, true>> = { new: true, resume: true };

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
	/** Actual owning runtime manager; absent in zero-session or MCP-disabled catalogs. */
	readonly getMcpManager?: (session: object) => MCPManager | undefined;
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
	if (spec?.name === "wt") return { available: false, reason: "project_root_fixed" };
	if (
		spec?.handle ||
		(spec && (getRpcProjectHostAction(spec.name) !== undefined || PROJECT_ROUTED_BUSINESS[spec.name] === true))
	)
		return AVAILABLE;
	if (spec?.handleTui) return UNAVAILABLE_BUSINESS;
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
	readonly #getMcpManager: ((session: object) => MCPManager | undefined) | undefined;
	#projectKey: string | undefined;
	#sessionKeys = new WeakMap<object, string>();
	readonly #revisions = new RpcRevisionSource("cmd-r0");

	constructor(options: RpcCommandCatalogOptions) {
		this.#cwd = options.cwd;
		this.#getSettings = options.getSettings;
		this.#getMcpManager = options.getMcpManager;
	}

	/** Current catalog revision; bumped by {@link invalidate}, stable across rebuilds. */
	get revision(): RpcRevision {
		return this.#revisions.current;
	}

	/** Drop the cached catalog and announce a new revision (`command_catalog_changed`). */
	invalidate(): void {
		this.#projectKey = undefined;
		this.#sessionKeys = new WeakMap();
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
			? await this.#completeArguments(head, text, snapshot.entries, cursor, sessionLike)
			: this.#completeCommandName(head, text, snapshot.entries);
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
			if (spec) {
				if (parsed.args && !(spec.acpAllowArgs ?? spec.allowArgs)) return { kind: "unknown", name: parsed.name };
				return { kind: "builtin", name: spec.name, spec };
			}
		}
		if (text.startsWith("/")) {
			const token = text.slice(1).split(/\s/, 1)[0] ?? "";
			if (token.startsWith("skill:")) {
				const skillName = token.slice("skill:".length);
				const session = sessionLike as Partial<Pick<AgentSession, "skills" | "skillsSettings">> | undefined;
				if (
					skillName &&
					session?.skillsSettings?.enableSkillCommands &&
					session.skills?.some(skill => getSkillSlashCommandName(skill) === token)
				) {
					return { kind: "skill", name: token, skillName };
				}
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
		const snapshot = sessionLike ? await this.#buildSessionSnapshot(sessionLike) : await this.#buildProjectSnapshot();
		const key = JSON.stringify(snapshot.descriptors);
		const previous = sessionLike ? this.#sessionKeys.get(sessionLike) : this.#projectKey;
		if (previous !== undefined && previous !== key) this.#revisions.bump();
		if (sessionLike) this.#sessionKeys.set(sessionLike, key);
		else this.#projectKey = key;
		return snapshot;
	}

	/** Live catalog from the session's own available-command listing. */
	async #buildSessionSnapshot(sessionLike: object): Promise<RpcCommandCatalogSnapshot> {
		const available = await buildAvailableSlashCommands(sessionLike as never, undefined, {
			includeTuiOnlyBuiltins: true,
		});
		const entries: RpcCommandCatalogEntry[] = [];
		const descriptors: RpcProjectCommandDescriptor[] = [];
		for (const command of available) {
			const entry = entryFromAvailable(command);
			entries.push(entry);
			descriptors.push(
				descriptorFor(
					entry,
					command.source === "builtin" &&
						getRpcProjectHostAction(command.name) !== undefined &&
						!lookupBuiltinSlashCommand(command.name)?.handle
						? "host_action"
						: "omp",
					entry.requiresSession ? "session" : "project",
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
			const requiresSession = PROJECT_SCOPED_BUILTIN_NAMES[spec.name] !== true;
			const hint = spec.acpInputHint ?? spec.inlineHint;
			const entry: RpcCommandCatalogEntry = {
				name: spec.name,
				...(spec.aliases?.length ? { aliases: spec.aliases } : {}),
				description: spec.description,
				...(hint ? { inputHint: hint } : {}),
				...(spec.subcommands?.length ? { subcommands: spec.subcommands } : {}),
				source: "builtin",
				requiresSession,
			};
			entries.push(entry);
			descriptors.push(
				descriptorFor(
					entry,
					getRpcProjectHostAction(spec.name) !== undefined && !spec.handle ? "host_action" : "omp",
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
	#completeCommandName(
		head: string,
		text: string,
		entries: readonly RpcCommandCatalogEntry[],
	): RpcProjectCompletionItem[] {
		const query = head.slice(1).toLowerCase();
		const tokenEnd = text.search(/\s/) < 0 ? text.length : text.search(/\s/);
		const scored: Array<{ score: number; item: RpcProjectCompletionItem }> = [];
		const pushCandidate = (
			entry: RpcCommandCatalogEntry,
			label: string,
			score: number,
			kind: RpcProjectCompletionKind,
		): void => {
			if (score <= 0) return;
			scored.push({
				score,
				item: {
					label,
					insertText: `/${label}${tokenEnd === text.length ? " " : ""}`,
					replaceStart: 0,
					replaceEnd: tokenEnd,
					kind,
					...(entry.description ? { description: entry.description } : {}),
					...(entry.inputHint ? { hint: entry.inputHint } : {}),
				},
			});
		};
		for (const entry of entries) {
			pushCandidate(
				entry,
				entry.name,
				scoreCommandText(entry.name, query),
				entry.source === "skill" ? "skill" : "command",
			);
			for (const alias of entry.aliases ?? []) {
				pushCandidate(entry, alias, scoreCommandText(alias, query), "command");
			}
		}
		scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
		return scored.map(candidates => candidates.item);
	}

	/** Reuse OMP argument completers with the real session/MCP metadata and cwd. */
	async #completeArguments(
		head: string,
		text: string,
		entries: readonly RpcCommandCatalogEntry[],
		cursor: number,
		sessionLike: object | undefined,
	): Promise<RpcProjectCompletionItem[]> {
		const invocation = /^\/([^\s]+)\s+/.exec(head);
		if (!invocation) return [];
		const name = invocation[1]!;
		if (!findEntryByInvocation(entries, name)) return [];
		const builtin = findTuiBuiltin(name);
		const spec = lookupBuiltinSlashCommand(name);
		if (!builtin || !spec || (spec.acpAllowArgs ?? spec.allowArgs) !== true) return [];
		const argumentStart = invocation[0].length;
		const prefix = head.slice(argumentStart);
		const session = sessionLike as AgentSession | undefined;
		let complete = builtin.getArgumentCompletions;
		if (builtin.name === "mcp") {
			complete = buildMcpArgumentCompletions(
				builtin.subcommands ?? [],
				{
					ctx: { mcpManager: sessionLike ? this.#getMcpManager?.(sessionLike) : undefined },
				},
				this.#cwd,
			);
		} else if (builtin.name === "move") {
			complete = buildDirectoryArgumentCompletions(this.#cwd);
		} else if (session && builtin.name === "effort") {
			complete = buildEffortArgumentCompletions({ ctx: { session } });
		} else if (session && (builtin.name === "switch" || builtin.name === "model")) {
			complete = buildModelSelectorCompletions({ ctx: { session, settings: session.settings } });
		}
		if (!complete) return [];
		const result = complete(prefix);
		const items: readonly AutocompleteItem[] = (Array.isArray(result) ? result : await result) ?? [];
		// Complete through the current token's suffix, including quoted spaces.
		let quote: string | undefined;
		let escaped = false;
		for (let index = argumentStart; index < cursor; index++) {
			const char = text[index]!;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (quote === char) quote = undefined;
			else if (!quote && (char === '"' || char === "'")) quote = char;
		}
		let replaceEnd = cursor;
		for (; replaceEnd < text.length; replaceEnd++) {
			const char = text[replaceEnd]!;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (!quote && /\s/.test(char)) break;
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (quote === char) quote = undefined;
			else if (!quote && (char === '"' || char === "'")) quote = char;
		}
		return items.map((item: AutocompleteItem) => ({
			label: item.label,
			insertText: /\s/.test(text[replaceEnd] ?? "") ? item.value.trimEnd() : item.value,
			replaceStart: argumentStart,
			replaceEnd,
			kind: "argument" as const,
			...(item.description ? { description: item.description } : {}),
			...(item.hint ? { hint: item.hint } : {}),
		}));
	}
}

/** Catalog row from a live `InternalAvailableSlashCommand`. */
function entryFromAvailable(command: InternalAvailableSlashCommand): RpcCommandCatalogEntry {
	return {
		name: command.name,
		...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
		...(command.description ? { description: command.description } : {}),
		...(command.input?.hint ? { inputHint: command.input.hint } : {}),
		...(command.subcommands?.length ? { subcommands: command.subcommands } : {}),
		source: command.source,
		requiresSession: command.source === "builtin" ? PROJECT_SCOPED_BUILTIN_NAMES[command.name] !== true : true,
	};
}
