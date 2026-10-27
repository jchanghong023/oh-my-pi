/**
 * Devin Desktop Command Adapter
 *
 * Formats commands for Devin Desktop following its frontmatter specification.
 * Devin Desktop reads Cascade-style workflows from `.devin/workflows/`, the
 * same shape Windsurf uses.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Devin Desktop adapter for command generation.
 * File path: .devin/workflows/opsx-<id>.md
 * Frontmatter: name, description, category, tags
 *
 * The `opsx-` filename prefix makes this a flat invocation, so the generator
 * rewrites the body's `/opsx:*` references to the `/opsx-*` form Devin
 * registers — see invocation.ts.
 */
export declare const devinAdapter: ToolCommandAdapter;
//# sourceMappingURL=devin.d.ts.map