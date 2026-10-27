/**
 * Bob Shell Command Adapter
 *
 * Formats commands for Bob Shell following its markdown specification.
 * Commands are stored in .bob/commands/ directory.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Bob Shell adapter for command generation.
 * File path: .bob/commands/opsx-<id>.md
 * Frontmatter: description
 *
 * Bob uses the filename (minus .md) as the slash command name, so
 * opsx-propose.md → /opsx-propose. generateCommand rewrites the body's
 * command references to that form before this adapter formats it.
 */
export const bobAdapter = {
    toolId: 'bob',
    getFilePath(commandId) {
        return path.join('.bob', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
argument-hint: command arguments
---

${content.body}
`;
    },
};
//# sourceMappingURL=bob.js.map