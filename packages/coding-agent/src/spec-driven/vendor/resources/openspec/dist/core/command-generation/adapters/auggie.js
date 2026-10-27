/**
 * Auggie (Augment CLI) Command Adapter
 *
 * Formats commands for Auggie following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Auggie adapter for command generation.
 * File path: .augment/commands/opsx-<id>.md
 * Frontmatter: description, argument-hint
 */
export const auggieAdapter = {
    toolId: 'auggie',
    getFilePath(commandId) {
        return path.join('.augment', 'commands', `opsx-${commandId}.md`);
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
//# sourceMappingURL=auggie.js.map