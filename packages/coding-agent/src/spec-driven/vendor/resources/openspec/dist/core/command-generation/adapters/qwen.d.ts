/**
 * Qwen Code Command Adapter
 *
 * Formats commands for Qwen Code following its Markdown custom command
 * specification. Qwen Code has deprecated TOML commands in favor of
 * Markdown files with YAML frontmatter.
 *
 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/#markdown-file-format-specification-recommended
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Qwen adapter for command generation.
 * File path: .qwen/commands/opsx-<id>.md
 * Format: Markdown with description frontmatter
 */
export declare const qwenAdapter: ToolCommandAdapter;
//# sourceMappingURL=qwen.d.ts.map