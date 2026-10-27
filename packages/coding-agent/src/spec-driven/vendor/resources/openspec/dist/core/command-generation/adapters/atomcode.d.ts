/**
 * AtomCode Command Adapter
 *
 * Formats project commands for AtomCode.
 * https://github.com/atomgit-atomcode/atomcode#custom-commands
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * AtomCode adapter for command generation.
 * File path: .atomcode/commands/opsx-<id>.md
 * Frontmatter: name, description, args
 *
 * AtomCode's custom-command parser reads name and args literally without YAML
 * unquoting, so these controlled identifiers must stay unquoted.
 * The command name matches the filename.
 *
 * `args` mirrors what the workflow actually accepts. AtomCode executes an
 * `args: none` command straight from the slash menu, while `optional` completes
 * to `/name ` and waits for a second Enter. Advertising arguments a workflow
 * never reads would cost every user that extra keystroke, so only workflows
 * carrying an `**Input**:` contract declare `optional` and receive $ARGUMENTS.
 */
export declare const atomcodeAdapter: ToolCommandAdapter;
//# sourceMappingURL=atomcode.d.ts.map