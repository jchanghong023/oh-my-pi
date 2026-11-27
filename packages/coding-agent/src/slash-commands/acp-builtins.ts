import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand, usage } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "./types";

export type { AcpBuiltinSlashCommandResult } from "./types";

const TUI_ONLY_REFUSED_NAMES: ReadonlySet<string> = new Set(["collab2", "todoloop"]);

/**
 * All names (primary + aliases) reserved by ACP builtins with text handlers.
 * Used to filter out extensions that would shadow a builtin or its alias at
 * dispatch time (e.g. `models` is an alias for `/model`, so an extension
 * registering `models` would appear in the palette but execute the builtin).
 */
export const ACP_BUILTIN_RESERVED_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMANDS_INTERNAL.filter(c => c.handle !== undefined).flatMap(c => [c.name, ...(c.aliases ?? [])]),
);

/**
 * Whether an extension command named `name` would be captured by ACP builtin
 * dispatch before reaching the extension handler. Beyond exact name/alias
 * collisions, `parseSlashCommand` treats `:` as a name/args separator, so a
 * colon-namespaced name whose prefix is a handled builtin (e.g. `model:foo`)
 * executes the `/model` builtin with `foo` as args. Such names must not be
 * advertised to ACP clients.
 */
export function isAcpBuiltinShadowedName(name: string): boolean {
	if (TUI_ONLY_REFUSED_NAMES.has(name) || ACP_BUILTIN_RESERVED_NAMES.has(name)) return true;
	const colon = name.indexOf(":");
	if (colon === -1) return false;
	const prefix = name.slice(0, colon);
	return TUI_ONLY_REFUSED_NAMES.has(prefix) || ACP_BUILTIN_RESERVED_NAMES.has(prefix);
}

/**
 * Commands advertised to ACP clients. Entries without a text-mode `handle`
 * (e.g. `/quit`, `/login`, dashboards) are filtered out so the client doesn't
 * see commands it cannot drive.
 */
export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
	command => command.handle !== undefined,
).map(command => {
	// Honor mode-specific copy: ACP clients receive concise text-mode
	// descriptions/hints when the spec sets `acpDescription` / `acpInputHint`,
	// otherwise fall back to the unified `description` / `inlineHint`.
	const hint = command.acpInputHint ?? command.inlineHint;
	return {
		name: command.name,
		description: command.acpDescription ?? command.description,
		input: hint ? { hint } : undefined,
	};
});

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no text-mode builtin matched; the caller should forward
 *   the input as a prompt. Credential-bearing or explicitly refused TUI commands are consumed locally.
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
	if (TUI_ONLY_REFUSED_NAMES.has(parsed.name)) {
		return (await usage(`/${parsed.name} is only supported in the TUI.`, runtime)) ?? { consumed: true };
	}
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) return false;
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
