import { lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "./types";

export type { AcpBuiltinSlashCommandResult } from "./types";

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no builtin matched (or matched a TUI-only entry, or the match
 *   disallows arguments in ACP while the invocation carries them); the caller
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
	// ACP may accept text arguments even when the TUI handler opens a picker
	// instead (for example, /model). Preserve the normal allowArgs gate unless
	// the spec explicitly overrides it for ACP.
	if (parsed.args.length > 0 && !(command.acpAllowArgs ?? command.allowArgs)) return false;
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
