/**
 * GigaCode Command Adapter
 *
 * Formats commands for GigaCode using its Markdown custom command format.
 * Project commands live in `.gigacode/commands/` and accept an optional
 * `description` field in YAML frontmatter.
 *
 * @see https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/commands
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * GigaCode adapter for command generation.
 * File path: .gigacode/commands/opsx-<id>.md
 * Format: Markdown with description frontmatter
 */
export declare const gigacodeAdapter: ToolCommandAdapter;
//# sourceMappingURL=gigacode.d.ts.map