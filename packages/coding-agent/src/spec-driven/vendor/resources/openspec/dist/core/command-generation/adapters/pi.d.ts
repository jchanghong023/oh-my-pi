/**
 * Pi Command Adapter
 *
 * Formats commands for Pi (pi.dev) following its prompt template specification.
 * Pi prompt templates live in .pi/prompts/*.md with description frontmatter.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Pi adapter for prompt template generation.
 * File path: .pi/prompts/opsx-<id>.md
 * Frontmatter: description
 *
 * Pi uses the filename (minus .md) as the slash command name, so
 * opsx-propose.md → /opsx-propose. generateCommand rewrites the body's
 * command references to that form before this adapter formats it.
 */
export declare const piAdapter: ToolCommandAdapter;
//# sourceMappingURL=pi.d.ts.map