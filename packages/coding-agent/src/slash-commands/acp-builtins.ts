import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "./types";

export type { AcpBuiltinSlashCommandResult } from "./types";

// Read the registry on demand: it can import this module via the RPC host.
let reservedNames: ReadonlySet<string> | undefined;

/** Primary names and aliases reserved by ACP builtins with a text handler. */
export function acpBuiltinReservedNames(): ReadonlySet<string> {
	return (reservedNames ??= new Set(
		BUILTIN_SLASH_COMMANDS_INTERNAL.filter(c => c.handle !== undefined).flatMap(c => [c.name, ...(c.aliases ?? [])]),
	));
}

/** ACP dispatch treats `:` as an argument separator, so a reserved prefix shadows the full name. */
export function isAcpBuiltinShadowedName(name: string): boolean {
	const reserved = acpBuiltinReservedNames();
	if (reserved.has(name)) return true;
	const colon = name.indexOf(":");
	return colon !== -1 && reserved.has(name.slice(0, colon));
}

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no builtin matched (or matched a TUI-only entry); the caller
 *   should forward the input as a prompt.
 * - `{ consumed: true }` when the command handled the input entirely.
 * - `{ prompt }` when the command was handled but a residual prompt should be
 *   sent to the model.
 */
export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) return false;
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
