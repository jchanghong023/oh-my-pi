/**
 * Command catalog + dynamic completion engine for the fork RPC surface
 * (rpc-ui-protocol.md).
 *
 * `RpcForkCommandCatalogService` snapshots the live session's `/command`
 * catalog via `buildAvailableSlashCommands` (descriptors carry an execution
 * verdict so terminal-only commands report themselves instead of failing at
 * dispatch), `complete` produces side-effect-free command-name and argument
 * completions, and `resolve` classifies a command line as builtin / skill /
 * unknown so a client can decide how to dispatch it.
 *
 * Argument completions come from the runtime-free static materialization in
 * `builtin-registry.ts` (`BUILTIN_SLASH_COMMANDS`), so completion never
 * constructs a TUI runtime and never prompts, writes, or executes anything;
 * beyond the stock available-commands listing (which refreshes the session's
 * file-command cache via `setSlashCommands`), the only state this service
 * tracks is its previous session key and revision.
 */
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import type { AgentSession } from "../../session/agent-session";
import type { MCPManager } from "../../mcp";
import {
	buildDirectoryArgumentCompletions,
	buildEffortArgumentCompletions,
	buildMcpArgumentCompletions,
	buildModelSelectorCompletions,
} from "../../slash-commands/builtin-completions";
import { getSkillSlashCommandName } from "../../extensibility/skills";
import {
	buildAvailableSlashCommands,
	type InternalAvailableSlashCommand,
} from "../../slash-commands/available-commands";
import {
	BUILTIN_SLASH_COMMANDS,
	lookupBuiltinSlashCommand,
	type TuiBuiltinSlashCommand,
} from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../../slash-commands/types";
import {
	RpcRevisionSource,
	type RpcCommandAvailability,
	type RpcCommandDescriptor,
	type RpcCompleteCommandResult,
	type RpcCompletionItem,
	type RpcCompletionKind,
	type RpcForkErrorCode,
} from "./rpc-fork-types";

/** Reusable availability verdicts (frozen shapes, compared by reason string). */
const AVAILABLE: RpcCommandAvailability = { available: true };
const TUI_ONLY: RpcCommandAvailability = { available: false, reason: "tui_only" };
const UNSUPPORTED: RpcCommandAvailability = { available: false, reason: "unsupported" };

/** Wire-error failure carrying an `invalid_params` code. */
export class RpcCommandCatalogError extends Error {
	constructor(
		message: string,
		readonly code: RpcForkErrorCode,
	) {
		super(message);
		this.name = "RpcCommandCatalogError";
	}
}

/** Internal catalog row: descriptor fields plus execution-relevant facts. */
interface RpcCommandCatalogEntry {
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly description?: string;
	readonly inputHint?: string;
	readonly subcommands?: readonly { name: string; description?: string; usage?: string }[];
	readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
	/** true when only a TUI runtime can run it. */
	readonly tuiOnly: boolean;
}

/** Strict resolution verdict (see {@link RpcForkCommandCatalogService.resolve}). */
export interface RpcCommandResolution {
	readonly kind: "builtin" | "skill" | "unknown";
	readonly name?: string;
	/** Canonical unified spec, present for `kind: "builtin"`. */
	readonly spec?: SlashCommandSpec;
	/** Bare skill name (no `skill:` prefix), present for `kind: "skill"`. */
	readonly skillName?: string;
}

export interface RpcCommandCatalogOptions {
	/** Project root the catalog is scoped to (the startup cwd). */
	readonly cwd: string;
	/** Actual owning runtime manager; absent when MCP is disabled. */
	readonly getMcpManager?: (session: object) => MCPManager | undefined;
}

/** One catalog snapshot: completion rows plus the wire descriptors. */
interface RpcCommandCatalogSnapshot {
	readonly entries: readonly RpcCommandCatalogEntry[];
	readonly descriptors: RpcCommandDescriptor[];
}

/**
 * Score a catalog label (command name or alias) against a typed query.
 * Exact match 1000, prefix 900, substring 700, no match 0 (filtered out).
 * Both sides are compared lowercased; callers pass the raw label.
 */
export function scoreCommandText(text: string, query: string): number {
	const lower = text.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lower === lowerQuery) return 1000;
	if (lower.startsWith(lowerQuery)) return 900;
	if (lower.includes(lowerQuery)) return 700;
	return 0;
}

/**
 * Builtin availability: RPC can route `handle`; `handleTui`-only commands are
 * terminal business; a handler-less spec cannot run anywhere.
 */
function builtinAvailability(spec: SlashCommandSpec | undefined): RpcCommandAvailability {
	if (spec?.handleRpc || spec?.handle) return AVAILABLE;
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
function descriptorFor(entry: RpcCommandCatalogEntry, availability: RpcCommandAvailability): RpcCommandDescriptor {
	return {
		name: entry.name,
		...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
		...(entry.description ? { description: entry.description } : {}),
		...(entry.inputHint ? { inputHint: entry.inputHint } : {}),
		...(entry.subcommands?.length ? { subcommands: entry.subcommands } : {}),
		source: entry.source,
		execution: entry.tuiOnly ? "tui" : "omp",
		availability,
	};
}

/**
 * Unified `/command` catalog for one RPC session: descriptor snapshots
 * (`get_available_commands` under v3), dynamic zero-side-effect completion
 * (`complete_command`), and strict resolution for clients that dispatch
 * commands themselves.
 *
 * Every call re-snapshots the live listing (like the stock RPC
 * `get_available_commands` path) and re-derives the session key from it
 * (settings, plugins, skill mutations feed the key); a changed key bumps the
 * monotonic {@link revision}, so clients detect drift by comparing revisions
 * between listings — there is no push notification, and nothing is retained
 * between calls except the previous key.
 */
export class RpcForkCommandCatalogService {
	readonly #cwd: string;
	readonly #getMcpManager: ((session: object) => MCPManager | undefined) | undefined;
	#sessionKey: string | undefined;
	readonly #revisions = new RpcRevisionSource("cmd-r0");

	constructor(options: RpcCommandCatalogOptions) {
		this.#cwd = options.cwd;
		this.#getMcpManager = options.getMcpManager;
	}

	/** Current catalog revision; bumps when a rebuild sees a changed session key. */
	get revision(): string {
		return this.#revisions.current;
	}

	/**
	 * Snapshot the catalog as wire descriptors from the session's live
	 * `buildAvailableSlashCommands` listing (handler-less builtins stay listed
	 * but report `tui_only`/`unsupported`).
	 */
	async buildCatalog(session?: object): Promise<RpcCommandDescriptor[]> {
		if (!session) return [];
		const snapshot = await this.#ensureSnapshot(session);
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
	async complete(options: { text: string; cursor: number; session?: object }): Promise<RpcCompleteCommandResult> {
		const { text, cursor, session } = options;
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
		const snapshot = session ? await this.#ensureSnapshot(session) : { entries: [] as RpcCommandCatalogEntry[] };
		const items = /\s/.test(head.slice(1))
			? await this.#completeArguments(head, text, snapshot.entries, cursor, session)
			: this.#completeCommandName(head, text, snapshot.entries);
		return { items, revision: this.revision };
	}

	/**
	 * Strict resolution: builtin lookup by name AND alias wins; a leading
	 * `/skill:<name>` token resolves as a skill; anything else is `unknown`,
	 * so the caller can decide how to dispatch instead of letting
	 * unrecognized input silently fall through to the model.
	 */
	async resolve(text: string, session?: object): Promise<RpcCommandResolution> {
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
				const sessionLike = session as Partial<Pick<AgentSession, "skills" | "skillsSettings">> | undefined;
				if (
					skillName &&
					sessionLike?.skillsSettings?.enableSkillCommands &&
					sessionLike.skills?.some(skill => getSkillSlashCommandName(skill) === token)
				) {
					return { kind: "skill", name: token, skillName };
				}
			}
		}
		return parsed?.name ? { kind: "unknown", name: parsed.name } : { kind: "unknown" };
	}

	async #ensureSnapshot(sessionLike: object): Promise<RpcCommandCatalogSnapshot> {
		const snapshot = await this.#buildSessionSnapshot(sessionLike);
		const key = JSON.stringify(snapshot.descriptors);
		if (this.#sessionKey !== undefined && this.#sessionKey !== key) this.#revisions.bump();
		this.#sessionKey = key;
		return snapshot;
	}

	/** Live catalog from the session's own available-command listing. */
	async #buildSessionSnapshot(sessionLike: object): Promise<RpcCommandCatalogSnapshot> {
		const available = await buildAvailableSlashCommands(sessionLike as never, undefined, {
			includeTuiOnlyBuiltins: true,
			includeRpcBuiltins: true,
		});
		const entries: RpcCommandCatalogEntry[] = [];
		const descriptors: RpcCommandDescriptor[] = [];
		for (const command of available) {
			const entry = entryFromAvailable(command);
			entries.push(entry);
			descriptors.push(
				descriptorFor(
					entry,
					command.source === "builtin" ? builtinAvailability(lookupBuiltinSlashCommand(command.name)) : AVAILABLE,
				),
			);
		}
		return { entries, descriptors };
	}

	/** Command-NAME completion over catalog names, aliases, and skill rows. */
	#completeCommandName(head: string, text: string, entries: readonly RpcCommandCatalogEntry[]): RpcCompletionItem[] {
		const query = head.slice(1).toLowerCase();
		const tokenEnd = text.search(/\s/) < 0 ? text.length : text.search(/\s/);
		const scored: Array<{ score: number; item: RpcCompletionItem }> = [];
		const pushCandidate = (
			entry: RpcCommandCatalogEntry,
			label: string,
			score: number,
			kind: RpcCompletionKind,
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
	): Promise<RpcCompletionItem[]> {
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
		const cwd = session?.sessionManager.getCwd() ?? this.#cwd;
		let complete = builtin.getArgumentCompletions;
		if (builtin.name === "mcp") {
			complete = buildMcpArgumentCompletions(
				builtin.subcommands ?? [],
				{
					ctx: { mcpManager: sessionLike ? this.#getMcpManager?.(sessionLike) : undefined },
				},
				cwd,
			);
		} else if (builtin.name === "move") {
			complete = buildDirectoryArgumentCompletions(cwd);
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
		// /move consumes the entire argument as one path, including unquoted
		// spaces; preserving a whitespace-delimited suffix would duplicate it.
		let replaceEnd = builtin.name === "move" ? text.length : cursor;
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
	const spec = command.source === "builtin" ? lookupBuiltinSlashCommand(command.name) : undefined;
	return {
		name: command.name,
		...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
		...(command.description ? { description: command.description } : {}),
		...(command.input?.hint ? { inputHint: command.input.hint } : {}),
		...(command.subcommands?.length ? { subcommands: command.subcommands } : {}),
		source: command.source,
		tuiOnly: spec !== undefined && !spec.handleRpc && !spec.handle && spec.handleTui !== undefined,
	};
}
