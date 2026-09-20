/**
 * Composer completion for the browser guest.
 *
 * Two sources share one list: the `/…` palette the host advertised for this
 * session, and — for the commands whose argument is a directory — the host's
 * own filesystem listing. Pure and synchronous: the Composer renders the
 * returned items and applies `insert` on accept, so the menu and the keyboard
 * path can never disagree about what a candidate means.
 */
import type { CollabCommandInfo, CollabDirEntry } from "@oh-my-pi/pi-wire";

export interface CompletionItem {
	/** Stable identity: React key and highlight target. */
	key: string;
	/** Menu row text, e.g. `/move` or `src/`. */
	label: string;
	/** Dim trailing hint, e.g. `[<path>]`. */
	hint?: string;
	/** Secondary line: command description or the full directory path. */
	description?: string;
	/** Short source badge, e.g. `skill`. */
	badge?: string;
	/** Replacement for the whole composer text when the item is accepted. */
	insert: string;
}

/** Commands whose first argument is a host directory. */
const DIRECTORY_ARGUMENT_COMMANDS: Record<string, true> = { move: true, "add-dir": true };
const DIRECTORY_ARGUMENT_RE = /^\/([^\s]+)\s+(\S*)$/;
const MAX_ITEMS = 8;

/**
 * The directory argument of `text` (`/move <prefix>`, `/add-dir <prefix>`), or
 * `null` when `text` is not one. `prefix` is what the host should search from.
 */
export function directoryArgument(text: string): { command: string; prefix: string } | null {
	const match = DIRECTORY_ARGUMENT_RE.exec(text);
	if (!match) return null;
	const command = match[1];
	if (DIRECTORY_ARGUMENT_COMMANDS[command] !== true) return null;
	return { command, prefix: match[2] ?? "" };
}

/**
 * Candidates for the current composer text. `dirs` are the host's answers for
 * the current directory prefix (empty while a request is in flight or when the
 * host cannot answer).
 */
export function completionItems(
	text: string,
	commands: readonly CollabCommandInfo[],
	dirs: readonly CollabDirEntry[],
): readonly CompletionItem[] {
	const directory = directoryArgument(text);
	if (directory) {
		return dirs.slice(0, MAX_ITEMS).map(entry => ({
			key: entry.path,
			label: entry.label,
			description: entry.path,
			insert: `/${directory.command} ${entry.path}`,
		}));
	}
	// Only the command name completes; once a space follows, arguments are the
	// guest's own text.
	if (!text.startsWith("/") || text.includes(" ")) return [];
	const query = text.toLowerCase();
	return commands
		.filter(
			command =>
				`/${command.name}`.toLowerCase().startsWith(query) ||
				(command.aliases ?? []).some(alias => `/${alias}`.toLowerCase().startsWith(query)),
		)
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_ITEMS)
		.map(command => ({
			key: command.name,
			label: `/${command.name}`,
			hint: command.input?.hint,
			description: command.description,
			badge: command.name.startsWith("skill:") ? "skill" : undefined,
			// Trailing space so arguments can follow immediately.
			insert: `/${command.name} `,
		}));
}
