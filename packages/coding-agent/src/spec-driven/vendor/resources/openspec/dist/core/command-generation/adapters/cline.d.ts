/**
 * Cline Command Adapter
 *
 * Formats commands for Cline following its workflow specification.
 * Cline uses markdown headers instead of YAML frontmatter.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Cline adapter for command generation.
 * File path: .clinerules/workflows/opsx-<id>.md
 * Format: Markdown header with description
 */
export declare const clineAdapter: ToolCommandAdapter;
//# sourceMappingURL=cline.d.ts.map