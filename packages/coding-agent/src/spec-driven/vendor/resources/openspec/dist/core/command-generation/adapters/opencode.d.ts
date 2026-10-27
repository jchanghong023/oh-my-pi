/**
 * OpenCode Command Adapter
 *
 * Formats commands for OpenCode following its frontmatter specification.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * OpenCode adapter for command generation.
 * File path: .opencode/commands/opsx-<id>.md
 * Frontmatter: description. $ARGUMENTS is injected after the complete input
 * contract because OpenCode only passes arguments through explicit placeholders.
 */
export declare const opencodeAdapter: ToolCommandAdapter;
//# sourceMappingURL=opencode.d.ts.map