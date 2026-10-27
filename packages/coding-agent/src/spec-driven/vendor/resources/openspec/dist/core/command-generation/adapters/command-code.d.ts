/**
 * Command Code Command Adapter
 *
 * Command Code reads custom slash commands from `.commandcode/commands/`. The
 * command name is the markdown filename without its `.md` extension, so
 * `opsx-<id>.md` registers `/opsx-<id>` — the same flat naming Cursor and
 * OpenCode use. See https://commandcode.ai/docs/reference/slash-commands.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Command Code adapter for command generation.
 * File path: .commandcode/commands/opsx-<id>.md
 * Format: plain Markdown with $ARGUMENTS injected after the input contract
 *
 * Command Code executes the full trimmed file body and substitutes invocation
 * arguments only where the body includes one of its argument placeholders.
 */
export declare const commandCodeAdapter: ToolCommandAdapter;
//# sourceMappingURL=command-code.d.ts.map