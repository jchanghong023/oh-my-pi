/**
 * Amazon Q Developer Command Adapter
 *
 * Formats commands for Amazon Q Developer following its frontmatter specification.
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * Amazon Q adapter for command generation.
 * File path: .amazonq/prompts/opsx-<id>.md
 * Frontmatter: description
 *
 * Amazon Q surfaces these files as its prompt library rather than as slash
 * commands: the user types `@opsx-propose`, not `/opsx-propose`.
 * https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-prompts.html
 */
export declare const amazonQAdapter: ToolCommandAdapter;
//# sourceMappingURL=amazon-q.d.ts.map