/**
 * Oh My Pi (OMP) Command Adapter
 *
 * Formats commands for Oh My Pi following its slash command specification.
 * OMP loads slash commands from .omp/commands/*.md with YAML frontmatter.
 * The filename (minus .md) becomes the slash command name.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Oh My Pi adapter for command generation.
 * File path: .omp/commands/opsx-<id>.md
 * Frontmatter: description
 *
 * OMP uses the filename (minus .md) as the slash command name, so
 * opsx-propose.md → /opsx-propose. generateCommand rewrites the body's
 * command references to that form before this adapter formats it, and
 * $@ is injected after **Input**: headings so user-supplied arguments
 * (e.g. /opsx-propose my-feature) are visible to the agent.
 */
export declare const ohMyPiAdapter: ToolCommandAdapter;
//# sourceMappingURL=oh-my-pi.d.ts.map