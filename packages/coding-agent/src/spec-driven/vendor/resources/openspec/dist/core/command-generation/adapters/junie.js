/**
 * Junie Command Adapter
 *
 * Formats commands for Junie following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Junie adapter for command generation.
 * File path: .junie/commands/opsx-<id>.md
 * Frontmatter: description
 */
export const junieAdapter = {
    toolId: 'junie',
    getFilePath(commandId) {
        return path.join('.junie', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=junie.js.map