/**
 * Cursor Command Adapter
 *
 * Formats commands for Cursor following its frontmatter specification.
 * Cursor uses a different frontmatter format and file naming convention.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Cursor adapter for command generation.
 * File path: .cursor/commands/opsx-<id>.md
 * Frontmatter: name (as /opsx-<id>), id, category, description
 */
export declare const cursorAdapter: ToolCommandAdapter;
//# sourceMappingURL=cursor.d.ts.map