/**
 * Factory Droid Command Adapter
 *
 * Formats commands for Factory Droid following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Factory adapter for command generation.
 * File path: .factory/commands/opsx-<id>.md
 * Frontmatter: description, argument-hint
 */
export const factoryAdapter = {
    toolId: 'factory',
    getFilePath(commandId) {
        return path.join('.factory', 'commands', `opsx-${commandId}.md`);
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
//# sourceMappingURL=factory.js.map