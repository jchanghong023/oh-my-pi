/**
 * Cursor Command Adapter
 *
 * Formats commands for Cursor following its frontmatter specification.
 * Cursor uses a different frontmatter format and file naming convention.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Cursor adapter for command generation.
 * File path: .cursor/commands/opsx-<id>.md
 * Frontmatter: name (as /opsx-<id>), id, category, description
 */
export const cursorAdapter = {
    toolId: 'cursor',
    getFilePath(commandId) {
        return path.join('.cursor', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
name: ${escapeYamlValue(`/opsx-${content.id}`)}
id: ${escapeYamlValue(`opsx-${content.id}`)}
category: ${escapeYamlValue(content.category)}
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=cursor.js.map