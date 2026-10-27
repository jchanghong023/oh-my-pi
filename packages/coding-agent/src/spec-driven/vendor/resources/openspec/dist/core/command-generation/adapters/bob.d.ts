/**
 * Bob Shell Command Adapter
 *
 * Formats commands for Bob Shell following its markdown specification.
 * Commands are stored in .bob/commands/ directory.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Bob Shell adapter for command generation.
 * File path: .bob/commands/opsx-<id>.md
 * Frontmatter: description
 *
 * Bob uses the filename (minus .md) as the slash command name, so
 * opsx-propose.md → /opsx-propose. generateCommand rewrites the body's
 * command references to that form before this adapter formats it.
 */
export declare const bobAdapter: ToolCommandAdapter;
//# sourceMappingURL=bob.d.ts.map